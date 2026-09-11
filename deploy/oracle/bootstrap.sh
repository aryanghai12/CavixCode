#!/usr/bin/env bash
#
# bootstrap.sh — turn a bare Oracle Cloud VM into the whole running Cavix.
#
# Run it on the instance, from inside a checkout of this repo:
#
#   cd /opt/cavix/deploy/oracle && ./bootstrap.sh
#
# It installs Docker, opens the two ports Oracle's images block by default,
# generates every secret, writes .env, builds the four services, and waits until
# the certificate is actually issued before telling you it worked.
#
# Safe to run again. Secrets already in .env are never regenerated — that is the
# whole point, because CAVIX_SECRET_KEY is the key to every stored API key and a
# fresh one reads, from the dashboard, as the data having vanished.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
SECRETS_DIR="$HERE/secrets"

# ── output ──────────────────────────────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
step()  { printf '\n%s▸ %s%s\n' "$BOLD$BLUE" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%s✗ %s%s\n\n' "$RED$BOLD" "$*" "$RESET" >&2; exit 1; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

[[ $EUID -eq 0 ]] && die "Run this as the normal login user (opc or ubuntu), not root. It calls sudo where it needs to."
sudo -n true 2>/dev/null || sudo true || die "This user cannot sudo, and installing Docker needs it."

printf '%s\n' "$BOLD"
cat <<'BANNER'
   ┌─────────────────────────────────────────────┐
   │  Cavix → Oracle Cloud                       │
   │  one box, no sleeping, no expiring database │
   └─────────────────────────────────────────────┘
BANNER
printf '%s' "$RESET"

# ── 0. what kind of machine is this ─────────────────────────────────────────
step "Checking the machine"

. /etc/os-release 2>/dev/null || die "Cannot read /etc/os-release. This script targets Ubuntu or Oracle Linux."
ARCH="$(uname -m)"
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
CPUS="$(nproc)"
ok "$PRETTY_NAME on $ARCH — $CPUS vCPU, ${MEM_MB}MB RAM"

case "$ID" in
  ubuntu|debian) FAMILY=debian ;;
  ol|oracle|rhel|centos|fedora|almalinux|rocky) FAMILY=rhel ;;
  *) die "Unsupported distro '$ID'. Use the Canonical Ubuntu 24.04 image when you create the instance." ;;
esac

if (( MEM_MB < 1800 )); then
  warn "Under 2GB of RAM. This is the AMD micro shape, not the Ampere one."
  note "It will run, but the build is slow and reviews will be tight. The free Ampere"
  note "shape gives you 24GB — see README.md, 'Out of host capacity', for how to get one."
fi

# ── 1. Docker ───────────────────────────────────────────────────────────────
step "Installing Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "already installed ($(docker --version | cut -d, -f1))"
else
  if [[ $FAMILY == debian ]]; then
    sudo install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
      sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      sudo chmod a+r /etc/apt/keyrings/docker.asc
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    sudo dnf install -y -q dnf-utils
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
    sudo dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  sudo systemctl enable --now docker
  ok "installed"
fi

# Group membership only applies to new logins, so this shell still needs sudo.
# Adding it now means the NEXT ssh session can run docker without.
if [[ " $(id -nG "$USER") " != *" docker "* ]]; then
  sudo usermod -aG docker "$USER"
  warn "added $USER to the docker group — log out and back in for it to apply"
fi
DC() { sudo docker compose "$@"; }

# ── 2. the firewall nobody expects ──────────────────────────────────────────
step "Opening ports 80 and 443 on the instance"

# This is the step that costs people an afternoon. Oracle's Linux images ship
# with a host firewall that DROPs everything except SSH, in ADDITION to the
# security list on the VCN. Both have to allow the port. Fixing the cloud
# console side and stopping there leaves you with a site that times out and no
# error message anywhere to explain it.

if [[ $FAMILY == debian ]]; then
  RULES=/etc/iptables/rules.v4
  for PORT in 80 443; do
    if sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
      ok "port $PORT already open"
      continue
    fi
    sudo iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
    ok "port $PORT opened"
  done

  # Persist by editing the saved rule file directly rather than running
  # `netfilter-persistent save`. Save would capture Docker's live chains too,
  # and replaying those at boot, before Docker has started and created the
  # interfaces they reference, is its own class of problem. Inserting two lines
  # ahead of the catch-all REJECT is the narrow, boring change.
  if [[ -f $RULES ]]; then
    for PORT in 80 443; do
      RULE="-A INPUT -p tcp -m state --state NEW -m tcp --dport $PORT -j ACCEPT"
      grep -qF -- "--dport $PORT -j ACCEPT" "$RULES" && continue
      if grep -q '^-A INPUT -j REJECT' "$RULES"; then
        sudo sed -i "0,/^-A INPUT -j REJECT/s||$RULE\n&|" "$RULES"
      else
        sudo sed -i "/^COMMIT/i $RULE" "$RULES"
      fi
    done
    ok "rules persisted to $RULES (they survive a reboot)"
  else
    sudo mkdir -p /etc/iptables
    sudo sh -c "iptables-save > $RULES"
    warn "no existing $RULES — wrote a fresh one"
  fi
else
  sudo firewall-cmd --permanent --add-service=http  >/dev/null
  sudo firewall-cmd --permanent --add-service=https >/dev/null
  sudo firewall-cmd --reload >/dev/null
  ok "firewalld: http and https allowed"
fi

warn "The VCN security list is a SEPARATE firewall, in the Oracle console."
note "If you used provision-oci.sh it is already done. If you clicked the instance"
note "together by hand, open it now — README.md step 4 — or the certificate check"
note "at the end of this script will fail and tell you the same thing."

# ── 3. swap ─────────────────────────────────────────────────────────────────
step "Swap"

if [[ -n "$(swapon --show 2>/dev/null)" ]]; then
  ok "already configured"
elif (( MEM_MB > 8000 )); then
  ok "skipped — ${MEM_MB}MB of RAM does not need it"
else
  # The npm install for this workspace, and the Go build, are both happy to use
  # more memory than a 1GB shape has. Swap turns "the build was killed with no
  # message" into "the build was slow".
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap -q /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "2GB swapfile added"
fi

# ── 4. what is this site called ─────────────────────────────────────────────
step "Working out the public address"

PUBLIC_IP="${CAVIX_PUBLIC_IP:-}"
if [[ -z $PUBLIC_IP ]]; then
  # The metadata service is authoritative and local; the others are for the case
  # where the instance sits behind something that rewrites it.
  PUBLIC_IP="$(curl -fsS -m 5 http://169.254.169.254/opc/v2/vnics/ -H 'Authorization: Bearer Oracle' 2>/dev/null \
    | grep -o '"publicIp"[^,]*' | head -1 | cut -d'"' -f4 || true)"
fi
[[ -z $PUBLIC_IP ]] && PUBLIC_IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
[[ -z $PUBLIC_IP ]] && die "Could not determine this instance's public IP. Pass it: CAVIX_PUBLIC_IP=1.2.3.4 ./bootstrap.sh"
ok "public IP: $PUBLIC_IP"

# ── 5. .env ─────────────────────────────────────────────────────────────────
step "Configuration"

gen() { openssl rand -hex 32; }

# Read a value already in .env, so a re-run keeps everything it generated.
kept() { [[ -f $ENV_FILE ]] && sed -n "s|^$1=||p" "$ENV_FILE" | head -1 || true; }

ask() { # ask VAR "prompt" "default"
  local var=$1 prompt=$2 default=${3:-} current
  current="$(kept "$var")"
  [[ -n $current ]] && { printf -v "$var" '%s' "$current"; return; }
  if [[ ! -t 0 ]]; then printf -v "$var" '%s' "$default"; return; fi
  local reply
  if [[ -n $default ]]; then
    read -r -p "    $prompt [$default]: " reply || true
    printf -v "$var" '%s' "${reply:-$default}"
  else
    read -r -p "    $prompt: " reply || true
    printf -v "$var" '%s' "$reply"
  fi
}

if [[ -f $ENV_FILE ]]; then
  ok "keeping the existing .env (secrets in it are never regenerated)"
else
  echo "    A few answers. Blank is fine for any of them — you can fill them in"
  echo "    later by editing $ENV_FILE and running: sudo docker compose up -d"
  echo
fi

DASHED="${PUBLIC_IP//./-}"
ask CAVIX_DOMAIN        "Public hostname" "${DASHED}.sslip.io"
ask CAVIX_ADMIN_EMAILS  "Your admin identity (prefer @your-github-login)" ""
ask CAVIX_GITHUB_CLIENT_ID     "GitHub App Client ID (Iv23...)" ""
ask CAVIX_GITHUB_CLIENT_SECRET "GitHub App client secret" ""
ask CAVIX_GITHUB_APP_SLUG      "GitHub App slug (github.com/apps/THIS)" ""
ask CAVIX_APP_ID               "GitHub App numeric App ID" ""

CAVIX_SESSION_SECRET="$(kept CAVIX_SESSION_SECRET)"; : "${CAVIX_SESSION_SECRET:=$(gen)}"
CAVIX_SECRET_KEY="$(kept CAVIX_SECRET_KEY)";         : "${CAVIX_SECRET_KEY:=$(gen)}"
CAVIX_INTERNAL_TOKEN="$(kept CAVIX_INTERNAL_TOKEN)"; : "${CAVIX_INTERNAL_TOKEN:=$(gen)}"
CAVIX_WEBHOOK_SECRET="$(kept CAVIX_WEBHOOK_SECRET)"; : "${CAVIX_WEBHOOK_SECRET:=$(gen)}"
# Hex, not base64: a password containing @ or / has to be percent-encoded inside
# the connection URL, and the day somebody forgets is the day Postgres reports a
# host that does not exist.
POSTGRES_PASSWORD="$(kept POSTGRES_PASSWORD)"; : "${POSTGRES_PASSWORD:=$(openssl rand -hex 24)}"
REDIS_PASSWORD="$(kept REDIS_PASSWORD)";       : "${REDIS_PASSWORD:=$(openssl rand -hex 24)}"

umask 077
cat > "$ENV_FILE" <<ENVEOF
# Written by bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Edit freely, then:
#   sudo docker compose up -d
#
# KEEP A COPY OF CAVIX_SECRET_KEY SOMEWHERE THAT IS NOT THIS MACHINE.
# It is the key to every stored BYOK key and OAuth token. Lose it and those blobs
# stop decrypting, and the store reports an undecryptable blob as "no credential"
# rather than as an error — so the failure looks exactly like the data vanishing.

CAVIX_DOMAIN=$CAVIX_DOMAIN

CAVIX_SESSION_SECRET=$CAVIX_SESSION_SECRET
CAVIX_SECRET_KEY=$CAVIX_SECRET_KEY
CAVIX_INTERNAL_TOKEN=$CAVIX_INTERNAL_TOKEN
CAVIX_WEBHOOK_SECRET=$CAVIX_WEBHOOK_SECRET
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD

CAVIX_ADMIN_EMAILS=$CAVIX_ADMIN_EMAILS

CAVIX_GITHUB_CLIENT_ID=$CAVIX_GITHUB_CLIENT_ID
CAVIX_GITHUB_CLIENT_SECRET=$CAVIX_GITHUB_CLIENT_SECRET
CAVIX_GITHUB_APP_SLUG=$CAVIX_GITHUB_APP_SLUG
CAVIX_APP_ID=$CAVIX_APP_ID

CAVIX_BOT_HANDLE=cavixcode,cavix
CAVIX_LLM_PROVIDER=anthropic
CAVIX_LLM_MODEL=claude-opus-5
CAVIX_SANDBOX_BACKEND=local
CAVIX_NARROW_REREVIEWS=false

CAVIX_GITLAB_WEBHOOK_SECRET=
CAVIX_BITBUCKET_WEBHOOK_SECRET=
CAVIX_AZURE_WEBHOOK_SECRET=
CAVIX_GITLAB_URL=
CAVIX_BITBUCKET_SERVER_URL=
CAVIX_AZURE_URL=
ENVEOF
chmod 600 "$ENV_FILE"
umask 022
ok "wrote $ENV_FILE (mode 600)"

mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
if [[ -f "$SECRETS_DIR/github-app.pem" ]]; then
  ok "GitHub App private key present"
else
  warn "No GitHub App private key at $SECRETS_DIR/github-app.pem"
  note "Without it the site and webhooks work, but the orchestrator cannot post a"
  note "review — an App install never hands you a token, so it has to sign a JWT."
  note "From your laptop:  scp your-app.private-key.pem $USER@$PUBLIC_IP:$SECRETS_DIR/github-app.pem"
  note "Then:              sudo docker compose restart orchestrator"
fi

# ── 6. does the name point here yet ─────────────────────────────────────────
step "Checking DNS before asking for a certificate"

RESOLVED="$(getent hosts "$CAVIX_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [[ -z $RESOLVED ]]; then
  warn "$CAVIX_DOMAIN does not resolve yet"
  note "Caddy will keep retrying, with a backoff that gets slow. Fix the DNS first if you can."
elif [[ $RESOLVED != "$PUBLIC_IP" ]]; then
  warn "$CAVIX_DOMAIN resolves to $RESOLVED, but this machine is $PUBLIC_IP"
  note "Certificate validation is a request to that name on port 80. It will land on"
  note "the wrong machine and fail. Point the A record here before continuing."
else
  ok "$CAVIX_DOMAIN → $PUBLIC_IP"
fi

# ── 7. build and start ──────────────────────────────────────────────────────
step "Building and starting (first run pulls images and compiles — give it a few minutes)"

cd "$HERE"
DC pull --quiet postgres redis caddy 2>/dev/null || true
DC up -d --build
ok "containers up"

# ── 8. prove it ─────────────────────────────────────────────────────────────
step "Waiting for the services to report healthy"

# `docker inspect` rather than `docker compose ps --format`, because compose's
# --format takes "table TEMPLATE" and not a bare Go template — a bare one is
# accepted and prints nothing, so the wait below would have looked like every
# service hanging forever. inspect has taken real templates since always.
health_of() {
  local cid
  cid="$(DC ps -q "$1" 2>/dev/null | head -1)"
  [[ -z $cid ]] && { echo "missing"; return; }
  sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown"
}

FAILED=0
for svc in postgres redis cavix edge orchestrator; do
  printf '    %-14s' "$svc"
  state=""
  for _ in $(seq 1 60); do
    state="$(health_of "$svc")"
    case "$state" in
      healthy|running) break ;;
      unhealthy|exited|dead|missing) break ;;
      *) sleep 5 ;;
    esac
  done
  case "$state" in
    healthy|running) printf '%s✓%s %s\n' "$GREEN" "$RESET" "$state" ;;
    *) printf '%s✗%s %s\n' "$RED" "$RESET" "${state:-no status}"; FAILED=1 ;;
  esac
done

if (( FAILED )); then
  warn "Something did not come up. Its own log will say why:"
  note "  sudo docker compose logs --tail=50 cavix"
  note "  sudo docker compose logs --tail=50 orchestrator"
fi

step "Waiting for the TLS certificate"

# This is the only check in this script that proves the OUTSIDE world can reach
# the box. Let's Encrypt validates by making a request to CAVIX_DOMAIN on port
# 80 from the internet, so a certificate in hand means DNS is right, the VCN
# security list is right, and the instance firewall is right — all three, at
# once. Nothing else here can tell you that.
CERT_OK=0
for _ in $(seq 1 36); do
  # Captured into a variable rather than piped into grep on purpose. `set -o
  # pipefail` is on, and `grep -q` exits the moment it matches, which hands the
  # upstream `docker compose logs` a SIGPIPE — so the pipeline reports failure
  # exactly when the thing it was looking for was found.
  CADDY_LOG="$(DC logs caddy 2>/dev/null || true)"
  if [[ $CADDY_LOG == *"certificate obtained successfully"* ]]; then CERT_OK=1; break; fi
  if curl -fsS -o /dev/null -m 5 "https://$CAVIX_DOMAIN/healthz" 2>/dev/null; then CERT_OK=1; break; fi
  sleep 5
done

if (( CERT_OK )); then
  ok "certificate issued — https://$CAVIX_DOMAIN is live"
else
  warn "No certificate after three minutes."
  note "Almost always the VCN security list. In the Oracle console:"
  note "  Networking → Virtual Cloud Networks → your VCN → Subnets → your subnet"
  note "  → Security Lists → Default → Add Ingress Rules"
  note "  Source 0.0.0.0/0, IP Protocol TCP, Destination Port Range 80,443"
  note "Then watch it retry:  sudo docker compose logs -f caddy"
fi

# ── 9. backups, because this database is yours now ──────────────────────────
step "Nightly backup"

# Render's managed Postgres backed itself up. This one does not, and a single
# box with no backup is a single box with a countdown on it.
if sudo test -f /etc/cron.d/cavix-backup; then
  ok "already scheduled"
else
  sudo tee /etc/cron.d/cavix-backup >/dev/null <<CRONEOF
# Nightly pg_dump of the Cavix database, kept 14 days. Written by bootstrap.sh.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
17 3 * * * root $HERE/backup.sh >> /var/log/cavix-backup.log 2>&1
CRONEOF
  sudo chmod 0644 /etc/cron.d/cavix-backup
  ok "03:17 daily → $HERE/backups, 14 days kept"
fi

# ── 10. what is left for a human ────────────────────────────────────────────
cat <<FINISH

$BOLD$GREEN━━━ running ━━━$RESET

  Site           ${BOLD}https://$CAVIX_DOMAIN$RESET
  Webhook URL    https://$CAVIX_DOMAIN/webhook
  Callback URL   https://$CAVIX_DOMAIN/api/auth/github/callback
  Setup URL      https://$CAVIX_DOMAIN/app

  Webhook secret ${BOLD}$CAVIX_WEBHOOK_SECRET$RESET
                 $DIM(paste into the GitHub App's webhook secret field)$RESET

$BOLD Three things only you can do:$RESET

  1. In the GitHub App settings, set the four URLs above and the webhook secret.
     Subscribe to BOTH "Pull request" AND "Issue comment" — issue_comment is what
     delivers "@cavixcode review", and without it commands never arrive at all.

  2. Copy the App's .pem to this box, if you have not:
       scp app.private-key.pem $USER@$PUBLIC_IP:$SECRETS_DIR/github-app.pem
       sudo docker compose restart orchestrator

  3. Reserve the public IP, or you will do all of this again. An ephemeral IP is
     released when the instance stops. Console → Instance → Attached VNICs → the
     VNIC → IPv4 Addresses → edit the public IP → Reserved. README.md step 8.

$BOLD Day to day:$RESET

  sudo docker compose ps                 what is running
  sudo docker compose logs -f cavix      the site's log
  sudo docker compose up -d --build      deploy a change after git pull
  ./backup.sh                            back up right now

FINISH
