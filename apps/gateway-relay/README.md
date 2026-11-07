# Discord Gateway 中継（VPS）

Main Bot の Discord Gateway 接続を VPS で常時動かし、イベントを Cloudflare Worker へ転送します。

## なぜ必要か

Cloudflare 無料プランの Durable Objects は、アカウント全体で **1日 13,000 GB秒** までです。
Gateway への常時接続は1本で約 10,800 GB秒/日を使うため、Main Bot と Security Bot の2本では足りず、
毎晩 23:30 頃（日本時間）に両方の Bot が止まっていました。

- Security Bot … これまで通り Cloudflare（Durable Object）で常時接続
- Main Bot …… この中継プログラムが VPS で常時接続し、入退室などのイベントを Worker に転送

中継が止まっていても、Worker が1分ごとにメンバー一覧を見比べるので、入退室通知は1〜2分遅れで届きます。
`/check` 用チャンネルの投稿も、中継が止まっている間は1分ごとの確認で削除されます。

## インストール（VPS で1回だけ）

```bash
curl -fsSL https://raw.githubusercontent.com/mnaoki20081106-afk/Discord-Bot/main/apps/gateway-relay/install.sh | sudo bash
```

途中で Main Bot のトークン（Cloudflare Worker の `DISCORD_BOT_TOKEN` と同じもの）を聞かれます。
トークンは VPS の `/etc/dsm-gateway-relay.env`（root だけが読める）に保存されます。

## よく使うコマンド

```bash
journalctl -u dsm-gateway-relay -f
```

```bash
sudo systemctl restart dsm-gateway-relay
```

トークンを変えたとき・中継を最新版にするとき（同じコマンドを再実行。トークンを変えるときは `RESET_TOKEN=1`）:

```bash
curl -fsSL https://raw.githubusercontent.com/mnaoki20081106-afk/Discord-Bot/main/apps/gateway-relay/install.sh | sudo RESET_TOKEN=1 bash
```

## しくみ

- Node.js 22 以上（組み込みの WebSocket）。依存パッケージなし
- 転送するイベント: READY / GUILD_CREATE / GUILD_DELETE / GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE
- `/check` 用チャンネル（管理画面の 仲介 → 実績 で設定）への投稿は、IDだけを Worker に送ってすぐ削除させます。
  どのチャンネルが対象かは、1分ごとの Worker への定期連絡で受け取ります。本文は読まないので Message Content Intent は不要です
- Worker の `/internal/gateway-relay` へ「時刻.本文」の HMAC-SHA256 署名付きで送信。
  鍵は BOT トークンから作るので、新しいシークレットを配る必要はありません
- 送信に失敗したイベントは順番を保って再送します
