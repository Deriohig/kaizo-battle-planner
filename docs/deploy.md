# Hosting the planner

> **Never push an image holding the data bundle to a public registry, and never commit the bundle.** It holds data and
> sprites taken from the game. Build such an image on your own machine or on your own server, and keep it there.

The planner runs on a server in **hosted mode**: anyone with the link opens it, loads their own save in the browser, and
plans as on the PC. The server needs no ROM and no save path. It reads the game data from a **bundle** made once on your
PC, and holds each player's save only in memory while they use it. Local mode (`npm run serve`) is unchanged.

## 1. Build the bundle (on your PC)

The bundle is exactly the files the server reads: the extracted ROM data, the trainer AI's data, the docs tabs, PKCalc's
files and the sprites, with a `bundle.json` listing each file's size and SHA-256. About 17 MB unpacked, 2.3 MB packed.

```bash
npm run extract -- --rom <path to the .nds>   # if data/rom/ is not there or is out of date
npm run sprites                               # if data/sprites/ is not there
npm run record:diffs                          # if data/pkcalc/ is not there
npm run bundle
```

It writes `dist/bundle/pkp-data/` and `dist/bundle/pkp-data.tar.gz`, and prints the size and the data's fingerprint.
It loads the data first as the server would, and stops with the command to run if anything is missing. It refuses to
bundle without PKCalc's files (the hosted site would answer differently from your PC) unless you pass
`--allow-no-pkcalc`, and it never writes a ROM or a save (`.nds`, `.dsv`, `.sav`) into the bundle. Options:
`--data <dir>` (default `data`), `--out <dir>` (default `dist/bundle`).

Make a new bundle and redeploy it when the docs, PKCalc or the extract change.

## 2. Pick a way to run it

Whichever way, run **exactly one** planner. Each player's session lives in that one process's memory. Two copies would
each forget the other's players, and every request would turn into an upload. A 1 vCPU, 2 GB machine is enough. The
process takes about 320 MB, plus up to 256 MB for sessions.

Players' saves are never written to disk, and a restart loses nothing a player needs: their browser still has the save
and sends it again by itself.

### A. Compose on a VPS, behind Caddy (recommended)

Caddy gets the HTTPS certificate for your domain by itself and passes requests to the planner. You need a domain (an A
or AAAA record pointing at the server) and ports 80 and 443 open.

On the server, in a checkout of this repo (the planner image builds from it, without the data):

```bash
cd deploy
cp .env.example .env               # set PKP_DOMAIN, and PKP_PASSWORD if you want one
# copy dist/bundle/pkp-data.tar.gz from your PC into deploy/ (scp, or any file copy), then:
tar -xzf pkp-data.tar.gz           # makes deploy/pkp-data/
docker compose up -d --build
```

The planner runs read-only with no Linux capabilities, the bundle mounted read-only at `/data`, a 1 GB memory limit and no
published port. Only Caddy is reachable. Compose sets `PKP_TRUST_PROXY=1` for it. `deploy/.gitignore` keeps `.env`,
`pkp-data/` and the tarball out of git.

With no domain of your own, use the server's IP as an sslip.io name: for 203.0.113.7, `PKP_DOMAIN=203-0-113-7.sslip.io`.
That name points at the IP with no DNS setup, and Caddy gets a real Let's Encrypt certificate for it. In `.env`, wrap a
password that holds `$`, `#` or spaces in single quotes (`PKP_PASSWORD='pa$$ #word'`), as compose reads them specially.

To try the stack on your own machine, set `PKP_DOMAIN=localhost`. Caddy then uses its own local certificate, which
browsers and curl do not trust until you install Caddy's root (or use `PKP_SMOKE_INSECURE=1` for the smoke test).
Both containers log to the host's journal (section 7); Docker Desktop has none, so there add `PKP_LOG_DRIVER=json-file`
to `.env`.

### B. A platform that runs a Docker image you build

Build the image with the data baked in, on your PC or on the platform from an upload of your own folder:

```bash
npm run bundle
docker build -t pkp-planner-data .                 # the default target, with-data
docker run --read-only --cap-drop ALL -p 8080:8080 -e PKP_PASSWORD=… pkp-planner-data
```

The platform must give the site HTTPS (most do), run one instance, and keep the image private. Set `PKP_TRUST_PROXY` to
the number of proxies the platform puts in front (usually 1). A platform that builds from the GitHub repo cannot bake the
data in, since the data is not in git. Use one that mounts a volume holding `pkp-data/` at `/data`, with
`docker build --target runtime`.

### C. Plain Node 22

```bash
npm ci
npm run build                      # the page (build:web) and the server (build:server)
PKP_DATA=/path/to/pkp-data PORT=8080 npm start
```

`npm start` is `node dist/server/server/main.js --hosted`. Put it behind a proxy that gives HTTPS, under a supervisor
that restarts it (systemd, pm2). The server exits on an unexpected error so that the supervisor restarts it.

## 3. Settings

All are environment variables. A value that does not parse stops the server with one line naming it.

| Variable | Default | Meaning |
|---|---|---|
| `PKP_MODE` | `local` | `hosted` switches hosted mode on (so does `--hosted`; the image sets it) |
| `PORT` | `8080` | the port in hosted mode; `--port` wins |
| `PKP_HOST` | `0.0.0.0` | the address it binds in hosted mode |
| `PKP_DATA` | `data` | the bundle folder; `/data` in the image |
| `PKP_STATIC` | next to the server | the built page |
| `PKP_PASSWORD` | unset | the site password; unset or empty is a public site |
| `PKP_TRUST_PROXY` | `0` | how many proxies sit in front (Caddy: 1) |
| `PKP_ALLOW_ORIGIN` | unset | extra allowed origins, comma-separated (the Vite dev server) |
| `PKP_MAX_SESSIONS` | `200` | players held at once; over it, the one idle longest is dropped |
| `PKP_SESSIONS_PER_IP` | `8` | players held per address |
| `PKP_SESSION_IDLE_MIN` | `120` | minutes before an idle player's save is forgotten |
| `PKP_SESSION_MEMORY_MB` | `256` | memory for players' boxes |
| `PKP_HEAVY_CONCURRENCY` | `2` | plan steps, sheets and AI odds worked on at once |
| `PKP_HEAVY_QUEUE` | `32` | how many may wait; past it, "busy, try again" |
| `PKP_LOG` | `requests` | `off` silences the request lines |
| `PKP_VERSION` | `dev` | shown by health and config; the image takes it as a build arg |
| `PKP_AI_ODDS` | `full` | how much of the trainer AI's odds the site shows and sends: `full` (exact odds), `likeliest` (their likeliest move by name, no percentages), `ranked` (their moves in order of likelihood, no percentages) or `off` (none); damage, KO chances, crit figures and speed order show at every level. Both modes |

A dropped player loses nothing: their browser sends the save again on its next request.

**`PKP_AI_ODDS`** follows what the community decides about showing the AI's odds. Set it in the server's `deploy/.env`
(`remote.sh` keeps a line added there by hand) and restart the stack; the start-up line says the level in use. The
server sends only what the level shows, so the browser's network tab gives away nothing more.

**`PKP_TRUST_PROXY` matters.** Behind a proxy with it left at 0, every player looks like the proxy's address. They would
then share one set of rate limits and one set of 8 sessions. The server logs a warning when it sees `X-Forwarded-For`
while the value is 0. Do not set it higher than the number of proxies, or players can pick their own address.

### Small servers (1 GB)

The image's heap limit (768 MB) suits a server with 2 GB or more. On a 1 GB server, give the planner less, by adding
these lines to `deploy/.env` (`deploy/remote.sh` keeps them on later runs):

```
NODE_OPTIONS=--max-old-space-size=512
PKP_SESSION_MEMORY_MB=96
PKP_MAX_SESSIONS=100
```

The live Hetzner server (1 vCPU, 1 GB, plus 2 GB of swap) runs with exactly these. A swap file is worth adding on such a
machine. For scale: in the load test, a cold server with no heap limit peaked at 822 MB of memory, and 503 MB with the
768 MB limit. A smaller session budget means more players' saves get dropped and re-sent, which the page does by itself.

## 4. The password

Set `PKP_PASSWORD` to put the site behind one shared password. Visitors sign in on the planner's own sign-in page, which
asks for the password only, and under the button says that visits are logged with a rough location (section 11). They
stay signed in for 30 days on that browser; changing the password signs everyone out. The page itself, health (`/api/health`) and config stay open; the planner's data, sprites and saves
need signing in. Scripts can still send the password with HTTP Basic (any user name). Ten wrong tries in 10 minutes from
one address are refused for a while.

**Only set a password on HTTPS.** Over plain HTTP the password travels readable. The site serves the game's data and
sprites to anyone who can open it, so starting with a password and sharing it with the people you want in is the safe
default.

## 5. Why HTTPS

Besides the password, **"Connect save file"** (Chrome and Edge follow the save file as you play) only works on a secure
page. Over plain HTTP players can still upload their save, but it does not follow the game. Caddy (way A) and most
platforms (way B) give HTTPS. For way C, put a proxy that does in front.

## 6. Updating

- **New code:** pull, then `docker compose up -d --build` (way A), rebuild and redeploy the image (B), or
  `npm ci && npm run build` and restart (C).
- **New data** (docs, PKCalc or extract changed): `npm run bundle` on your PC, copy the new `pkp-data.tar.gz` across,
  then in `deploy/`: `rm -rf pkp-data && tar -xzf pkp-data.tar.gz && docker compose restart planner` (a clean unpack,
  so no file of the old bundle stays). For way B, rebuild the image.
- **On Hetzner (section 10):** run `deploy/remote.sh` again; it does both.

Players need do nothing. Their browsers send their saves again after the restart.

## 7. The log

Hosted mode writes one JSON line per API request to standard output (`docker compose logs -f planner`):

```json
{"t":"2026-11-21T14:02:11.412Z","ip":"203.0.113.0/24","m":"POST","p":"/api/plan/step","s":200,"ms":41,"in":912,"sess":"a41f9c","code":null,"user":null,"ua":"Chrome 142 · Windows · desktop","lang":"es-ES","src":null,"fmt":null,"run":null,"fight":"roark-split/leader-roark/1","turns":null}
```

- `ip` is cut to /24 (IPv4) or /48 (IPv6). The full address is never logged. The usage report places the /24 roughly
  (section 11).
- `sess` is a short hash of the player's session, never the session itself.
- `user` is a name sent with the sign-in (the sign-in page asks for none; a script may send one, or its HTTP Basic user
  name), logged only for a signed-in request (null while there is no password, or when no name was sent). Control
  characters are stripped and it is cut to 40 characters.
- `ua` is the device and browser, summed up by the server from the `User-Agent` header in a few fixed words: "Chrome
  142 · Windows · desktop", "Safari 18 · iPhone · phone", "bot" or "script". The header itself is never kept.
- `lang` is the first language the browser asks for ("es-ES"), and nothing else of `Accept-Language`.
- On a save upload (`PUT /api/save`):
  - `src` says how the page came to send it: `upload` (the Upload button or picker), `drop`, `connected` (Connect save
    file, and each upload of the watched file), `resend` (the page sending the stored save again after a restart) or
    `settings` (a settings change). Anything else the header says is logged as null;
  - `fmt` is what the file's size says it is: "raw .sav" (melonDS, DraStic or a flashcart), "DeSmuME .dsv" or "other";
  - `run`, once the save has read, is where the run is: `{"badges":2,"split":"Gardenia Split","cap":28}`.
- `fight`, on a plan step, a Matchups sheet or an AI stream, is the trainer planned for (its ID, such as
  `roark-split/leader-roark/1`; the report turns it into a name). `turns` is for a plan step's turn count, which no
  request carries yet, so it is always null.
- Never logged: save bytes, the box's Pokémon and nicknames (only the three `run` facts), the in-game trainer name or ID,
  file names, note text, request bodies, the full IP, the full `User-Agent`, the password and the `Authorization` header.
- The sign-in page tells visitors what is logged: "Visits are logged with a rough location, device and the fights you
  plan."
- An error answers the player with a reference (`ref 1a2b3c4d`). The same reference is in the log beside the full error.
- Page files and sprites are logged only when they fail. `PKP_LOG=off` turns the request lines off.

With compose (way A), both containers log to the host's journal, tagged `pkp-planner` and `pkp-caddy`, so the lines
outlive a redeploy, which recreates the planner: `journalctl -t pkp-planner -o cat` on the host. `docker compose logs`
reads the same lines, but only the current container's.

## 8. The smoke test

From a checkout of this repo on any machine (with `npm ci` done), against the running site:

```bash
npm run smoke -- https://planner.example.com 'the password'    # the password only if one is set
```

It makes its own test save (no real save needed) and checks, one line each:
- health and config say hosted, and the password is asked for when set;
- the local mode's routes are gone;
- a save uploads and the box matches it;
- a too-big file and a non-save are refused;
- a sprite loads;
- a sheet and a plan step answer;
- the security headers are there.

It exits 1 when any check fails. For Caddy's local certificate (`PKP_DOMAIN=localhost`), run it with
`PKP_SMOKE_INSECURE=1`.

## 9. The load test

```bash
npm run bundle && docker build -t pkp-planner-data .
docker run -d --name pkp-load --read-only --cap-drop ALL --memory 1g -p 8080:8080 -e PKP_TRUST_PROXY=1 -e PKP_SESSION_IDLE_MIN=1 pkp-planner-data
npm run loadtest -- http://127.0.0.1:8080 --container pkp-load --idle-check 1
docker rm -f pkp-load
```

`--memory 1g` is compose's limit, so the run tests what compose runs. Twenty players each upload a save, then for 60 s mix
plan steps, sheets and AI odds. It passes when:
- every answer is 200 but the occasional "busy" (under 1%), "load your save again" (re-sent, as the page does) and a plan
  step the trainer AI cannot answer (422 `AI_UNDEFINED`, expected, counted on its own line); a
  rate-limit answer is a failure;
- every player got its save in;
- the plan step p95 is under 2 s;
- health's p99 is under 500 ms;
- memory peaks under 700 MB. Measure it with `--container` (a Docker container) or `--pid` (a local process), or skip it
  with `--no-memory`.

With `--idle-check <minutes>` (the server's `PKP_SESSION_IDLE_MIN`), it then waits for the sessions to expire. It checks
that every player's session is gone and prints the memory. A second run's "before" figure should not be higher than that.

Each player sends its own `X-Forwarded-For` address. Run it **against the planner directly** (not through Caddy), started
with `PKP_TRUST_PROXY=1`. Otherwise all twenty players share one address's limits. Other options: `--players`,
`--seconds`, `--think <ms>` (default 500), `--password`, `--same-ip`, `--insecure`.

## 10. Hetzner Cloud

One shared x86 VM is plenty: a CPX22 (or any shared AMD or Intel plan with 2 GB or more), Ubuntu 24.04, a public IPv4.
The image builds on the VM itself. `deploy/remote.sh` does every step on the VM from your PC, and is safe to run again
for each update.

**Once, in the Hetzner Cloud console:**
1. Make an ssh key for this on your PC (`ssh-keygen -t ed25519 -f ~/.ssh/pkp_deploy`), and add its public half
   (`~/.ssh/pkp_deploy.pub`) under Security → SSH keys.
2. Create the server: Ubuntu 24.04, the plan, a public IPv4, and that ssh key. Note its IP. You log in as `root`.
3. Optional: a **Cloud Firewall**. Hetzner leaves every port open unless one is attached. To close the rest, add a
   firewall with inbound rules for TCP `22` (ssh), TCP `80` and TCP `443` (and UDP `443` for HTTP/3), and apply it to the
   server. Ports 80 and 443 must stay open: Let's Encrypt checks the domain over 80, and Caddy redirects it to HTTPS.

**From your PC, in this repo:**

```bash
npm run bundle
PKP_PASSWORD='the site password' bash deploy/remote.sh root@<server IP>
```

It:
- installs Docker (Ubuntu's `docker.io`, `docker-buildx`, `docker-compose-v2`), rsync and `python3-maxminddb` with apt
  when missing, on the server only (nothing runs as root on your PC);
- leaves the server's own firewall alone. Hetzner's images accept everything. Only an image whose iptables rejects
  incoming traffic gets 80 and 443 opened there, saved across reboots;
- copies only the files the build needs, and the bundle, to `~/pkp/`;
- writes `~/pkp/deploy/.env`;
- builds and starts the stack;
- keeps DB-IP's IP location databases in `~/pkp/geo/` for the usage report (section 11), downloading them only when
  they are missing or more than 40 days old. A failed download is a warning, and the deploy goes on;
- waits until `https://<ip-with-dashes>.sslip.io/api/health` answers.

The site's address is `https://<ip-with-dashes>.sslip.io/` (for 203.0.113.7, `https://203-0-113-7.sslip.io/`). Give a
second argument to use a domain of your own instead, once its A record points at the IP. Then run the smoke test
against it (section 8).

Two things about sslip.io names:
- The name is the IP, so it changes if the server's IP does. A Hetzner server keeps its IPv4 for as long as it exists. A
  Primary IP kept on its own survives rebuilding the server.
- Every sslip.io user shares one set of Let's Encrypt limits. In a busy week the first certificate can be refused. Caddy
  then tries again, and falls back to ZeroSSL by itself, so the first run's wait can be longer.

- **Updates:** run the same command again. It copies what changed and rebuilds. It restarts the planner for new code or a
  new bundle, and Caddy for a changed Caddyfile. A request during the restart can fail; the page retries.
- **The password:** leave out `PKP_PASSWORD` to keep the one already there; set it to change it. It cannot hold a single
  quote or a newline, or end in a backslash (the script refuses them); anything else is written as typed.
- **Other settings** (section 3) can be added to `~/pkp/deploy/.env` on the server by hand; the script keeps them.
- **The ssh key:** `~/.ssh/pkp_deploy`, or set `PKP_DEPLOY_KEY`.
- **Dry run:** `PKP_REMOTE_DRY_RUN=1` prints what it would do.
- **The log:** `ssh -i ~/.ssh/pkp_deploy root@<ip> 'cd ~/pkp/deploy && docker compose logs -f planner'`. Who used the
  site: section 11.
- **Another user than root:** it works the same through sudo (the user needs passwordless sudo).

The same script serves any Ubuntu 24.04 server reachable over ssh, Arm ones included. The image needs nothing x86-only:
- every native build tool in the lockfile (vite's bundler, TypeScript, esbuild) has an arm64 build;
- the run-time packages are plain JavaScript (the Dockerfile fails the build if one ever is not);
- both base images ship for arm64.

An arm64 image even builds on an x86 PC without emulation: `docker buildx build --platform linux/arm64 -t pkp-planner-data .`.

## 11. Who used it

The sign-in page asks only for the password, and says under the button what is logged: "Visits are logged with a rough
location, device and the fights you plan." The report tells visitors apart by where their IP's /24 is and whose network
it is on, and shows what each one used the planner for.

From your PC, in this repo:

```bash
bash deploy/usage.sh root@<server IP>                        # the last 7 days
bash deploy/usage.sh root@<server IP> --since 2026-11-20     # or 12h, 3d, yesterday, "2026-11-20 18:00"
```

It only reads, and never downloads or installs anything. Over ssh with the deploy key (`PKP_DEPLOY_KEY` to change it),
it runs `journalctl`, `docker logs` and python3 (which reads the location databases and the bundle's split tabs) on the
server, then prints, in Madrid time:
- the visitors grouped by rough location and provider, such as `Zaragoza, Spain · Telefonica de Espana`;
- under each location, one block per visitor: the IP's /24, first and last seen, each visit (a gap of over 30 minutes
  starts a new one), and the counts of page opens, save uploads, plan steps, Matchups sheets and AI streams. A name
  shows only if one was sent with the sign-in (a script can send one);
- in each block, from the log's usage fields (section 7):
  - `device` and `language`, the latest the visitor's browser gave, such as `Chrome 142 · Windows · desktop` and `es-ES`;
  - `save`, the saves the server took, by format then by how they came: `DeSmuME .dsv, uploaded ×1, connected ×12`
    (re-sent is the page sending the stored save again after a restart; a settings change sends it again too);
  - `run`, as the latest save left it: `2 badges · Gardenia Split · cap 28`;
  - `fights`, the trainers planned for, most planned first, at most eight and then how many more:
    `Leader Roark (12 plan steps, Matchups ×3), Commander Mars (Matchups ×1)`. The names come from the data bundle's
    split tabs on the server (`~/pkp/deploy/pkp-data/docs/`); without them, or for a trainer they do not name, the
    trainer's ID shows. The split's second trainer of one name is `2nd Barry #2`, and two of one name from different
    splits say their split (`Galactic Grunt · Galactic Split`);
  - lines logged before these fields existed give none of them, so an older visit shows only the counts;
- how many requests the password refused, and from how many /24s. Those are internet scanners, mostly.

A visitor is one browser: the page keeps its session there. The same person on a second browser or device shows as a
second visitor.

**The location** is looked up from the network address of the /24 (for `62.40.120.0/24`, `62.40.120.0`); the full
address is never logged. The city and country come from DB-IP's IP to City Lite, and the provider from its IP to ASN
Lite. It is rough:
- on mobile data, the city is often wherever the provider routes its traffic, not where the person is;
- everyone on the same Wi-Fi (a home, an office, a café) shares one location and /24, so only the session tells them
  apart;
- a visitor seen from a second /24 that is placed elsewhere shows that place beside it.

A private, reserved or unknown address, or a server without the databases, shows the visitor's block on its own,
without a location, as before.

The databases are DB-IP's free monthly downloads, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): "IP locations by DB-IP (db-ip.com)", which the report
prints at its foot. `deploy/remote.sh` keeps them in `~/pkp/geo/`, with a `SOURCE` file that names each file, where it
came from and when. They refresh on each deploy when they are more than 40 days old, with this month's files, or last
month's until this month's are out. That is about 65 MB to download (City Lite about 60 MB, ASN Lite about 5 MB,
gzipped). A failed download keeps the files already there and only warns. python3 reads them with
`python3-maxminddb`, which the deploy installs.

The lines come from the server's journal (section 7), so a redeploy no longer loses them. The journal keeps them until it
reaches its size cap (by default 10% of the disk, at most 4 GB). A planner started before the journal change logs only
inside its container, and loses its lines when that container is recreated; until then the script reads them with
`docker logs`, and says so.

**Visitors you know.** Put a labels file on your PC at `~/.config/pkp-hosted/visitor-labels` (or set
`PKP_VISITOR_LABELS`), one `<session> <label>` per line, such as `9a7b3c Sam`, using the six hex the report shows.
Those visitors, and automated checks (no session, only config or health, a script or bot for a device, such as the
deploy checks), are left out of the list and counted in one line each at the end, so the list is other people.
`--all` shows everyone.

