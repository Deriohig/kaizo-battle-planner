#!/usr/bin/env bash
# Deploys (or updates) the planner on an Ubuntu 24.04 server over ssh: docs/deploy.md, "Hetzner Cloud".
#
#   PKP_PASSWORD='the site password' bash deploy/remote.sh root@203.0.113.7 [domain]
#
# Run it from this repo's root on the PC that has the bundle (`npm run bundle` first). Safe to run again for each update:
# every step checks before it changes anything. Nothing here runs as root on this PC. On the server (as root, or through
# sudo for another user) it:
#   1. installs Docker (Ubuntu's docker.io, buildx and compose v2), rsync and python3-maxminddb with apt when missing;
#   2. only when the server's own iptables blocks incoming traffic (some providers' images do; Hetzner's do not), opens
#      TCP 80 and 443 (and UDP 443) there and saves the rules across reboots;
#   3. copies the code (only what the image build and compose need) to ~/pkp/, and the bundle to ~/pkp/deploy/pkp-data/;
#   4. writes ~/pkp/deploy/.env: PKP_DOMAIN, and PKP_PASSWORD when it is set here (kept from the last run when not);
#   5. builds the image there (natively, for its own CPU) and starts the stack with docker compose;
#   6. keeps DB-IP's free IP to City Lite and IP to ASN Lite databases (CC BY 4.0) in ~/pkp/geo/ for deploy/usage.sh:
#      downloads them only when missing or more than 40 days old, and a failed download is a warning, not a failure;
#   then waits for health.
#
# The domain defaults to <ip with dashes>.sslip.io, a name that points at the IP with no DNS of your own; Caddy gets a
# Let's Encrypt certificate for it. The ssh key is ~/.ssh/pkp_deploy (PKP_DEPLOY_KEY to change it). The password travels
# over ssh's stdin, never on a command line. PKP_BUNDLE_DIR picks another bundle folder than dist/bundle/pkp-data.
# PKP_REMOTE_DRY_RUN=1 prints the plan and runs nothing.

set -euo pipefail

usage='Usage: PKP_PASSWORD=<password> bash deploy/remote.sh <user@host> [domain]'
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "$usage" >&2; exit 2; }
target=$1
case $target in *@*) ;; *) echo "The target must be user@host, as root@203.0.113.7. $usage" >&2; exit 2 ;; esac
host=${target#*@}
if [ $# -eq 2 ]; then
  domain=$2
elif [[ $host =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  domain="${host//./-}.sslip.io"
else
  domain=$host
fi
[[ $domain =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Not a domain name: $domain" >&2; exit 2; }

key=${PKP_DEPLOY_KEY:-$HOME/.ssh/pkp_deploy}
[[ $key =~ [[:space:]] ]] && { echo "The ssh key's path must not hold a space (rsync splits it): $key" >&2; exit 2; }
password=${PKP_PASSWORD:-}
# In .env the password is single-quoted: a quote or a newline cannot be written there, and compose reads a final
# backslash as escaping the closing quote.
case $password in *"'"*|*$'\n'*|*'\') echo "PKP_PASSWORD must not hold a single quote or a newline, or end in a backslash" >&2; exit 2 ;; esac
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bundle=${PKP_BUNDLE_DIR:-$repo/dist/bundle/pkp-data}
remote_dir='pkp'
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
version="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo dev)"
[ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ] && version="$version-dirty"

# What the image build and compose need, and nothing else: never data/, saves, ROMs, .git, an archive, or a local
# deploy/.env (or .env.anything but the example). The server's own .env, bundle and IP location files are protected
# from --delete.
rsync_code=(
  --filter='P /deploy/.env' --filter='P /deploy/pkp-data/' --filter='P /deploy/pkp-data.tar.gz' --filter='P /geo/'
  --include=/deploy/.env.example
  --exclude='/deploy/.env*' --exclude='/deploy/pkp-data*' --exclude='*.tar.gz' --exclude='*.zip'
  --exclude='*.nds' --exclude='*.dsv' --exclude='*.sav' --exclude=node_modules/
  --include=/Dockerfile --include=/.dockerignore --include=/package.json --include=/package-lock.json
  --include=/tsconfig.json --include=/tsconfig.server.json --include=/vite.config.ts
  --include='/src/***' --include='/web/***' --include='/deploy/***'
  --exclude='*'
)

echo "Deploying $version to $target as https://$domain/"
if [ "${PKP_REMOTE_DRY_RUN:-}" = 1 ]; then
  echo "key: $key"
  echo "code: rsync -az --delete ${rsync_code[*]} $repo/ $target:$remote_dir/"
  echo "bundle: rsync -az --delete $bundle/ $target:$remote_dir/deploy/pkp-data/"
  echo "env: PKP_DOMAIN=$domain; PKP_PASSWORD $([ -n "$password" ] && echo 'replaced' || echo 'kept as it is')"
  echo "geo: DB-IP IP to City Lite and IP to ASN Lite into ~/$remote_dir/geo/ when missing or over 40 days old"
  exit 0
fi

[ -f "$key" ] || { echo "No ssh key at $key (set PKP_DEPLOY_KEY)" >&2; exit 1; }
[ -f "$bundle/bundle.json" ] || { echo "No bundle at $bundle/: run npm run bundle first" >&2; exit 1; }
echo "Bundle: $(grep -o '"createdAt": *"[^"]*"' "$bundle/bundle.json" | cut -d'"' -f4), fingerprint $(grep -o '"fingerprint": *"[^"]*"' "$bundle/bundle.json" | cut -d'"' -f4 | cut -c1-12)"
remote() { ssh "${ssh_opts[@]}" "$target" "$@"; }

echo '1/6 Docker, rsync, python3-maxminddb and the firewall'
remote 'bash -s' <<'SETUP'
set -euo pipefail
# As root (Hetzner's default login) directly; as another user through sudo.
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
# A VM minutes old has its first unattended upgrade holding apt's lock: wait for it. No apt command reads this script's
# stdin (`</dev/null`), which holds the rest of the script.
install() {
  echo "installing: $*"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update -qq </dev/null
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq "$@" </dev/null >/dev/null
}
missing=()
command -v docker >/dev/null || missing+=(docker.io)
docker buildx version >/dev/null 2>&1 || missing+=(docker-buildx)
docker compose version >/dev/null 2>&1 || missing+=(docker-compose-v2)
command -v rsync >/dev/null || missing+=(rsync)
# For deploy/usage.sh, which looks the visitors' /24s up in DB-IP's databases (step 6/6).
python3 -c 'import maxminddb' >/dev/null 2>&1 </dev/null || missing+=(python3-maxminddb)
if [ ${#missing[@]} -gt 0 ]; then install "${missing[@]}"; fi
as_root systemctl enable --now docker >/dev/null

# The server's own firewall: left alone unless its INPUT chain rejects or drops (some providers' Ubuntu images end it
# with a REJECT rule; Hetzner's accept everything, and its Cloud Firewall, if any, is set in its console).
if as_root iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT DROP|-j (REJECT|DROP)'; then
  changed=0
  for rule in 'tcp 80' 'tcp 443' 'udp 443'; do
    set -- $rule
    if ! as_root iptables -C INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT 2>/dev/null; then
      # Before the first REJECT or DROP rule, else at the end (a DROP policy).
      at=$(as_root iptables -L INPUT --line-numbers -n | awk '($2 == "REJECT" || $2 == "DROP") && !n { n = $1 } END { if (n) print n }')
      if [ -n "$at" ]; then as_root iptables -I INPUT "$at" -p "$1" --dport "$2" -m state --state NEW -j ACCEPT
      else as_root iptables -A INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT; fi
      echo "opened $1 $2 in the server's iptables"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then
    command -v netfilter-persistent >/dev/null || install iptables-persistent
    as_root netfilter-persistent save >/dev/null
  fi
fi
mkdir -p ~/pkp/deploy/pkp-data
SETUP

echo '2/6 The code'
rsync -az --delete -e "ssh ${ssh_opts[*]}" "${rsync_code[@]}" "$repo/" "$target:$remote_dir/"

echo '3/6 The bundle'
# Readable by the container's `node` user whatever modes the files have on this PC.
rsync -az --delete --chmod=D755,F644 -e "ssh ${ssh_opts[*]}" "$bundle/" "$target:$remote_dir/deploy/pkp-data/"

echo '4/6 deploy/.env'
# The script, password included, goes over ssh's stdin. The password is single-quoted in .env, so compose takes it as
# written; an empty PKP_PASSWORD here keeps the one already there. Any other line of the server's .env (a setting added
# there by hand, as PKP_SESSION_IDLE_MIN) is kept.
remote 'bash -s' <<ENV
set -euo pipefail
umask 077
env_file=~/$remote_dir/deploy/.env
new_password=$(printf '%q' "$password")
if [ -n "\$new_password" ]; then
  password_line="PKP_PASSWORD='\$new_password'"
else
  password_line=\$(grep '^PKP_PASSWORD=' "\$env_file" 2>/dev/null | head -1 || true)
fi
case \$password_line in
  ''|PKP_PASSWORD=|"PKP_PASSWORD=''") echo 'No password set yet: run again with PKP_PASSWORD=<password>' >&2; exit 1 ;;
esac
others=\$(grep -vE '^(PKP_DOMAIN|PKP_PASSWORD|PKP_VERSION)=' "\$env_file" 2>/dev/null || true)
printf 'PKP_DOMAIN=%s\n%s\nPKP_VERSION=%s\n' $(printf '%q' "$domain") "\$password_line" $(printf '%q' "$version") > "\$env_file.new"
if [ -n "\$others" ]; then printf '%s\n' "\$others" >> "\$env_file.new"; fi
mv "\$env_file.new" "\$env_file"
ENV

echo '5/6 Build and start (the first build takes a few minutes)'
# The planner is restarted only when the bundle changed and `up` kept its container (a code change recreates it). Caddy
# is recreated when the Caddyfile changed: rsync replaces the file, and a single-file bind mount keeps the old one.
remote 'bash -s' <<BUILD
set -euo pipefail
as_root() { if [ "\$(id -u)" = 0 ]; then "\$@"; else sudo "\$@"; fi; }
cd ~/$remote_dir/deploy
state=~/$remote_dir/.state
mkdir -p "\$state"
bundle_sum=\$(sha256sum pkp-data/bundle.json | cut -d' ' -f1)
caddy_sum=\$(sha256sum Caddyfile | cut -d' ' -f1)
before=\$(as_root docker compose ps -q planner 2>/dev/null || true)
as_root docker compose up -d --build --remove-orphans
after=\$(as_root docker compose ps -q planner 2>/dev/null || true)
if [ "\$before" = "\$after" ] && [ "\$bundle_sum" != "\$(cat "\$state/bundle.sha256" 2>/dev/null || true)" ]; then
  echo 'new bundle: restarting the planner'
  as_root docker compose restart planner >/dev/null
fi
if [ "\$caddy_sum" != "\$(cat "\$state/caddyfile.sha256" 2>/dev/null || true)" ]; then
  as_root docker compose up -d --force-recreate --no-deps caddy
fi
echo "\$bundle_sum" > "\$state/bundle.sha256"
echo "\$caddy_sum" > "\$state/caddyfile.sha256"
as_root docker image prune -f >/dev/null
as_root docker compose ps
BUILD

echo '6/6 IP locations for the usage report (DB-IP Lite)'
# DB-IP's free monthly databases (https://db-ip.com, CC BY 4.0), which deploy/usage.sh reads to show each visitor's /24
# as a city and provider. Each is downloaded only when missing or more than 40 days old: this month's file, or last
# month's while this month's is not published yet. A download is unpacked beside the old file and replaces it only
# when it holds the MaxMind DB marker, so a failure keeps what is there; it is a warning, and the deploy goes on.
if ! remote 'bash -s' <<GEO; then
set -euo pipefail
geo=~/$remote_dir/geo
mkdir -p "\$geo"
this=\$(date -u +%Y-%m)
last=\$(date -u -d "\$(date -u +%Y-%m-01) -1 month" +%Y-%m)
for kind in city asn; do
  name=dbip-\$kind-lite.mmdb
  file=\$geo/\$name
  if [ -s "\$file" ] && [ -z "\$(find "\$file" -mmin +$((40 * 24 * 60)))" ]; then
    echo "\$name: up to date"
    continue
  fi
  got=''
  for month in "\$this" "\$last"; do
    url=https://download.db-ip.com/free/dbip-\$kind-lite-\$month.mmdb.gz
    rm -f "\$file.gz.part" "\$file.part"
    if curl -fsSL --retry 2 --connect-timeout 20 --max-time 900 -o "\$file.gz.part" "\$url" </dev/null \
      && gunzip -c "\$file.gz.part" > "\$file.part" 2>/dev/null \
      && tail -c 131072 "\$file.part" | grep -caF 'MaxMind.com' >/dev/null; then
      got=\$url
      break
    fi
  done
  rm -f "\$file.gz.part"
  if [ -z "\$got" ]; then
    rm -f "\$file.part"
    echo "warning: could not download DB-IP's dbip-\$kind-lite for \$this or \$last\$([ -s "\$file" ] && echo '; keeping the one there')" >&2
    continue
  fi
  mv "\$file.part" "\$file"
  echo "\$name: \$got"
  # SOURCE: what each file is, from where and when, under the licence's line.
  {
    echo '# IP to City Lite and IP to ASN Lite by DB-IP (https://db-ip.com), under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).'
    echo '# Kept by deploy/remote.sh (downloaded again when over 40 days old) for deploy/usage.sh.'
    { grep -v -e '^#' -e "^\$name " "\$geo/SOURCE" 2>/dev/null || true; echo "\$name from \$got, downloaded \$(date -u +%F)"; } | sort
  } > "\$geo/SOURCE.new"
  mv "\$geo/SOURCE.new" "\$geo/SOURCE"
done
GEO
  echo "warning: the IP location step failed; the usage report shows bare /24s until a later deploy gets the files" >&2
fi

echo "Waiting for https://$domain/api/health (Caddy gets its certificate on the first run)…"
last_error=''
for _ in $(seq 1 30); do
  if last_error=$(curl -fsS --max-time 5 "https://$domain/api/health" 2>&1 >/dev/null); then
    echo "Up: https://$domain/"
    echo "Check it: npm run smoke -- https://$domain '<the password>'"
    exit 0
  fi
  sleep 5
done
echo "No answer from https://$domain/api/health after about 5 minutes (last: ${last_error:-none})." >&2
echo "Are TCP 80 and 443 open (a Cloud Firewall, if one is attached)? A certificate error can mean Let's Encrypt's limits: give it time." >&2
echo "Look at: ssh -i $key $target 'cd ~/$remote_dir/deploy && docker compose logs --tail 50' (sudo for a user other than root)" >&2
exit 1
