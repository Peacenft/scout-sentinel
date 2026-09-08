# HTTP API

All JSON errors use this shape:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Readable explanation",
    "requestId": "request correlation id"
  }
}
```

Mutating browser requests must send an `Origin` listed in `ALLOWED_ORIGINS`. Authenticated routes accept the secure `ss_session` cookie or a bearer session token.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Database readiness |
| POST | `/v1/auth/bootstrap` | Create the first and only operator |
| POST | `/v1/auth/login` | Create a 12-hour session |
| POST | `/v1/auth/logout` | Revoke the current session |
| GET | `/v1/auth/me` | Read the current operator |
| GET | `/v1/capabilities` | Read account, execution, and mandate-compiler connection state |
| POST | `/v1/mandates` | Validate and activate a new mandate version |
| GET | `/v1/mandates/active` | Read the active mandate |
| POST | `/v1/sentinel/evaluate` | Evaluate a proposal using trusted provider state |
| POST | `/v1/evaluations/:id/confirmation` | Create or return the live confirmation request |
| POST | `/v1/confirmations/:id/accept` | Accept the exact terms hash once |
| GET | `/v1/confirmations/pending` | List unexpired approvals waiting for the operator |
| GET | `/v1/confirmations/:id` | Read one approval and its exact proposal terms |
| POST | `/v1/confirmations/:id/execute` | Consume a confirmation and submit through the configured Binance provider |
| GET | `/v1/executions/:id` | Read durable execution and provider status |
| POST | `/v1/executions/:id/reconcile` | Read Binance order status without resubmitting |
| GET | `/v1/positions` | List positions created from confirmed fill receipts |
| GET | `/v1/protection-events` | List monitoring events that need action |
| GET | `/v1/audit` | Page through audit events |
| GET | `/v1/audit/integrity` | Recalculate the audit hash chain |

## Remote MCP and OAuth

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | OAuth server discovery |
| GET | `/.well-known/oauth-protected-resource/mcp` | MCP resource discovery |
| POST | `/oauth/register` | Dynamic public-client registration |
| GET | `/oauth/authorize` | PKCE authorization and operator consent |
| POST | `/oauth/token` | Authorization-code exchange and refresh rotation |
| POST | `/oauth/revoke` | Revoke an access or refresh token |
| POST | `/mcp` | OAuth-protected Streamable HTTP MCP endpoint |

The MCP scopes are `sentinel:read`, `sentinel:evaluate`, `sentinel:confirmations`, and `sentinel:execute`. Clients receive the first three by default. Execution access must be requested explicitly. The execution tool cannot approve its own confirmation. Exact terms must be accepted with the dashboard session first.

`POST /v1/sentinel/evaluate` returns `503 binance_not_connected` until a live authenticated portfolio provider is registered. It never accepts a portfolio snapshot in the request body.

`POST /v1/confirmations/:id/execute` requires an `idempotencyKey` containing 16 to 128 letters, numbers, dots, underscores, colons, or hyphens. The same key returns the existing operation. An unclear provider result is stored as `unknown` and must be reconciled before any new submission.
