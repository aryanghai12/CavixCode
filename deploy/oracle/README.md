# Cavix on Oracle Cloud

Moving off Render, onto a machine that does not sleep and does not expire.

## Why this is better than what you have

| | Render free | Oracle Always Free |
|---|---|---|
| Web services | sleep after 15 min idle, cold start on the next request | always on |
| Postgres | free tier expires, and yours already did | yours, no expiry |
| Redis | free tier expires | yours, no expiry |
| Machine | a small shared box per service | 4 CPU cores, 24 GB RAM, 50 GB disk |
| Bandwidth | limited | 10 TB out per month |
| Cost | £0 until it stops working | £0, indefinitely |

The 15-minute sleep matters more than it sounds for this product. A sleeping
service means a GitHub webhook arrives at a cold box, and the first request pays
30–50 seconds of start-up before anything happens. On Oracle the orchestrator is
sitting there waiting.

The catch is that you now own the database. Render was backing it up; nothing
does that here unless something is told to, so `bootstrap.sh` installs a nightly
`pg_dump`. That is the one real responsibility this move hands you.

## What gets built

One instance, six containers, two ports open to the world:

```
                    internet
                       │
              ┌────────┴────────┐  :80 :443
              │      Caddy      │  gets and renews the certificate
              └────────┬────────┘
             /webhook  │  everything else
          ┌────────────┴────────────┐
          ▼                         ▼
   ┌─────────────┐          ┌───────────────┐
   │    edge     │          │     cavix     │  site, docs, login,
   │  (Go, hooks)│          │(control plane)│  dashboard, JSON API
   └──────┬──────┘          └───────┬───────┘
          │ queues a job            │ reads and writes
          ▼                         ▼
   ┌─────────────┐          ┌───────────────┐
   │    Redis    │          │   Postgres    │
   └──────┬──────┘          └───────────────┘
          │ takes a job
          ▼
   ┌──────────────────┐
   │   orchestrator   │  reads the diff, runs the sandbox,
   │  (review engine) │  posts the review
   └──────────────────┘
```

Same four services as `render.yaml`. The difference is that Postgres and Redis
moved inside, and Caddy replaced Render's router.

---

## The whole thing, in order

Budget about 40 minutes, most of it waiting for a build.

### 1. Sign in to Oracle Cloud and open Cloud Shell

<https://cloud.oracle.com> → sign in → click the **`>_`** icon in the top-right
toolbar. A terminal opens at the bottom of the page. It takes about 30 seconds
the first time.

Cloud Shell matters more than it looks: the `oci` command inside it is **already
signed in as you**. Getting the same CLI working on your own laptop means
generating an API key, uploading it, and copying a fingerprint into a config
file — about fifteen steps, and the usual place people give up. Doing the cloud
setup from here skips all of it.

### 2. Get this repo into Cloud Shell

```bash
git clone https://github.com/aryanghai12/CavixCode.git
cd CavixCode/deploy/oracle
```

If the repo is private, GitHub will ask for a username and password. The password
is **not** your GitHub password — it is a personal access token from
<https://github.com/settings/tokens> (classic, `repo` scope).

### 3. Create the network and the machine

```bash
./provision-oci.sh
```

This creates a VCN, a subnet, an internet gateway, the firewall rules for ports
22/80/443, and a `VM.Standard.A1.Flex` instance with 4 cores and 24 GB of RAM —
the entire Always Free Ampere allowance. It also reserves the public IP, so
stopping the instance later does not change its address.

**"Out of host capacity" is normal.** Free Ampere is heavily oversubscribed and
Oracle hands it out as it frees up. The script retries every 60 seconds across
every availability domain in your region and will usually land within an hour.
If it does not:

- Leave it running. Capacity frees up in waves, often overnight.
- Ask for a smaller slice: `CAVIX_OCPUS=1 CAVIX_MEMORY_GB=6 ./provision-oci.sh`.
  A 1-core/6 GB instance is far easier to place and still runs all of this
  comfortably. You can resize upward later without rebuilding.
- Keep the Cloud Shell tab focused. It disconnects after roughly 20 minutes idle.

When it finishes it prints the instance's IP and the exact next commands.

### 4. Put the app on the machine

From the same Cloud Shell:

```bash
ssh -i ~/.ssh/cavix_oci ubuntu@<the IP it printed>

# now on the instance:
sudo mkdir -p /opt/cavix && sudo chown $USER /opt/cavix
git clone https://github.com/aryanghai12/CavixCode.git /opt/cavix
cd /opt/cavix/deploy/oracle
./bootstrap.sh
```

`bootstrap.sh` does everything else: installs Docker, opens ports 80 and 443 on
the instance's own firewall, adds swap, generates every secret, writes `.env`,
builds all four services, starts them, waits for the TLS certificate, and
schedules nightly backups.

It asks a handful of questions. **Every one can be left blank** — press Enter
through all of them and fill things in later by editing `.env`. The only one with
a consequence if you skip it is the hostname, and it offers a working default.

### 5. About the hostname

You need a name, because HTTPS certificates are issued to names and not to IP
addresses, and GitHub OAuth will not redirect to a bare IP.

**If you own a domain**: add an A record — say `cavix.yourdomain.com` → the
instance IP — and give that to `bootstrap.sh`. Wait for it to resolve before
running, or the first certificate request fails and Caddy backs off.

**If you do not**: press Enter and take the default, which looks like
`152-67-12-34.sslip.io`. sslip.io resolves any name of that shape to the address
inside it, for free, with nothing to sign up for, and Let's Encrypt issues
certificates for it happily. It is a real, working, public HTTPS address. Swap in
a proper domain whenever you get one — change `CAVIX_DOMAIN` in `.env`, update
the four URLs in your GitHub App, `sudo docker compose up -d`.

### 6. Point your GitHub App at the new address

This is the part no script can do for you. In your GitHub App's settings
(<https://github.com/settings/apps>), replace every Render URL:

| Field | Value |
|---|---|
| Homepage URL | `https://YOUR-HOST` |
| Callback URL | `https://YOUR-HOST/api/auth/github/callback` |
| Setup URL | `https://YOUR-HOST/app` — tick "Redirect on update" |
| Webhook URL | `https://YOUR-HOST/webhook` |
| Webhook secret | the value `bootstrap.sh` printed |

Subscribe to **both** "Pull request" **and** "Issue comment". `issue_comment` is
what delivers `@cavixcode review`; without it those commands never arrive at all.

Permissions: Pull requests **Read & write**, Contents **Read**, Metadata
**Read**, and Checks **Read & write** if you want the row in the Checks box.

### 7. Copy up the App's private key

The orchestrator cannot post anything without it — a GitHub App install never
hands you a token, so it signs a JWT with this key and trades it for a
short-lived one on every review.

From your laptop:

```bash
scp your-app.private-key.pem ubuntu@<IP>:/opt/cavix/deploy/oracle/secrets/github-app.pem
```

Then on the instance: `sudo docker compose restart orchestrator`.

A file, not an environment variable, deliberately: a `.pem` is multi-line, and a
multi-line value pasted into a config field is the most common way this breaks.

### 8. Check it

```bash
curl https://YOUR-HOST/healthz          # the site
curl https://YOUR-HOST/webhook          # the edge (405 is correct — it wants POST)
sudo docker compose ps                  # everything "healthy"
```

Then open the site, sign in, connect a repository, and comment
`@cavixcode review` on a pull request. Cavix reacts 👀 within seconds and 🚀 when
the review posts. No reaction at all means the webhook never arrived — check the
App's "Recent Deliveries" page.

---

## Your data

Your Render Postgres expired, so there is nothing to migrate. The schema is a
single table that the control plane creates on first boot, so the new database
sets itself up and you start clean.

**If you still have a Render database that has not expired**, move it before it
does:

```bash
# from anywhere with psql, using Render's external connection string
pg_dump "<render external URL>" > cavix.sql

# copy it up, then on the instance:
cat cavix.sql | sudo docker compose exec -T postgres psql -U cavix -d cavix
```

One thing must come with it: **`CAVIX_SECRET_KEY` from the old Render service.**
Every stored API key and OAuth token in that dump is encrypted with it. Restore
the data under a different key and none of those blobs decrypt — and the store
treats a blob that will not decrypt as "no credential" rather than as an error,
so it does not fail loudly. The workspace comes back looking intact, with every
key and connected repository silently gone. Copy the old value into `.env` before
starting, or accept that owners re-enter their keys.

## Backups

`bootstrap.sh` installs a cron job: nightly at 03:17, `pg_dump` into
`deploy/oracle/backups/`, 14 days kept. The `.env` is copied alongside each dump,
for exactly the reason above — a database backup without `CAVIX_SECRET_KEY`
restores a workspace whose credentials all read as absent.

```bash
./backup.sh                             # back up right now
gunzip -c backups/cavix-TIMESTAMP.sql.gz | sudo docker compose exec -T postgres psql -U cavix -d cavix
```

Both copies sit on the same disk as the thing they back up, which protects you
from a bad deploy and not at all from losing the instance. Pull them down now and
then: `scp -r ubuntu@<IP>:/opt/cavix/deploy/oracle/backups ./cavix-backups`.

## Running it

```bash
cd /opt/cavix/deploy/oracle

sudo docker compose ps                  # what is running, and is it healthy
sudo docker compose logs -f cavix       # the site
sudo docker compose logs -f orchestrator
sudo docker compose restart edge        # one service
sudo docker compose down                # stop everything (data survives)
```

Deploying a change:

```bash
cd /opt/cavix && git pull
cd deploy/oracle && sudo docker compose up -d --build
```

There is no CI hook doing this for you the way Render's auto-deploy did. If you
want that back, a `git pull && docker compose up -d --build` in a cron job, or a
GitHub Actions job that SSHes in, both work — but do it deliberately, because
auto-deploying to the only machine you have is a different risk than
auto-deploying to a service you can roll back with a click.

## When it does not work

**The site times out and nothing is in any log.** A firewall, and there are two.
The VCN security list is in the console (`provision-oci.sh` sets it); the
instance's own iptables rules are on the box (`bootstrap.sh` sets those). Opening
one and not the other is the single most common way to lose an afternoon on
Oracle Cloud. Check both:

```bash
sudo iptables -L INPUT -n --line-numbers | head       # want ACCEPT on 80 and 443
oci network security-list get --security-list-id <id> # or just look in the console
```

**No certificate.** `sudo docker compose logs caddy`. Almost always DNS pointing
somewhere else, or port 80 closed — Let's Encrypt validates by making a request
to your hostname on port 80, so closing it breaks issuance *and* silently breaks
renewal 60 days later.

**The site loads but the workspace is empty.** Check the log for the database:

```bash
sudo docker compose logs cavix | grep persistence
```

`persistence: Postgres enabled` is what you want. `Postgres could not be reached
at startup` means the connection failed — and on this setup the overwhelmingly
likely cause is `CAVIX_DATABASE_SSL=off` having been removed from the compose
file. The container's hostname is `postgres`, the code reads any non-localhost
hostname as a managed database and turns TLS on, and this Postgres does not speak
TLS. The site then runs read-only, refusing writes with a 503, which is
deliberate: it is the honest version of a database it cannot save to.

**`@cavixcode review` does nothing.** In order: is the App subscribed to
`issue_comment`; does the App's "Recent Deliveries" page show the delivery and
what response it got; `sudo docker compose logs edge`.

**Out of memory during the build.** The `npm install` for this workspace is the
heaviest moment. On a 1 GB shape the swap `bootstrap.sh` adds handles it; if you
are on something smaller still, build once with
`sudo docker compose build cavix` before bringing everything up.

## What is deliberately not here

**Postgres and Redis are not published.** No `ports:` on either, so 5432 and 6379
do not exist as far as the internet is concerned. Their passwords guard against a
compromised container, not against the internet, which is why generating them
randomly and never looking at them again is fine.

**The sandbox runs `local`, not `docker`.** The docker backend gives each
candidate test its own throwaway container with `--network=none`, which is
stronger — but it needs `/var/run/docker.sock` mounted into the orchestrator, and
access to that socket is root on the host. For reviewing your own repositories,
the container boundary that is already there is the right trade. If you reach the
point of reviewing code you do not control, the answer is a second instance, not
a mounted socket.

**No auto-deploy.** See above.

## Files

| | |
|---|---|
| `provision-oci.sh` | creates the Oracle network and instance. Runs in Cloud Shell. |
| `bootstrap.sh` | turns a bare instance into the running product. Runs on the instance. |
| `docker-compose.yml` | the six containers |
| `Dockerfile.node` | control-plane and orchestrator |
| `Dockerfile.edge` | the Go webhook receiver |
| `Caddyfile` | TLS, and the `/webhook` split |
| `.env.example` | every setting, and what breaks when it is wrong |
| `backup.sh` | nightly `pg_dump`, 14 days |
