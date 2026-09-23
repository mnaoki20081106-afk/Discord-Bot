# Discord Server Manager

Discordサーバーの **セキュリティ / 認証 / Ticket / チャンネル構築 / PayPay自販機** を
Webダッシュボードからまとめて管理するモノレポです。

- Dashboard: React + Vite → **GitHub Pages**
- Bot/API: Node.js + TypeScript + discord.js + Fastify
- Database: PostgreSQL
- Payments: PayPay Open Payment API (Dynamic QR)
- Authentication: Discord OAuth2
- Deployment: DashboardはGitHub Actions、Bot/APIはDocker対応

## Features

### Security

- Anti-Spam
- Discord招待リンクのブロック
- 大量メンション保護
- Join burstベースのAnti-Raid
- Audit LogベースのAnti-Nuke
  - 大量チャンネル削除
  - 大量ロール削除
  - 大量BAN
  - 危険なロール権限昇格
- Trusted User / Trusted Role
- Security Log
- 危険操作実行者から編集可能な危険権限ロールを解除
- 誤検知時の被害を抑えるため、検知だけで即BANはしません

### Verification

- Discord上の「認証する」ボタン
- 使い捨て確認コード
- Modal入力
- Discordアカウント作成日チェック
- 認証済みRole自動付与

### Ticket

- WebまたはSlash CommandからTicket Panelを設置
- ユーザーごとのPrivate Channel
- Support Role対応
- Close Button

### Server Builder

Webからテンプレートを1クリックで適用できます。

- Community
- Shop
- Support

既存チャンネルを消さず、不足しているRole / Category / Channelだけを追加します。

### PayPay Vending

- Webから商品作成
- Discordへ商品パネル設置
- PayPay Dynamic QR発行
- merchantPaymentIdごとの支払い状態確認
- COMPLETEDを確認した後だけ納品
- Discord Role自動付与
- または購入者へDMテキスト自動納品

PayPay部分は公式Open Payment APIを利用します。実運用にはPayPay加盟店/API Credentialが必要です。
まずSandboxで動作確認してください。

## Architecture

```text
GitHub Pages
  React Dashboard
        |
        | HTTPS / Discord OAuth session
        v
Persistent Node.js server
  Fastify API + discord.js Bot
        |
        +---- Discord API / Gateway
        |
        +---- PayPay Open Payment API
        |
        v
    PostgreSQL
```

GitHub Pagesは静的ホスティングなので、Bot Token / Discord Client Secret /
PayPay API Secretは絶対にPages側へ置きません。

## 1. Discord Application

Discord Developer PortalでApplication/Botを作成します。

Botで次のPrivileged Gateway Intentsを有効にしてください。

- Server Members Intent
- Message Content Intent

OAuth2 Redirect URL:

```text
https://YOUR-BACKEND.example.com/auth/discord/callback
```

このURLは `API_PUBLIC_URL` と一致させます。

BOTの招待URLは管理画面から生成します。
Administrator権限は要求せず、現在実装している機能に必要な権限だけを指定しています。

## 2. Environment

```bash
cp .env.example .env
```

最低限:

```env
PORT=8787
API_PUBLIC_URL=https://YOUR-BACKEND.example.com
WEB_ORIGIN=https://mnaoki20081106-afk.github.io
DATABASE_URL=postgres://...

DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_TOKEN=...

SESSION_ENCRYPTION_KEY=...
```

32-byteのSession Encryption Keyを作る例:

```bash
openssl rand -base64 32
```

PayPayを使う場合:

```env
PAYPAY_ENV=sandbox
PAYPAY_API_KEY=...
PAYPAY_API_SECRET=...
PAYPAY_MERCHANT_ID=
```

`PAYPAY_MERCHANT_ID` は必要な契約/構成の場合のみ設定します。

## 3. Local development

Node.js 20+ とPostgreSQLが必要です。

```bash
npm install
docker compose up -d postgres
npm run dev:server
```

別ターミナル:

```bash
npm run dev:web
```

Local dashboard:

```text
http://localhost:5173
```

Local API:

```text
http://localhost:8787
```

## 4. Backend deployment

Bot/APIはDiscord Gatewayへ常時接続するため、常駐できるNode.jsホストが必要です。

Dockerイメージ用の `apps/server/Dockerfile` と
PostgreSQL込みの `docker-compose.yml` を用意しています。

本番環境では必ずHTTPSを使い、`.env` をGitHubへcommitしないでください。

## 5. GitHub Pages

このrepositoryには `.github/workflows/pages.yml` が入っています。

Repository Settings → Pages でGitHub Actionsを利用できる状態にし、
Repository Variablesに次を追加します。

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.example.com
```

Pages URL:

```text
https://mnaoki20081106-afk.github.io/Discord-Bot/
```

Backend側の `WEB_ORIGIN` は **originだけ** を指定します。

```env
WEB_ORIGIN=https://mnaoki20081106-afk.github.io
```

## Slash Commands

- `/dashboard`
- `/security-status`
- `/verify-panel`
- `/ticket-panel`

Webだけでも主要設定を行えます。

## Security design

- Discord OAuth Access/Refresh TokenはDBへAES-256-GCMで暗号化して保存
- BrowserへDiscord Access Tokenを直接保存しない
- Dashboardにはランダムなopaque session tokenだけを渡す
- Session tokenはDBではSHA-256 hashとして保存
- OAuth stateをワンタイム検証
- APIはDiscordのowner / Administrator / Manage Guild権限を毎回確認
- CORSをDashboard originへ限定
- API Rate Limit
- Bot Token / Client Secret / PayPay SecretはBackendのみ
- 管理BOT自体はAdministratorを要求しない

## Open-source

設計上参考にしたOSSとライセンスは [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) を参照してください。

特に以下のMITプロジェクトの設計を参考にしています。

- qwertyvan/Discord-Bot
- nawaf1t/discord-security-bot
- SapphDevelopment/discord-captcha-bot

Private/closed-sourceなDiscord Botから抜き取ったコードは含みません。

## License

MIT
