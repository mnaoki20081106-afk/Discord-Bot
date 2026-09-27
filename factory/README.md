# Discord Bot Factory

This directory contains the deployment factory used by `.github/workflows/bot-factory.yml`.

## What it does

The workflow accepts a bot repository, branch, working directory, runtime, and provider. `provider=auto` behaves as follows:

- Wrangler/Worker project -> Cloudflare Workers
- Persistent Node/Docker project -> Oracle Cloud Always Free shared host

The Oracle provider creates the networking and one shared Always Free VM automatically if they do not exist. Subsequent Node bots are deployed as isolated Docker containers on that host with `--restart unless-stopped`.

Cloudflare uses Wrangler's automatic resource provisioning. Draft D1/KV/R2/Queue bindings in `wrangler.jsonc` can therefore be provisioned during deployment. When Wrangler writes generated IDs back into the config, the Factory commits only Wrangler config changes back to the source branch.

## One-time Factory secrets

Configure these in the repository hosting the Factory workflow:

### GitHub

- `FACTORY_GITHUB_PAT`: fine-grained token with Contents read/write for bot repositories. Required for private source repositories and for persisting Wrangler-generated bindings across repositories.

### Cloudflare

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Use the least-privilege Cloudflare API token that can deploy Workers and provision only the Cloudflare resources your bot manifests require.

### Oracle Cloud

- `OCI_TENANCY_OCID`
- `OCI_USER_OCID`
- `OCI_FINGERPRINT`
- `OCI_API_PRIVATE_KEY`
- `OCI_REGION`
- `OCI_COMPARTMENT_OCID`
- `BOT_FACTORY_SSH_PRIVATE_KEY`: an SSH private key used only for Factory -> shared host deployment. The workflow derives its public key automatically.

The OCI user/policy must be allowed to manage compute instances, virtual networks, subnets, route tables, security lists, internet gateways, VNICs, and images in the target compartment.

## Per-bot secret bundle

Store each bot's runtime secrets as one Actions secret containing a JSON object. Example secret name: `BOT_BUNDLE_DISCORD_SECURITY`.

Example value (do not commit this):

```json
{
  "DISCORD_BOT_TOKEN": "...",
  "DISCORD_APPLICATION_ID": "...",
  "MAIN_BOT_APPLICATION_ID": "...",
  "SECURITY_BRIDGE_SECRET": "..."
}
```

Pass the secret name, not its value, as `secret_bundle_name` when running Bot Factory.

For Cloudflare, the bundle is uploaded with `wrangler secret bulk`. For Oracle, it becomes the Docker container's protected env file on the host.

## Typical runs

### Existing Discord-Bot Worker

- repository: `mnaoki20081106-afk/Discord-Bot`
- working directory: `apps/worker`
- runtime: `auto`
- provider: `auto`

This resolves to Cloudflare.

### Existing Discord-Security Worker

- repository: `mnaoki20081106-afk/Discord-Security`
- working directory: `.`
- runtime: `auto`
- provider: `auto`

This resolves to Cloudflare.

### New persistent Discord Gateway bot

A repository with a `Dockerfile` or Node `package.json` and no Wrangler config resolves to Oracle. If no Dockerfile exists, the Factory creates an ephemeral Node 22 Dockerfile during deployment; it is not committed to the source repository.

## Safety / limits

- The workflow requires `confirm=DEPLOY`.
- Deployments for the same bot name are serialized with GitHub Actions concurrency.
- Oracle infrastructure is reused rather than creating one VM per bot.
- Oracle Always Free capacity is not guaranteed, and idle Always Free instances can be reclaimed by Oracle.
- Cloudflare free limits are account-wide. The Factory does not create extra Cron triggers on its own.
