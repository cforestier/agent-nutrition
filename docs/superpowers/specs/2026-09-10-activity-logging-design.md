# Log d'activité et rééquilibrage calorique — design

Date : 2026-09-10
Statut : validé, prêt pour le plan d'implémentation

## Contexte

Idée de départ : connecter Strava/Garmin pour récupérer automatiquement les calories dépensées par activité. Recherche faite en cours de conversation :

- **Garmin Connect API** : selon la FAQ officielle du programme développeur Garmin, l'accès est *"only for business use"* — aucun tier personnel, impasse pour un projet perso.
- **Strava API v3** : accessible en self-service, webhooks disponibles, mais **nécessite un abonnement Strava payant actif** pour créer une app développeur (documenté officiellement). L'utilisateur n'a pas d'abonnement payant.

**Décision** : abandon de toute intégration API externe. À la place, un flux conversationnel manuel dans le chat Telegram existant — l'utilisateur rapporte lui-même l'activité et les calories affichées par sa montre/tracker.

## Objectif

Permettre à l'utilisateur de dire au bot qu'il a fait une activité physique, avec les calories mesurées par son tracker, et de rééquilibrer la cible calorique du jour **seulement quand c'est justifié** (activité non déjà comptée dans le système), sans jamais fausser le calcul du TDEE observé qui pilote les ajustements à long terme.

## Pourquoi ce n'est pas du double comptage

Le TDEE observé (`observedTdee = avgKcal_mangé − variation_poids × 7700 / 14`, spec §5) capture déjà, sur 14 jours glissants, toute l'activité réelle de l'utilisateur via l'effet sur son poids — pas besoin de connaître les calories d'une séance individuelle. Ajouter une estimation d'activité à la cible du jour ET laisser cette même activité influencer le poids (donc le TDEE observé deux semaines plus tard) reviendrait à compter deux fois la même dépense.

La parade : n'ajouter un bonus/malus que sur la **portion réellement nouvelle** (l'écart entre ce qui était déjà prévu/typique pour ce jour et ce qui a été réellement fait), et exclure ce jour-là du calcul de moyenne glissante qui alimente le TDEE observé — mécanisme qui **existe déjà** dans le code (`DayPlan.isAtypical` → `DailyState.isExcluded` → exclu de `fourteenDayAverageKcal()` dans `lib/calc/rolling.ts`, vérifié dans `lib/dailyRecompute.ts:91,99,193`). On ne fait qu'alimenter ce mécanisme avec une donnée précise au lieu de le laisser inutilisé.

## Flux utilisateur

1. L'utilisateur dit au bot qu'il a fait une activité, avec les calories affichées par sa montre (ex: "j'ai fait du vélo, 350 kcal d'après ma montre").
2. Si l'utilisateur ne précise pas si cette activité **remplace** ce qui était prévu pour la journée (ex: une petite course à pied prévue) ou si elle est **en plus**, l'agent le demande explicitement avant d'enregistrer — jamais de supposition.
3. Le bot calcule l'écart, applique le rabais de sécurité, décide s'il ajuste la cible, et répond immédiatement avec le résultat (pas besoin d'attendre le calcul nocturne).

## Calcul

1. **Référence "typique" du jour** : `getWeeklyDefault(weekday)` (déjà existant, `lib/weeklyScheduleStore.ts`) donne `avgKcal` pour ce jour de semaine. C'est la dépense déjà "normale"/attendue pour ce jour-là.
2. **Écart brut** :
   - Si `relationToPlan = 'replaces'` : `écart = calories_rapportées − avgKcal_typique`
   - Si `relationToPlan = 'additional'` : `écart = calories_rapportées` (rien n'était prévu pour cette activité précise, donc pas de soustraction)
3. **Rabais de sécurité par sport, appliqué sur l'écart brut** (dans les deux sens, positif ou négatif — le rabais rapproche toujours l'ajustement de zéro, ce qui est la version prudente dans les deux cas) :

   | Type de sport | Rabais |
   |---|---|
   | Vélo (cycling) | 20% |
   | Course à pied (running) | 25% |
   | Musculation / CrossFit (strength) | 30% |
   | Autre (other) | 35% |

   `écart_ajusté = écart_brut × (1 − rabais)`
4. **Seuil de matérialité** : si `|écart_ajusté| < 100 kcal` → aucun changement de cible, l'activité est juste enregistrée pour référence (utile pour le timing glucides du §8). Si `|écart_ajusté| ≥ 100 kcal` → `bonusKcal = écart_ajusté`, appliqué à la cible du jour.

## Données

**Nouveau modèle `ActivityLog`** (trace de chaque activité rapportée, un enregistrement par activité — pas de contrainte d'unicité sur la date, plusieurs activités possibles le même jour) :

```prisma
model ActivityLog {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  date             String
  description      String
  sportType        String
  reportedCalories Float
  relationToPlan   String
  baselineKcal     Float
  rawDiffKcal      Float
  discountPct      Float
  bonusKcal        Float
  createdAt        DateTime @default(now())
}
```

**`DayPlan`** : ajout d'un champ optionnel `eventBonusKcal Float?`. Quand `bonusKcal ≠ 0`, l'outil fait un upsert du `DayPlan` de cette date avec `isAtypical: true` et `eventBonusKcal: bonusKcal` — réutilisation directe du mécanisme d'exclusion existant, sans le modifier.

## Nouvel outil conversationnel `log_activity`

Même pattern que `log_weight`/`log_meal` (`lib/activity.ts`, nouveau fichier) :

```ts
export const LOG_ACTIVITY_TOOL: ToolDefinition = {
  name: 'log_activity',
  description:
    "Enregistre une activité physique rapportée par l'utilisateur avec les calories affichées par sa montre/tracker. " +
    "Si l'utilisateur ne précise pas si cette activité REMPLACE l'activité initialement prévue pour la journée ou si elle est EN PLUS, " +
    "demande-le lui explicitement avant d'appeler cet outil — ne suppose jamais.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      description: { type: 'string' },
      sportType: { type: 'string', enum: ['cycling', 'running', 'strength', 'other'] },
      reportedCalories: { type: 'number' },
      relationToPlan: { type: 'string', enum: ['replaces', 'additional'] },
    },
    required: ['date', 'description', 'sportType', 'reportedCalories', 'relationToPlan'],
  },
};
```

Le handler calcule le bonus (logique ci-dessus), écrit `ActivityLog`, upsert `DayPlan` si `bonusKcal ≠ 0`, et répond avec un message qui indique la nouvelle cible du jour (`profile.currentTargetKcal + bonusKcal`) — feedback immédiat, sans attendre le cron nocturne.

Câblé dans `api/telegram/webhook.ts` : ajouté à `GENERAL_CHAT_TOOLS` / `handleGeneralChatTool`, comme les autres outils du chat général.

## Intégration avec `lib/dailyRecompute.ts`

Changement minimal et localisé : après le bloc existant de calcul de l'ajustement hebdomadaire (qui doit rester **intact**, il continue de fonctionner avec la cible de référence `profile.currentTargetKcal`, sans jamais voir le bonus d'un jour ponctuel), on ajoute le bonus du jour à la valeur qui sera persistée dans `DailyState.targetKcal` :

```ts
// après le bloc `if (targetKcal !== null && profile.kcalFloor !== null && ...) { ... }`, avant la construction de todayMacros/isExcluded
const eventBonusKcal = eventBonusByDate.get(date) ?? 0;
if (targetKcal !== null && eventBonusKcal !== 0) {
  targetKcal = targetKcal + eventBonusKcal;
}
```

`eventBonusByDate` est construit comme `isAtypicalByDate` l'est déjà (ligne 91), à partir des `dayPlans` déjà chargés dans le même `Promise.all`. Aucune nouvelle requête DB nécessaire.

**Pourquoi c'est sûr** : `computeAdjustment` (le calcul de l'ajustement hebdomadaire de fond) reçoit toujours `profile.currentTargetKcal` tel quel, jamais bonusé — le bonus n'existe que dans l'enregistrement `DailyState` de ce jour précis, pour l'historique et l'affichage. La logique d'exclusion de la moyenne glissante (déjà testée, ligne 91/99/193) n'est pas touchée.

## Erreurs et cas limites

- Aucun `WeeklyDefault` pour ce jour de semaine → `baselineKcal = 0`. Pour `relationToPlan = 'replaces'`, l'écart devient simplement les calories rapportées en entier (comportement raisonnable : rien n'était prévu, donc tout est "nouveau").
- `sportType` non reconnu par le modèle : impossible côté schéma (`enum` sur l'outil), donc pas de cas à gérer côté handler au-delà du mapping direct.
- Plusieurs activités le même jour : chaque appel de l'outil recalcule et **remplace** `DayPlan.eventBonusKcal` avec le bonus de la dernière activité loggée (pas de cumul dans cette v1) — limite connue, acceptable pour démarrer ; cumuler plusieurs bonus le même jour est une amélioration future si le besoin se présente.

## Tests

- `tests/activity.test.ts` : calcul de l'écart (`replaces` vs `additional`), application du rabais par sport, seuil de matérialité (juste en dessous / juste au-dessus de 100 kcal après rabais), signe négatif (activité moindre que prévu → cible réduite), écriture `ActivityLog` + upsert `DayPlan`.
- `tests/dailyRecompute.test.ts` : nouveau cas vérifiant qu'un `DayPlan.eventBonusKcal` s'ajoute bien à `DailyState.targetKcal` du jour concerné, et que `computeAdjustment`/`Profile.currentTargetKcal` restent inchangés par ce bonus.
- `tests/webhook.test.ts` : mise à jour de la liste `GENERAL_CHAT_TOOLS` attendue pour inclure `LOG_ACTIVITY_TOOL`.

## Hors scope (v1)

- Toute intégration API externe (Strava, Garmin) — abandonnée pour cette itération.
- Cumul de plusieurs bonus le même jour (cf. cas limites ci-dessus).
- Référencer les activités loggées dans le bilan hebdomadaire (`ruleWeeklyMacroInsight`) pour expliquer un TDEE observé inhabituel — bonne idée mentionnée en discussion, mais amélioration future séparée, pas dans cette spec.
