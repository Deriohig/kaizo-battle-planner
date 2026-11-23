#!/usr/bin/env bash
# The hosted planner's smoke test (docs/deploy.md):
#
#   npm run smoke -- <base URL> [password]
#   bash deploy/smoke.sh https://planner.example.com 'the site password'
#
# It talks to the server with curl alone, so it runs against any host. Run it from a checkout of this repo with
# `npm ci` done: it makes its own save with scripts/makeSmokeSave.ts (no real save needed) and reads the JSON answers
# with node. PKP_SMOKE_INSECURE=1 accepts a certificate curl cannot check (Caddy's local one, for PKP_DOMAIN=localhost).
# One line per check; exits 1 when any check fails.

set -u

usage='Usage: npm run smoke -- <base URL> [password]'
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "$usage" >&2; exit 2; }
base=${1%/}
password=${2:-}
case $base in http://*|https://*) ;; *) echo "The base URL must start with http:// or https://. $usage" >&2; exit 2 ;; esac

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl_opts=(-sS --max-time 60 -H 'Expect:')
[ "${PKP_SMOKE_INSECURE:-}" = 1 ] && curl_opts+=(-k)
auth=()
[ -n "$password" ] && auth=(-u "smoke:$password")

failed=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failed=$((failed + 1)); }

# call [--no-auth] METHOD PATH [curl args...]: the body lands in $work/body, the headers in $work/head; prints the status
# (000 when no answer came).
call() {
  local send_auth=1
  if [ "$1" = --no-auth ]; then send_auth=0; shift; fi
  local method=$1 path=$2
  shift 2
  rm -f "$work/body" "$work/head"
  : >"$work/body"
  : >"$work/head"
  # ${auth[@]+…}: an empty array under `set -u` on bash before 4.4 (macOS) is not an error this way.
  if [ "$send_auth" = 1 ]; then
    curl "${curl_opts[@]}" ${auth[@]+"${auth[@]}"} -X "$method" -o "$work/body" -D "$work/head" -w '%{http_code}' "$@" "$base$path" 2>"$work/err" || true
  else
    curl "${curl_opts[@]}" -X "$method" -o "$work/body" -D "$work/head" -w '%{http_code}' "$@" "$base$path" 2>"$work/err" || true
  fi
}

# json FILE EXPR: EXPR over the parsed JSON `d`, printed (a string as it is, anything else as JSON); empty on any error.
json() {
  node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const v = new Function("d", `return (${process.argv[2]});`)(d);
      process.stdout.write(v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
    } catch {}
  ' "$1" "$2"
}

header() { grep -i "^$1:" "$work/head" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

session=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
session_header=(-H "x-pkp-session: $session")

# 1. Health: 200, hosted, without the password.
status=$(call --no-auth GET /api/health)
mode=$(json "$work/body" d.mode)
if [ "$status" = 200 ] && [ "$mode" = hosted ]; then pass "1  health answers 200 in hosted mode (version $(json "$work/body" d.version))"
else fail "1  health: status $status, mode '${mode}' (want 200, hosted) $(head -c 200 "$work/err")"; fi

# 2. The sign-in: with a password, the page and config are open, the API is 401 SIGN_IN with no browser
#    challenge, and signing in gives a cookie the API takes. The later checks sign in with HTTP Basic, the fallback.
if [ -n "$password" ]; then
  page=$(call --no-auth GET /)
  cfg=$(call --no-auth GET /api/config)
  required=$(json "$work/body" d.passwordRequired)
  boxs=$(call --no-auth GET /api/box "${session_header[@]}")
  code=$(json "$work/body" d.code)
  challenge=$(header www-authenticate)
  login_body=$(node -e 'process.stdout.write(JSON.stringify({ password: process.argv[1], name: "smoke" }))' "$password")
  login=$(call --no-auth POST /api/login -H 'Content-Type: application/json' --data "$login_body")
  cookie=$(header set-cookie | grep -o 'pkp_auth=[^;]*' || true)
  signed=""
  if [ -n "$cookie" ]; then call --no-auth GET /api/config -H "Cookie: $cookie" >/dev/null; signed=$(json "$work/body" d.signedIn); fi
  if [ "$page" = 200 ] && [ "$cfg" = 200 ] && [ "$required" = true ] && [ "$boxs" = 401 ] && [ "$code" = SIGN_IN ] \
    && [ -z "$challenge" ] && [ "$login" = 204 ] && [ "$signed" = true ]; then
    pass "2  sign-in: the page is open, the API is 401 SIGN_IN with no browser prompt, and signing in works"
  else
    fail "2  sign-in: page $page, config $cfg (passwordRequired '${required}'), box $boxs ('${code}', challenge '${challenge}'), login $login, cookie ${cookie:+set}${cookie:-missing}, signedIn '${signed}'"
  fi
else
  pass "2  no password given: the page's password check skipped"
fi

# 3. Config says hosted.
status=$(call GET /api/config)
if [ "$status" = 200 ] && [ "$(json "$work/body" d.mode)" = hosted ]; then pass "3  config says hosted (largest save $(json "$work/body" d.maxSaveBytes) bytes)"
else fail "3  config: status $status, body $(head -c 200 "$work/body")"; fi
cp "$work/head" "$work/config-head"

# 4. The local mode's path routes are not there.
four=""
for route in 'GET /api/setup' 'GET /api/settings' 'GET /api/events'; do
  status=$(call ${route})
  [ "$status" = 404 ] || four="$four ${route}=$status"
done
status=$(call POST /api/line/start -H 'Content-Type: application/json' --data '{"trainerId":"x","team":[],"draft":[]}')
[ "$status" = 404 ] || four="$four POST /api/line/start=$status"
if [ -z "$four" ]; then pass "4  setup, settings, events and line start are 404"
else fail "4  want 404:$four"; fi

# 5. A fresh session holds no save.
status=$(call GET /api/box "${session_header[@]}")
code=$(json "$work/body" d.code)
if [ "$status" = 409 ] && [ "$code" = NO_SAVE ]; then pass "5  a fresh session's box is 409 NO_SAVE"
else fail "5  a fresh session's box: status $status, code '${code}' (want 409 NO_SAVE)"; fi

# 6. Upload the made save; the box then matches the upload's answer.
if ! (cd "$repo" && npx --no-install tsx scripts/makeSmokeSave.ts "$work/smoke.dsv") 2>"$work/err"; then
  fail "6  could not make the smoke save (npm ci done?): $(head -c 300 "$work/err")"
else
  upload=(-H 'Content-Type: application/octet-stream' -H 'x-pkp-save-name: smoke.dsv' -H "x-pkp-save-modified: $(date +%s)000")
  status=$(call PUT /api/save "${session_header[@]}" "${upload[@]}" --data-binary "@$work/smoke.dsv")
  cp "$work/body" "$work/put.json"
  box=$(call GET /api/box "${session_header[@]}")
  if [ "$status" = 200 ] && [ "$box" = 200 ] && cmp -s "$work/body" "$work/put.json"; then pass "6  the save uploads (200) and the box matches it ($(json "$work/put.json" d.mons.length) Pokémon)"
  else fail "6  upload $status, then box $box (want 200, 200 and the same box): $(head -c 200 "$work/put.json")"; fi

  # 7. Too big, and not a save.
  head -c 2097152 /dev/urandom >"$work/big.bin"
  head -c 1000 /dev/urandom >"$work/junk.bin"
  big=$(call PUT /api/save "${session_header[@]}" "${upload[@]}" --data-binary "@$work/big.bin")
  junk=$(call PUT /api/save "${session_header[@]}" "${upload[@]}" --data-binary "@$work/junk.bin")
  junk_code=$(json "$work/body" d.code)
  if [ "$big" = 413 ] && [ "$junk" = 422 ] && [ "$junk_code" = BAD_SAVE ]; then pass "7  a 2 MB upload is 413 and 1,000 random bytes are 422 BAD_SAVE"
  else fail "7  2 MB: $big (want 413); 1,000 random bytes: $junk '${junk_code}' (want 422 BAD_SAVE)"; fi
fi

# 8. A sprite is a PNG.
status=$(call GET /api/sprites/icon/1.png)
type=$(header content-type)
magic=$(head -c 8 "$work/body" | od -An -tx1 | tr -d ' \n')
if [ "$status" = 200 ] && [[ $type == image/png* ]] && [ "$magic" = 89504e470d0a1a0a ]; then pass "8  /api/sprites/icon/1.png is a PNG"
else fail "8  the sprite: status $status, type '${type}', first bytes $magic"; fi

# 9. A sheet and a plan step for the first single battle, with the smoke save's Pokémon.
status=$(call GET /api/trainers)
trainer=$(json "$work/body" 'd.find((t) => t.battleType === "single").id')
ref=$( [ -f "$work/put.json" ] && json "$work/put.json" 'd.mons.find((m) => m.draft !== null && m.ineligibleReasons.length === 0).ref')
if [ "$status" != 200 ] || [ -z "$trainer" ] || [ -z "$ref" ]; then
  fail "9  no trainer or Pokémon to plan with (trainers: $status, trainer '${trainer}', Pokémon '${ref}')"
else
  json_post=(-H 'Content-Type: application/json' "${session_header[@]}")
  sheet=$(call POST /api/sheet "${json_post[@]}" --data "{\"trainer\":\"$trainer\",\"team\":[\"$ref\"],\"draft\":[]}")
  sheet_body=$(head -c 200 "$work/body")
  side='{"reflect":false,"lightScreen":false}'
  field="{\"rocks\":{\"player\":false,\"enemy\":false},\"screens\":{\"player\":$side,\"enemy\":$side},\"stages\":{\"player\":{},\"enemy\":{}},\"enemyStatus\":\"none\"}"
  state="{\"player\":{\"active\":\"$ref\",\"fainted\":[]},\"enemy\":{\"active\":0,\"fainted\":[]},\"field\":$field}"
  step=$(call POST /api/plan/step "${json_post[@]}" --data "{\"trainerId\":\"$trainer\",\"team\":[\"$ref\"],\"draft\":[],\"state\":$state}")
  if [ "$sheet" = 200 ] && [ "$step" = 200 ]; then pass "9  a sheet and a plan step for $trainer answer 200 (phase $(json "$work/body" d.phase))"
  else fail "9  $trainer: sheet $sheet ($sheet_body), plan step $step ($(head -c 200 "$work/body"))"; fi
fi

# 10. The security headers, on an API answer and on the page.
missing=""
for answer in config-head page-head; do
  if [ "$answer" = page-head ]; then call GET / >/dev/null; cp "$work/head" "$work/page-head"; fi
  for name in content-security-policy x-content-type-options x-frame-options referrer-policy cross-origin-opener-policy \
              cross-origin-resource-policy permissions-policy x-robots-tag; do
    grep -qi "^$name:" "$work/$answer" || missing="$missing ${answer%-head}:$name"
  done
done
if [ -z "$missing" ]; then pass "10 the security headers are on the API and the page"
else fail "10 missing headers:$missing"; fi

if [ "$failed" -gt 0 ]; then echo "$failed of 10 checks failed against $base"; exit 1; fi
echo "All 10 checks passed against $base"
