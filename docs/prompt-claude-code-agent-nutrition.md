# Agent nutrition personnel — spécification de build

Tu vas construire un agent de suivi de sèche personnel, mono-utilisateur, piloté par un bot Telegram.
Lis toute la spec avant d'écrire du code. Pose-moi des questions si un point est ambigu plutôt que de deviner.

---

## 1. Stack imposé

- **Runtime** : Node.js (TypeScript), ESM
- **Hébergement** : Vercel, plan Hobby — donc **serverless uniquement**, pas de process long, pas d'état en mémoire entre invocations
- **Base** : MongoDB Atlas (free tier M0), driver officiel `mongodb`
- **Messagerie** : Telegram Bot API (webhook, pas de polling)
- **LLM** : API Anthropic (`@anthropic-ai/sdk`), Claude pour le texte et la vision
- **Scheduler** : cron externe (cron-job.org ou GitHub Actions) qui appelle une route HTTP protégée toutes les 15 minutes. Le cron Vercel Hobby est limité à 1 exécution/jour, on ne l'utilise pas.

Contraintes serverless à respecter partout :
- connexion Mongo mise en cache dans une variable globale (pattern standard Vercel, pas de reconnexion par requête)
- réponse au webhook Telegram en < 10 s ; si un traitement est plus long, réponds d'abord `200 OK` et poursuis
- aucune dépendance à un système de fichiers persistant

---

## 2. Ce que fait le produit

Un seul utilisateur (moi). Le bot :

1. **Onboarding** conversationnel au premier lancement
2. **Reçoit des photos de repas** → estime l'apport calorique et les macros
3. **Reçoit des saisies texte** libres (poids, repas, entraînement, ressenti)
4. **Parse un PDF** de composition corporelle (rapport 2 pages de la balance impédancemétrie de ma salle)
5. **Recalcule ma dépense énergétique réelle** à partir des données observées, et ajuste la cible calorique
6. **Envoie des notifications contextuelles** (rappels de collation pré-entraînement, pesée hebdo, relance si absence de saisie)

Pas de multi-utilisateur, pas d'authentification, pas de front web. Le seul filtre d'accès est mon `chat_id` Telegram, en variable d'environnement.

---

## 3. Onboarding

Au premier `/start`, l'agent mène une conversation pour établir :

- date de démarrage (peut être antérieure à aujourd'hui)
- poids de départ, taille, âge, sexe
- niveau d'activité de base (hors entraînements)
- planning d'entraînement récurrent (jours + heures + type : CrossFit, vélo, course)
- contraintes alimentaires, aversions, habitudes
- horizon souhaité en semaines **et** objectif de poids

Il calcule ensuite une cible et **négocie** si l'objectif est irréaliste.

### Règles de cible — à coder en dur, non contournables par la conversation

```
RATE_MAX_PCT       = 1.0   // % du poids corporel par semaine, plafond absolu
RATE_RECOMMENDED   = 0.7   // % / semaine, valeur par défaut proposée
DEFICIT_MAX_PCT    = 25    // % sous la maintenance estimée
KCAL_FLOOR_MALE    = 1500  // plancher absolu, kcal/jour
KCAL_FLOOR_FEMALE  = 1200
BMI_FLOOR          = 18.5  // sous ce seuil : refus de programme de perte
```

Si l'objectif demandé dépasse `RATE_MAX_PCT`, l'agent **allonge l'horizon** — il ne creuse jamais le déficit. Il l'explique clairement.

Si l'IMC de départ est sous `BMI_FLOOR`, ou si l'objectif ferait passer sous ce seuil : refus, message bienveillant, orientation vers un professionnel de santé. Non négociable.

Maintenance initiale : Mifflin-St Jeor × facteur d'activité. C'est une **estimation de départ uniquement**, remplacée dès que 14 jours de données réelles existent (voir §5).

---

## 4. Modèle de données (MongoDB)

Collections. Tous les documents portent `createdAt` / `updatedAt`.

### `profile` (document unique)
```
{
  startDate, startWeightKg, heightCm, age, sex,
  activityFactor,
  targetWeightKg, targetWeeks, targetRatePctPerWeek,
  kcalFloor,
  currentTargetKcal,          // recalculé par la boucle d'adaptation
  proteinTargetG,             // 1.8–2.2 g/kg de poids cible
  constraints: [String],      // aversions, allergies, contexte
  trainingSchedule: [ { weekday, timeHHMM, type, durationMin } ],
  onboardingComplete: Boolean
}
```

### `weights`
```
{ date, weightKg, source: 'manual' | 'scan' }
```

### `meals`
```
{
  datetime,
  inputType: 'photo' | 'text',
  telegramFileId,             // conservé, permet une réanalyse ; l'image n'est jamais stockée par nous
  rawDescription,
  items: [ { name, estimatedGrams, kcal, proteinG, carbsG, fatG } ],
  kcalLow, kcalMid, kcalHigh, // fourchette, jamais un chiffre unique
  confidence: 'low' | 'medium' | 'high',
  userCorrected: Boolean
}
```

### `workouts`
```
{ datetime, type, durationMin, intensity, source: 'planned' | 'declared', estimatedKcal }
```

### `bodyScans`
```
{ date, weightKg, fatMassKg, fatPct, leanMassKg, boneMassKg, waterPct, visceralFat, rawText }
```

### `notes` — le qualitatif, séparé des chiffres
```
{ date, type: 'fatigue' | 'injury' | 'hunger' | 'constraint' | 'other', content, severity }
```

### `dailyState` — agrégat par jour, recalculé
```
{
  date, totalKcal, proteinG, carbsG, fatG,
  weightKg, rolling7Weight, rolling14Kcal,
  observedTdee, targetKcal, adherenceFlag
}
```

### `messages` — historique conversationnel pour le contexte
```
{ datetime, role: 'user' | 'assistant', content, tokensUsed }
```

---

## 5. Boucle d'adaptation — le cœur du système

**Ne jamais prédire la perte à partir du déficit théorique.** On fait l'inverse : on déduit la dépense réelle de ce qui s'est passé.

Recalcul quotidien, dès que 14 jours de données existent :

```
avgKcal      = moyenne des apports sur 14 j
weightStart  = moyenne glissante 7 j, centrée sur J-14
weightEnd    = moyenne glissante 7 j, centrée sur aujourd'hui
deltaKg      = weightEnd - weightStart

observedTdee = avgKcal + (deltaKg * 7700 / 14) * -1
```

Toujours comparer des **moyennes hebdomadaires**, jamais deux pesées ponctuelles : le bruit hydrique écrase le signal.

Ajustement de la cible :
- écart entre rythme observé et rythme cible < 20 % → **ne rien changer**
- perte trop lente → baisser la cible de 100 kcal max, une seule fois par semaine
- perte trop rapide → **remonter** la cible
- jamais sous `kcalFloor`, quelles que soient les données

### Palier haut obligatoire (diet break)

Une boucle qui ne sait que baisser finit mécaniquement trop bas. À coder :

- si le poids stagne (< 0,2 % de variation) sur **3 semaines consécutives** malgré l'adhérence → l'agent propose une **remontée à maintenance pendant 7 jours**, pas une baisse supplémentaire
- toutes les 8 à 10 semaines de déficit continu → proposer un diet break d'une semaine
- si `notes` contient de la fatigue élevée ou une blessure récente → suspendre tout ajustement à la baisse

### Estimation photo

L'analyse vision a une marge d'erreur réelle de 20 à 40 %. En conséquence :
- toujours renvoyer une **fourchette** (`kcalLow`/`kcalHigh`), jamais un chiffre net
- afficher le niveau de confiance
- proposer une correction en un tap
- le biais d'estimation est absorbé par la boucle §5, puisque la maintenance est déduite du poids réel et non des calories saisies. Documente ce raisonnement dans le code.

---

## 6. Notifications

Route `POST /api/cron/tick`, appelée toutes les 15 min, protégée par un header secret (`CRON_SECRET`). Elle évalue des règles et n'envoie que si pertinent.

**Anti-spam, à respecter strictement :**
- maximum 4 notifications par jour
- pas d'envoi entre 22 h et 7 h
- une même règle ne se déclenche pas deux fois dans la même journée
- toute notification est **conditionnelle** : si la condition qui la motive est déjà satisfaite, on n'envoie rien

### Règles v1

| Règle | Condition | Contenu |
|---|---|---|
| Collation pré-entraînement | séance planifiée dans 60–90 min **et** aucun repas enregistré depuis > 3 h | suggestion de collation légère, adaptée au type de séance |
| Pesée hebdo | jour fixe choisi à l'onboarding, matin, si aucune pesée ce jour | rappel + rappel des conditions constantes (à jeun, après WC, avant de boire) |
| Relance saisie | aucun repas enregistré depuis > 24 h | message court, non culpabilisant |
| Bilan hebdomadaire | jour fixe, soir | rythme de perte réel, TDEE observé, ajustement éventuel, une observation qualitative |

Ton des messages : factuel, court, jamais moralisateur. Aucun compte à rebours anxiogène, aucune formulation de type « tu as échoué ».

---

## 7. Garde-fous à coder en dur

Ces règles sont dans le code, pas dans le prompt système — elles ne doivent pas être contournables par la conversation.

1. **Plancher calorique** : `kcalFloor` jamais franchi, quel que soit le calcul.
2. **Plafond de rythme** : `RATE_MAX_PCT`, l'horizon s'allonge au lieu du déficit qui se creuse.
3. **Refus sous IMC 18,5**, et refus si l'objectif y mène.
4. **Détection de signaux de trouble du comportement alimentaire.** Si le langage de l'utilisateur suggère une restriction excessive, une culpabilité alimentaire marquée, des comportements compensatoires ou une obsession du chiffre : l'agent **cesse de donner des cibles chiffrées**, exprime son inquiétude simplement, et oriente vers un professionnel. Il ne diagnostique rien. Implémente ça comme une vérification sur les entrées utilisateur, avec un état persistant — une fois déclenché, il ne se réinitialise pas tout seul.
5. **Perte rapide anormale** : > 1,5 % du poids corporel sur une semaine → alerte, remontée automatique de la cible.
6. **Aucun conseil médical.** Pas d'interprétation de symptômes, pas de recommandation de complément au-delà des bases, pas d'avis sur des médicaments. Orientation systématique vers un professionnel.
7. Le PDF de composition corporelle est stocké en tendance uniquement. L'impédancemétrie varie de plusieurs points selon l'hydratation : l'agent doit le rappeler à chaque scan et ne jamais traiter le % de masse grasse comme une valeur absolue.

---

## 8. Structure du projet

```
/api
  /telegram/webhook.ts       // entrée unique des messages
  /cron/tick.ts              // scheduler externe
  /cron/daily-recompute.ts   // agrégats + boucle d'adaptation
/lib
  /db.ts                     // connexion Mongo cachée
  /telegram.ts               // envoi, parsing, download de fichier
  /claude.ts                 // wrapper SDK Anthropic
  /vision.ts                 // photo repas → items + fourchette
  /pdf.ts                    // rapport composition corporelle → bodyScan
  /router.ts                 // intention du message → handler
  /calc/                     // TOUT le déterministe, zéro LLM
    tdee.ts
    rolling.ts
    adjust.ts
    guardrails.ts
  /notify/rules.ts
/prompts
  system.md
  onboarding.md
  vision.md
```

**Règle d'architecture non négociable : aucun calcul numérique dans le LLM.**
Le contenu de `/lib/calc` est du code pur, testé unitairement. Le modèle lit les résultats et les commente, il ne les produit jamais. Un LLM qui fait une moyenne glissante « à l'œil » sur 90 lignes donne des chiffres approximatifs — c'est exactement ce qu'on veut éviter.

Pas d'orchestration multi-agents. Un seul agent, avec des fonctions spécialisées appelées en tool use. Le multi-agents ajouterait latence, coût et modes de panne pour un gain nul à cette échelle.

---

## 9. Contexte envoyé au modèle

À chaque tour, construis le contexte ainsi :

- **profil + contraintes** (stable, toujours inclus)
- **notes récentes** (30 derniers jours, qualitatif : fatigue, blessure, contraintes)
- **dailyState des 14 derniers jours** (chiffres, déjà calculés)
- **10 derniers messages**

Pas de RAG. Le corpus tient largement dans le contexte ; une recherche sémantique n'apporterait qu'un risque de sélection ratée.

---

## 10. Ordre de construction

Construis et fais-moi valider étape par étape, ne passe pas à la suivante sans mon accord :

1. Setup, connexion Mongo, webhook Telegram, écho simple
2. `/lib/calc` complet + tests unitaires (avant toute intégration LLM)
3. Onboarding conversationnel + garde-fous
4. Saisie texte + saisie photo
5. Recompute quotidien + boucle d'adaptation
6. Notifications + règles
7. Parsing du PDF de composition corporelle

Strava est **hors périmètre v1**. Prévois seulement un champ `source` sur `workouts` pour l'ajouter plus tard sans migration.

---

## 11. Variables d'environnement

```
MONGODB_URI
ANTHROPIC_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
CRON_SECRET
TZ=Europe/Zurich
```

Attention aux fuseaux : Vercel tourne en UTC. Toute logique horaire (fenêtre de nuit, rappels pré-entraînement, jour de pesée) doit se faire en heure locale Europe/Zurich, explicitement convertie.

---

## 12. Ce que je veux en sortie

- Le code, par étapes validées
- Un `README.md` avec le setup complet : création du bot Telegram, configuration du webhook, du cron externe, des index Mongo
- Les tests unitaires de `/lib/calc`
- Un script de seed pour tester la boucle d'adaptation sur des données fictives de 30 jours

Commence par me confirmer que tu as compris la spec, signale les points que tu juges fragiles, puis attaque l'étape 1.
