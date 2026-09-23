# Koyeb + Neon deployment

This is the recommended long-term deployment for Discord Server Manager.

## Architecture

- GitHub Pages: static management dashboard
- Koyeb: always-running Discord bot + Fastify API
- Neon: PostgreSQL
- GitHub: source code + automatic Koyeb deploys

No keepalive job is required.

## 1. Neon

Create a Neon PostgreSQL project and copy its pooled connection string.

Set it in Koyeb as:

```text
DATABASE_URL=postgresql://...
```

Neon can suspend idle compute automatically and wake on the next database
connection. The stored database is separate from Koyeb deployments.

## 2. Koyeb

Create a Web Service and choose GitHub deployment.

Repository:

```text
mnaoki20081106-afk/Discord-Bot
```

Use:

- Builder: Dockerfile
- Dockerfile: `apps/server/Dockerfile`
- Port: `8787`
- Health check: `/health`
- Scale: fixed at 1 instance
- Do not enable scale-to-zero

For a low-maintenance production-like hobby deployment, use at least 512 MB RAM.
If you intentionally choose a smaller instance, watch memory usage during the
first few days.

Koyeb automatically deploys new commits from the linked GitHub branch.

## 3. Environment variables

```text
PORT=8787
API_PUBLIC_URL=https://YOUR-KOYEB-APP.koyeb.app
WEB_ORIGIN=https://mnaoki20081106-afk.github.io
WEB_PUBLIC_URL=https://mnaoki20081106-afk.github.io/Discord-Bot/

DATABASE_URL=postgresql://...

DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_TOKEN=...
SESSION_ENCRYPTION_KEY=...

PAYPAY_ENV=sandbox
PAYPAY_API_KEY=
PAYPAY_API_SECRET=
PAYPAY_MERCHANT_ID=
```

Generate `SESSION_ENCRYPTION_KEY` locally:

```bash
openssl rand -base64 32
```

Do not commit any real secret into GitHub.

## 4. Discord OAuth

Discord Developer Portal OAuth2 redirect:

```text
https://YOUR-KOYEB-APP.koyeb.app/auth/discord/callback
```

Enable these privileged Gateway Intents for the bot:

- Server Members Intent
- Message Content Intent

## 5. GitHub Pages

Enable GitHub Pages with GitHub Actions for this repository.

Repository variable:

```text
VITE_API_BASE_URL=https://YOUR-KOYEB-APP.koyeb.app
```

The dashboard URL is:

```text
https://mnaoki20081106-afk.github.io/Discord-Bot/
```

## 6. PayPay

Keep `PAYPAY_ENV=sandbox` until the payment flow is verified end to end.

Production requires PayPay Open Payment API credentials.
