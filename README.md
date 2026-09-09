# agent-nutrition

Personal, single-user nutrition/training tracker driven by a Telegram bot.
Full functional spec: `docs/spec-agent-nutrition-v4.md`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — MongoDB Atlas connection string (Prisma-compatible, `mongodb+srv://...`)
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_CHAT_ID` — your own Telegram numeric chat id (only this id gets responses)
3. `npm test` — runs unit tests, including a live check that Prisma can reach MongoDB.

## Deploying the webhook (step 1)

1. `vercel link` (creates/links the Vercel project) then `vercel env add` for each variable above, or set them in the Vercel dashboard → Settings → Environment Variables.
2. `vercel deploy --prod`
3. Register the webhook with Telegram (replace values):
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/telegram/webhook"
   ```
4. Send any text message to the bot from your own Telegram account — you should get `echo: <your message>` back. Messages from any other chat id are silently ignored.

## Daily recompute cron (step 8)

`/api/cron/daily-recompute` recomputes yesterday's TDEE estimates and adjusts `currentTargetKcal`. It's triggered by `.github/workflows/daily-recompute.yml`, which needs two repo secrets set manually (GitHub → Settings → Secrets and variables → Actions):

- `RECOMPUTE_URL` — `https://<your-vercel-domain>/api/cron/daily-recompute`
- `CRON_SECRET` — same value as the `CRON_SECRET` env var set in Vercel

Until `ANTHROPIC_API_KEY` is available and the project is deployed, this route exists but isn't reachable in production yet.

## Notification tick (step 9)

`/api/cron/tick` runs every 15 minutes via `.github/workflows/tick.yml` and sends anti-spammed, conditional Telegram nudges (day-plan prompt, weekly weigh-in, weekly review, no-meal-24h reminder, diet-break proposal). It needs one more repo secret alongside `CRON_SECRET` (already set for step 8):

- `TICK_URL` — `https://<your-vercel-domain>/api/cron/tick`

Note: GitHub Actions scheduled workflows can run late under load — the spec already accounts for this ("fenêtre large, cron en retard").
