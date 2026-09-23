# 無料運用: GitHub Pages + Cloudflare Workers + D1

この構成では24時間稼働するVM/コンテナを持ちません。

- 管理画面: GitHub Pages
- API / Discord Interactions: Cloudflare Workers Free
- DB: Cloudflare D1 Free
- 定期監視: Cloudflare Cron Triggers
- スパム対策: Discord AutoMod
- 決済通知: PayPay Webhook

Render/Koyebのkeepaliveは不要です。

## 初回セットアップ

### 1. CloudflareへGitHubリポジトリをImport

Cloudflare Dashboard:

Workers & Pages → Create application → Import a repository

Repository:

```text
mnaoki20081106-afk/Discord-Bot
```

Root directory:

```text
apps/worker
```

Deploy command:

```text
npx wrangler deploy
```

`apps/worker/wrangler.jsonc` のD1 bindingはresource IDを固定していません。
対応するWranglerでは最初のdeployでD1 resourceを自動プロビジョニングできます。

### 2. Worker Secrets

Cloudflare Worker → Settings → Variables and Secrets へ以下を登録します。

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
DISCORD_CLIENT_SECRET
SESSION_ENCRYPTION_KEY
```

PayPayを使用する場合のみ:

```text
PAYPAY_API_KEY
PAYPAY_API_SECRET
PAYPAY_MERCHANT_ID
```

`SESSION_ENCRYPTION_KEY` は32 byteのランダム値をbase64化したものです。

### 3. Discord Developer Portal

Worker URLを仮に

```text
https://discord-server-manager.example.workers.dev
```

とします。

Interactions Endpoint URL:

```text
https://discord-server-manager.example.workers.dev/interactions
```

OAuth2 Redirect URL:

```text
https://discord-server-manager.example.workers.dev/auth/discord/callback
```

Cloudflare版はGatewayへ常時接続しないため、Message Content Intentや
Server Members Intentを必須にしません。

### 4. GitHub Pages

GitHub:

Settings → Pages → Build and deployment → GitHub Actions

Repository Variable:

```text
VITE_API_BASE_URL=https://discord-server-manager.example.workers.dev
```

管理画面:

```text
https://mnaoki20081106-afk.github.io/Discord-Bot/
```

### 5. PayPay

PayPay Webhook URL:

```text
https://discord-server-manager.example.workers.dev/paypay/webhook
```

Webhookの内容をそのまま信用せず、WorkerがPayPay Get Payment Details APIへ
再照会して `COMPLETED` を確認した時だけ商品を納品します。

まず `PAYPAY_ENV=sandbox` でテストし、本番Credentialを設定した後に
`production` へ変更します。

## セキュリティ方式

### AutoMod

管理画面でSecurityを保存すると、DSM prefixのAutoMod ruleを作り直します。

- Spam
- Discord invite link
- Mention spam

これらはDiscord側で実行されるためWorkerが休止/常駐しているという概念がありません。

### Anti-Nuke

1分ごとのCloudflare CronでDiscord Audit Logを取得します。

対象:

- Channel Delete
- Member Ban
- Role Delete

設定時間内に一定回数以上の破壊操作を行ったユーザーについて、
BOTが編集可能な危険権限Roleの解除を試みます。

Server Owner / Trusted User / Trusted Roleは除外します。

### Anti-Raid

Guild Member AddはDiscord Gateway eventであり、今回のHTTP-only構成では常時受信しません。
そのためAnti-RaidだけはDiscord標準Raid Protectionを利用します。

## 無料枠について

この構成は「時間で失効する無料VM」を利用していません。

ただしCloudflare Free planにはリクエスト数・CPU・D1 read/write/storageの上限があります。
大規模サーバーで無料枠を超えた場合は制限される可能性があります。

また外部サービスの無料枠/利用規約が将来変更されないことまでは保証できません。
