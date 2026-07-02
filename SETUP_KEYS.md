# Cavix — Keys & Secrets Setup (for non‑technical users)

This is a plain‑English companion to `GUIDE.md`. It lists **every key, secret, and
setting** the guide asks you to provide, tells you **exactly where to get each one**
(click‑by‑click), and shows **where to paste it**.

> **The single most important thing to understand first**
>
> A "key" here is just a piece of text (a password, a token, an ID). The software
> reads these from **environment variables** — named slots in your terminal. You
> don't edit the code. You just put each value into its named slot before starting
> a service.
>
> Whenever the `GUIDE.md` shows a line like `export CAVIX_X="value"`, that is the
> Mac/Linux way. **On Windows (PowerShell)** the same thing is written:
> `$env:CAVIX_X = "value"`. Both mean *"put this value into the slot named CAVIX_X."*

---

## 0. Do you even need keys right now?

**No — not to try it.** Every test and every demo in the guide runs with **zero
keys and zero internet** (`npm test`, `npm run verify-demo`, etc.). You only need
real keys when you want Cavix to **review real Pull Requests on real GitHub repos
using a real AI model.**

So there are three "levels." Pick the one you're at:

| Level | What you want to do | Keys you need |
|-------|--------------------|---------------|
| **A. Just try it** | Run tests & demos on your laptop | **None** |
| **B. Review a real PR (developer/test mode)** | Point it at one repo you own | ① AI key + ② GitHub personal token |
| **C. Go live properly (production)** | Install on repos/orgs like a real product | ① AI key + ③ GitHub App (App ID, private key, webhook secret, public URL) |
| **D. Self‑host / air‑gapped / enterprise** | Run inside your own servers | Above + ⑦ license file + ⑧ image‑signing key |

Below, each numbered key ① ② ③ … is explained once, in full.

---

## PART 1 — How to set a key on Windows (read this once)

Because you're on Windows PowerShell, here is the pattern you'll reuse for **every**
key below. Two ways:

### Option 1 — Temporary (just for the current window) — easiest to start
Open **PowerShell**, then type (example):
```powershell
$env:CAVIX_LLM_API_KEY = "sk-ant-paste-your-real-key-here"
```
This value lives **only** until you close that PowerShell window. If you close it,
you must set it again. Good for testing.

### Option 2 — Permanent (survives restarts) — better once it works
```powershell
[System.Environment]::SetEnvironmentVariable("CAVIX_LLM_API_KEY", "sk-ant-...", "User")
```
Then **close and reopen PowerShell** for it to take effect. Set it once, forget it.

### To check a value is set
```powershell
echo $env:CAVIX_LLM_API_KEY
```
If it prints your key, the slot is filled. If it prints nothing, it's empty.

> **Golden rule:** set the keys in the **same PowerShell window** where you then run
> the service (`npm run orchestrator`, etc.). Keys set in one window are not visible
> in another window unless you used the *permanent* method.

> **Never** paste real keys into a public place (GitHub, Slack, screenshots). Treat
> them like passwords.

---

## PART 2 — The keys, one by one

### ① AI model key — `CAVIX_LLM_API_KEY` (a.k.a. `ANTHROPIC_API_KEY`)

**What it is:** the password that lets Cavix talk to the AI (Claude by default).
This is what makes the actual review "thinking" happen. Needed for Levels B, C, D
(unless you run a fully air‑gapped in‑house model — see ⑥).

**Where to get it (Claude / Anthropic — the default):**
1. Open a browser and go to **https://console.anthropic.com**.
2. Sign up / log in (email + password, or Google).
3. Add a payment method: **Settings → Billing → Add credits** (a few dollars is
   plenty to test — reviews cost cents).
4. In the left menu click **API Keys**.
5. Click **Create Key**. Give it a name like `cavix`. Click **Create**.
6. **Copy the key immediately** — it starts with `sk-ant-...` and is shown **only
   once**. If you lose it, just create another.

**What it looks like:** `sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx`

**Where to feed it** (PowerShell, before starting the orchestrator):
```powershell
$env:CAVIX_LLM_API_KEY = "sk-ant-api03-...."
$env:CAVIX_LLM_PROVIDER = "anthropic"          # the AI vendor (default)
$env:CAVIX_LLM_MODEL    = "claude-opus-4-8"     # which model — see note below
```

> **Which model to put in `CAVIX_LLM_MODEL`?** Use a valid current Claude model id.
> Good choices: `claude-opus-4-8` (smartest) or `claude-sonnet-4-6` (cheaper/faster,
> the code's default). You can change it any time.

> **Want to use GPT or Gemini instead?** Set `CAVIX_LLM_PROVIDER` to that vendor and
> use that vendor's API key + model id. Get an OpenAI key at
> **https://platform.openai.com/api-keys**; a Google Gemini key at
> **https://aistudio.google.com/apikey**. The steps are the same idea: sign in →
> create key → copy → paste into `CAVIX_LLM_API_KEY`.

---

### ② GitHub personal token — `CAVIX_GITHUB_TOKEN`  *(Level B: dev / testing only)*

**What it is:** a simpler, personal GitHub password‑token so Cavix can read a PR and
post comments **as you**. This is the *quick* way to test on one repo. For a real
product you use the GitHub **App** instead (③) — don't ship this to customers.

**Where to get it (click‑by‑click):**
1. Go to **https://github.com** and log in.
2. Click your **profile picture** (top‑right) → **Settings**.
3. Scroll down the left menu to **Developer settings** (very bottom).
4. Click **Personal access tokens → Fine‑grained tokens**.
5. Click **Generate new token**.
6. **Token name:** `cavix-test`. **Expiration:** 90 days is fine.
7. **Repository access:** choose **Only select repositories** → pick the test repo
   you'll try Cavix on.
8. **Permissions → Repository permissions**, set these to the access shown:
   - **Contents:** Read‑only
   - **Pull requests:** Read and write
   - **Issues:** Read and write
   - **Checks:** Read and write
   - **Metadata:** Read‑only (auto‑selected)
9. Click **Generate token**.
10. **Copy the token now** — it starts with `github_pat_...` (older "classic" tokens
    start with `ghp_...`). Shown once.

**Where to feed it:**
```powershell
$env:CAVIX_GITHUB_TOKEN = "github_pat_...."
```
Then run `npm run orchestrator`, open a PR on that repo, and Cavix will review it.

---

### ③ The production GitHub App  *(Level C: the real way to go live)*

For a real product you register a **GitHub App** once. It gives Cavix its own
identity (`yourname[bot]`), lets customers install it with a click, and produces
short‑lived secure tokens automatically. This one app produces **three** values you
must feed in: **App ID (④)**, **Private key (⑤)**, and **Webhook secret (⑥‑below)**.

**Create the App (one time, ~10 minutes):**
1. Go to **https://github.com/settings/apps** (or for an organization:
   **Org page → Settings → Developer settings → GitHub Apps**).
2. Click **New GitHub App**.
3. **GitHub App name:** e.g. `Cavix` or `CavixCode`. ⚠️ **This name becomes the
   mention handle.** If the resulting handle is `cavixcode`, users will type
   `@cavixcode review` on their PRs. Remember it — you'll put it in `CAVIX_BOT_HANDLE`.
4. **Homepage URL:** any valid URL (your website, or even your GitHub profile).
5. **Webhook** section:
   - Tick **Active**.
   - **Webhook URL:** the public internet address of your running "edge" service,
     ending in `/webhook` — e.g. `https://your-server.com/webhook`. (If you're just
     testing locally, see **PART 4** for how to get a temporary public URL free.)
   - **Webhook secret:** make up a long random password and paste it here. **Keep a
     copy** — this exact string also goes into `CAVIX_WEBHOOK_SECRET` (⑥). Generate
     one in PowerShell with:
     ```powershell
     -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
     ```
6. **Repository permissions** — set exactly these:
   | Permission | Access |
   |------------|--------|
   | Contents | Read‑only |
   | Pull requests | Read and write |
   | Issues | Read and write |
   | Checks | Read and write |
   | Metadata | Read‑only |
7. **Subscribe to events:** tick **Pull request**, **Issue comment**,
   **Pull request review comment**, **Installation**, **Installation repositories**.
8. **Where can this app be installed:** "Only on this account" (private) or "Any
   account" (if you'll publish it publicly / on the Marketplace).
9. Click **Create GitHub App**.

Now collect the values:

#### ④ `CAVIX_APP_ID`
On the App's page (right after creating it), near the top you'll see **App ID:**
followed by a number like `123456`. That number is your App ID.
```powershell
$env:CAVIX_APP_ID = "123456"
```

#### ⑤ `CAVIX_APP_PRIVATE_KEY`
1. Still on the App's page, scroll down to **Private keys**.
2. Click **Generate a private key**. A file named something like
   `cavix.2026-07-02.private-key.pem` **downloads** to your computer.
3. This file *is* the key. You feed its **contents** (not the filename) into the
   variable. Easiest on Windows:
   ```powershell
   $env:CAVIX_APP_PRIVATE_KEY = Get-Content "C:\Users\aryan\Downloads\cavix.2026-07-02.private-key.pem" -Raw
   ```
   (Adjust the path to wherever the `.pem` downloaded.)
> Keep the `.pem` file safe and private. Anyone with it can act as your app. If it
> leaks, delete it in GitHub and generate a new one.

#### ⑥ `CAVIX_WEBHOOK_SECRET`  *(also used at Level B if you receive webhooks)*
**What it is:** a shared password that proves an incoming GitHub message is really
from GitHub and not a faker. **It must be the *exact same string* in two places:**
(a) the "Webhook secret" box you filled in step 5 above, and (b) this variable on
the edge service.
```powershell
$env:CAVIX_WEBHOOK_SECRET = "the-exact-random-string-you-put-in-github"
```
> The edge service refuses to start without this — that's on purpose (it "fails
> closed" for safety).

#### `CAVIX_BOT_HANDLE` (the `@mention` name)
Set this to your App's handle, all lowercase, no spaces, so `@yourhandle review`
works in PR comments:
```powershell
$env:CAVIX_BOT_HANDLE = "cavixcode"     # must match the App name you chose
```

**Install the App on your repos** (so it actually sees PRs):
1. On the App's page, click **Install App** (left menu).
2. Choose your account/organization.
3. Pick **All repositories** or **Only select repositories**.
4. Click **Install**. Done — Cavix now receives that repo's PR events.

---

## PART 3 — Settings you *choose* (not fetched from anywhere)

These aren't secrets you go get — they're just choices. Most have sensible defaults,
so you can **skip them** unless you want to change behavior.

> **Two exceptions — set these for a real website deployment (Level C/D):**
> `CAVIX_SESSION_SECRET` (signs dashboard login cookies) and `CAVIX_SECRET_KEY`
> (encrypts stored BYOK keys). They have insecure dev defaults, so you *can* skip them
> on your laptop, but you **must** set them before inviting real org owners. They
> aren't fetched from anywhere — you invent a long random string for each:
> ```powershell
> $env:CAVIX_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
> $env:CAVIX_SECRET_KEY     = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
> ```
> (Save the two values in your host's secret manager so restarts reuse them — if
> `CAVIX_SECRET_KEY` changes, previously stored BYOK keys can't be decrypted.)

| Variable | What it controls | What to set / default |
|----------|------------------|-----------------------|
| `CAVIX_LLM_PROVIDER` | Which AI vendor | `anthropic` (default), or `selfhosted`, or your GPT/Gemini setup |
| `CAVIX_LLM_MODEL` | Which model | e.g. `claude-opus-4-8` |
| `CAVIX_SANDBOX_BACKEND` | Where it safely runs code | `local` for your laptop; `docker` if you have Docker |
| `CAVIX_EDGE_ADDR` | Address the edge listens on | `127.0.0.1:8080` (default fine) |
| `CAVIX_REDIS_HOST` / `CAVIX_REDIS_PORT` | The queue's location | `127.0.0.1` / `6379`; **omit entirely** to use a built‑in in‑memory queue |
| `CAVIX_REDIS_ADDR` | Same, for the edge service | `127.0.0.1:6379`, or omit for in‑memory |
| `CAVIX_CONTROL_PLANE_PORT` | Dashboard web port | `8088` (default) |
| `CAVIX_FREE_REVIEWS_PER_DAY` | Free‑tier daily limit | a number, your choice |
| `CAVIX_AIRGAPPED` | Block all internet (offline mode) | `true` only for air‑gapped self‑host |

> **Redis note for a non‑tech user:** Redis is a small "waiting line" for jobs. You
> can ignore it entirely at first — if you don't set the Redis variables, Cavix uses
> a built‑in in‑memory line and just works on one machine.

---

## PART 4 — Local testing trick: giving GitHub a public URL (free)

GitHub lives on the internet and **cannot reach your laptop's `localhost`.** So when
testing the real webhook flow on your own machine, you need a temporary public
address that forwards to your laptop. Easiest free option — **smee.io**:

1. Go to **https://smee.io** in a browser.
2. Click **Start a new channel.**
3. Copy the URL it gives you (looks like `https://smee.io/AbCdEf123`).
4. Use **that** URL as the **Webhook URL** in your GitHub App (step 5 of ③).
5. In a PowerShell window, install and run the forwarder:
   ```powershell
   npm install --global smee-client
   smee --url https://smee.io/AbCdEf123 --target http://127.0.0.1:8080/webhook
   ```
6. Leave that window open. Now GitHub's messages reach your local edge service.

(`ngrok` from **https://ngrok.com** does the same job if you prefer it.)

---

## PART 5 — Enterprise / self‑host keys (Level D — only if deploying to servers)

You only touch these if you're installing Cavix into a Kubernetes cluster or an
offline (air‑gapped) environment. A non‑technical user setting this up should pair
with an IT person — but here's what each item is.

### ⑦ Offline license file — `cavix-license.json`
**What it is:** a signed file that unlocks enterprise features **without any internet
check.** You (the vendor) generate it for a customer; a customer receives it from
you. It's referenced during install:
```bash
terraform apply -var license_file=./cavix-license.json ...
```
Place the file next to the Terraform config and point `license_file` at it.

### ⑧ Image‑signing key + `COSIGN_PASSWORD` (air‑gapped installs)
**What it is:** for air‑gapped installs you copy Cavix's container images into your
*own* private registry and cryptographically **sign** them so nobody tampered with
them. `cosign.key` is the signing key file; `COSIGN_PASSWORD` is the password that
protects it. Both are created with the `cosign` tool by your IT/security team:
```bash
COSIGN_PASSWORD=yourpassword deploy/sign-images.sh registry.internal/cavix 0.3.0 cosign.key
```
These are generated by you, not fetched from a website.

---

## PART 6 — Putting it all together (copy‑paste starter blocks)

### ▶ Level B — quick test on one of your own repos (PowerShell)
```powershell
# 1) The AI key
$env:CAVIX_LLM_API_KEY = "sk-ant-...."
$env:CAVIX_LLM_MODEL   = "claude-sonnet-4-6"

# 2) Your GitHub personal token (read/post on the test repo)
$env:CAVIX_GITHUB_TOKEN = "github_pat_...."

# 3) Run it (from the project root: C:\Users\aryan\Videos\CavixCode)
npm run orchestrator
```
Then open a Pull Request in that repo and watch Cavix comment.

### ▶ Level C — production GitHub App (PowerShell)
```powershell
# --- Edge service window ---
$env:CAVIX_WEBHOOK_SECRET = "the-exact-secret-from-github"
$env:CAVIX_BOT_HANDLE     = "cavixcode"
$env:CAVIX_EDGE_ADDR      = "127.0.0.1:8080"
# (in services/edge)  go run ./cmd/edge

# --- Orchestrator window ---
$env:CAVIX_APP_ID          = "123456"
$env:CAVIX_APP_PRIVATE_KEY = Get-Content "C:\Users\aryan\Downloads\cavix....private-key.pem" -Raw
$env:CAVIX_WEBHOOK_SECRET  = "the-exact-secret-from-github"
$env:CAVIX_BOT_HANDLE      = "cavixcode"
$env:CAVIX_LLM_API_KEY     = "sk-ant-...."
$env:CAVIX_LLM_MODEL       = "claude-opus-4-8"
# npm run orchestrator
```

---

## PART 7 — Quick reference: every key at a glance

| # | Key / variable | Level | Where to get it | Where to paste it |
|---|----------------|-------|-----------------|-------------------|
| ① | `CAVIX_LLM_API_KEY` (`ANTHROPIC_API_KEY`) | B,C,D | console.anthropic.com → API Keys → Create | Orchestrator window |
| — | `CAVIX_LLM_PROVIDER` / `CAVIX_LLM_MODEL` | B,C,D | You choose | Orchestrator window |
| ② | `CAVIX_GITHUB_TOKEN` | B | github.com → Settings → Developer settings → Fine‑grained token | Orchestrator window |
| ④ | `CAVIX_APP_ID` | C | Shown on your GitHub App's page | Orchestrator window |
| ⑤ | `CAVIX_APP_PRIVATE_KEY` | C | GitHub App page → Generate private key (`.pem`) → its contents | Orchestrator window |
| ⑥ | `CAVIX_WEBHOOK_SECRET` | B/C | You invent it; paste same string in GitHub App **and** here | Edge + Orchestrator |
| — | `CAVIX_BOT_HANDLE` | C | Your App's name, lowercased | Edge + Orchestrator |
| — | Webhook URL | C | Your server, or smee.io (testing) | GitHub App settings |
| ⑦ | `cavix-license.json` | D | Vendor‑generated license file | Terraform `-var license_file` |
| ⑧ | `cosign.key` + `COSIGN_PASSWORD` | D | Your IT creates with `cosign` | `deploy/sign-images.sh` |

**Bottom line:** to review real PRs you truly only need **two** things to start —
an **AI key ①** and a **GitHub token ② (or the App ③)**. Everything else has a safe
default or is only for advanced self‑hosting.
```
