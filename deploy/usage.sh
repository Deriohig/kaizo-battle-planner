#!/usr/bin/env bash
# Who used the hosted planner, from its request log on the server: docs/deploy.md, "Who used it". Read-only.
#
#   bash deploy/usage.sh root@203.0.113.7 [--since <when>]
#
# It reads the planner's request lines from the server's journal (compose logs both containers there, tagged
# pkp-planner and pkp-caddy, so the lines outlive a redeploy), plus `docker logs` of the current planner container when
# that one does not log to the journal (a stack started before the journald change). python3 on the server then prints,
# in Europe/Madrid time:
#   - one block per visitor (a browser's session): a name sent at sign-in if any (the page asks for none now; scripts
#     and older pages may send one), the IP's /24, the latest device and language, first and last seen, the visits (a gap
#     over 30 minutes starts a new one), the page opens, save uploads, plan steps, Matchups sheets and AI streams, then
#     the saves taken by format and source ("DeSmuME .dsv, uploaded ×1, connected ×12"), the run as the latest upload
#     left it ("2 badges · Gardenia Split · cap 28") and the fights planned ("Leader Roark (12 plan steps, Matchups ×3)"),
#     the trainers named from the data bundle's split tabs in ~/pkp/deploy/pkp-data/docs/ (by ID without them). A line
#     logged before those fields gives none of them. The page asks for its config before it sends its session, so a page
#     open is put with the session from the same /24 and name nearest in time (or stands alone as "no session");
#   - the visitors grouped under a rough location, "Zaragoza, Spain · Telefonica de Espana": the city and country of
#     their first /24's network address from DB-IP's IP to City Lite, and its provider from IP to ASN Lite, which
#     deploy/remote.sh keeps in ~/pkp/geo/ (python3-maxminddb reads them). Without them, and for a private, reserved or
#     unknown address, the visitor's block is as before, on its own;
#   - how many requests the password refused, and from how many /24s: internet scanners, mostly.
# Visitors you know: a labels file on this PC (PKP_VISITOR_LABELS, default ~/.config/pkp-hosted/visitor-labels), one
# "<session> <label>" per line ("9a7b3c Sam"; the six hex the report shows), names those sessions. Labelled visitors and
# automated checks (no session, only config or health, and a script or bot for a device, such as the deploy checks) are
# left out of the list and counted in one line each at the end, so the list is other people; --all shows them too.
# --since takes 12h or 3d, or anything GNU date reads, in Madrid time ("2026-11-20", "2026-11-20 18:00", "yesterday");
# the default is 7 days. The ssh key is ~/.ssh/pkp_deploy (PKP_DEPLOY_KEY to change it). Nothing on the server changes:
# it runs journalctl, docker ps, inspect and logs, and python3 (which only reads ~/pkp/geo/ and the bundle's docs/), as
# root or through sudo for another user. It never downloads or installs anything.

set -euo pipefail

usage='Usage: bash deploy/usage.sh <user@host> [--since <when>] [--all]'
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }
target=$1
shift
case $target in *@*) ;; *) echo "The target must be user@host, as root@203.0.113.7. $usage" >&2; exit 2 ;; esac
since='7 days ago'
show_all=0
while [ $# -gt 0 ]; do
  case $1 in
    --all) show_all=1; shift ;;
    --since) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; since=$2; shift 2 ;;
    --since=*) since=${1#--since=}; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
when=$since
if [[ $since =~ ^([0-9]+)([hd])$ ]]; then
  if [ "${BASH_REMATCH[2]}" = h ]; then when="${BASH_REMATCH[1]} hours ago"; else when="${BASH_REMATCH[1]} days ago"; fi
fi
# Only this number travels to the server, so nothing typed here reaches its shell.
cutoff=$(TZ=Europe/Madrid date -d "$when" +%s 2>/dev/null) || { echo "--since: not a time GNU date reads: $since" >&2; exit 2; }
[ "$cutoff" -le "$(date +%s)" ] || { echo "--since is in the future: $since" >&2; exit 2; }

key=${PKP_DEPLOY_KEY:-$HOME/.ssh/pkp_deploy}
[ -f "$key" ] || { echo "No ssh key at $key (set PKP_DEPLOY_KEY)" >&2; exit 1; }
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15)

# The labels travel as base64 of the file's well-formed lines only, so nothing in the file reaches the server's shell.
labels_file=${PKP_VISITOR_LABELS:-$HOME/.config/pkp-hosted/visitor-labels}
labels=none
if [ -f "$labels_file" ]; then
  wanted=$(grep -E '^[0-9a-f]{6}[[:space:]]+[A-Za-z0-9 ._-]{1,40}[[:space:]]*$' "$labels_file" || true)
  [ -n "$wanted" ] && labels=$(printf '%s\n' "$wanted" | base64 -w0)
fi

ssh "${ssh_opts[@]}" "$target" "bash -s -- $cutoff $labels $show_all" <<'REMOTE'
set -euo pipefail
cutoff=$1
labels=${2:-none}
show_all=${3:-0}
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }

# The report: request lines on stdin, each as "<source>\t<JSON line>"; the cutoff and the container's log driver as args.
report=$(cat <<'PY'
import base64, csv, ipaddress, json, os, re, sys, unicodedata
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
    ZONE, ZONE_NAME = ZoneInfo('Europe/Madrid'), 'Europe/Madrid time'
except Exception:
    ZONE, ZONE_NAME = timezone.utc, 'UTC: the server has no Europe/Madrid zone'

CUTOFF = int(sys.argv[1])
DRIVER = sys.argv[2]
# Sessions the owner named in the labels file ("9a7b3c Sam"), and whether to show them and the automated checks in full.
LABELS = {}
if len(sys.argv) > 3 and sys.argv[3] != 'none':
    try:
        for row in base64.b64decode(sys.argv[3]).decode('utf-8', 'replace').splitlines():
            parts = row.split(None, 1)
            if len(parts) == 2 and re.fullmatch(r'[0-9a-f]{6}', parts[0]):
                LABELS[parts[0]] = parts[1].strip()
    except ValueError:
        pass
SHOW_ALL = len(sys.argv) > 4 and sys.argv[4] == '1'
GAP = 30 * 60
COUNTS = (('page opens', 'GET', '/api/config'), ('save uploads', 'PUT', '/api/save'), ('plan steps', 'POST', '/api/plan/step'),
          ('Matchups sheets', 'POST', '/api/sheet'), ('AI streams', 'POST', '/api/sheet/ai/stream'))
# How a save came in (the request line's `src`), in words.
SOURCES = {'upload': 'uploaded', 'drop': 'dropped', 'connected': 'connected', 'resend': 're-sent', 'settings': 'settings change'}
MAX_FIGHTS = 8
# The data bundle deploy/remote.sh unpacks: its split tabs hold the trainer names a fight's ID is made from.
BUNDLE_DOCS = os.path.expanduser('~/pkp/deploy/pkp-data/docs')


def plural(n, word):
    return f'{n} {word}' if n == 1 else f'{n} {word}s'


def local(ts):
    return datetime.fromtimestamp(ts, ZONE)


def day_time(ts):
    d = local(ts)
    return f'{d:%a} {d.day} {d:%b %H:%M}'


def clean(text):
    return ''.join(ch for ch in str(text) if unicodedata.category(ch)[0] != 'C').strip() or None


def text_of(value):
    """A line's text field, cleaned; None for null, a number or anything else that is not text."""
    return clean(value) if isinstance(value, str) else None


def slug(text):
    """src/battle/resolveTrainer.ts's slug: accents dropped, lower case, every run of other characters one '-'."""
    bare = ''.join(ch for ch in unicodedata.normalize('NFD', text) if not unicodedata.category(ch).startswith('M'))
    return re.sub(r'[^a-z0-9]+', '-', bare.lower()).strip('-')


splits = None


def trainer_names():
    """{split slug: (split name, {name slug: [name, …]})} from the bundle's tabs on this server: column 4 holds each
    trainer's heading, its name before the first '(' without '*' (src/docs/teams.ts), each name in docs order, as a
    trainer ID counts them. Empty without the bundle."""
    global splits
    if splits is None:
        splits = {}
        try:
            files = sorted(f for f in os.listdir(BUNDLE_DOCS) if f.endswith('.csv'))
        except OSError:
            files = []
        for f in files:
            names = {}
            try:
                with open(os.path.join(BUNDLE_DOCS, f), encoding='utf-8-sig', newline='') as tab:
                    for row in csv.reader(tab):
                        bare = row[4].split('(')[0].replace('*', '').strip() if len(row) > 4 else ''
                        if bare and slug(bare):
                            names.setdefault(slug(bare), []).append(clean(bare))
            except (OSError, UnicodeDecodeError, csv.Error):
                continue
            splits[slug(f[:-4])] = (clean(f[:-4]), names)
    return splits


def ordinal(n):
    return f'{n}{"th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")}'


def trainer_name(fight):
    """'Leader Roark' for 'roark-split/leader-roark/1' ('2nd Barry #2' for the split's second trainer of that name), and
    the split's name; (the ID, None) when the bundle does not name it."""
    parts = fight.split('/')
    if len(parts) == 3 and parts[2].isdigit() and int(parts[2]) >= 1:
        split = trainer_names().get(parts[0])
        if split is not None and parts[1] in split[1]:
            n, names = int(parts[2]), split[1][parts[1]]
            name = names[n - 1] if n <= len(names) else names[0]
            return (name if n == 1 else f'{ordinal(n)} {name}'), split[0]
    return fight, None


def latest(own, key):
    """The last value of `key` a visitor's lines carry, or None."""
    for l in reversed(own):
        if l[key] is not None:
            return l[key]
    return None


def took(l, method, path):
    return l['m'] == method and l['p'] == path and 200 <= l['s'] < 300


def saves(own):
    """'DeSmuME .dsv, uploaded ×1, re-sent ×2; raw .sav, connected ×5': the saves the server took, by format then source.
    None when no line says (lines from before the format and source were logged)."""
    taken = [l for l in own if took(l, 'PUT', '/api/save')]
    if not any(l['fmt'] or l['src'] for l in taken):
        return None
    formats = {}
    for l in taken:
        by = formats.setdefault(l['fmt'] or 'format not logged', {})
        how = SOURCES.get(l['src'], 'source not logged')
        by[how] = by.get(how, 0) + 1
    return '; '.join(f'{fmt}, ' + ', '.join(f'{how} ×{n}' for how, n in hows.items()) for fmt, hows in formats.items())


def run_of(own):
    """'2 badges · Gardenia Split · cap 28', from the last save the server took that says where the run is."""
    for l in reversed(own):
        run = l['run']
        if not took(l, 'PUT', '/api/save') or not isinstance(run, dict):
            continue
        badges, split, cap = run.get('badges'), text_of(run.get('split')), run.get('cap')
        if isinstance(badges, int) and isinstance(cap, int):
            return ' · '.join(p for p in (plural(badges, 'badge'), split, f'cap {cap}') if p)
    return None


def fights(own):
    """'Leader Roark (12 plan steps, Matchups ×3), …': each trainer planned, most planned first (ties in order of first
    planned), at most MAX_FIGHTS, then how many more. Two that share a name say their split."""
    counts = {}
    for l in own:
        if l['fight'] is not None and l['m'] == 'POST' and 200 <= l['s'] < 300:
            mine = counts.setdefault(l['fight'], {})
            mine[l['p']] = mine.get(l['p'], 0) + 1
    if not counts:
        return None
    order = sorted(counts, key=lambda fight: -sum(counts[fight].values()))
    named = {fight: trainer_name(fight) for fight in order}
    seen = [name for name, _ in named.values()]
    shown = []
    for fight in order[:MAX_FIGHTS]:
        name, split = named[fight]
        if split is not None and seen.count(name) > 1:
            name = f'{name} · {split}'
        mine = counts[fight]
        did = [plural(mine['/api/plan/step'], 'plan step')] if mine.get('/api/plan/step') else []
        did += [f'Matchups ×{mine["/api/sheet"]}'] if mine.get('/api/sheet') else []
        did += [f'AI odds ×{mine["/api/sheet/ai/stream"]}'] if mine.get('/api/sheet/ai/stream') else []
        shown.append(f'{name} ({", ".join(did)})')
    more = len(order) - MAX_FIGHTS
    return ', '.join(shown) + (f', and {more} more' if more > 0 else '')


def open_geo():
    """DB-IP's databases in ~/pkp/geo/ that are there and open, as {'city': reader, 'asn': reader}: none without maxminddb."""
    try:
        import maxminddb
    except Exception:
        return {}
    readers = {}
    for kind in ('city', 'asn'):
        path = os.path.expanduser(f'~/pkp/geo/dbip-{kind}-lite.mmdb')
        if os.path.isfile(path):
            try:
                readers[kind] = maxminddb.open_database(path)
            except Exception:
                pass  # not a database (a cut-off download): as if it were not there
    return readers


GEO = open_geo()
places = {}


def english(record, key):
    """The English name of the record's city or country, or None."""
    try:
        name = record[key]['names']['en']
    except (KeyError, TypeError):
        return None
    return clean(name) if isinstance(name, str) else None


def place(block):
    """'Zaragoza, Spain · Telefonica de Espana' for a /24 or /48 ('62.40.120.0/24'), from its network address; None
    without the databases, for a private or reserved address, or when they know nothing of it."""
    if block not in places:
        found = None
        try:
            address = ipaddress.ip_network(block, strict=False).network_address
        except ValueError:
            address = None
        if GEO and address is not None and address.is_global:
            try:
                town = GEO['city'].get(str(address)) if 'city' in GEO else None
                net = GEO['asn'].get(str(address)) if 'asn' in GEO else None
            except Exception:
                town = net = None
            where = ', '.join(p for p in (english(town, 'city'), english(town, 'country')) if p) if isinstance(town, dict) else ''
            provider = clean(net.get('autonomous_system_organization') or '') if isinstance(net, dict) else None
            found = ' · '.join(p for p in (where, provider) if p) or None
        places[block] = found
    return places[block]


read = {}
lines = []
for raw in sys.stdin:
    source, _, text = raw.rstrip('\n').partition('\t')
    try:
        line = json.loads(text)
        ts = datetime.fromisoformat(line['t'].replace('Z', '+00:00')).timestamp()
        entry = {'ts': ts, 'm': str(line['m']), 'p': str(line['p']), 's': int(line['s'])}
    except (ValueError, KeyError, TypeError, AttributeError):
        continue  # a start-up line, a warning or error line, or anything else that is not a request line
    if ts < CUTOFF:
        continue
    read[source] = read.get(source, 0) + 1
    entry['ip'] = clean(line.get('ip')) or '?'
    entry['sess'] = clean(line.get('sess')) if line.get('sess') else None
    entry['user'] = clean(line.get('user')) if line.get('user') else None
    # The usage fields, absent from lines logged before them.
    for key in ('ua', 'lang', 'fmt', 'fight'):
        entry[key] = text_of(line.get(key))
    entry['src'] = line.get('src') if line.get('src') in SOURCES else None
    entry['run'] = line.get('run') if isinstance(line.get('run'), dict) else None
    lines.append(entry)
lines.sort(key=lambda l: l['ts'])

refused = [l for l in lines if l['s'] == 401]
passed = [l for l in lines if l['s'] != 401]
sessions = {}
for l in passed:
    if l['sess'] is not None:
        sessions.setdefault(l['sess'], []).append(l)


def owner(l):
    """The session from the same /24 and name with a line nearest in time to l, within the visit gap."""
    best, best_gap = None, GAP + 1
    for sess, own in sessions.items():
        for o in own:
            if o['ip'] == l['ip'] and o['user'] == l['user'] and abs(o['ts'] - l['ts']) < best_gap:
                best, best_gap = sess, abs(o['ts'] - l['ts'])
    return best


visitors = {('session', sess): list(own) for sess, own in sessions.items()}
loose = {}
for l in passed:
    if l['sess'] is not None:
        continue
    sess = owner(l)
    if sess is not None:
        visitors[('session', sess)].append(l)
    else:
        loose.setdefault((l['ip'], l['user']), []).append(l)
other = []
for (ip, user), own in loose.items():
    if any(l['s'] < 400 for l in own):
        visitors[('none', ip, user)] = own
    else:
        other.extend(own)


def visit(start, end, n):
    if day_time(end) == day_time(start):
        return f'{day_time(start)} ({plural(n, "request")})'
    until = f'{local(end):%H:%M}' if local(end).date() == local(start).date() else day_time(end)
    return f'{day_time(start)} to {until} ({max(1, round((end - start) / 60))} min, {plural(n, "request")})'


print(f'Plat Kaizo planner visitors since {day_time(CUTOFF)} ({ZONE_NAME})')
journal, docker = read.get('journal', 0), read.get('docker', 0)
if docker:
    print(f'Read {plural(journal + docker, "request line")}: {journal} from the journal, {docker} from docker logs of the current container.')
else:
    print(f'Read {plural(journal, "request line")} from the journal.')
if DRIVER == 'none':
    print('No planner container on the server: this is the journal alone.')
elif DRIVER != 'journald':
    print(f'The planner container does not log to the journal ({DRIVER}): its lines go when it is recreated. Deploy the compose file that logs to the journal to keep them.')
print()

def show(key, own, where=None):
    """One visitor's block: as it always was, or indented under the location heading `where`, where a missing name is
    left out and another /24 placed elsewhere says where."""
    at = '' if where is None else '  '
    names = ', '.join(dict.fromkeys(l['user'] for l in own if l['user'] is not None))
    if key[0] == 'session' and key[1] in LABELS:
        names = LABELS[key[1]]
    tag = f'session {key[1]}' if key[0] == 'session' else 'no session'
    if where is None:
        print(f'{names or "no name given"} ({tag})')
    else:
        print(f'{at}{names} ({tag})' if names else f'{at}{tag}')
    ips = []
    for ip in dict.fromkeys(l['ip'] for l in own):
        there = place(ip) if where is not None else None
        ips.append(f'{ip} ({there})' if there is not None and there != where else ip)
    print(f'{at}  IP /24      {", ".join(ips)}')
    for label, value in (('device', latest(own, 'ua')), ('language', latest(own, 'lang'))):
        if value is not None:
            print(f'{at}  {label:<10}  {value}')
    print(f'{at}  first seen  {day_time(own[0]["ts"])}')
    print(f'{at}  last seen   {day_time(own[-1]["ts"])}')
    runs = [[own[0]]]
    for l in own[1:]:
        if l['ts'] - runs[-1][-1]['ts'] > GAP:
            runs.append([l])
        else:
            runs[-1].append(l)
    for i, run in enumerate(runs):
        print(f'{at}  {"visits" if i == 0 else "":<10}  {visit(run[0]["ts"], run[-1]["ts"], len(run))}')
    done = [f'{name} {sum(1 for l in own if l["m"] == m and l["p"] == p and 200 <= l["s"] < 300)}' for name, m, p in COUNTS]
    print(f'{at}  did         {", ".join(done)}')
    for label, value in (('save', saves(own)), ('run', run_of(own)), ('fights', fights(own))):
        if value is not None:
            print(f'{at}  {label:<10}  {value}')
    failed = sum(1 for l in own if l['s'] >= 500)
    if failed:
        print(f'{at}  errors      {plural(failed, "server error")} (5xx)')


def automated(key, own):
    """No session, nothing but config or health, and a script or bot for a device with no browser named: a check, not a person."""
    if key[0] != 'none' or any(l['m'] != 'GET' or l['p'] not in ('/api/config', '/api/health') for l in own):
        return False
    devices = set(l['ua'] for l in own if l['ua'] is not None)
    return bool(devices) and devices <= {'script', 'bot'}


def visits_of(own):
    """How many visits (a gap over 30 minutes starts a new one)."""
    times = sorted(l['ts'] for l in own)
    return 1 + sum(1 for a, b in zip(times, times[1:]) if b - a > GAP)


left_out = {'labelled': {}, 'automated': []}
if not SHOW_ALL:
    for key in list(visitors):
        own = visitors[key]
        if key[0] == 'session' and key[1] in LABELS:
            left_out['labelled'].setdefault(LABELS[key[1]], []).extend(visitors.pop(key))
        elif automated(key, own):
            left_out['automated'].extend(visitors.pop(key))

blocks = sorted(visitors.items(), key=lambda kv: min(l['ts'] for l in kv[1]))
if not blocks:
    print(f'No {"other " if left_out["labelled"] or left_out["automated"] else ""}visitors since {day_time(CUTOFF)}.')
    print()
# Visitors placed by their first /24 share one heading per location, in order of first seen; the others stand alone.
entries, groups = [], {}
for key, own in blocks:
    own.sort(key=lambda l: l['ts'])
    where = place(own[0]['ip'])
    if where is None:
        entries.append((None, [(key, own)]))
    elif where in groups:
        groups[where].append((key, own))
    else:
        groups[where] = [(key, own)]
        entries.append((where, groups[where]))
for where, members in entries:
    if where is not None:
        print(where)
    for key, own in members:
        show(key, own, where)
    print()

if refused:
    ips = set(l['ip'] for l in refused)
    seen = ips & set(l['ip'] for own in visitors.values() for l in own)
    note = f' ({len(seen)} of those /24s also had a visitor: the browser asks once before it sends the password)' if seen else ''
    print(f'Blocked by the password: {plural(len(refused), "request")} from {len(ips)} /24{"" if len(ips) == 1 else "s"}{note}.')
else:
    print('Blocked by the password: none.')
if other:
    ips = set(l['ip'] for l in other)
    print(f'Other requests without a session: {len(other)} from {len(ips)} /24{"" if len(ips) == 1 else "s"}.')
for label, own in left_out['labelled'].items():
    own.sort(key=lambda l: l['ts'])
    print(f'Left out, {label}: {plural(visits_of(own), "visit")}, last {day_time(own[-1]["ts"])} (--all shows them).')
if left_out['automated']:
    print(f'Left out, automated checks: {plural(len(left_out["automated"]), "request")} (--all shows them).')
if GEO:
    print()
    print('IP locations by DB-IP (db-ip.com), CC BY 4.0.')
PY
)

# The current planner container (compose project "deploy"), and where it logs. No command here may read stdin: it
# holds the rest of this script.
container=$(as_root docker ps -aq --filter label=com.docker.compose.project=deploy --filter label=com.docker.compose.service=planner </dev/null 2>/dev/null | head -1 || true)
driver=none
if [ -n "$container" ]; then driver=$(as_root docker inspect -f '{{.HostConfig.LogConfig.Type}}' "$container" </dev/null 2>/dev/null || echo unknown); fi
{
  as_root journalctl -t pkp-planner --since "@$cutoff" --all --output cat --no-pager --quiet </dev/null 2>/dev/null | sed 's/^/journal\t/' || true
  # A container logging to the journal is in it already; `docker logs` would read the same lines again.
  if [ -n "$container" ] && [ "$driver" != journald ]; then
    as_root docker logs --since "$cutoff" "$container" </dev/null 2>&1 | sed 's/^/docker\t/' || true
  fi
} | PYTHONIOENCODING=utf-8:replace python3 -c "$report" "$cutoff" "$driver" "$labels" "$show_all"
REMOTE
