# Agent nutrition personnel — spécification de build (v4)

Tu vas construire un agent de suivi de sèche personnel, mono-utilisateur, piloté par un bot Telegram.
Lis toute la spec avant d'écrire du code. Pose-moi des questions si un point est ambigu plutôt que de deviner.

> **v3** : le planning figé devient un système de **scénarios nommés** résolus chaque matin ; le plancher calorique vient d'un **scan de composition corporelle mesuré** (prérequis à l'onboarding) ; **double estimateur TDEE** prédit vs observé, avec suivi de l'écart.
>
> **v4 — ce qui change** : suivi du sommeil par **auto-déclaration en un tap** dans le message du matin, aucune intégration d'objet connecté.

---

## 1. Stack imposé

- **Runtime** : Node.js (TypeScript), ESM
- **Hébergement** : Vercel, plan Hobby — **serverless uniquement**
- **Base** : Vercel Postgres (Neon), via `@vercel/postgres`
- **Messagerie** : Telegram Bot API (webhook, pas de polling)
- **LLM** : API Anthropic (`@anthropic-ai/sdk`), Claude pour texte et vision
- **Scheduler** : GitHub Actions ou cron-job.org, appel HTTP toutes les 15 min sur route protégée

Contraintes :
- pool géré par `@vercel/postgres`, pas de connexion manuelle par requête
- réponse au webhook Telegram en < 10 s ; sinon `200 OK` puis poursuite
- aucun système de fichiers persistant

**Scheduler** : GitHub Actions a 5-15 min de retard réel et tourne en UTC. Toute logique horaire convertie explicitement en `Europe/Zurich`, fenêtres de déclenchement larges (§8).

---

## 2. Profil utilisateur

**Athlète d'endurance en volume élevé**, pas un sédentaire en perte de poids. Ça conditionne tous les seuils de sécurité.

Volume : **8 à 10 h/semaine**, séances quotidiennes de 1 à 2 h, base d'endurance importante.

Conséquences :
- maintenance observée haute — c'est normal
- risque dominant : la **sous-alimentation relative** (RED-S), pas l'échec de perte
- semaine répétable dans sa structure → la boucle 14 j est fiable
- variabilité concentrée sur les **variantes de trajet** et les **changements de saison**

---

## 3. Scénarios — remplace le planning figé

Le planning n'est **pas** un calendrier fixe. C'est un vocabulaire de situations que l'utilisateur nomme en une phrase, et dont l'agent déduit tous les segments d'activité.

### Semaine standard (défauts, pas des certitudes)

| Jour | Situation par défaut | Trajets |
|---|---|---|
| Lundi | Bureau, dort chez Rémi | Vélo descente gare (léger) → train → 20-25 min plat modéré vers bureau → retour 20-25 min → 15 min modéré vers chez Rémi |
| Mardi | Bureau depuis chez Rémi, rentre chez lui | 20 min modéré vers gare → 25 min modéré vers bureau → 30 min intensité moyenne-haute retour maison |
| Mercredi | Bureau Philip Morris | Aller-retour vélo |
| Jeudi | Télétravail + **CrossFit** | Selon mode de déplacement déclaré |
| Vendredi | Télétravail | Aucun trajet |
| Samedi | Variable | Vélo, course ou renforcement |
| Dimanche | **CrossFit** (matin) | Selon mode de déplacement déclaré |

CrossFit : ~2 séances/semaine, généralement jeudi et dimanche matin, **mais variable**. Le mode de déplacement change à chaque fois — parfois en vélo, parfois en courant (20 min aller / 30 min retour).

### Table `scenarios`

```
id, name,
aliases jsonb,        -- formulations utilisées : ["je dors chez Rémi", "chez Rémi", "nuit Rémi"]
segments jsonb,       -- [{ type, duration_min, intensity, timing }]
implies_next_day,     -- id d'un scénario déclenché le lendemain
usage_count           -- fréquence, sert à proposer le défaut
```

**Comportement attendu :**

1. Chaque matin, l'agent demande : « qu'est-ce que tu as prévu aujourd'hui ? », en **pré-remplissant** le scénario le plus probable pour ce jour de la semaine. L'utilisateur confirme d'un mot ou corrige.
2. L'utilisateur répond en langage naturel : « CrossFit en vélo, et je dors chez Rémi ». L'agent résout **plusieurs scénarios** dans une seule phrase.
3. Un scénario avec `implies_next_day` pré-configure automatiquement le lendemain — dormir chez Rémi le lundi détermine les trajets du mardi matin.
4. **Apprentissage** : si l'utilisateur emploie une formulation inconnue, l'agent demande une fois ce qu'elle implique, crée le scénario, et le réutilise ensuite sans reposer la question.
5. L'agent ne repose une question que si c'est ambigu ou nouveau. Jamais de formulaire.

### Table `day_plan`

`date, scenarios_applied jsonb, segments_resolved jsonb, confirmed boolean, is_atypical boolean`

Résolu à partir de la réponse du matin. Sert aux rappels pré-séance (§8) et au marquage des jours atypiques (§6).

---

## 4. Onboarding

**Prérequis bloquant : un scan de composition corporelle.** L'agent ne fixe aucune cible avant de l'avoir. L'utilisateur envoie le PDF de la machine de sa salle (§7).

Conversation pour établir :
- date de démarrage, poids, taille, âge, sexe
- objectif de poids **et** horizon en semaines
- contraintes alimentaires, aversions, habitudes
- scénarios de base (§3) — l'agent propose la semaine standard, l'utilisateur corrige
- jour de pesée hebdo et jour du bilan
- présence ou non d'un **jour de repos complet** — si aucun, le signaler

### Règles de cible — code en dur, non contournables par la conversation

```ts
const RATE_MAX_PCT     = 0.75; // % du poids corporel / semaine, plafond absolu
const RATE_DEFAULT_PCT = 0.5;  // proposé par défaut (profil endurance)
const DEFICIT_MAX_PCT  = 20;   // % sous la maintenance
const KCAL_PER_KG_LBM  = 30;   // plancher = 30 kcal/kg de masse maigre MESURÉE
const KCAL_FLOOR_ABS   = 1800; // filet de sécurité
const BMI_FLOOR        = 18.5;
```

**Plancher calorique — depuis le scan, jamais depuis une estimation :**

```
kcalFloor = max(KCAL_FLOOR_ABS, scan.lean_mass_kg * KCAL_PER_KG_LBM)
```

Recalculé **à chaque nouveau scan** : la masse maigre bouge pendant une sèche.

Note à faire figurer dans le code et à dire à l'utilisateur : les machines de salle **n'ont pas mesuré** le métabolisme de base — elles estiment la masse maigre par impédance puis appliquent une formule. Seule une calorimétrie indirecte le mesure. On stocke et affiche le BMR du rapport s'il existe, mais le plancher se calcule sur la masse maigre, qui est la donnée la plus traçable.

Si l'objectif dépasse `RATE_MAX_PCT` → l'agent **allonge l'horizon**, jamais ne creuse le déficit, et explique pourquoi.
Si l'IMC est sous `BMI_FLOOR` ou si l'objectif y mène → refus, orientation vers un professionnel. Non négociable.

Protéines : **2,0 à 2,2 g/kg de poids corporel**. Non négociable sur ce profil.

---

## 5. Double estimateur TDEE

Deux chiffres calculés et **affichés côte à côte**, avec leur écart.

### TDEE prédit
```
BMR (Mifflin-St Jeor sur masse maigre mesurée, ou Katch-McArdle)
+ facteur d'activité de base
+ estimation des segments du day_plan
```
Disponible dès J1. Sert à démarrer et de garde-fou.

### TDEE observé
Issu de la boucle 14 j (§6). Disponible à J14. **C'est lui qui pilote** une fois disponible.

### Suivi de l'écart

Stocké dans `tdee_comparison` : `date, predicted, observed, delta_pct`.

L'écart est une **donnée personnelle utile**, pas une erreur à corriger. Un prédit à 3200 pour un observé à 2900 t'apprend que soit les estimations de séances sont hautes, soit le NEAT est plus bas que supposé, soit l'apport est sous-déclaré. L'agent le présente ainsi.

**Garde-fou** : si l'écart dépasse 25 %, quelque chose cloche dans les données. L'agent le signale plutôt que d'ajuster aveuglément.

**Règle stricte** : les estimations de dépense par séance sont **informatives**. Elles alimentent le prédit, jamais la cible calorique une fois l'observé disponible. Sinon double comptage — l'observé inclut déjà tout.

---

## 6. Boucle d'adaptation

**Ne jamais prédire la perte à partir du déficit théorique.** On déduit la dépense réelle du résultat observé.

```
avgKcal      = moyenne des apports sur 14 j, jours exclus retirés
weightStart  = moyenne glissante 7 j centrée sur J-14
weightEnd    = moyenne glissante 7 j centrée sur aujourd'hui
deltaKg      = weightEnd - weightStart

observedTdee = avgKcal - (deltaKg * 7700 / 14)
```

Toujours des **moyennes hebdomadaires**, jamais deux pesées ponctuelles.

Ajustement :
- écart au rythme cible < 20 % → **ne rien changer**
- trop lent → baisser de 100 kcal max, une fois par semaine maximum
- trop rapide → **remonter**
- jamais sous `kcalFloor`
- jamais pendant `baseline_locked_until`

### Pourquoi la variation de poids bat l'addition d'estimations

Métabolisme de base ~60-65 % de la dépense, NEAT ~15-25 %, entraînement ~5-15 %. Le NEAT n'est mesuré par rien et baisse discrètement pendant une sèche — c'est l'adaptation métabolique. La variation de poids mesure **le bilan net total**, adaptation comprise. Documente ce raisonnement dans le code.

### Jours atypiques

Une journée dont la charge **s'écarte fortement de la routine** (sortie > 2 h hors habitude, week-end long) est marquée `is_atypical` et **exclue** du calcul de moyenne. Le critère est l'écart à la routine, pas la durée absolue : les 2 h quotidiennes de l'utilisateur sont sa baseline et entrent normalement dans la moyenne.

### Re-baseline

Commande `/rebaseline`, ou détection par l'agent d'un changement structurel : saison, déménagement, blessure, reprise, changement de rythme de travail.

Effet : `baseline_started_at = today`, ajustements **gelés 14 jours**, message clair expliquant que les cibles sont provisoires le temps de réobserver.

Sans ce mécanisme, un changement de routine produit deux semaines de cibles fausses sans que rien ne le signale.

### Palier haut obligatoire (diet break)

Une boucle qui ne sait que baisser finit mécaniquement trop bas.

- stagnation (< 0,2 %) sur **3 semaines consécutives** malgré l'adhérence → **remontée à maintenance 7 jours**, jamais une baisse supplémentaire
- toutes les **8 à 10 semaines** de déficit continu → diet break d'une semaine, proposé d'office
- fatigue élevée ou blessure dans `notes` → ajustements à la baisse suspendus

Prévenir que le poids remonte de 1 à 2 kg pendant un palier (glycogène et eau, pas de la graisse) et redescend en quelques jours. Sans cet avertissement, le palier sera abandonné au bout de trois jours.

### Performance comme signal d'alerte

Sur ce profil, **la performance décroche avant que le poids ne signale un problème.**

Deux semaines de baisse (allure, charge, capacité de travail, ou RPE en hausse à effort constant) → l'agent **remonte les calories** sans attendre une stagnation de poids, et l'explique.

Signaux à surveiller : fatigue persistante, sommeil dégradé, récupération allongée, faim excessive, infections répétées, motivation en baisse. Combinés, ils évoquent un déficit énergétique relatif (RED-S). L'agent ne diagnostique pas — il remonte les calories et oriente vers un professionnel.

### Sommeil — auto-déclaré, pas d'objet connecté

Le sommeil compte parce qu'il prédit la faim et l'adhérence du lendemain, **pas** parce qu'il entre dans un calcul calorique. Les « calories brûlées pendant le sommeil » affichées par certaines applications sont du métabolisme de base recalculé, déjà compris dans le TDEE — à ignorer.

**Le sommeil ressenti est le bon indicateur.** Une estimation de phases par tapis ou bracelet n'ajoute rien d'exploitable ici, et un suivi trop précis du sommeil a un effet contre-productif documenté.

Implémentation : dans le message du matin (§9), une question « nuit ? » avec trois réponses en un tap — **bonne / moyenne / mauvaise**. Écrit dans `notes` avec `type = 'sleep'`.

Règle : **deux nuits « mauvaise » consécutives → aucun ajustement à la baisse**, et mention dans le bilan hebdomadaire.

Pas d'intégration Withings, Oura ou équivalent. Si le besoin apparaît plus tard, ce sera une source supplémentaire alimentant la même colonne, sans changer la logique.

---

## 7. Saisie

### Repas — trois modes, par ordre de fiabilité

**1. Pesée (mode principal)** — « 200 g de riz basmati cuit, 150 g de poulet ». Lookup dans `foods` (Ciqual/OSAV), macros exactes, `confidence = 'high'`.

**2. Décrite** — « une assiette de pâtes bolognaise ». Estimation par le modèle, fourchette, `confidence = 'medium'`.

**3. Photo (fallback restaurant)** — analyse vision, 20-40 % d'erreur réelle. Toujours une **fourchette**, jamais un chiffre net. `confidence = 'low'`, affichée comme telle. Correction en un tap.

Le biais des modes 2 et 3 est absorbé par la boucle §6, puisque la maintenance vient du poids réel et non des calories saisies.

### Composition corporelle

PDF de 2 pages de la machine de la salle, envoyé au bot, parsé vers `body_scans`, puis **recalcul de `kcal_floor`**.

L'impédancemétrie varie de plusieurs points selon l'hydratation et l'heure. L'agent le rappelle à chaque scan, ne traite jamais le % de masse grasse comme absolu, et ne l'utilise qu'en **tendance**, à conditions de mesure constantes. Sa valeur principale : distinguer perte de gras et perte de muscle — ce que la balance seule ne dira jamais.

---

## 8. Nutrition autour des séances

La cible calorique quotidienne **ne varie pas** selon la séance (double comptage). Ce qui varie, c'est la **répartition et le timing** — carb cycling léger à budget constant.

| Situation | Recommandation |
|---|---|
| Cardio long (> 90 min) | Glucides accrus avant/pendant/après, collation pré-séance systématique |
| WOD / renforcement | Priorité protéines post-séance |
| Séance courte (< 30 min) | Pas de collation spécifique |
| Sortie > 2 h | **Mode événement** : maintenance ou léger surplus ce jour-là, 60-90 g glucides/h pendant l'effort, recharge après, jour `is_atypical` |
| Semaine très chargée | Aucun ajustement à la baisse |

Les recommandations de glucides horaires sont bien documentées et **ne dépendent pas** d'une estimation de dépense — d'où la possibilité d'être précis ici sans instrumentation.

L'agent lit la description en langage naturel (« Fortime 25 min très cardio » vs « AMRAP 9 min renforcement ») et en tire les bonnes recommandations. **Aucune table de dépense par exercice.**

---

## 9. Notifications

Route `POST /api/cron/tick`, toutes les 15 min, protégée par `CRON_SECRET`.

**Anti-spam strict :**
- max 4 notifications/jour
- rien entre 22 h et 7 h (Zurich)
- une règle ne se déclenche pas deux fois le même jour
- toute notification est **conditionnelle** : condition déjà satisfaite → rien

| Règle | Condition | Contenu |
|---|---|---|
| Plan du jour | matin, si `day_plan` non confirmé | « qu'est-ce que tu as prévu aujourd'hui ? » avec le scénario probable pré-rempli, **plus la question « nuit ? » en un tap** (bonne / moyenne / mauvaise) |
| Collation pré-séance | séance dans **45-105 min** (fenêtre large, cron en retard) **et** aucun repas depuis > 3 h | suggestion adaptée au type de séance |
| Pesée hebdo | jour choisi, matin, si aucune pesée | rappel + conditions constantes (à jeun, après WC, avant de boire) |
| Relance saisie | aucun repas depuis > 24 h | message court, non culpabilisant |
| Bilan hebdomadaire | jour choisi, soir | rythme réel, TDEE observé vs prédit, ajustement, observation qualitative, état de la performance |
| Alerte performance | 2 semaines de baisse | remontée de calories, explication |
| Diet break | conditions §6 | proposition de palier haut |

Ton : factuel, court, jamais moralisateur. Aucun compte à rebours anxiogène, aucune formulation d'échec.

---

## 10. Garde-fous — code en dur, hors du prompt système

Un prompt se contourne en trois messages. Ces règles sont dans le code.

1. **Plancher calorique** basé sur la masse maigre **mesurée**, jamais franchi.
2. **Plafond de rythme** : l'horizon s'allonge, le déficit ne se creuse pas.
3. **Refus sous IMC 18,5**, et refus si l'objectif y mène.
4. **Détection de signaux de trouble du comportement alimentaire.** Restriction excessive, culpabilité alimentaire marquée, comportements compensatoires, obsession du chiffre → l'agent **cesse de donner des cibles chiffrées**, exprime son inquiétude simplement, oriente vers un professionnel. Il ne diagnostique pas. État **persistant**, pas de réinitialisation automatique.
5. **Perte rapide anormale** : > 1 % du poids sur une semaine → alerte et remontée automatique.
6. **Alerte RED-S** : volume élevé + déficit + baisse de performance + fatigue → remontée des calories, orientation vers un professionnel du sport.
7. **Aucun conseil médical.** Pas d'interprétation de symptômes, pas de recommandation de complément au-delà des bases, pas d'avis sur des médicaments.
8. **Jour de repos** : aucun jour de repos complet sur 10 jours consécutifs → le signaler.

---

## 11. Modèle de données (Postgres)

Migrations SQL. Index sur toutes les colonnes de date.

- **`profile`** — identité, objectif, `kcal_floor`, `current_target_kcal`, `protein_target_g`, `constraints`, `baseline_started_at`, `baseline_locked_until`, `rest_day_declared`, `onboarding_complete`
- **`scenarios`** — §3
- **`day_plan`** — §3
- **`weights`** — `date, weight_kg, source`
- **`meals`** — `datetime, input_type, telegram_file_id, raw_input, items jsonb, kcal_low/mid/high, confidence, user_corrected`
- **`workouts`** — `datetime, type, duration_min, intensity_text, is_atypical, source, perceived_effort`
- **`body_scans`** — `date, weight_kg, fat_mass_kg, fat_pct, lean_mass_kg, bone_mass_kg, water_pct, visceral_fat, reported_bmr, raw_text`
- **`performance`** — `date, workout_type, metric_name, metric_value, note`
- **`notes`** — `date, type, content, severity`
- **`daily_state`** — `date, total_kcal, macros, weight_kg, rolling7_weight, rolling14_kcal, observed_tdee, predicted_tdee, target_kcal, is_excluded, adherence_flag`
- **`tdee_comparison`** — `date, predicted, observed, delta_pct`
- **`foods`** — import Ciqual/OSAV, index trigram sur `name_normalized`
- **`messages`** — `datetime, role, content, tokens_used`

`telegram_file_id` est conservé pour permettre une réanalyse ; **l'image n'est jamais stockée** par nous.

---

## 12. Structure du projet

```
/api
  /telegram/webhook.ts
  /cron/tick.ts
  /cron/daily-recompute.ts
/lib
  /db.ts
  /telegram.ts
  /claude.ts
  /vision.ts
  /pdf.ts
  /foods.ts
  /scenarios.ts           // résolution langage naturel → segments
  /router.ts
  /calc/                  // TOUT le déterministe, zéro LLM
    tdee.ts               // prédit ET observé
    rolling.ts
    adjust.ts
    baseline.ts
    guardrails.ts
  /notify/rules.ts
/prompts
  system.md
  onboarding.md
  vision.md
/migrations
/scripts
  import-ciqual.ts
  seed-demo.ts
```

**Règle non négociable : aucun calcul numérique dans le LLM.**
`/lib/calc` est du code pur, testé unitairement. Le modèle lit les résultats et les commente, il ne les produit jamais.

Le LLM sert à **interpréter le langage naturel** (résolution de scénarios, description de repas, ressenti) et à **formuler** les recommandations. Pas à calculer.

Pas d'orchestration multi-agents : un seul agent, fonctions spécialisées en tool use.

**Pas de RAG.** Le corpus tient en contexte. Protocoles dans `/prompts/system.md`, tables de composition en base relationnelle.

---

## 13. Contexte envoyé au modèle

- **profil + contraintes + scénarios connus** (stable, toujours inclus)
- **day_plan du jour et de demain**
- **notes des 30 derniers jours**
- **daily_state des 14 derniers jours** (chiffres déjà calculés)
- **performance des 4 dernières semaines**
- **10 derniers messages**

---

## 14. Ordre de construction

Valider chaque étape avant la suivante :

1. Setup, Postgres + migrations, webhook Telegram, écho simple
2. `/lib/calc` complet + tests unitaires — **avant toute intégration LLM**
3. Parsing PDF composition corporelle (prérequis à l'onboarding)
4. Onboarding + garde-fous
5. Scénarios : création, résolution langage naturel, `day_plan` quotidien
6. Saisie pesée + lookup Ciqual
7. Saisie décrite + photo
8. Recompute quotidien, double TDEE, boucle d'adaptation, re-baseline
9. Notifications et règles
10. Suivi de performance et alertes

Strava hors périmètre. Le champ `source` sur `workouts` permet de l'ajouter sans migration.

---

## 15. Variables d'environnement

```
POSTGRES_URL
ANTHROPIC_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
CRON_SECRET
TZ=Europe/Zurich
```

Vercel tourne en UTC. Toute logique horaire convertie explicitement en heure locale.

---

## 16. Livrables

- Le code, par étapes validées
- `README.md` : bot Telegram, webhook, cron externe, migrations, import Ciqual
- Tests unitaires de `/lib/calc`, cas limites inclus : plancher atteint, jour atypique, re-baseline, diet break, écart TDEE > 25 %
- Script de seed : 30 jours de données cohérentes avec §2 et §3, pour tester la boucle

Commence par confirmer que tu as compris, signale les points que tu juges fragiles, puis attaque l'étape 1.
