# Discord Server Manager

Discordサーバーの **セキュリティ / 認証 / Ticket / チャンネル構築 / PayPay自販機** を
Webダッシュボードからまとめて管理するモノレポです。

- Dashboard: React + Vite → **GitHub Pages**
- Backend: **Cloudflare Workers Free**
- Database: **Cloudflare D1 Free**
- Discord: REST API + HTTP Interactions + AutoMod
- Payments: PayPay / Kyash vending adapters (payment-link flow)
- Authentication: Discord OAuth2
- Cost target: **月額0円（無料枠内）**

## Features

### Security

主要な防御は独立リポジトリ **mnaoki20081106-afk/Discord-Security** の別Discord Bot / 別Workerへ分離しています。
管理画面は本リポジトリのWeb Dashboardだけを使用し、認証済みMain WorkerがHMAC署名付き内部APIでSecurity Workerを操作します。

- Main Bot
  - Discord AutoModによるAnti-Spam / Invite / Mentionの予備防御
  - 認証 / Ticket / 自販機 / サーバー管理
  - バックアップ / 復元
- Security Bot
  - Discord GatewayによるリアルタイムAnti-Nuke / Anti-Raid
  - Cross-action Risk
  - Scam / Phishing / Dangerous Attachment
  - Bot / Webhook / Role / Permission / AutoMod Guard
  - 危険権限剥奪 / Timeout / 悪性Bot除去
  - Emergency Lockdown + Lockdown状態の独立D1保存
- Main Botは恒久的にSecurity BotのWhitelistへ入れません。
  正常な管理操作とバックアップ復元時だけ、短時間の署名付きMaintenance Leaseを発行します。
- 推奨ロール順は **人間の管理者 > Main Bot > Security Bot > 他社製Bot > 一般ロール** です。
  上位の人間管理者はBotによる自動Kick/BAN/Timeout/危険ロール剥奪の対象外とし、異常操作は記録・通知します。高信頼度な大量削除などでは本人を処罰せずLockdownで被害拡大を止めます。
- Security Bot未接続環境では、従来のCron + Audit Log Anti-Nukeがフォールバックとして残ります。このフォールバックもMain Botより上位の人間管理者へ自動ロール剥奪を行いません。

### Verification

- Discord上の「認証する」ボタン
- Discord OAuth2による1回認証
- Discordアカウント作成日チェック
- 認証済みRole自動付与
- 認証完了と同時に `guilds.join` を使うサーバー復旧用メンバー登録も保存
- 認証パネルとバックアップ用メンバー登録を1つの導線に統合

### Ticket

- WebまたはSlash CommandからTicket Panelを設置
- ユーザーごとのPrivate Channel
- Support Role対応
- Close Button

### Live Server Editor

Web管理画面にDiscord風のサーバープレビューを表示し、実際の構成を見ながら編集できます。

- サーバー名横の「＋」からチャンネル追加
- カテゴリ名横の「＋」から、そのカテゴリ内へ直接追加
- テキスト / ボイスチャンネル作成
- カテゴリ作成
- チャンネル名・トピック・所属カテゴリ変更
- カテゴリ名変更
- チャンネル / カテゴリ削除
- 変更後にDiscordの実状態を再取得してプレビュー同期
- Announcement / Stage / Forum / Mediaチャンネルもプレビュー表示

### Server Builder

Webからテンプレートを1クリックで適用できます。

- Community
- Shop
- Support

既存チャンネルを消さず、不足しているRole / Category / Channelだけを追加します。

### Vending machine

The supplied multi-function vending implementation has been ported to the
Cloudflare Worker/D1 architecture. It supports PayPay/Kyash, multiple vending
machines, finite/infinite stock, coupons, logs, role grants, stock alerts,
panel updates and Web management.

See [docs/VENDING.md](./docs/VENDING.md) for the full feature map and design.

## Architecture

```text
GitHub Pages
  React Dashboard
        |
        v
Main Cloudflare Worker ----------------------+
  OAuth / Interactions / Vending / Backup    |
        |                                    | HMAC signed bridge
        v                                    v
     Main D1                         Discord-Security Worker
                                            |
                                            +-- Durable Object Gateway
                                            +-- Security D1
                                            +-- Discord REST containment
```

Main Botの通常機能とSecurity Botの防御実行系は別Worker・別Discord Token・別D1です。
Main側が停止しても、既に接続済みのSecurity Gatewayは独立して防御を継続できます。
管理画面だけは1つに統合したままです。

Main側のSpam・招待リンク・大量メンション保護にはDiscord AutoModも残し、
Security Botが未設定の環境では従来のCron Anti-Nukeをフォールバックとして使用します。

Cloudflare Workers Free/D1 Freeの利用上限を超えた場合はその日の処理が制限される
可能性がありますが、時間経過だけで30日後にDBが失効する構成ではありません。

## 1. Discord Application

Discord Developer PortalでApplication/Botを作成します。

Cloudflare版はGatewayへ常時接続しないので、
Server Members Intent / Message Content Intentを必須にはしていません。

初回Cloudflare deploy後、Workerの `workers.dev` URLを使って設定します。

Interactions Endpoint URL:

```text
https://YOUR-WORKER.workers.dev/interactions
```

OAuth2 Redirect URL:

```text
https://YOUR-WORKER.workers.dev/auth/discord/callback
```

BOTの招待URLは管理画面が生成します。
Administrator権限は要求せず、現在の機能に必要な権限のみ要求します。

## 2. Secrets

秘密情報はGitHub Pagesやリポジトリへ置かず、Cloudflare Worker Secretsへ保存します。

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
DISCORD_CLIENT_SECRET
SESSION_ENCRYPTION_KEY
SECURITY_BRIDGE_SECRET
```

Security Bot連携時は、Main Workerの通常Environment Variableとして次も設定します。

```text
SECURITY_API_BASE_URL=https://discord-security.<account>.workers.dev
```

`SECURITY_BRIDGE_SECRET` はMain WorkerとDiscord-Security Workerへ**同じ32文字以上のランダム値**をSecretとして保存します。ブラウザやGitHub Pagesには渡しません。

PayPay / Kyashのアカウント接続は、デプロイ後にWeb管理画面からOTP認証します。
決済アカウント情報をGitHub Secretsへ直接書く必要はありません。

## 3. Zero-cost Cloudflare deployment

推奨バックエンドは `apps/worker` です。

Cloudflare Workers & PagesでGitHubリポジトリをImportし、
Root directoryを `apps/worker` に設定します。

Wrangler設定ではD1 bindingをIDなしで宣言しているため、対応するWranglerでは
初回deploy時にD1を自動プロビジョニングできます。

Worker Secrets:

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
DISCORD_CLIENT_SECRET
SESSION_ENCRYPTION_KEY
SECURITY_BRIDGE_SECRET
```

Security Botを接続する場合は `SECURITY_API_BASE_URL` もMain WorkerのEnvironment Variableへ設定してください。

`SESSION_ENCRYPTION_KEY` は **32文字以上の推測されにくいランダム文字列** をそのまま設定できます。内部でSHA-256からAES-256-GCM用の鍵を生成します。旧32-byte Base64形式も互換対応しています。

Cloudflare Workerの公開URLが例えば

```text
https://discord-server-manager.<account>.workers.dev
```

なら、Discord Developer PortalのInteractions Endpoint URLを

```text
https://discord-server-manager.<account>.workers.dev/interactions
```

OAuth2 Redirect URLを

```text
https://discord-server-manager.<account>.workers.dev/auth/discord/callback
```

に設定します。

## 4. GitHub Pages

Repository Settings → Pages でSourceを **GitHub Actions** にします。

Repository Variable:

```text
VITE_API_BASE_URL=https://discord-server-manager.<account>.workers.dev
```

Dashboard:

```text
https://mnaoki20081106-afk.github.io/Discord-Bot/
```

## Slash Commands

- `/dashboard`
- `/security-status`
Web管理画面から認証/Ticket/販売パネルを設置できます。

Global commandはWorker APIから登録でき、現在は
`/dashboard` と `/security-status` を用意しています。

## Security design

- Discord OAuth Access/Refresh TokenはDBへAES-256-GCMで暗号化して保存
- BrowserへDiscord Access Tokenを直接保存しない
- Dashboardにはランダムなopaque session tokenだけを渡す
- Session tokenはDBではSHA-256 hashとして保存
- OAuth stateをワンタイム検証
- APIはDiscordのowner / Administrator / Manage Guild権限を毎回確認
- CORSをDashboard originへ限定
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
