#!/usr/bin/env bash
#
# provision-oci.sh — create the Oracle Cloud side: network, firewall rules, and
# the free Ampere instance Cavix runs on.
#
# RUN THIS IN THE ORACLE CLOUD SHELL, not on your laptop. Cloud Shell is the
# terminal icon (>_) in the top right of the OCI console. The `oci` CLI there is
# already signed in as you, which is the entire reason this script can exist —
# authenticating the CLI anywhere else is about fifteen console steps involving
# API keys and fingerprints, and doing them wrong is the usual place people stop.
#
#   1. Open the console, click >_ , wait for the prompt
#   2. git clone <your repo> && cd CavixCode/deploy/oracle
#   3. ./provision-oci.sh
#
# Safe to run again: it adopts anything it already created rather than making a
# second copy.

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
step() { printf '\n%s▸ %s%s\n' "$BOLD$BLUE" "$*" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
die()  { printf '\n%s✗ %s%s\n\n' "$RED$BOLD" "$*" "$RESET" >&2; exit 1; }

NAME="${CAVIX_NAME:-cavix}"
VCN_CIDR="10.0.0.0/16"
SUBNET_CIDR="10.0.1.0/24"
OCPUS="${CAVIX_OCPUS:-4}"
MEM_GB="${CAVIX_MEMORY_GB:-24}"
# 50GB, not the 100 the free 200GB allowance would also permit. Docker images,
# build layers and a fortnight of backups come to well under 20GB, and leaving
# headroom in the allowance means a second instance is still possible later.
BOOT_GB="${CAVIX_BOOT_GB:-50}"
SSH_KEY="${CAVIX_SSH_KEY:-$HOME/.ssh/cavix_oci}"
CAPACITY_RETRIES="${CAVIX_CAPACITY_RETRIES:-40}"

command -v oci >/dev/null || die "No 'oci' command. This script is meant for the OCI Cloud Shell, where it is already installed and signed in."

q() { oci "$@" --query "$QUERY" --raw-output 2>/dev/null || true; }

# ── the compartment ─────────────────────────────────────────────────────────
step "Account"

# Cloud Shell exports OCI_TENANCY. When it does not, every availability domain
# is returned with its compartment-id set to the tenancy OCID, which is the one
# lookup that works from a completely cold start.
C="${CAVIX_COMPARTMENT:-${OCI_TENANCY:-}}"
if [[ -z $C ]]; then
  C="$(oci iam availability-domain list --query 'data[0]."compartment-id"' --raw-output 2>/dev/null || true)"
fi
[[ -z $C ]] && die "Could not work out your compartment. Pass one: CAVIX_COMPARTMENT=ocid1.compartment... ./provision-oci.sh"
ok "compartment ${C:0:28}…"

mapfile -t ADS < <(oci iam availability-domain list -c "$C" --query 'data[].name' --raw-output | tr -d '[]," ' | grep -v '^$')
(( ${#ADS[@]} )) || die "No availability domains visible. Is the CLI signed in?"
ok "${#ADS[@]} availability domain(s): ${ADS[*]}"

# ── ssh key ─────────────────────────────────────────────────────────────────
step "SSH key"

if [[ -f "$SSH_KEY" ]]; then
  ok "using existing $SSH_KEY"
else
  ssh-keygen -t ed25519 -N '' -f "$SSH_KEY" -C "cavix-oci" >/dev/null
  ok "generated $SSH_KEY"
  warn "This key is the only way into the instance. Cloud Shell's home directory"
  note "persists, but download a copy anyway: the console's Cloud Shell menu has"
  note "a Download option, or run:  cat $SSH_KEY"
fi
PUBKEY="$(cat "$SSH_KEY.pub")"

# ── network ─────────────────────────────────────────────────────────────────
step "Network"

find_by_name() { # find_by_name <list-cmd...> — echoes the id of a resource named $NAME-*
  local want=$1; shift
  oci "$@" -c "$C" --query "data[?\"display-name\"=='$want' && \"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output 2>/dev/null || true
}

VCN_ID="$(find_by_name "$NAME-vcn" network vcn list)"
if [[ -n $VCN_ID && $VCN_ID != null ]]; then
  ok "VCN exists"
else
  VCN_ID="$(oci network vcn create -c "$C" --cidr-block "$VCN_CIDR" --display-name "$NAME-vcn" \
    --dns-label "${NAME//-/}" --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  ok "VCN created"
fi

IG_ID="$(find_by_name "$NAME-ig" network internet-gateway list --vcn-id "$VCN_ID")"
if [[ -n $IG_ID && $IG_ID != null ]]; then
  ok "internet gateway exists"
else
  IG_ID="$(oci network internet-gateway create -c "$C" --vcn-id "$VCN_ID" --is-enabled true \
    --display-name "$NAME-ig" --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  ok "internet gateway created"
fi

# The default route table of the VCN, pointed at the gateway. Without this the
# instance has a public IP and still cannot reach the internet, which presents
# as apt hanging forever with no error.
RT_ID="$(oci network vcn get --vcn-id "$VCN_ID" --query 'data."default-route-table-id"' --raw-output)"
oci network route-table update --rt-id "$RT_ID" --force \
  --route-rules '[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","networkEntityId":"'"$IG_ID"'"}]' \
  >/dev/null
ok "default route → internet gateway"

# ── the firewall people forget ──────────────────────────────────────────────
step "Security list"

# This is the cloud-side firewall. There is a SECOND one on the instance itself
# — Oracle's Linux images ship iptables rules that drop everything but SSH — and
# bootstrap.sh handles that half. Both have to allow a port. Opening one and
# stopping there gives you a site that times out with nothing in any log.
SL_ID="$(oci network vcn get --vcn-id "$VCN_ID" --query 'data."default-security-list-id"' --raw-output)"
oci network security-list update --security-list-id "$SL_ID" --force \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
  --ingress-security-rules '[
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}},"description":"ssh"},
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}},"description":"http (also Lets Encrypt validation)"},
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}},"description":"https"},
    {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4},"description":"path mtu discovery"}
  ]' >/dev/null
ok "22, 80, 443 open from anywhere"
note "Postgres and Redis are deliberately absent: they are never published off the"
note "docker network, so there is no port to expose and no password on the wire."

SUBNET_ID="$(find_by_name "$NAME-subnet" network subnet list --vcn-id "$VCN_ID")"
if [[ -n $SUBNET_ID && $SUBNET_ID != null ]]; then
  ok "subnet exists"
else
  SUBNET_ID="$(oci network subnet create -c "$C" --vcn-id "$VCN_ID" --cidr-block "$SUBNET_CIDR" \
    --display-name "$NAME-subnet" --dns-label "public" --route-table-id "$RT_ID" \
    --security-list-ids "[\"$SL_ID\"]" --prohibit-public-ip-on-vnic false \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  ok "subnet created"
fi

# ── the instance ────────────────────────────────────────────────────────────
step "Instance"

EXISTING="$(oci compute instance list -c "$C" \
  --query "data[?\"display-name\"=='$NAME' && \"lifecycle-state\"=='RUNNING'].id | [0]" --raw-output 2>/dev/null || true)"

if [[ -n $EXISTING && $EXISTING != null ]]; then
  INSTANCE_ID="$EXISTING"
  ok "already running — adopting it"
else
  SHAPE="VM.Standard.A1.Flex"
  IMAGE_ID="$(oci compute image list -c "$C" \
    --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC \
    --query 'data[0].id' --raw-output)"
  [[ -z $IMAGE_ID || $IMAGE_ID == null ]] && die "No Ubuntu 24.04 image found for $SHAPE in this region."
  ok "image ${IMAGE_ID:0:28}…"

  echo
  echo "    Asking for ${OCPUS} OCPU / ${MEM_GB}GB of Ampere A1 — the whole free allowance."
  echo "    ${DIM}Ampere is popular enough that 'Out of host capacity' is normal rather than"
  echo "    exceptional. This retries every 60s; leave it running. Cloud Shell times out"
  echo "    after about 20 minutes idle, so keep the tab focused, or press a key now and"
  echo "    then.${RESET}"
  echo

  LAUNCHED=0
  for attempt in $(seq 1 "$CAPACITY_RETRIES"); do
    for AD in "${ADS[@]}"; do
      printf '    attempt %-3s %-30s ' "$attempt" "$AD"
      if OUT="$(oci compute instance launch -c "$C" \
          --availability-domain "$AD" \
          --shape "$SHAPE" \
          --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}" \
          --image-id "$IMAGE_ID" \
          --subnet-id "$SUBNET_ID" \
          --assign-public-ip true \
          --boot-volume-size-in-gbs "$BOOT_GB" \
          --display-name "$NAME" \
          --metadata "{\"ssh_authorized_keys\":\"$PUBKEY\"}" \
          --wait-for-state RUNNING \
          --query 'data.id' --raw-output 2>&1)"; then
        INSTANCE_ID="$(printf '%s' "$OUT" | tail -1 | tr -d '[:space:]')"
        printf '%s✓ launched%s\n' "$GREEN" "$RESET"
        LAUNCHED=1
        break 2
      fi
      if printf '%s' "$OUT" | grep -qi 'out of host capacity\|OutOfCapacity'; then
        printf '%sno capacity%s\n' "$YELLOW" "$RESET"
      elif printf '%s' "$OUT" | grep -qi 'LimitExceeded\|QuotaExceeded'; then
        printf '%squota%s\n' "$RED" "$RESET"
        echo
        warn "Your account's free Ampere allowance is already spent."
        note "Either terminate the instance using it, or drop to the AMD shape:"
        note "  CAVIX_SHAPE_FALLBACK=1 ./provision-oci.sh"
        note "The AMD micro shape is 1 OCPU / 1GB, which runs Cavix slowly but does run it."
        die "Nothing to retry."
      else
        printf '%serror%s\n' "$RED" "$RESET"
        printf '%s\n' "$OUT" | tail -3 | sed 's/^/        /'
      fi
    done
    sleep 60
  done

  if (( ! LAUNCHED )); then
    echo
    warn "No Ampere capacity after $CAPACITY_RETRIES rounds."
    note "This is a real shortage, not a mistake on your side. Options, best first:"
    note "  1. Leave this running overnight — capacity frees up in waves."
    note "  2. Ask for less: CAVIX_OCPUS=1 CAVIX_MEMORY_GB=6 ./provision-oci.sh"
    note "     A 1/6 slice is far easier to place and still runs everything here."
    note "  3. Try another home region — but a tenancy's home region is fixed at"
    note "     signup, so this means a second account."
    die "Stopped."
  fi
fi

IP="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0]."public-ip"' --raw-output)"
ok "instance running at $IP"

# ── the IP that does not survive a stop ─────────────────────────────────────
step "Reserving the public IP"

# An ephemeral public IP is released the moment the instance stops, and it takes
# your DNS and your GitHub App's four URLs with it. Reserving costs nothing on
# the free tier and is the difference between a reboot and an afternoon.
VNIC_ID="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0].id' --raw-output)"
PRIV_ID="$(oci network private-ip list --vnic-id "$VNIC_ID" --query 'data[0].id' --raw-output)"
PUB_ID="$(oci network public-ip list -c "$C" --scope REGION --all \
  --query "data[?\"display-name\"=='$NAME-ip'].id | [0]" --raw-output 2>/dev/null || true)"

if [[ -n $PUB_ID && $PUB_ID != null ]]; then
  ok "already reserved"
else
  EPHEMERAL="$(oci network public-ip list -c "$C" --scope AVAILABILITY_DOMAIN --all \
    --query "data[?\"private-ip-id\"=='$PRIV_ID'].id | [0]" --raw-output 2>/dev/null || true)"
  if [[ -n $EPHEMERAL && $EPHEMERAL != null ]]; then
    # An ephemeral IP cannot be converted in place; it is deleted and a reserved
    # one is attached, which changes the address. Doing it NOW, before any DNS
    # or GitHub App URL points at the old one, is why this runs here and not later.
    oci network public-ip delete --public-ip-id "$EPHEMERAL" --force --wait-for-state TERMINATED >/dev/null 2>&1 || true
    sleep 5
  fi
  if NEW_IP="$(oci network public-ip create -c "$C" --lifetime RESERVED --display-name "$NAME-ip" \
      --private-ip-id "$PRIV_ID" --wait-for-state ASSIGNED --query 'data."ip-address"' --raw-output 2>/dev/null)"; then
    IP="$NEW_IP"
    ok "reserved $IP — it now survives stopping the instance"
  else
    warn "Could not reserve automatically; the instance keeps its ephemeral IP ($IP)."
    note "Do it in the console later: Instance → Attached VNICs → the VNIC →"
    note "IPv4 Addresses → edit → No Public IP, then add a Reserved one."
  fi
fi

DASHED="${IP//./-}"

cat <<FINISH

$BOLD$GREEN━━━ the Oracle side is done ━━━$RESET

  Instance   $NAME
  IP         ${BOLD}$IP${RESET}  ${DIM}(reserved)${RESET}
  Hostname   ${BOLD}${DASHED}.sslip.io${RESET}  ${DIM}— free, no domain needed, resolves to the IP above${RESET}
  SSH        ssh -i $SSH_KEY ubuntu@$IP

$BOLD Now the app. From this same Cloud Shell:$RESET

  ssh -i $SSH_KEY ubuntu@$IP

  ${DIM}then, on the instance:${RESET}
  sudo mkdir -p /opt/cavix && sudo chown \$USER /opt/cavix
  git clone ${CAVIX_REPO_URL:-https://github.com/aryanghai12/CavixCode.git} /opt/cavix
  cd /opt/cavix/deploy/oracle && ./bootstrap.sh

  ${DIM}If the repo is private, git will ask for a username and password — use your
  GitHub username and a personal access token (github.com/settings/tokens) as the
  password. Or copy the folder up from your laptop instead:
    scp -i $SSH_KEY -r ./CavixCode ubuntu@$IP:/opt/cavix${RESET}

  Give bootstrap.sh ${BOLD}${DASHED}.sslip.io${RESET} when it asks for the hostname, unless you
  own a domain and have pointed an A record at $IP.

FINISH
