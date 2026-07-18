# AFCIA Backend

Single-file Express + PostgreSQL API for the AFCIA (Automobile Fault Codes Interpreter App) frontend.

## What it does

- **Auth** — signup/login with JWT, bcrypt password hashing
- **Fault code interpretation** — checks a small seeded cache of common OBD-II codes first (instant, free), falls back to Claude (Anthropic API) for anything else and caches the result for next time
- **Scanner screenshot upload** — Claude vision reads the fault codes out of an uploaded image, optionally stored in Cloudinary
- **Scanner export upload** — parses PDF/CSV/TXT exports and regex-extracts fault codes
- **VIN decoder** — real decode via NHTSA's free vPIC API (make/model/trim/engine/specs), plus local SAE model-year decoding
- **History** — every interpretation a logged-in user runs is saved and listable
- **Dashboard stats** — interpretations this month, vehicles tracked, average severity, plan usage
- **AI assistant** — the chat panel in the frontend, powered by Claude with the current fault code as context
- **Billing** — Stripe Checkout + customer portal + webhook to upgrade/downgrade plans (optional — app runs fine without Stripe configured, just stays on the Free plan)

## Quick start (local)

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY at minimum
npm start
```

The server auto-creates its schema on boot when `AUTO_MIGRATE=true` (default in `.env.example`) and seeds ~6 common fault codes when `AUTO_SEED=true`. Both are idempotent — safe to leave on permanently, no shell access needed on Render.

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string (Render Postgres works out of the box) |
| `JWT_SECRET` | Yes | Long random string |
| `ANTHROPIC_API_KEY` | Yes | Powers fault-code generation, image code extraction, and the AI assistant |
| `CORS_ORIGIN` | Yes | Your deployed frontend URL(s), comma-separated |
| `CLOUDINARY_*` | No | Screenshot uploads still work without it, just aren't persisted to a URL |
| `STRIPE_*` | No | Billing routes return `501` until these are set — Free plan still fully works |

See `.env.example` for the full list.

## Deploying on Render

1. Push this folder to a GitHub repo (or a subfolder of your existing Kerify/AFCIA repo).
2. **New → Web Service** on Render, point it at the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. **New → PostgreSQL** on Render (free tier is fine to start). Copy its **Internal Database URL** into the web service's `DATABASE_URL` env var.
4. Add the rest of the env vars from `.env.example` in the Render dashboard (Environment tab). Leave `AUTO_MIGRATE=true` and `AUTO_SEED=true`.
5. Set `CORS_ORIGIN` to wherever `AFCIA_App.html` is hosted (e.g. a Render Static Site, Netlify, or Vercel URL).
6. Deploy. On first boot you'll see `[migrate] schema is up to date` and `[seed] inserted 6 common fault codes` in the logs.
7. In `AFCIA_App.html`, set `window.AFCIA_API_BASE` (top of the `<script>` block) to your Render service URL, e.g. `https://afcia-backend.onrender.com`.

## API summary

All routes are under `/api/v1`. Full request/response shapes are documented as comments directly above each route in `server.js`.

```
POST   /api/v1/auth/signup            { name, email, password } -> { token, user }
POST   /api/v1/auth/login             { email, password } -> { token, user }
GET    /api/v1/auth/me                (auth) -> { user }
PATCH  /api/v1/auth/me                (auth) { name?, locale?, password? }

GET    /api/v1/fault-codes/:code      (optional auth) -> interpretation JSON
POST   /api/v1/fault-codes/image      (optional auth, multipart "file") -> { codes, results, imageUrl }
POST   /api/v1/fault-codes/file       (optional auth, multipart "file") -> { codes, results }

GET    /api/v1/vin/:vin               (optional auth) -> { make, year, trim, engine, specs }

GET    /api/v1/history                (auth) -> { history: [...] }
GET    /api/v1/history/:id            (auth) -> full interpretation
DELETE /api/v1/history/:id            (auth) -> 204

GET    /api/v1/dashboard/stats        (auth) -> stat card values

POST   /api/v1/assistant              (optional auth) { code?, question, history? } -> { answer }

POST   /api/v1/billing/checkout       (auth) { plan } -> { url }
GET    /api/v1/billing/portal         (auth) -> { url }
POST   /api/v1/billing/webhook        Stripe-signed, raw body
```

Anonymous (no token) requests to the interpret/VIN/assistant endpoints work but aren't rate-limited by plan or saved to history — only logged-in usage counts against the Free plan's 10/month limit and shows up in History/Dashboard.

## Known simplifications / next steps

- Fault-code cost estimates come from Claude with a US-pricing prompt — swap in real parts-pricing APIs (e.g. RockAuto/PartsTech) later for accuracy.
- Workshop Console / Analytics (marked `PRO` in the sidebar) have no backend yet — they're gated client-side only.
- No email verification or password-reset flow yet — add a transactional email provider (Resend/Postmark) when ready.
