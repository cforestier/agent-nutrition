# Routines d'activité récurrentes — design

Date : 2026-09-13
Statut : validé en discussion, prêt pour le plan d'implémentation

## Contexte

Idée de départ : l'utilisateur veut pouvoir dire "demain je vais au bureau" et que le trajet complet (marche/vélo jusqu'à la gare, vélo jusqu'au bureau, retour, puis jusque chez un ami) soit reconnu et compté sans avoir à redécrire chaque étape à chaque fois. Après plusieurs occurrences réelles loggées, le système doit apprendre la dépense moyenne et l'appliquer tout seul par la suite.

Point de conception clé établi en discussion : le **TDEE observé** (`lib/calc/tdee.ts`, fenêtre glissante de 14 jours) absorbe déjà, sur la durée, la dépense moyenne réelle de l'utilisateur — trajets récurrents compris — via l'effet sur le poids. Il n'a pas besoin qu'on lui dise explicitement "j'ai fait du vélo" pour intégrer cette dépense dans son estimation à long terme. Le rôle des routines n'est donc **pas** d'apprendre une moyenne au TDEE (ça, il le fait déjà tout seul) — c'est de **redistribuer la cible calorique jour par jour**, de façon **proactive** (avant même que l'activité ait eu lieu), pour que la cible du lundi (jour de bureau) soit correcte dès le petit-déjeuner, pas seulement après avoir loggé l'activité le soir.

Contrainte explicite de l'utilisateur : ce mécanisme doit être disponible **dès le départ** (onboarding / 14 premiers jours), pas comme une amélioration tardive — sinon la cible des jours actifs est fausse pendant toute la phase où le TDEE observé n'est pas encore fiable.

Second projet, **hors scope de cette spec**, mais pour lequel celle-ci pose les fondations : suivi intra-journée de l'apport vs. l'heure d'une activité prévue, avec push Telegram proactif ("mange une banane avant ton crossfit de 17h"). Voir "Hors scope" en fin de document.

## Objectif

1. Permettre de définir une **routine nommée et réutilisable** (pas liée à un seul jour de semaine), composée d'une ou plusieurs étapes (vélo, marche, course...), avec une tranche horaire.
2. Estimer sa dépense initiale via la table MET (si l'utilisateur ne connaît pas déjà le chiffre) ou directement si l'utilisateur le connaît (montre, historique).
3. Appliquer cette estimation **proactivement** à la cible du jour dès qu'on sait que la routine va avoir lieu (mention explicite, ou planning récurrent automatique).
4. Affiner l'estimation vers une vraie moyenne à chaque occurrence réellement loggée (un seul chiffre total, pas de détail étape par étape à chaque fois).
5. Pour les routines à jour(s) de semaine récurrent(s), appliquer automatiquement le matin même, notifier l'utilisateur, et lui permettre d'annuler d'un tap si ce jour-là dévie du plan.
6. Généraliser la même mécanique d'annonce anticipée à une activité ponctuelle non routinière (ex: "je pense courir 30 min à midi").

## Pourquoi ce n'est pas du double comptage

Contrairement à `WeeklyDefault` (qui soustrait une baseline avant de calculer un écart — cf. `docs/superpowers/specs/2026-09-10-activity-logging-design.md`), une routine réutilisable comme "aller au bureau" n'a **pas** de jour fixe : elle peut tomber un mardi une semaine, un jeudi la suivante. Le TDEE observé, calculé sur une fenêtre glissante de 14 jours, ne "sait" donc jamais à l'avance combien de fois elle est tombée dans cette fenêtre — son effet y est mélangé de façon irrégulière, pas moyenné proprement par jour de semaine comme le ferait `WeeklyDefault`.

La bonne façon de redistribuer une activité irrégulière est donc d'ajouter **intégralement** son estimation en bonus le jour où elle a lieu (comme le mode `additional` de `log_activity` existant), et de laisser le TDEE observé continuer à absorber la moyenne réelle sur la durée sans s'en préoccuper. Il n'y a pas de soustraction de baseline à faire ici — chaque occurrence est un ajout ponctuel, pas un écart par rapport à un "normal" du jour.

## Modèle de données

### Nouveau modèle `ActivityRoutine`

```prisma
model ActivityRoutine {
  id                 String   @id @default(auto()) @map("_id") @db.ObjectId
  name               String   @unique
  aliases            String[]
  legs               Json?    // [{ sportType, durationMinutes, intensity }] — omis si estimatedKcal fourni directement
  primarySportType   String?  // utilisé pour le rabais si legs est absent
  estimatedKcal      Float
  blendedDiscountPct Float
  observedAvgKcal    Float?
  sampleCount        Int      @default(0)
  recurringWeekdays  String[] // sous-ensemble de Weekday ; vide = usage ponctuel uniquement
  timeRangeStart     String?  // "HH:MM"
  timeRangeEnd       String?  // "HH:MM"
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

`legs` réutilise exactement la forme de `Segment` (`lib/scenarios.ts`) — mêmes champs (`type`/`sportType`, `durationMin`, `intensity`) — mais je garde `ActivityRoutine` séparé de `Scenario` : les scénarios décrivent la forme qualitative d'une journée (segments non convertis en kcal aujourd'hui), les routines sont spécifiquement le mécanisme calorique proactif. Les fusionner reviendrait à faire porter à `Scenario` une responsabilité qu'il n'a pas aujourd'hui ; on garde les deux systèmes séparés pour l'instant.

### Extension d'`ActivityLog`

```prisma
model ActivityLog {
  // ... champs existants (voir 2026-09-10 et l'ajout MET de ce matin) ...
  routineId   String? // lien vers ActivityRoutine si cette ligne provient d'une routine
  status      String  @default("done") // "done" | "planned" — planned = annoncé à l'avance, pas encore confirmé
  plannedTime String? // "HH:MM" — heure prévue, uniquement pertinent quand status = "planned"
}
```

`status: "planned"` couvre à la fois : (a) une routine auto-appliquée le matin avant que la journée n'ait eu lieu, et (b) une activité ponctuelle annoncée à l'avance via `log_activity` (voir plus bas). `plannedTime` est stocké **sur la ligne `ActivityLog` elle-même** dans les deux cas — pour une routine, copié depuis `timeRangeStart` au moment de l'auto-application ; pour une activité ponctuelle, fourni directement par l'utilisateur ("à midi"). Ça permet au second projet de savoir quand vérifier l'apport sans avoir à distinguer routine vs ponctuel ni à joindre `ActivityRoutine`.

### Correction : `DayPlan.eventBonusKcal` devient une somme, pas une valeur écrasée

**Bug existant trouvé pendant la conception** : `handleLogActivityTool` (`lib/activity.ts`) fait aujourd'hui `dayPlan.upsert({ update: { eventBonusKcal: bonusKcal } })` — un `log_activity` **remplace** tout le bonus du jour au lieu de l'additionner. Deux activités le même jour (ex: routine du matin + course exceptionnelle à midi) s'écrasent l'une l'autre au lieu de s'additionner.

Fix : nouvelle fonction partagée `recomputeEventBonusForDate(date: string)` (`lib/activity.ts`) :

```ts
export async function recomputeEventBonusForDate(date: string): Promise<void> {
  const logs = await prisma.activityLog.findMany({ where: { date } });
  const total = logs.reduce((sum, l) => sum + l.bonusKcal, 0);
  await prisma.dayPlan.upsert({
    where: { date },
    create: { date, scenariosApplied: [], segmentsResolved: [], isAtypical: total !== 0, eventBonusKcal: total },
    update: { isAtypical: total !== 0, eventBonusKcal: total },
  });
}
```

Appelée après **toute** création/mise à jour/suppression d'`ActivityLog` (dans `handleLogActivityTool`, `handleApplyActivityRoutineTool`, et le handler d'annulation par bouton). Remplace l'upsert direct de `DayPlan` qui existe aujourd'hui dans `handleLogActivityTool`.

Ça résout précisément le cas que tu as posé : remplacer l'estimation d'une même routine par le vrai chiffre (300 → 400) = mise à jour de **cette ligne**, le total se recalcule ; ajouter une activité en plus (course à midi) = **nouvelle ligne**, le total augmente d'autant.

## Table MET : ajout de la marche

Ajout d'un nouveau `sportType: 'walking'` à `lib/activity.ts` (généralement utile, pas seulement pour cet exemple) :

| Intensité | MET marche |
|---|---|
| Léger | 2.8 |
| Modéré | 3.5 |
| Soutenu | 4.3 |
| Vigoureux | 5.0 |
| Maximal | 6.0 |

Rabais : 35% (aligné sur `other`, pas de données spécifiques justifiant un taux différent pour l'instant).

## Calcul de l'estimation initiale d'une routine

Deux chemins, au choix de l'utilisateur :

1. **Kcal déjà connu** (montre, historique) → `estimatedKcal` fourni directement + `primarySportType` pour déterminer `blendedDiscountPct = SPORT_DISCOUNTS[primarySportType]`.
2. **Décomposition en étapes** (`legs`) → pour chaque étape, `kcal_étape = MET × 3.5 × poids(kg) / 200 × durée` (réutilise exactement le calcul MET ajouté ce matin dans `log_activity`, poids depuis `Profile.weightKg`). `estimatedKcal = Σ kcal_étape`. `blendedDiscountPct = Σ (kcal_étape / estimatedKcal) × SPORT_DISCOUNTS[sportType_étape]` — moyenne pondérée par la part de calories de chaque étape.

`blendedDiscountPct` est calculé **une seule fois**, à la création, et reste fixe (pas recalculé à chaque log réel) — simplification volontaire ; si le mix d'étapes change fondamentalement, l'utilisateur recrée la routine.

## Application proactive vs réelle

**Le total d'un log réel est toujours un chiffre unique** (ex: "ma montre dit 450 kcal pour tout le trajet") — pas de re-détail étape par étape à chaque occurrence. Le détail par étape ne sert qu'à construire l'estimation initiale.

`blendedDiscountPct × total` s'applique **à la volée**, que le total vienne de `estimatedKcal`, `observedAvgKcal`, ou un `reportedKcal` réel — jamais stocké déjà rabaissé, pour rester cohérent si le taux de rabais devait changer plus tard.

`observedAvgKcal` est une **moyenne courante** des totaux bruts réels reçus (formule incrémentale, pas besoin de stocker chaque échantillon individuellement) :

```
nouvelle_moyenne = (observedAvgKcal_actuel × sampleCount + reportedKcal) / (sampleCount + 1)
```

## Nouveaux outils conversationnels

### `define_activity_routine`

```ts
input_schema: {
  name: string,
  aliases: string[],
  legs?: [{ sportType: enum[...], durationMinutes: number, intensity: enum[...] }],
  estimatedKcal?: number,       // requis si legs absent
  primarySportType?: enum[...], // requis si legs absent
  recurringWeekdays?: string[], // Weekday[], omis/vide = usage ponctuel
  timeRangeStart?: string,      // "HH:MM"
  timeRangeEnd?: string,
}
```

Validation côté handler : au moins l'un de `legs` ou (`estimatedKcal` + `primarySportType`) doit être fourni ; sinon message d'erreur renvoyé au LLM pour qu'il redemande.

### `apply_activity_routine`

```ts
input_schema: {
  routineName: string,
  date: string,        // YYYY-MM-DD
  reportedKcal?: number, // omis = application proactive/estimée ; fourni = occurrence réelle
}
```

Handler :
1. Résout `routineName` par nom ou alias (même logique que `findScenarioByNameOrAlias`).
2. `effectiveKcal = reportedKcal ?? (routine.observedAvgKcal ?? routine.estimatedKcal)`.
3. `bonusKcal = effectiveKcal × (1 − routine.blendedDiscountPct)`.
4. Cherche une `ActivityLog` existante `{ date, routineId }` avec `status: 'planned'` (créée par l'auto-application du matin ou un appel précédent) :
   - trouvée → **met à jour cette ligne** (`reportedCalories`, `bonusKcal`, `status: reportedKcal ? 'done' : 'planned'`) ;
   - sinon → **crée une nouvelle ligne**.
5. Si `reportedKcal` fourni : incrémente `sampleCount`, met à jour `observedAvgKcal` (formule ci-dessus).
6. `recomputeEventBonusForDate(date)`.
7. Réponse : cible du jour mise à jour, et précise si c'est une estimation ou une confirmation réelle.

### Extension de `log_activity` : annonce anticipée générique

Ajout de deux champs optionnels à l'input existant : `status?: 'done' | 'planned'` (défaut `'done'`, comportement actuel inchangé par défaut) et `plannedTime?: string` ("HH:MM", requis quand `status: 'planned'`, ignoré sinon).

Quand `status: 'planned'` : mêmes calculs qu'aujourd'hui (MET ou `reportedCalories`), mais la ligne est marquée `planned`, `routineId: null`, `plannedTime` stocké tel quel. Si une ligne `planned` existe déjà aujourd'hui avec le même `sportType` et `routineId: null`, elle est mise à jour en place (au lieu d'être dupliquée) quand l'utilisateur confirme/corrige plus tard — limite connue en cas de deux activités ponctuelles planifiées le même jour (voir "Erreurs et cas limites").

## Application quotidienne récurrente + notification + boutons

Nouvelle règle de notification (`lib/notificationRules.ts` ou fichier dédié `lib/routineNotifications.ts`), branchée dans `NOTIFICATION_RULES` — avec une différence importante par rapport aux règles existantes : **celle-ci a un effet de bord** (elle crée l'`ActivityLog` du jour), les autres règles ne font que générer un message.

Dans `runNotificationTick` (`lib/notificationTick.ts`), avant la boucle des règles : charger les `ActivityRoutine` dont `recurringWeekdays` contient le jour de la semaine courant, et qui n'ont **pas encore** d'`ActivityLog` pour `(date, routineId)` aujourd'hui.

Pour la première trouvée (une par tick, cohérent avec le principe existant d'une notification à la fois) :
1. Créer la ligne `ActivityLog` (`status: 'planned'`, `plannedTime: routine.timeRangeStart`, kcal = `observedAvgKcal ?? estimatedKcal`, rabais appliqué).
2. `recomputeEventBonusForDate(date)`.
3. Envoyer via `sendMessageWithKeyboard` : *"Lundi, tu vas normalement au bureau — avec ton métabolisme, cible du jour : XXX kcal. Dis-moi si aujourd'hui ce n'est pas le cas."* avec boutons `Confirmer` (`callback_data: "routine:confirm:<activityLogId>"`) / `Pas aujourd'hui` (`callback_data: "routine:cancel:<activityLogId>"`).

Extension de `handleCallbackQuery` (`api/telegram/webhook.ts`) :
- `routine:confirm:<id>` → `answerCallbackQuery` + message d'accusé de réception (aucun changement, déjà appliqué).
- `routine:cancel:<id>` → supprime l'`ActivityLog`, `recomputeEventBonusForDate(date)`, `answerCallbackQuery` + confirmation.

## Intégration onboarding

Après les 11 champs existants de `record_onboarding_profile`, le prompt d'onboarding (`ONBOARDING_SYSTEM_PROMPT`, `lib/onboarding.ts`) demande si l'utilisateur a des activités sportives régulières et prévisibles. `DEFINE_ACTIVITY_ROUTINE_TOOL` est ajouté à la liste d'outils de l'onboarding (`api/telegram/webhook.ts`, à côté de `ONBOARDING_TOOL`/`FLAG_CONCERN_TOOL`) — les routines peuvent donc être créées **avant** la confirmation finale et l'appel à `record_onboarding_profile`.

## Erreurs et cas limites

- Routine créée sans `legs` ni `estimatedKcal`/`primarySportType` → erreur renvoyée au LLM, ne crée rien.
- `routineName` non reconnu dans `apply_activity_routine` → message invitant à créer la routine d'abord (comme `apply_day_plan` aujourd'hui pour les scénarios inconnus).
- Deux activités ponctuelles `status: 'planned'` le même jour avec le même `sportType` (rare) : la seconde annonce écrase la mise à jour en place de la première au lieu d'en créer une nouvelle — limite connue acceptée pour cette v1.
- Bouton "Pas aujourd'hui" cliqué sur un `activityLogId` déjà supprimé (double-clic, notification en doublon) : suppression idempotente (`deleteMany` plutôt que `delete`, ne lève pas si absent).
- Poids utilisateur inconnu au moment de créer une routine par `legs` : même erreur que le `log_activity` MET existant ce matin — demander le poids d'abord.

## Tests

- `tests/activity.test.ts` : `recomputeEventBonusForDate` (somme correcte sur plusieurs lignes, y compris une ligne à 0 après seuil de matérialité).
- `tests/activityRoutine.test.ts` (nouveau) : calcul d'estimation initiale par legs (MET + rabais pondéré), par kcal direct, `apply_activity_routine` proactif (pas de `reportedKcal`) vs réel (met à jour `observedAvgKcal`/`sampleCount`), mise à jour en place d'une ligne `planned` existante.
- `tests/notificationTick.test.ts` : nouvelle règle déclenche bien la création d'`ActivityLog` + notification avec boutons pour une routine due aujourd'hui, ne se redéclenche pas si déjà appliquée.
- `tests/webhook.test.ts` : callbacks `routine:confirm:`/`routine:cancel:`.
- `tests/onboarding.test.ts` : `DEFINE_ACTIVITY_ROUTINE_TOOL` disponible pendant l'onboarding.

## Hors scope (v1)

- **Le suivi intra-journée et le push proactif pré-activité** ("mange une banane avant ton crossfit à 17h") — second projet séparé, qui consommera `timeRangeStart`/`timeRangeEnd` des routines et le statut `planned` des activités ponctuelles posés ici, mais dont la logique de calcul de rythme d'apport dans la journée reste entièrement à concevoir.
- Recalcul de `blendedDiscountPct` si le mix d'étapes d'une routine change dans le temps.
- Plusieurs activités ponctuelles `planned` le même jour avec le même sport (cf. cas limites).
- Fusion ou lien formel entre `ActivityRoutine` et le système `Scenario` existant — restent deux mécanismes séparés pour l'instant.
