# Scout + Sentinel

Scout proposes. Sentinel decides.

Scout + Sentinel is a risk control plane for Binance Agent OS. Scout can produce trade proposals from live read-only market and account tools. Sentinel applies deterministic mandate rules before any confirmation or trade request can exist.

Live demo: https://scout-sentinel.peacenft7.workers.dev

Sentinel MCP endpoint: `https://scout-sentinel.peacenft7.workers.dev/mcp`

The current repository contains the deployable control-plane foundation, a public installation guide, and a same-origin private control room. Each private workspace can start its own Binance Agent OS OAuth connection. Account reads and trading remain fail-closed until that connection is verified and the missing portfolio and execution adapters are enabled. No route accepts browser-supplied balances, prices, exposure, profit and loss, or execution results.

## Current capabilities

- Public installation guide with no product signup
- Private agent workspaces created during Sentinel MCP consent, with opaque hashed sessions and no email or password
- Single-use, five-minute dashboard access links issued only through an authenticated Sentinel MCP connection
- Per-user Binance Agent OS OAuth using public client metadata and PKCE, with single-use state and encrypted downstream tokens
- Read-only post-OAuth verification of `spot.getAccount`, plus stored capability evidence without stored balance values
- Separate local-operator authentication with salted PBKDF2-HMAC-SHA-256 password hashes at 600,000 iterations
- Versioned JSON mandates with strict validation and SHA-256 document hashes
- Decimal-safe policy evaluation for capital, assets, venues, order size, position caps, stacking, risk budget, drawdown, stale state, and protection exits
- Live evaluation boundary that accepts proposals but obtains portfolio state only from a trusted server-side provider
- Strict Binance public-market client with bounded retries, response validation, and freshness checks
- Deterministic Scout scoring and risk-bounded sizing with visible evidence
- Ninety-second user confirmations bound to mandate, proposal, verdict, and portfolio-state hashes
- Single-use execution operations with account-level serialization and idempotency keys
- Provider reconciliation that keeps unclear submissions in an `unknown` state
- Position registration only from validated, confirmed provider fill receipts
- Durable PostgreSQL monitoring jobs with leases, retry backoff, and deduplicated protection events
- PostgreSQL audit events linked by a versioned integrity hash chain that covers event identity and timestamps
- Structured error responses, request IDs, rate limits, origin checks, security headers, and log redaction
- OAuth 2.1 authorization code flow with PKCE, dynamic client registration, rotating refresh tokens, revocation, and hashed tokens
- Streamable HTTP MCP gateway with scoped tools for Binance connection, mandate activation, status, evaluation, exact in-agent approval, execution, reconciliation, positions, and protection events
- Same-origin React experience with a public agent setup guide and a private control room for mandate management, exact trade approval, capability state, and audit inspection
- Reproducible test-database preparation and GitHub Actions verification
- Unit and PostgreSQL integration tests
- Installable `skills/scout-sentinel` package that uses read-only Binance discovery and the Sentinel gateway for policy-gated execution

The MCP gateway, per-user Binance OAuth flow, and execution state machine are implemented. Live order submission stays disabled until a real connected account completes the first hosted OAuth callback and the service adds trusted portfolio normalization plus a price-protected Spot or Convert adapter.

## Requirements

- Node.js 22 or newer
- pnpm 11.19.0 through Corepack
- PostgreSQL 17, or Docker with Compose

## Local setup

1. Copy `.env.example` to `.env` and replace every secret with a cryptographically random value. In production, set `PUBLIC_BASE_URL` to the HTTPS origin, include that origin in `ALLOWED_ORIGINS`, and set `BINANCE_TOKEN_ENCRYPTION_KEY` from `openssl rand -base64 32`.
2. Start PostgreSQL:

   ```bash
   docker compose up -d postgres
   ```

3. Enable the pinned package manager, install, and build:

   ```bash
   corepack enable
   pnpm install
   pnpm build
   ```

4. Start the API. It applies pending migrations under a PostgreSQL advisory lock before accepting traffic:

   ```bash
   pnpm start
   ```

5. Optional local administration uses an operator account created with `POST /v1/auth/bootstrap`. Supply `X-Bootstrap-Token`, email, and a password of at least 12 characters. Bootstrap closes after the first operator exists. Normal agent users do not use this account.

The API and compiled UI listen on `127.0.0.1:4100` by default. Set `HOST=0.0.0.0` only behind TLS termination and an access-controlled reverse proxy.

## Agent connection

Deploy the service over HTTPS, then add `<PUBLIC_BASE_URL>/mcp` as a remote MCP server in the agent client. The client discovers OAuth metadata, registers, and opens the consent page. Approval creates an isolated private workspace and a same-browser dashboard session without collecting an email or password. The agent calls `sentinel_connect_binance` to open Binance's own permission screen for that workspace.

The user can create a mandate and approve exact terms inside the agent with `sentinel_activate_mandate` and `sentinel_accept_confirmation`. The dashboard is optional. It provides a visual editor, approval fallback, alerts, receipts, and audit history.

If the dashboard session expires, the authenticated agent calls `sentinel_dashboard_link`. The returned URL stores its single-use token in the fragment, which keeps the token out of HTTP request logs. The browser exchanges it for an HTTP-only session, removes the fragment, and rejects any replay. Links expire after five minutes.

The validated Codex plugin package is in `plugins/scout-sentinel`. Add the deployment-specific Sentinel MCP URL after installing it. The current Scout flow also needs the official Binance MCP connection for direct live market and account reads. That second connection can be removed only after the hosted portfolio and market adapter is complete.

The dashboard provides separate setup instructions for Codex, ChatGPT, Claude Code, and other OAuth-capable HTTP MCP clients. It reads active Sentinel OAuth grants from PostgreSQL and shows them as verified connections. The guided setup also checks the Binance account provider and active mandate, then gives the user a read-only first-test prompt. A successful browser login alone does not mark an agent or Binance connection as ready.

## Tests

Unit tests:

```bash
pnpm test
```

Prepare an isolated PostgreSQL database whose name ends in `_test`, then run the integration tests:

```bash
TEST_DATABASE_URL=postgres://scout_sentinel:change_me@127.0.0.1:5432/scout_sentinel_test pnpm test:db:prepare
TEST_DATABASE_URL=postgres://scout_sentinel:change_me@127.0.0.1:5432/scout_sentinel_test pnpm test:integration
```

## Cloudflare deployment

The Worker uses Cloudflare static assets for the UI and Hyperdrive for the Neon PostgreSQL connection. `wrangler.jsonc` declares the required bindings, production variables, required secrets, observability, and smart placement.

Generate the three production secrets once, upload them, build, and deploy:

```bash
pnpm secrets:generate
wrangler secret bulk .production-secrets.local
pnpm cloudflare:deploy
```

The local secret file is mode `0600` and ignored by Git. Keep it private because it contains the one-time operator bootstrap token and the key used to encrypt Binance OAuth tokens. Run `pnpm cloudflare:types` after any binding or variable change. Run `pnpm cloudflare:check` before later deployments.

## Binance connection status

The official MCP endpoint is `https://agent.binance.com/mcp/agentic`. On 8 Sep 2026, its live metadata advertised OAuth authorization code with PKCE S256 and HTTPS client metadata documents. The connection service implements that flow and verifies `spot.getAccount` before saving an encrypted credential. The local contract test covers token exchange and schema boundaries, but a real hosted callback has not been completed yet. Futures, margin, transfers, and withdrawals remain unavailable in this product.

## Safety boundary

- Scout has no execution credential or execution service reference.
- The browser cannot provide account state used by policy.
- Sentinel evaluations expire with their state freshness window.
- Confirmation does not mean execution or fill.
- A Binance submission, timeout, or pending response is not treated as a confirmed trade.
- A confirmed buy fill creates a tracked position and durable monitor job. Protection events require user action and never bypass confirmation.
- Binance tokens use AES-256-GCM encryption with workspace-bound additional authenticated data. OAuth callback queries are stripped from request logs.
- The Agentic sub-account must contain only funds the operator accepts putting at risk.

This software is not financial advice. Availability depends on Binance account eligibility and region. No live trade has been submitted from this repository yet. Encrypted downstream token storage is complete. The remaining blockers are the first real hosted Binance callback, trusted portfolio normalization, cost basis, a price-protected order adapter, and verified order-response schemas. Every new mandate requires an explicit slippage ceiling, with 25 bps used by the moderate preset. A Codex-local Binance MCP login cannot be reused by this API.
