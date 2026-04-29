# Gateway — Deployment Runbook

Production target: `gateway.outreachdeal.com` → `103.180.163.41` (Ubuntu 22.04).

Architecture: 3 containers behind Caddy (auto-TLS).
- `gateway-api` — Node, internal :4000
- `gateway-web` — nginx static, internal :80
- `gateway-caddy` — public :80 + :443

DB: external Neon Postgres.

---

## One-time setup

### 1. DNS

Create an `A` record at your DNS host:

```
gateway.outreachdeal.com   A   103.180.163.41   TTL 300
```

Wait for it to resolve before continuing:

```bash
dig +short gateway.outreachdeal.com
```

### 2. SSH deploy key (run locally)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gateway_deploy -N "" -C "gateway-ci"
cat ~/.ssh/gateway_deploy.pub
```

Copy the public key onto the VM:

```bash
ssh root@103.180.163.41
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
echo "<paste public key here>" >> /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

Allow `deploy` to use Docker:

```bash
usermod -aG docker deploy
```

Test from your laptop:

```bash
ssh -i ~/.ssh/gateway_deploy deploy@103.180.163.41 'docker ps'
```

Capture the host key:

```bash
ssh-keyscan -t ed25519 103.180.163.41
```

### 3. VM directories & secrets

On the VM as `root`:

```bash
mkdir -p /opt/gateway /etc/gateway
chown deploy:deploy /opt/gateway
chmod 750 /etc/gateway
```

Drop the production `.env` at `/etc/gateway/gateway.env` — start from `server/.env.example` and replace with real values:

```bash
nano /etc/gateway/gateway.env
chmod 600 /etc/gateway/gateway.env
```

**Required values:**

| Var | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (with `?sslmode=require`) |
| `ADMIN_EMAIL` | Admin login |
| `ADMIN_PASSWORD` | Strong, 20+ chars |
| `GATEWAY_SECRET` | **≥32 chars random** — encrypts stored OAuth tokens. Never rotate without migrating. |
| `RESEND_API_KEY` | from resend.com |
| `ALERT_FROM_EMAIL` | verified sender on Resend |
| `ALERT_TO_EMAIL` | who gets alerts |
| `OPENAI_REDIRECT_URI` | `https://gateway.outreachdeal.com/auth/callback` |
| `GEMINI_CLIENT_ID` | leave default unless using your own GCP OAuth client |
| `GEMINI_CLIENT_SECRET` | only required if you set up your own client |
| `PORT` | `4000` |

Generate `GATEWAY_SECRET`:

```bash
openssl rand -hex 32
```

### 4. GHCR pull credentials on VM

The container images live in `ghcr.io/relicwavetechnologies/gateway-{api,web}` (private). The VM needs to authenticate to pull them.

Create a **classic PAT** (`anish877` account) with **`read:packages`** scope only: https://github.com/settings/tokens/new?scopes=read:packages

On the VM, as the `deploy` user:

```bash
sudo -iu deploy
echo '<your-PAT>' | docker login ghcr.io -u anish877 --password-stdin
```

This writes credentials to `~deploy/.docker/config.json` so `docker compose pull` works.

> **Alternative:** make the GHCR packages public after the first push. Then no PAT is needed on the VM. To do that, after the first deploy: GitHub → repo → Packages → each package → Settings → Change visibility → Public.

### 5. GitHub secrets

In `https://github.com/relicwavetechnologies/gateway/settings/secrets/actions`, add:

| Secret | Value |
|---|---|
| `SSH_HOST` | `103.180.163.41` |
| `SSH_USER` | `deploy` |
| `SSH_PRIVATE_KEY` | contents of `~/.ssh/gateway_deploy` (the **private** key, all of it including header/footer) |

(The workflow uses `GITHUB_TOKEN` for GHCR push — no extra secret needed.)

---

## First deploy

1. Commit and push these files to `main`:
   - `Dockerfile`
   - `.dockerignore`
   - `deploy/docker-compose.yml`
   - `deploy/Caddyfile`
   - `deploy/nginx.web.conf`
   - `.github/workflows/ci.yml`
   - `.github/workflows/deploy.yml`

2. The Deploy workflow runs automatically. Watch it at:
   `https://github.com/relicwavetechnologies/gateway/actions`

3. First run takes ~5–8 minutes (no build cache). Caddy will request a Let's Encrypt cert on first start (~10s after the container is up).

4. Verify:

   ```bash
   curl -I https://gateway.outreachdeal.com/health
   curl -fsS https://gateway.outreachdeal.com/health   # should print {"ok":true,...}
   ```

   And the SPA:

   ```bash
   curl -I https://gateway.outreachdeal.com/
   ```

---

## Operations

```bash
# SSH in
ssh deploy@103.180.163.41
cd /opt/gateway

# Status
docker compose ps

# Logs
docker compose logs -f api
docker compose logs -f caddy
docker compose logs --tail=200 web

# Restart a service
docker compose restart api

# Pull latest manually (e.g. force update without a push)
docker compose pull && docker compose up -d

# Roll back to a specific git SHA (12 chars)
IMAGE_TAG=<sha> docker compose up -d

# Edit env (then restart api)
sudo nano /etc/gateway/gateway.env
docker compose restart api
```

## Updating Caddy / compose config

The deploy workflow `scp`s `deploy/docker-compose.yml` and `deploy/Caddyfile` to `/opt/gateway/` on every deploy, then runs `docker compose up -d`. Just commit changes to those files and push to `main`.

## TLS troubleshooting

If Let's Encrypt fails on first start:

```bash
docker compose logs caddy | grep -i 'acme\|error'
```

Common causes:
- DNS hasn't propagated yet — wait, then `docker compose restart caddy`
- Port 80 blocked upstream — check `sudo ss -tulpn | grep ':80 '`
- Rate limit (5 failures/hour from LE) — wait an hour

## Post-deploy: OAuth provider whitelisting

After your first successful deploy, update redirect URIs in each OAuth provider:

- **OpenAI** (Auth dashboard) → add `https://gateway.outreachdeal.com/auth/callback`
- **Gemini** (Google Cloud Console → your OAuth 2.0 Client) → add the URI you set in `GEMINI_REDIRECT_URI`. ⚠️ Note: the public Gemini CLI client ID won't accept arbitrary redirect URIs — you'll likely need to create your own Web OAuth client in Google Cloud and update `GEMINI_CLIENT_ID`/`GEMINI_CLIENT_SECRET`.
- **Claude** (Anthropic) → uses `https://console.anthropic.com/oauth/code/callback` (Anthropic-hosted page, no whitelisting needed on your side)

## Stopping the stack

```bash
cd /opt/gateway && docker compose down
```

Volumes (`caddy_data`, `caddy_config`) persist — TLS cert survives. To wipe everything:

```bash
docker compose down -v
```
