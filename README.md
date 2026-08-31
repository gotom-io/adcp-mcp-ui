# adcp-mcp-ui

A small Node/HTTP chat UI that talks to an **AdCP seller MCP server** on behalf of a
buyer. It wraps an LLM (OpenAI or Anthropic) with the AdCP tools exposed by one or
more seller MCP endpoints, and can optionally sign outbound MCP calls with
**RFC 9421 HTTP Message Signatures**.

- App entry point: [`app/server.mjs`](app/server.mjs) (plain `node:http`, no framework)
- Request signing: [`app/signing.mjs`](app/signing.mjs) + [`app/signed-http-transport.mjs`](app/signed-http-transport.mjs)
- Runs on port **3851** (host) → **3000** (container)

> This is a **public** repo. No key material or private code lives here — not even
> test keys. Everything secret comes from your local `.env` / `app/secrets/`, both
> gitignored.

---

## Prerequisites

- **Docker** + **Docker Compose** (the supported way to run it)
- **Node 20+** on the host — only needed to run the key-generation script
- SSH access to the `gotom-io` GitHub org (to clone)
- At least one LLM key: **OpenAI** and/or **Anthropic**
- The URL of an **AdCP seller MCP server** to point at (a locally-running seller +
  ngrok, or a shared dev endpoint like `https://dev-demo-mcp.gotom.io`)

---

## Quick start (5 steps)

```bash
# 1. Clone
git clone git@github.com:gotom-io/adcp-mcp-ui.git
cd adcp-mcp-ui

# 2. Create your env file and fill it in (see "Configuration" below)
cp .env.example .env
${EDITOR:-nano} .env

# 3. Create the shared docker network (idempotent — safe to re-run)
docker network create adcpnetwork 2>/dev/null || true

# 4. Build and start
docker compose up --build

# 5. Open the UI
open http://localhost:3851   # or just visit it in a browser
```

That's the whole happy path. Signed requests are **optional** and off by default —
see the section further down.

---

## Configuration

Copy `.env.example` → `.env` and set the following. Only `.env` is read; the compose
file passes these through to the container.

| Variable | What it is | Required? |
|---|---|---|
| `HOST_UID` / `HOST_GID` | Your host user/group id so container-written files are owned by you. Get them with `id -u` / `id -g`. | Yes |
| `OPENAI_API_KEY` | OpenAI key. | One of OpenAI/Anthropic |
| `ANTHROPIC_API_KEY` | Anthropic key. | One of OpenAI/Anthropic |
| `VALID_ADCP_AUTH_KEYS` | Comma-separated list of buyer API keys the UI accepts / sends to the seller as `Authorization: Bearer` (e.g. `1,2,3` in dev). | Yes |
| `MCP_SERVER_CHOICES` | JSON array of seller endpoints shown in the UI dropdown. See below. | Yes |
| `ADCP_CUSTOMER_KEYS` | Customer API keys that lock the UI to their own environments (customer mode). See below. | No (opt-in) |
| `ADCP_BUYER_*` | RFC 9421 request signing. Leave unset to disable. | No (opt-in) |

### Where to get each value

None of these are in the repo (it's public) — here's the source for each:

- **`OPENAI_API_KEY`** — create one at <https://platform.openai.com/api-keys>
  (or use a shared team key).
- **`ANTHROPIC_API_KEY`** — create one at <https://console.anthropic.com/settings/keys>
  (or use a shared team key).
- **`VALID_ADCP_AUTH_KEYS`** — these are **buyer API keys issued by the seller**.
  The seller maps each key to a buyer principal in its instance config, so you can't
  invent your own. Ask whoever operates the seller endpoint you're targeting
  (for goTom devs: the keys live in the seller's `app/config/instances/` config —
  ask the team for a dev key, or add yourself one if you run the seller locally).
- **`MCP_SERVER_CHOICES`** — the seller endpoint URL(s). Either your locally
  running seller (its ngrok URL) or a shared dev endpoint from the team.
- **`ADCP_BUYER_*` (signing)** — you generate this keypair yourself; see
  ["Enabling signed requests"](#enabling-signed-requests-rfc-9421--optional) below.
  Only the *registration* of your public key happens on the seller side.

### `MCP_SERVER_CHOICES`

A single-line JSON array of `{ "url", "label" }` objects:

```env
MCP_SERVER_CHOICES=[{"url": "https://your-ngrok-or-local-seller", "label": "Local"}, {"url": "https://dev-demo-mcp.gotom.io", "label": "Dev Demo"}]
```

If you're running the seller (`sdk-adcp-seller`) locally, put its ngrok URL here.

### `ADCP_CUSTOMER_KEYS` — customer mode (GOT-12664)

Early-access customers use the same deployment but must not reach foreign
instances. A key listed here switches the UI into **customer mode** as soon as
it is entered: the MCP server dropdown only offers that key's own environments
(fixed and disabled when there is exactly one), the AI model is pinned
(`model`, default `anthropic:claude-sonnet-5`), and the signing password,
**Get Logs** and **Session ID** disappear from the sidebar. All of it is also
enforced server-side — `/api/chat` rejects a customer key aimed at a foreign
server, and `/api/logs` refuses customer keys outright.

```env
ADCP_CUSTOMER_KEYS=[{"key": "<agency API key>", "label": "Velocity Media (demo agency)", "servers": [{"url": "https://dev-demo-mcp.gotom.io/mcp", "label": "Demo"}]}]
```

The key must be a real buyer API key from an **agency** of the instance it
points at — the seller authenticates it, this app only routes. Today there is
one instance, `demo` (see `app/config/instances/demo.ts` in `sdk-adcp-seller`),
whose agency buyer is `velocity_media`; add one entry per customer as further
instances appear. Customer keys are valid on their own — they don't need to be
repeated in `VALID_ADCP_AUTH_KEYS`. Leaving the variable unset keeps the UI
exactly as it was before this feature.

**Customer sessions never sign their MCP calls** — the API key is their only
credential, even when `ADCP_BUYER_*` signing is configured for this deployment.
That is deliberate: when a signature and an API key arrive together, the seller
keeps the *signed* identity as the buyer and demotes the key to an operator hint
(see `resolveOperatorPrincipal` in `sdk-adcp-seller/app/auth/signing/verifier.ts`
— "the key must never widen who you buy as"). Since this app's signing key maps
to a single internal principal, signing a customer's call would book their
campaign as that principal instead of their own agency. Internal sessions keep
signing unchanged.

> **Local cookie gotcha:** the UI marks its session cookie `Secure` unless
> `GOTOM_ENV=local`, and `Secure` cookies are dropped over plain `http://localhost`.
> `GOTOM_ENV` is **not** currently wired through `docker-compose.yml`, so if you hit
> cookie issues in local dev, add `GOTOM_ENV` to the `environment:` block in
> [`docker-compose.yml`](docker-compose.yml) and set `GOTOM_ENV=local` in `.env`.

---

## Enabling signed requests (RFC 9421) — optional

Signing is **opt-in**. When the `ADCP_BUYER_*` vars are unset, the app degrades to
plain fetch with API-key auth and behaves exactly as before. When enabled, the app:

1. makes one **unsigned** `get_adcp_capabilities` call to learn which operations the
   seller requires signatures for, then
2. routes MCP traffic through a fetch that signs **exactly those** operations
   (`create_media_buy` is always signed as a cold-cache safety net).

### Setup

```bash
# 1. Generate an ed25519 keypair.
#    Writes the PRIVATE JWK to app/secrets/buyer-private.jwk (chmod 600, gitignored)
#    and prints the PUBLIC JWK.
node scripts/gen-buyer-key.mjs            # or: node scripts/gen-buyer-key.mjs my-buyer-kid

# 2. Give the PUBLIC JWK (printed to stdout) to the seller so they register it.
#    The seller maps your `kid` to a buyer principal. For goTom devs: it goes
#    into `instanceSigningKeys` in the seller's `app/config/instances/` config —
#    ask the team, or add it yourself if you run the seller locally.

# 3. Add to .env  (NOTE: path is relative to the app/ dir — no leading "app/"):
#    ADCP_BUYER_PRIVATE_JWK_FILE=secrets/buyer-private.jwk
#    ADCP_BUYER_KID=<the kid printed by the script>
#    ADCP_SIGNING_PASSWORD=<a password you choose>

# 4. Restart
docker compose up --build
```

### Your buyer identity documents (served automatically)

With signing configured, the app publishes this buyer's AdCP identity —
the buy-side mirror of what a seller serves:

- `GET /.well-known/brand.json` — who this buyer is: a `buying` agent entry
  with `url` = `ADCP_BUYER_AGENT_URL` and an explicit `jwks_uri`.
- `GET /.well-known/jwks.json` — the **public** half of your signing key
  (derived from the private JWK by stripping `d`; the private scalar is
  never served).

Sellers running the AdCP discovery chain resolve your signing key through
these documents instead of having it hand-registered. Set
`ADCP_BUYER_AGENT_URL` to the deployment's public URL
(e.g. `https://adcp-ui.gotom.io/`) so the published URLs are correct.

```bash
curl -s http://localhost:3851/.well-known/brand.json | jq
curl -s http://localhost:3851/.well-known/jwks.json | jq   # must contain NO "d"
```

With signing unset both routes return 404 (no identity to publish).

### The signing password (why it exists)

The signing key belongs to the **server**, not to the person in the
browser. Without a gate, anyone who can reach a deployed UI could leave
the API-key field empty and make signed requests **as your buyer
identity**. So signature-only sessions (empty API-key field) additionally
require the **Signing Password** (sidebar field, checked server-side
against `ADCP_SIGNING_PASSWORD`).

- `ADCP_SIGNING_PASSWORD` unset ⇒ signature-only sessions are refused
  entirely (fail closed); sessions with a valid API key still work and
  still get their requests signed on top.
- Users with a valid API key never need the password.

Optional signing vars:

- `ADCP_BUYER_PRIVATE_JWK` — inline single-line private JWK instead of a file.
- `ADCP_BUYER_AGENT_URL` — informational agent origin stamped into the signature
  context (only relevant for sellers that resolve keys via `brand.json` discovery;
  ignored by sellers that pin your public key directly).

### Verifying it works

On startup with signing on, the logs show which ops the seller requires:

```
[signing] seller <url> requires signatures for: ["create_media_buy", ...]
```

If priming fails (seller unreachable / doesn't advertise signing) the app **fails
open** — signing stays off for that seller and retries shortly. Watch logs with:

```bash
docker compose logs -f app
```

Common mistakes:

- **`... is not a PRIVATE JWK (missing "d")`** — you pointed at the public JWK.
  Use `app/secrets/buyer-private.jwk`.
- **File not found** — remember the path is relative to `app/`, so it's
  `secrets/buyer-private.jwk`, not `app/secrets/buyer-private.jwk`.
- **Seller rejects the signature** — your public JWK isn't registered with the
  seller, or your `ADCP_BUYER_KID` doesn't match the JWK's `kid`.
- **`Forbidden: signature-only sessions are disabled`** — set
  `ADCP_SIGNING_PASSWORD` in `.env` and restart.
- **`Forbidden: missing or wrong signing password`** — fill the "Signing
  Password" sidebar field (or use an API key instead).

---

## Everyday commands

```bash
docker compose up --build      # build + run (foreground)
docker compose up -d           # run detached
docker compose logs -f app     # tail logs
docker compose down            # stop
```

Logs also land in `app/adcp-mcp-ui-logs/` on the host (gitignored).

## Deployment

`./deploy.sh` builds the image and ships it to the `gotom-adcp-mcp` host via
`docker save | ssh 'docker load'`, then restarts the container there using
`/root/.adcp-mcp-ui.env` on the server. Requires SSH access to that host.

## Repo layout

```
app/
  server.mjs                 HTTP server + chat loop + MCP client wiring
  signing.mjs                RFC 9421 opt-in signing (key loading, capability priming)
  signed-http-transport.mjs  MCP transport that plugs in the signing fetch
  index.template.html        UI shell
  secrets/                   your private JWK lives here (gitignored)
scripts/
  gen-buyer-key.mjs          ed25519 keypair generator for buyer signing
docker/Dockerfile            node:lts image
docker-compose.yml           service + external adcpnetwork
deploy.sh                    build & ship to the prod host
```
