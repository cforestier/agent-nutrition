# Web dashboard — design

Date : 2026-09-10
Statut : validé, prêt pour le plan d'implémentation

## Contexte

Le projet `agent-nutrition` est aujourd'hui uniquement piloté par un bot Telegram : aucune UI web, aucune route API de lecture, aucune authentification web. L'utilisateur (mono-utilisateur, identifié par `TELEGRAM_CHAT_ID`) veut une page web pour :

1. Ouvrir facilement le chat Telegram du bot.
2. Visualiser les données déjà enregistrées, en v1 : l'historique de poids (modèle Prisma `Weight` : `date`, `weightKg`, `source`).

## Portée (v1)

- Une seule page : courbe de poids dans le temps + bouton vers le chat Telegram.
- Pas d'autres graphiques (composition corporelle, calories/macros, TDEE) pour cette itération — pourra faire l'objet d'un futur spec séparé.
- Pas de gestion multi-utilisateur : un seul mot de passe protège toute la page.

## Approche retenue

Page HTML/JS statique servie par une fonction Vercel (pas de framework front — cohérent avec le reste du repo qui n'a aujourd'hui aucune dépendance frontend), plus deux routes API dédiées. Alternative écartée : une mini-app Next.js (plus standard mais disproportionnée pour "un graphique + un lien", introduirait tout un pipeline de build dans un repo qui n'en a pas).

## Architecture / routes

Trois nouvelles routes Vercel, dans le même style que `api/cron/*` et `api/telegram/*` :

- `GET /api/dashboard` — sert la page HTML (graphique SVG + bouton Telegram + formulaire de mot de passe si besoin), avec le JS inline nécessaire.
- `POST /api/dashboard/login` — vérifie le mot de passe soumis, pose un cookie de session si correct.
- `GET /api/dashboard/weights` — renvoie l'historique de poids en JSON ; protégée par le cookie de session.

## Authentification

Un mot de passe unique en variable d'environnement `DASHBOARD_PASSWORD` :
- Ajouté à `.env.example` (placeholder vide), au `.env` local, et comme variable d'environnement Vercel en production — même traitement que `ANTHROPIC_API_KEY` et `CRON_SECRET`.

Pas de base de session : le cookie de session contient un HMAC-SHA256 du mot de passe courant (calculé côté serveur au login), vérifiable à chaque requête sans état stocké côté serveur — donc aucune nouvelle collection Mongo.

- `lib/dashboardAuth.ts` expose :
  - `DASHBOARD_SESSION_COOKIE` (nom du cookie)
  - `signSession(password: string): string` — calcule le token HMAC
  - `isValidSessionToken(token: string | undefined, password: string): boolean` — comparaison timing-safe
  - `buildSessionCookieHeader(password: string): string` — construit la valeur complète du header `Set-Cookie` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=2592000` (30 jours), `Path=/`)

`api/dashboard/weights.ts` lit le cookie de la requête, extrait le token, appelle `isValidSessionToken` ; si invalide → `401`.

## Flux utilisateur

1. La page `/api/dashboard` charge, le JS inline tente `GET /api/dashboard/weights`.
2. Si `401` → affiche un formulaire mot de passe (aucune donnée affichée).
3. Soumission du formulaire → `POST /api/dashboard/login` avec `{ password }` ; en cas de succès, le serveur répond `200` avec le header `Set-Cookie` ; le JS relance alors `GET /api/dashboard/weights`.
4. Les données arrivent (`[{ date, weightKg }, ...]` triées par date croissante) → tracé SVG fait main (polyline, axes simples, pas de dépendance externe).
5. Bouton "Ouvrir le chat" → lien direct `<a href="https://t.me/Nutrition_malet_bot">` (username récupéré une fois via l'API Telegram `getMe`, hardcodé comme constante — c'est une donnée publique, pas un secret).

## Données

Nouvelle fonction dans `lib/weight.ts` (aujourd'hui écriture seule) :

```ts
export async function getAllWeights(): Promise<WeightEntry[]>
```

Lecture de tous les enregistrements `Weight`, triés par `date` croissante. Aucun changement de schéma Prisma.

## Gestion des erreurs

- Mot de passe incorrect → `401` + message d'erreur inline sur la page. Pas de verrouillage après N tentatives (usage strictement personnel, pas nécessaire pour cette v1).
- Aucune donnée de poids enregistrée → message "Aucune donnée pour l'instant" affiché à la place du graphique vide.
- Cookie absent/invalide sur `/api/dashboard/weights` → `401` (déclenche le formulaire côté client, cf. flux ci-dessus).

## Tests

TDD, comme le reste du projet :
- `tests/dashboardAuth.test.ts` — signature/vérification du token (roundtrip valide, détection d'un token altéré, mot de passe différent rejeté).
- `tests/api-dashboard-login.test.ts` — `api/dashboard/login.ts` : mauvais mot de passe → `401` ; bon mot de passe → `200` + header `Set-Cookie` présent et correctement formé.
- `tests/api-dashboard-weights.test.ts` — `api/dashboard/weights.ts` : pas de cookie / cookie invalide → `401` ; cookie valide → `200` + JSON (avec `getAllWeights` mocké).
- `tests/weight.test.ts` — nouveau test pour `getAllWeights` (tri croissant, tableau vide si aucune donnée), suivant le pattern existant (base réelle, comme le reste du fichier).
- La page HTML/JS elle-même : vérification manuelle dans le navigateur une fois déployée (pas de framework de test frontend introduit pour une seule page).

## Hors scope (v1)

- Autres graphiques (composition corporelle, calories, TDEE).
- Multi-utilisateur / plusieurs comptes.
- Rate-limiting / verrouillage après tentatives de mot de passe échouées.
- Librairie de graphiques externe (SVG fait main suffit pour une seule courbe).
