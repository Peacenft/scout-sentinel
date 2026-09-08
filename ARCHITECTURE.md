# Architecture

## Trust model

The API is the trusted control plane. The browser displays state and asks for actions. It cannot assert balances, prices, holdings, profit and loss, policy results, confirmation state, or provider completion.

Scout and Sentinel are capability-separated services, not prompt personas. Scout receives a read-only Binance tool registry. Sentinel receives the policy engine and, after confirmation, a narrow trade executor. Prompts may explain a result, but only deterministic code creates a verdict.

## Backend flow

1. Sentinel MCP consent creates a private user workspace. The user activates a versioned mandate in their agent or in the optional dashboard.
2. Scout reads live Binance market and account tools, scores one candidate, and emits a validated proposal.
3. Sentinel re-reads trusted account state and evaluates the proposal against the active mandate.
4. The service persists the proposal, exact state snapshot, verdict, hashes, and audit event in one transaction.
5. An approved verdict can create a confirmation request valid for 90 seconds.
6. The user confirms the exact terms hash in their agent or in the optional dashboard. Both paths call the same single-use confirmation service and require the `sentinel:confirmations` scope.
7. Execution locks the account lane, refreshes trusted account state, reevaluates policy, consumes the confirmation, and creates an idempotent Binance operation.
8. Provider responses remain `pending` or `unknown` until Binance evidence proves the intended order state. Only a validated fill receipt can mark an operation `confirmed`.
9. A confirmed buy fill creates a tracked position and leased monitor job. A drawdown breach creates one deduplicated protection event and waits for a fresh user-approved exit proposal.

## State ownership

| State | Owner |
|---|---|
| Operator identity and session | API and PostgreSQL |
| Agent OAuth clients, grants, and hashed tokens | API and PostgreSQL |
| Per-user Binance OAuth state and encrypted tokens | API and PostgreSQL |
| Active mandate and versions | API and PostgreSQL |
| Market and account observations | Binance Agent OS adapter |
| Proposal | Scout service |
| Verdict | Deterministic policy engine |
| Confirmation | API and PostgreSQL |
| Order status and receipt | Binance Agent OS, reconciled into PostgreSQL |
| Audit history | PostgreSQL hash chain |

## Concurrency and replay safety

- Mandate activation, evaluation, confirmation, and execution use PostgreSQL locks.
- Proposal IDs are unique and cannot be evaluated twice.
- Confirmation terms are immutable, short-lived, and single-use.
- Execution operations have a per-user idempotency key.
- Pending buy commitments must be included in exposure and position-cap checks before execution.

## Per-user Binance authorization

1. An authenticated workspace calls `sentinel_connect_binance` or `POST /v1/binance/connect`.
2. The service discovers Binance OAuth metadata, creates PKCE S256 state, hashes the state, and encrypts the verifier.
3. Binance redirects to the fixed public HTTPS callback. The service consumes the state once and exchanges the code without retrying.
4. The service opens Binance MCP with the returned bearer token, discovers tools, and performs one read-only `spot.getAccount` verification.
5. AES-256-GCM encrypts the token payload with workspace-bound additional authenticated data. Only capability evidence is returned to clients.
6. Disconnect deletes the local encrypted credential. Binance does not advertise a revocation endpoint, so the user is also told to remove access in Binance settings.

OAuth codes, state, PKCE verifiers, and tokens are never logged. Callback query strings are removed from request logs. Production startup rejects a missing or malformed encryption key.

## Remaining production work

- Deploy the existing client metadata and Binance OAuth callback on public HTTPS, then complete one real eligible-account authorization
- Pin the live account and write schemas using recorded redacted provider fixtures after the hosted authorization
- Live portfolio normalization with actual quote conversion and freshness metadata
- Scout orchestration endpoint that calls the verified market client, selects candidates, and persists its visible scoring evidence
- A price-protected Spot or Convert adapter using an explicit user-approved slippage limit
- Verified provider-response schema pinning against a funded canary account
- Protection exit proposal creation and confirmed sell reconciliation
- Make hosted Scout reads use the stored per-user Binance connection so users no longer need a second direct Binance MCP connection
- Browser verification against the authenticated production build
- Deployment-specific TLS, backups, metrics, alerting, and restore rehearsal
