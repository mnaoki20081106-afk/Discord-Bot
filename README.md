# Discord Server Manager

Discordサーバーの **セキュリティ / 認証 / Ticket / チャンネル構築 / PayPay自販機** を
Webダッシュボードからまとめて管理するモノレポです。

- Dashboard: React + Vite → **GitHub Pages**
- Backend: **Cloudflare Workers Free**
- Database: **Cloudflare D1 Free**
- Discord: REST API + HTTP Interactions + AutoMod
- Payments: PayPay Open Payment API (Dynamic QR + Webhook)
- Authentication: Discord OAuth2
- Cost target: **月額0円（無料枠内）**

## Features

### Security

- Discord AutoModによるAnti-Spam
- Discord AutoModによる招待リンクのブロック
- Discord AutoModによる大量メンション保護
- Discord標準Raid Protectionを利用
- Cloudflare Cron + Audit LogベースのAnti-Nuke
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
        | HTTPS
        v
Cloudflare Workers
  OAuth / Discord Interactions / REST API / PayPay Webhook
        |
        +---- Discord REST API + AutoMod
        +---- PayPay Open Payment API
        |
        v
Cloudflare D1
```

常時起動サーバーはありません。Render / Koyeb / Railway / keepalive は不要です。

DiscordのMessage/Member Gatewayイベントはサーバーレスでは常時受信しません。
その代わり、Spam・招待リンク・大量メンションはDiscord AutoMod、
大量破壊はCloudflare CronによるAudit Log監視で保護します。
参加イベント依存のAnti-RaidはDiscord標準Raid Protectionを使用します。

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
```

PayPayを使う場合のみ:

```text
PAYPAY_API_KEY
PAYPAY_API_SECRET
PAYPAY_MERCHANT_ID
```

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
PAYPAY_API_KEY          # PayPay利用時のみ
PAYPAY_API_SECRET       # PayPay利用時のみ
PAYPAY_MERCHANT_ID      # 必要な場合のみ
```

`SESSION_ENCRYPTION_KEY` は32 bytesをbase64化した値にします。

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

PayPay Webhook URL:

```text
https://discord-server-manager.<account>.workers.dev/paypay/webhook
```

PayPay Webhook受信後もPayPay APIへ決済状態を再照会し、
`COMPLETED` を確認してから納品します。

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
