import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { AuditEvent, Capabilities, ConfirmationReview, MandateDocument, ProtectionEvent, StoredMandate, TrackedPosition, User } from "./types";

type LoadState = "loading" | "ready" | "error";

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatMoney(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
}

function EmptyState({ title, detail, tone = "neutral" }: { title: string; detail: string; tone?: "neutral" | "safe" }) {
  return (
    <div className={`empty-state ${tone === "safe" ? "empty-safe" : ""}`}>
      <span className="empty-mark" aria-hidden="true" />
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" aria-live="polite" aria-label="Loading trusted state">
      <span className="sr-only">Loading trusted state…</span>
      <div className="skeleton skeleton-kicker" />
      <div className="skeleton skeleton-title" />
      <div className="skeleton-grid">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div className="skeleton skeleton-panel" />
    </div>
  );
}

type ReadinessItem = { label: string; value: string; ok: boolean };

function CapabilityTerminal({ readiness }: { readiness: ReadinessItem[] }) {
  return (
    <article className="bento-tile terminal-tile" aria-label="Live capability session">
      <div className="terminal-chrome">
        <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
        <span>sentinel.status</span>
        <span className="terminal-live"><i aria-hidden="true" /> live</span>
      </div>
      <div className="terminal-body" aria-live="off">
        <div className="terminal-line terminal-command"><span>$</span> sentinel status --verified</div>
        {readiness.map((item, index) => (
          <div className="terminal-line" style={{ "--line-index": index + 1 } as CSSProperties} key={item.label}>
            <span className={item.ok ? "terminal-ok" : "terminal-warn"}>{item.ok ? "ok" : "wait"}</span>
            <span>{item.label.toLowerCase().replaceAll(" ", ".")}</span>
            <strong>{item.value.toLowerCase()}</strong>
          </div>
        ))}
        <div className="terminal-cursor" aria-hidden="true"><span>$</span><i /></div>
      </div>
      <p>Results come from the live control API. No order data is invented.</p>
    </article>
  );
}

function AuditTerminal({ events, integrity }: { events: AuditEvent[]; integrity: boolean | null }) {
  const latest = events[0];
  return (
    <div className="mini-terminal" aria-label="Live audit session">
      <div className="terminal-chrome"><span>audit.verify</span><span>{events.length} loaded</span></div>
      <div className="terminal-body" aria-live="off">
        <div className="terminal-line terminal-command"><span>$</span> sentinel audit verify</div>
        <div className="terminal-line" style={{ "--line-index": 1 } as CSSProperties}>
          <span className={integrity === true ? "terminal-ok" : "terminal-warn"}>{integrity === true ? "ok" : "wait"}</span>
          <span>hash.chain</span>
          <strong>{integrity === true ? "verified" : integrity === false ? "broken" : "checking"}</strong>
        </div>
        <div className="terminal-line" style={{ "--line-index": 2 } as CSSProperties}>
          <span className="terminal-note">last</span>
          <span>event</span>
          <strong>{latest ? `#${latest.sequence} ${latest.eventType}` : "none"}</strong>
        </div>
      </div>
    </div>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="notice notice-error" role="alert">
      <span>{message}</span>
      {requestId && <code>{requestId}</code>}
    </div>
  );
}

function AuthScreen({ onAuthenticated, onBack }: { onAuthenticated: (user: User) => void; onBack: () => void }) {
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage("");
    try {
      if (mode === "bootstrap") {
        await api<{ user: User }>("/v1/auth/bootstrap", {
          method: "POST",
          headers: { "x-bootstrap-token": bootstrapToken },
          body: JSON.stringify({ email, password })
        });
        setMode("login");
        setBootstrapToken("");
        setMessage("Operator created. Sign in to continue.");
      } else {
        const result = await api<{ user: User }>("/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password })
        });
        onAuthenticated(result.user);
      }
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="product-name">
        <div className="wordmark" id="product-name"><span className="brand-mark" aria-hidden="true">S</span>Scout <b>+</b> Sentinel</div>
        <div className="auth-statement">
          <p className="eyebrow">Binance Agent OS control plane</p>
          <h1>Every trade starts with a reason. Every reason meets a rule.</h1>
          <p>Scout can inspect. Sentinel can refuse. Execution stays locked until the mandate, live state, and exact order terms agree.</p>
          <div className="auth-flow" aria-label="How Scout and Sentinel work">
            <span>Discover</span><i aria-hidden="true" /><span>Check</span><i aria-hidden="true" /><span>Approve</span><i aria-hidden="true" /><span>Record</span>
          </div>
        </div>
        <div className="boundary-line" aria-label="Agent boundaries">
          <span><i className="status-dot status-info" />Scout · read only</span>
          <span><i className="status-dot status-ok" />Sentinel · policy gated</span>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <div>
          <p className="eyebrow">Operator access</p>
          <h2 id="auth-title">{mode === "login" ? "Sign in" : "First setup"}</h2>
        </div>
        {message && <div className="notice notice-success" role="status">{message}</div>}
        {error !== null ? <ErrorNotice error={error} /> : null}
        <form onSubmit={submit} className="form-stack">
          <label>
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            <span>Password</span>
            <input type="password" minLength={12} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {mode === "bootstrap" && (
            <label>
              <span>Bootstrap token</span>
              <input type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required />
              <small>Read it from the server environment. It isn’t stored in this browser.</small>
            </label>
          )}
          <button className="button button-primary" type="submit" disabled={submitting}>
            {submitting ? "Working…" : mode === "login" ? "Enter control room" : "Create operator"}
          </button>
        </form>
        <button className="button-link" type="button" onClick={() => { setMode(mode === "login" ? "bootstrap" : "login"); setError(null); }}>
          {mode === "login" ? "Run first setup" : "Return to sign in"}
        </button>
        <button className="button-link" type="button" onClick={onBack}>Back to installation</button>
      </section>
    </main>
  );
}

type MandateFormState = {
  name: string;
  baseCurrency: string;
  capitalUsd: string;
  maxDrawdownPct: string;
  maxOrderUsd: string;
  maxSlippageBps: string;
  allowedAssets: string;
  allowedVenues: Array<"spot" | "convert">;
  maxHoldings: string;
  exitIfLossPct: string;
};

const emptyMandate: MandateFormState = {
  name: "",
  baseCurrency: "USDC",
  capitalUsd: "",
  maxDrawdownPct: "",
  maxOrderUsd: "",
  maxSlippageBps: "25",
  allowedAssets: "BTC, ETH, USDC",
  allowedVenues: ["spot", "convert"],
  maxHoldings: "",
  exitIfLossPct: ""
};

function parseMandate(form: MandateFormState): MandateDocument {
  const allowedAssets = [...new Set(form.allowedAssets.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
  const maxHoldingsUsd = Object.fromEntries(
    form.maxHoldings.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [asset, amount, extra] = line.split("=").map((value) => value.trim());
      if (!asset || !amount || extra) throw new Error("Position caps must use one ASSET=AMOUNT entry per line.");
      return [asset.toUpperCase(), amount];
    })
  );
  return {
    name: form.name,
    baseCurrency: form.baseCurrency.trim().toUpperCase(),
    capitalUsd: form.capitalUsd,
    goal: "preserve",
    maxDrawdownPct: form.maxDrawdownPct,
    maxOrderUsd: form.maxOrderUsd,
    maxSlippageBps: form.maxSlippageBps,
    allowedAssets,
    allowedVenues: form.allowedVenues,
    forbidFutures: true,
    forbidWithdraw: true,
    requireUserConfirm: true,
    maxHoldingsUsd,
    exitIfLossPct: form.exitIfLossPct,
    minLiquidity: "can_exit_via_convert_or_spot"
  };
}

function formFromMandate(mandate?: StoredMandate): MandateFormState {
  if (!mandate) return emptyMandate;
  const document = mandate.document;
  return {
    name: document.name,
    baseCurrency: document.baseCurrency,
    capitalUsd: document.capitalUsd,
    maxDrawdownPct: document.maxDrawdownPct,
    maxOrderUsd: document.maxOrderUsd,
    maxSlippageBps: document.maxSlippageBps ?? "25",
    allowedAssets: document.allowedAssets.join(", "),
    allowedVenues: document.allowedVenues,
    maxHoldings: Object.entries(document.maxHoldingsUsd).map(([asset, amount]) => `${asset}=${amount}`).join("\n"),
    exitIfLossPct: document.exitIfLossPct
  };
}

function MandateEditor({ initial, onSaved, onCancel }: { initial?: StoredMandate; onSaved: (mandate: StoredMandate) => void; onCancel?: () => void }) {
  const [form, setForm] = useState(() => formFromMandate(initial));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof MandateFormState, value: MandateFormState[typeof key]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ mandate: StoredMandate }>("/v1/mandates", { method: "POST", body: JSON.stringify(parseMandate(form)) });
      onSaved(result.mandate);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  }

  function toggleVenue(venue: "spot" | "convert") {
    const next = form.allowedVenues.includes(venue)
      ? form.allowedVenues.filter((item) => item !== venue)
      : [...form.allowedVenues, venue];
    set("allowedVenues", next);
  }

  return (
    <form className="mandate-form" onSubmit={submit}>
      {error !== null ? <ErrorNotice error={error} /> : null}
      <div className="field-grid two">
        <label className="span-two"><span>Mandate name</span><input value={form.name} onChange={(event) => set("name", event.target.value)} required /></label>
        <label><span>Sleeve capital, USD</span><input inputMode="decimal" value={form.capitalUsd} onChange={(event) => set("capitalUsd", event.target.value)} required /></label>
        <label><span>Base currency</span><input value={form.baseCurrency} onChange={(event) => set("baseCurrency", event.target.value)} required /></label>
        <label><span>Maximum drawdown, %</span><input inputMode="decimal" value={form.maxDrawdownPct} onChange={(event) => set("maxDrawdownPct", event.target.value)} required /></label>
        <label><span>Protection exit at loss, %</span><input inputMode="decimal" value={form.exitIfLossPct} onChange={(event) => set("exitIfLossPct", event.target.value)} required /></label>
        <label><span>Maximum order, USD</span><input inputMode="decimal" value={form.maxOrderUsd} onChange={(event) => set("maxOrderUsd", event.target.value)} required /></label>
        <label><span>Maximum slippage, bps</span><input inputMode="decimal" value={form.maxSlippageBps} onChange={(event) => set("maxSlippageBps", event.target.value)} required /><small>25 bps equals 0.25%.</small></label>
        <label><span>Allowed assets</span><input value={form.allowedAssets} onChange={(event) => set("allowedAssets", event.target.value)} required /></label>
      </div>
      <fieldset>
        <legend>Allowed venues</legend>
        <label className="check"><input type="checkbox" checked={form.allowedVenues.includes("spot")} onChange={() => toggleVenue("spot")} /> Spot</label>
        <label className="check"><input type="checkbox" checked={form.allowedVenues.includes("convert")} onChange={() => toggleVenue("convert")} /> Convert</label>
      </fieldset>
      <label>
        <span>Position caps, one per line</span>
        <textarea rows={4} value={form.maxHoldings} onChange={(event) => set("maxHoldings", event.target.value)} required />
        <small>Use ASSET=USD cap, one entry per line. Example: BTC=120.</small>
      </label>
      <div className="fixed-rules">
        <span>Futures blocked</span><span>Withdrawals blocked</span><span>Confirmation required</span><span>One-step exit required</span>
      </div>
      <div className="button-row">
        <button className="button button-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Activate mandate"}</button>
        {onCancel && <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function MandateView({ mandate, onReplace }: { mandate: StoredMandate; onReplace: () => void }) {
  const document = mandate.document;
  const capital = Number(document.capitalUsd);
  const orderShare = clampPercent((Number(document.maxOrderUsd) / capital) * 100);
  const drawdownShare = clampPercent(Number(document.maxDrawdownPct));
  return (
    <div className="mandate-view">
      <div className="mandate-lead">
        <div><span className="status-dot status-ok" /> Active · version {mandate.version}</div>
        <button className="button button-secondary" onClick={onReplace}>Replace mandate</button>
      </div>
      <h3>{document.name}</h3>
      <div className="metric-row">
        <div><span>Capital</span><strong>{formatMoney(document.capitalUsd)}</strong><small>Protected sleeve</small></div>
        <div><span>Drawdown halt</span><strong>{document.maxDrawdownPct}%</strong><small>Loss boundary</small></div>
        <div><span>Order ceiling</span><strong>{formatMoney(document.maxOrderUsd)}</strong><small>{orderShare.toFixed(0)}% of capital</small></div>
        <div><span>Slippage ceiling</span><strong>{document.maxSlippageBps ?? "Missing"} bps</strong><small>Per execution</small></div>
      </div>
      <div className="risk-visual" aria-label="Mandate risk limits">
        <div className="risk-track-row">
          <div><span>Maximum order</span><strong>{orderShare.toFixed(0)}% of sleeve</strong></div>
          <div className="risk-track"><span style={{ width: `${orderShare}%` }} /></div>
        </div>
        <div className="risk-track-row">
          <div><span>Drawdown stop</span><strong>{drawdownShare.toFixed(1)}%</strong></div>
          <div className="risk-track risk-track-warning"><span style={{ width: `${drawdownShare}%` }} /></div>
        </div>
      </div>
      <dl className="rule-list">
        <div><dt>Assets</dt><dd>{document.allowedAssets.join(" · ")}</dd></div>
        <div><dt>Venues</dt><dd>{document.allowedVenues.join(" · ")}</dd></div>
        <div><dt>Exit trigger</dt><dd>{document.exitIfLossPct}% sleeve loss</dd></div>
        <div><dt>Document hash</dt><dd><code title={mandate.documentHash}>{mandate.documentHash.slice(0, 16)}…</code></dd></div>
      </dl>
    </div>
  );
}

function AgentLane({ capabilities, hasMandate }: { capabilities: Capabilities | null; hasMandate: boolean }) {
  const connected = capabilities?.binance.accountState === "connected";
  const portfolioReady = capabilities?.binance.portfolioState === "connected";
  const executionConnected = capabilities?.binance.execution === "connected";
  return (
    <section className="agent-lane" aria-labelledby="agent-lane-title">
      <div className="section-heading">
        <div><p className="eyebrow">Decision lane</p><h2 id="agent-lane-title">Proposal to permission</h2></div>
        <span className={`connection-pill ${connected ? "connected" : "blocked"}`}>{connected ? "Binance connected" : "Binance disconnected"}</span>
      </div>
      <div className="lane-grid">
        <article className="agent-panel scout-panel">
          <div className="agent-index">01</div>
          <div><p className="eyebrow">Read only</p><h3>Scout</h3></div>
          <p>Reads Spot price, book, candles, and the Agentic account. Produces one scored proposal or HOLD.</p>
          <div className={`locked-action ${connected && portfolioReady && hasMandate ? "ready-action" : ""}`}>
            {connected && portfolioReady && hasMandate ? "Ready in your agent" : "Hosted Scout unavailable"}
          </div>
          <small>{connected && portfolioReady && hasMandate ? "Start a scan by talking to Scout + Sentinel in your agent." : connected && hasMandate ? "The account is verified. The hosted portfolio adapter is still required." : "An active mandate and account connection are required."}</small>
        </article>
        <div className="lane-divider" aria-hidden="true"><span>policy</span></div>
        <article className="agent-panel sentinel-panel">
          <div className="agent-index">02</div>
          <div><p className="eyebrow">Deterministic gate</p><h3>Sentinel</h3></div>
          <p>Rechecks live state, enforces the active mandate, and creates an expiring confirmation only when every rule passes.</p>
          <div className={`locked-action ${executionConnected ? "ready-action" : ""}`}>
            {executionConnected ? "Execution provider ready" : "Execution disabled"}
          </div>
          <small>{executionConnected ? "Every order still needs a fresh policy pass and exact confirmation." : "The price-protected Binance execution adapter is still required."}</small>
        </article>
      </div>
    </section>
  );
}

function PositionWatch({ positions, alerts }: { positions: TrackedPosition[]; alerts: ProtectionEvent[] }) {
  const activeAlerts = alerts.filter((event) => event.status === "action_required");
  const largestPosition = Math.max(...positions.map((position) => Number(position.openedQuoteQuantity)), 0);
  return (
    <section className="watch-section" aria-labelledby="watch-title">
      <div className="section-heading">
        <div><p className="eyebrow">Sentinel watch</p><h2 id="watch-title">Positions and protection</h2></div>
        <span className={`connection-pill ${activeAlerts.length > 0 ? "alert" : "connected"}`}>
          {activeAlerts.length > 0 ? `${activeAlerts.length} action required` : "No open alerts"}
        </span>
      </div>
      {activeAlerts.map((event) => (
        <div className="protection-alert" role="alert" key={event.id}>
          <div><strong>{event.details.baseAsset ?? "Position"} reached a protection condition</strong><span>{event.eventType.replaceAll("_", " ")}</span></div>
          <div><span>Loss</span><strong>${event.details.lossUsd ?? "unknown"}</strong></div>
          <div><span>Limit</span><strong>${event.details.thresholdUsd ?? "unknown"}</strong></div>
        </div>
      ))}
      {positions.length === 0 ? (
        <EmptyState title="No positions under watch" detail="A position appears here only after Binance confirms a real fill." tone="safe" />
      ) : (
        <div className="position-table" role="table" aria-label="Tracked positions">
          <div className="position-row position-head" role="row">
            <span>Asset</span><span>Opened amount</span><span>Cost</span><span>Status</span>
          </div>
          {positions.map((position) => (
            <div className="position-row" role="row" key={position.id}>
              <div className="position-asset"><strong>{position.baseAsset}/{position.quoteAsset}</strong><span className="exposure-bar"><i style={{ width: `${clampPercent((Number(position.openedQuoteQuantity) / largestPosition) * 100)}%` }} /></span></div>
              <span>{position.openedBaseQuantity} {position.baseAsset}</span>
              <span>{position.openedQuoteQuantity} {position.quoteAsset}</span>
              <span className={`position-status ${position.monitorStatus === "failed" ? "failed" : position.status}`}>
                {position.monitorStatus === "failed" ? "watch failed" : position.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ApprovalQueue({ confirmations, onApproved }: { confirmations: ConfirmationReview[]; onApproved: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const requestedId = new URLSearchParams(window.location.search).get("confirmation");
  const ordered = [...confirmations].sort((left, right) => Number(right.id === requestedId) - Number(left.id === requestedId));

  async function approve(confirmation: ConfirmationReview) {
    setApprovingId(confirmation.id);
    setError(null);
    try {
      await api(`/v1/confirmations/${confirmation.id}/accept`, {
        method: "POST",
        body: JSON.stringify({ termsHash: confirmation.termsHash })
      });
      window.history.replaceState({}, "", window.location.pathname);
      onApproved();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setApprovingId(null);
    }
  }

  if (confirmations.length === 0) return null;
  return (
    <section className="approval-section" aria-labelledby="approval-title">
      <div className="section-heading">
        <div><p className="eyebrow">Human approval</p><h2 id="approval-title">Review exact trade</h2></div>
        <span className="connection-pill alert">{confirmations.length} waiting</span>
      </div>
      {error !== null ? <ErrorNotice error={error} /> : null}
      <div className="approval-list">
        {ordered.map((confirmation) => (
          <article className={confirmation.id === requestedId ? "approval-card requested" : "approval-card"} key={confirmation.id}>
            <div className="approval-main">
              <span>{confirmation.proposal.side} · {confirmation.proposal.venue}</span>
              <h3>{confirmation.proposal.baseAsset}/{confirmation.proposal.quoteAsset}</h3>
              <p>{confirmation.proposal.thesis}</p>
            </div>
            <dl>
              <div><dt>Maximum notional</dt><dd>${confirmation.proposal.notionalUsd}</dd></div>
              <div><dt>Expected risk</dt><dd>${confirmation.proposal.expectedRiskUsd}</dd></div>
              <div><dt>Expires</dt><dd>{new Date(confirmation.expiresAt).toLocaleTimeString()}</dd></div>
              <div><dt>Terms hash</dt><dd><code title={confirmation.termsHash}>{confirmation.termsHash.slice(0, 16)}…</code></dd></div>
            </dl>
            <div className="button-row">
              <button className="button button-primary" disabled={approvingId !== null || new Date(confirmation.expiresAt).getTime() <= Date.now()} onClick={() => void approve(confirmation)}>
                {approvingId === confirmation.id ? "Approving…" : "Approve exact terms"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

type AgentPlatform = "codex" | "chatgpt" | "claude" | "other";

const platformChoices: Array<{ id: AgentPlatform; name: string; detail: string; badge: string }> = [
  { id: "codex", name: "Codex", detail: "Install the plugin or connect both MCP servers.", badge: "Full workflow" },
  { id: "chatgpt", name: "ChatGPT", detail: "Add the app, then mention it in a chat.", badge: "Plan limits apply" },
  { id: "claude", name: "Claude Code", detail: "Add both remote MCP servers from the CLI.", badge: "CLI setup" },
  { id: "other", name: "Another agent", detail: "Use any client with HTTP MCP and OAuth.", badge: "MCP compatible" }
];

const platformStorageKey = "scout-sentinel:agent-platform:v1";

function savedPlatform(): AgentPlatform {
  try {
    const value = window.localStorage.getItem(platformStorageKey);
    return platformChoices.some((platform) => platform.id === value) ? value as AgentPlatform : "codex";
  } catch {
    return "codex";
  }
}

function PublicLanding({ onOperatorAccess, accessError }: { onOperatorAccess: () => void; accessError: unknown }) {
  const [platform, setPlatform] = useState<AgentPlatform>(savedPlatform);
  const [copied, setCopied] = useState<"commands" | "endpoint" | "prompt" | "failed" | null>(null);
  const sentinelEndpoint = `${window.location.origin}/mcp`;
  const binanceEndpoint = "https://agent.binance.com/mcp/agentic";
  const codexCommands = `codex mcp add binance-mcp-server --url ${binanceEndpoint}\ncodex mcp login binance-mcp-server\n\ncodex mcp add scout-sentinel --url ${sentinelEndpoint}\ncodex mcp login scout-sentinel`;
  const claudeCommands = `claude mcp add --transport http --scope user binance-agent-os ${binanceEndpoint}\nclaude mcp add --transport http --scope user scout-sentinel ${sentinelEndpoint}\n\n# Then open Claude Code and run:\n/mcp`;
  const safePrompt = "Use Scout + Sentinel in read-only mode. Show my Binance Agentic account balances and connection status. Do not create an approval or execute anything.";

  function choosePlatform(next: AgentPlatform) {
    setPlatform(next);
    try { window.localStorage.setItem(platformStorageKey, next); } catch { /* Preference remains session-only. */ }
  }

  async function copy(value: string, target: "commands" | "endpoint" | "prompt") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 2200);
  }

  return (
    <div className="public-shell">
      <a className="skip-link" href="#install">Skip to installation</a>
      <header className="public-topbar">
        <a className="wordmark small" href="#top" aria-label="Scout and Sentinel home"><span className="brand-mark" aria-hidden="true">S</span><span>Scout <b>+</b> Sentinel</span></a>
        <nav aria-label="Public sections"><a href="#install">Install</a><a href="#workflow">How it works</a><a href="#controls">Controls</a></nav>
        <button className="button button-secondary" type="button" onClick={onOperatorAccess}>Operator access</button>
      </header>

      <main id="top">
        <section className="public-hero" aria-labelledby="public-title">
          <div>
            <p className="eyebrow">A Binance Agent OS skill</p>
            <h1 id="public-title">Use the agent you already have.</h1>
            <p>Install Scout + Sentinel in ChatGPT, Codex, Claude Code, or another MCP client. Ask naturally. Your agent reads Binance, checks your rules, and stops for approval before any supported trade.</p>
            <div className="hero-actions"><a className="button button-primary" href="#install">Choose your agent</a><a className="text-link" href="#workflow">See the flow <span aria-hidden="true">↘</span></a></div>
          </div>
          <article className="public-flow-panel" aria-label="Product boundaries">
            <p className="eyebrow">Where each part lives</p>
            <ol>
              <li><span>01</span><div><strong>Your agent</strong><p>The conversation, live Binance tool use, and recommendation.</p></div></li>
              <li><span>02</span><div><strong>Sentinel</strong><p>Risk rules, exact approval, monitoring, and audit history.</p></div></li>
              <li><span>03</span><div><strong>Binance Agent OS</strong><p>Account authorization and supported market or trade actions.</p></div></li>
            </ol>
          </article>
        </section>

        {accessError !== null ? <div className="public-access-error"><ErrorNotice error={accessError} /><p>Ask your connected agent to open your Sentinel dashboard again. Each link works once and expires after five minutes.</p></div> : null}

        <section className="public-install" id="install" aria-labelledby="install-title">
          <div className="section-heading setup-heading"><div><p className="eyebrow">Start here</p><h2 id="install-title">Choose where you talk.</h2><p>No Scout + Sentinel signup is required. Connecting the Sentinel MCP creates your private workspace.</p></div><span className="step-time">About 3 minutes</span></div>
          <div className="platform-picker" role="group" aria-label="Choose your agent environment">
            {platformChoices.map((choice) => (
              <button type="button" className={`platform-card ${platform === choice.id ? "selected" : ""}`} aria-pressed={platform === choice.id} onClick={() => choosePlatform(choice.id)} key={choice.id}>
                <span>{choice.badge}</span><strong>{choice.name}</strong><small>{choice.detail}</small><i aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="public-guide-grid">
            <article className="guide-panel">
              <div className="guide-panel-heading"><div><p className="eyebrow">Installation</p><h3>{platformChoices.find((choice) => choice.id === platform)?.name}</h3></div></div>
              {(platform === "codex" || platform === "claude") && (
                <>
                  <ol className="guided-steps">
                    <li><span>01</span><div><strong>Add both services</strong><p>Connect Binance Agent OS for live Binance tools, then connect Scout + Sentinel for rules and monitoring.</p></div></li>
                    <li><span>02</span><div><strong>Approve access</strong><p>Binance handles its own permissions. Sentinel creates a private workspace without asking for an email or password.</p></div></li>
                    <li><span>03</span><div><strong>Talk naturally</strong><p>Ask for an allocation, review the evidence, and approve only the exact action you accept.</p></div></li>
                  </ol>
                  <div className="command-box"><div><span>{platform} setup</span><button type="button" onClick={() => void copy(platform === "codex" ? codexCommands : claudeCommands, "commands")}>{copied === "commands" ? "Copied" : "Copy commands"}</button></div><pre><code>{platform === "codex" ? codexCommands : claudeCommands}</code></pre></div>
                </>
              )}
              {platform === "chatgpt" && (
                <ol className="guided-steps">
                  <li><span>01</span><div><strong>Add both apps</strong><p>Open Settings, then Apps. Add Binance Agent OS and Scout + Sentinel when the published app is available.</p></div></li>
                  <li><span>02</span><div><strong>Approve each connection</strong><p>Binance controls account scopes. Sentinel creates your private rule workspace.</p></div></li>
                  <li><span>03</span><div><strong>Mention the skill</strong><p>Choose Scout + Sentinel in the chat, then ask for the allocation you want.</p></div></li>
                </ol>
              )}
              {platform === "other" && (
                <>
                  <ol className="guided-steps">
                    <li><span>01</span><div><strong>Check compatibility</strong><p>Your client must support remote HTTP MCP, OAuth, and confirmation for write tools.</p></div></li>
                    <li><span>02</span><div><strong>Add both endpoints</strong><p>Use the official Binance MCP endpoint and this Sentinel MCP endpoint.</p></div></li>
                    <li><span>03</span><div><strong>Add the skill instructions</strong><p>Import Scout + Sentinel if your client supports skills. Otherwise call the tools directly.</p></div></li>
                  </ol>
                  <div className="endpoint-stack"><div><span>Binance Agent OS</span><code>{binanceEndpoint}</code></div><div><span>Sentinel MCP</span><code>{sentinelEndpoint}</code><button type="button" onClick={() => void copy(sentinelEndpoint, "endpoint")}>{copied === "endpoint" ? "Copied" : "Copy"}</button></div></div>
                </>
              )}
            </article>
            <aside className="public-next-panel">
              <p className="eyebrow">After connection</p>
              <h3>Stay in your agent.</h3>
              <p>Use the dashboard only when you want to change risk rules, approve exact terms, inspect alerts, or review history.</p>
              <div className="safe-test-compact"><span>First read-only request</span><blockquote>{safePrompt}</blockquote><button className="button button-primary" type="button" onClick={() => void copy(safePrompt, "prompt")}>{copied === "prompt" ? "Prompt copied" : copied === "failed" ? "Copy failed" : "Copy safe test"}</button></div>
              <p className="agent-return">Already connected? Ask your agent: <q>Open my Sentinel dashboard.</q></p>
            </aside>
          </div>
        </section>

        <section className="public-workflow" id="workflow" aria-labelledby="workflow-title">
          <div><p className="eyebrow">Daily use</p><h2 id="workflow-title">One conversation. Clear boundaries.</h2></div>
          <ol><li><span>01</span><strong>Ask</strong><p>Describe the amount, goal, and risk level.</p></li><li><span>02</span><strong>Scout</strong><p>Reads live Binance data and explains one proposal or HOLD.</p></li><li><span>03</span><strong>Sentinel</strong><p>Checks the proposal against your saved limits.</p></li><li><span>04</span><strong>You decide</strong><p>Approve exact terms or leave the action blocked.</p></li></ol>
        </section>

        <section className="public-controls" id="controls" aria-labelledby="controls-title"><div><p className="eyebrow">Optional control center</p><h2 id="controls-title">Open the dashboard only when needed.</h2></div><div className="control-grid"><article><span>01</span><h3>Rules</h3><p>Set capital, asset, venue, loss, size, and slippage limits.</p></article><article><span>02</span><h3>Approvals</h3><p>Review the exact order terms before Sentinel can continue.</p></article><article><span>03</span><h3>Evidence</h3><p>Inspect monitoring events, execution receipts, and the audit chain.</p></article></div></section>
      </main>
      <footer className="public-footer"><span>Scout reads. Sentinel checks. You approve.</span><button className="button-link" type="button" onClick={onOperatorAccess}>Local operator access</button></footer>
    </div>
  );
}

function AgentSetup({ capabilities, hasMandate, onRefresh }: { capabilities: Capabilities; hasMandate: boolean; onRefresh: () => void }) {
  const [platform, setPlatform] = useState<AgentPlatform>(savedPlatform);
  const [copied, setCopied] = useState<"endpoint" | "commands" | "prompt" | "failed" | null>(null);
  const [binanceAction, setBinanceAction] = useState<"connecting" | "disconnecting" | null>(null);
  const [binanceError, setBinanceError] = useState<unknown>(null);
  const endpoint = capabilities.agentGateway.endpoint;
  const binanceEndpoint = "https://agent.binance.com/mcp/agentic";
  const agentConnected = capabilities.agentGateway.connections.length > 0;
  const binanceConnected = capabilities.binance.accountState === "connected";
  const portfolioReady = capabilities.binance.portfolioState === "connected";
  const canScout = agentConnected && binanceConnected && portfolioReady && hasMandate;
  const executionScope = capabilities.agentGateway.connections.some((connection) => connection.scopes.includes("sentinel:execute"));
  const canExecute = canScout && executionScope && capabilities.binance.execution === "connected";
  const safePrompt = "Use Scout + Sentinel in read-only mode. Show my Binance Agentic account balances and connection status. Do not create an approval or execute anything.";
  const codexCommands = `codex mcp add binance-mcp-server --url ${binanceEndpoint}\ncodex mcp login binance-mcp-server\n\ncodex mcp add scout-sentinel --url ${endpoint}\ncodex mcp login scout-sentinel`;
  const claudeCommands = `claude mcp add --transport http --scope user binance-agent-os ${binanceEndpoint}\nclaude mcp add --transport http --scope user scout-sentinel ${endpoint}\n\n# Then open Claude Code and run:\n/mcp`;
  const commands = platform === "claude" ? claudeCommands : codexCommands;
  const progress = [
    { label: "Private workspace", detail: "Opened through your agent or local operator", ok: true, href: undefined },
    { label: "Binance connection", detail: binanceConnected ? "Read-only account check passed" : "Connect Binance before scanning", ok: binanceConnected, href: undefined },
    { label: "Agent connection", detail: agentConnected ? `${capabilities.agentGateway.connections.length} active connection${capabilities.agentGateway.connections.length === 1 ? "" : "s"}` : "Connect Sentinel MCP from your agent", ok: agentConnected, href: undefined },
    { label: "Risk mandate", detail: hasMandate ? "Active policy is ready" : "Set the limits Sentinel must enforce", ok: hasMandate, href: "#mandate" }
  ];
  const completed = progress.filter((item) => item.ok).length;

  function choosePlatform(next: AgentPlatform) {
    setPlatform(next);
    try { window.localStorage.setItem(platformStorageKey, next); } catch { /* Preference remains session-only. */ }
  }

  async function copy(value: string, target: "endpoint" | "commands" | "prompt") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 2200);
  }

  async function connectBinance() {
    setBinanceAction("connecting");
    setBinanceError(null);
    try {
      const result = await api<{ authorizationUrl: string }>("/v1/binance/connect", { method: "POST" });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setBinanceError(error);
      setBinanceAction(null);
    }
  }

  async function disconnectBinance() {
    if (!window.confirm("Remove Sentinel's stored Binance access? You should also disconnect Scout + Sentinel in Binance account settings.")) return;
    setBinanceAction("disconnecting");
    setBinanceError(null);
    try {
      await api<void>("/v1/binance/connection", { method: "DELETE" });
      onRefresh();
    } catch (error) {
      setBinanceError(error);
    } finally {
      setBinanceAction(null);
    }
  }

  return (
    <section className="setup-section" aria-labelledby="setup-title">
      <div className="section-heading setup-heading">
        <div><p className="eyebrow">Start here · guided setup</p><h2 id="setup-title">Where will you use it?</h2><p>Choose your agent. The steps below change for that app.</p></div>
        <div className="setup-score" aria-label={`${completed} of ${progress.length} setup steps complete`}><strong>{completed}/{progress.length}</strong><span>setup complete</span></div>
      </div>

      <div className="platform-picker" role="group" aria-label="Choose your agent environment">
        {platformChoices.map((choice) => (
          <button type="button" className={`platform-card ${platform === choice.id ? "selected" : ""}`} aria-pressed={platform === choice.id} onClick={() => choosePlatform(choice.id)} key={choice.id}>
            <span>{choice.badge}</span><strong>{choice.name}</strong><small>{choice.detail}</small><i aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="onboarding-grid">
        <article className="guide-panel">
          <div className="guide-panel-heading"><div><p className="eyebrow">Your instructions</p><h3>{platformChoices.find((choice) => choice.id === platform)?.name}</h3></div><span className="step-time">About 3 minutes</span></div>

          {platform === "codex" && (
            <ol className="guided-steps">
              <li><span>01</span><div><strong>Use the plugin</strong><p>Open Plugins, install Scout + Sentinel, then connect both included services. If the plugin isn’t published in your workspace, use the commands below.</p></div></li>
              <li><span>02</span><div><strong>Enable it in a task</strong><p>Open Sources, choose Use plugins, then select Scout + Sentinel.</p></div></li>
              <li><span>03</span><div><strong>Talk normally</strong><p>Ask for an allocation, review the proposal, and approve exact terms in the agent. This dashboard stays optional.</p></div></li>
            </ol>
          )}
          {platform === "chatgpt" && (
            <ol className="guided-steps">
              <li><span>01</span><div><strong>Add the app</strong><p>Open Settings → Apps. Install Scout + Sentinel when published, or create a custom app with the Sentinel MCP URL below.</p></div></li>
              <li><span>02</span><div><strong>Connect both services</strong><p>Complete OAuth for Scout + Sentinel and Binance. Use @Scout + Sentinel or + → More when sending a request.</p></div></li>
              <li><span>03</span><div><strong>Check your plan</strong><p>Personal Pro supports the read-only Scout path. Full MCP trade actions currently need a supported Business, Enterprise, or Edu workspace.</p><a href="https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt" target="_blank" rel="noreferrer">Open current plan guidance</a></div></li>
            </ol>
          )}
          {platform === "claude" && (
            <ol className="guided-steps">
              <li><span>01</span><div><strong>Add both MCP servers</strong><p>Run the commands below once. User scope makes the connections available across your projects.</p></div></li>
              <li><span>02</span><div><strong>Complete OAuth</strong><p>Open Claude Code, run /mcp, and finish each browser login.</p></div></li>
              <li><span>03</span><div><strong>Use the workflow prompt</strong><p>The MCP tools work now. Automatic Scout behavior also needs the Claude-specific skill package, which is still pending.</p></div></li>
            </ol>
          )}
          {platform === "other" && (
            <ol className="guided-steps">
              <li><span>01</span><div><strong>Check compatibility</strong><p>Your agent must support remote HTTP MCP, OAuth, tool permissions, and write-tool confirmation.</p></div></li>
              <li><span>02</span><div><strong>Add two remote servers</strong><p>Add the Binance endpoint for market and account reads, then add the Sentinel endpoint for policy and approvals.</p></div></li>
              <li><span>03</span><div><strong>Add the skill</strong><p>Import the Scout + Sentinel instructions if your agent supports skills. Without them, call the Sentinel tools explicitly.</p></div></li>
            </ol>
          )}

          {(platform === "codex" || platform === "claude") ? (
            <div className="command-box">
              <div><span>{platform} setup</span><button type="button" onClick={() => void copy(commands, "commands")}>{copied === "commands" ? "Copied" : "Copy commands"}</button></div>
              <pre><code>{commands}</code></pre>
            </div>
          ) : (
            <div className="endpoint-stack">
              <div><span>Binance Agent OS</span><code>{binanceEndpoint}</code></div>
              <div><span>Sentinel MCP</span><code>{endpoint}</code><button type="button" onClick={() => void copy(endpoint, "endpoint")}>{copied === "endpoint" ? "Copied" : "Copy"}</button></div>
            </div>
          )}
        </article>

        <aside className="setup-progress" aria-labelledby="progress-title">
          <div className="progress-heading"><div><p className="eyebrow">Verified state</p><h3 id="progress-title">Your setup</h3></div><button className="button button-secondary" type="button" onClick={onRefresh}>Check again</button></div>
          <ol className="progress-list">
            {progress.map((item) => (
              <li className={item.ok ? "complete" : "waiting"} key={item.label}>
                <span aria-hidden="true">{item.ok ? "✓" : ""}</span>
                <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                {item.href ? <a href={item.href}>Set now</a> : null}
              </li>
            ))}
          </ol>
          <div className={`binance-connect-card ${binanceConnected ? "connected" : "waiting"}`}>
            <div>
              <span>Binance account</span>
              <strong>{binanceConnected ? "Verified account read" : capabilities.binance.oauthReady ? "Ready to authorize" : "Requires public HTTPS"}</strong>
              <small>{binanceConnected
                ? `Checked ${capabilities.binance.connection.lastVerifiedAt ? new Date(capabilities.binance.connection.lastVerifiedAt).toLocaleString() : "recently"}. No balance values are stored in this status card.`
                : capabilities.binance.oauthReady
                  ? "Binance opens its own permission screen. Sentinel never asks for an API key."
                  : "Deploy this service on HTTPS before starting Binance OAuth."}</small>
            </div>
            {binanceConnected
              ? <button className="button button-secondary" type="button" disabled={binanceAction !== null} onClick={() => void disconnectBinance()}>{binanceAction === "disconnecting" ? "Removing…" : "Remove access"}</button>
              : <button className="button button-primary" type="button" disabled={!capabilities.binance.oauthReady || binanceAction !== null} onClick={() => void connectBinance()}>{binanceAction === "connecting" ? "Opening Binance…" : "Connect Binance"}</button>}
          </div>
          {binanceError !== null ? <ErrorNotice error={binanceError} /> : null}
          <div className={`readiness-callout ${canExecute ? "ready" : canScout ? "scout-ready" : "blocked"}`}>
            <span>{canExecute ? "Ready for gated execution" : canScout ? "Ready for Scout" : "Setup required"}</span>
            <p>{canExecute ? "Trades still need exact user approval and a final instruction." : canScout ? "You can scan live markets. Execution stays locked until its provider and scope are ready." : binanceConnected && !portfolioReady ? "Your Binance account is verified. Hosted portfolio reads and trading are still disabled." : "Complete the waiting items above. Nothing can trade while setup is incomplete."}</p>
          </div>
          {agentConnected ? (
            <div className="agent-evidence">
              <span>Connected agents</span>
              {capabilities.agentGateway.connections.map((connection) => (
                <div key={connection.clientId}><strong>{connection.clientName}</strong><small>{connection.scopes.includes("sentinel:execute") ? "Execution scope granted" : "Read and review only"} · connected {new Date(connection.connectedAt).toLocaleDateString()}</small></div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      <div className="safe-test">
        <div><p className="eyebrow">First safe test</p><h3>Check the connection without trading</h3><p>Copy this into your chosen agent. It asks for live account state and blocks approvals and execution.</p></div>
        <blockquote>{safePrompt}</blockquote>
        <button className="button button-primary" type="button" onClick={() => void copy(safePrompt, "prompt")}>{copied === "prompt" ? "Prompt copied" : copied === "failed" ? "Copy failed" : "Copy read-only test"}</button>
      </div>

      <div className="daily-flow" aria-label="Daily Scout and Sentinel workflow">
        <p className="eyebrow">After setup</p>
        <ol><li><span>1</span>Ask your agent</li><li><span>2</span>Scout reads Binance</li><li><span>3</span>Sentinel checks rules</li><li><span>4</span>Approve in your agent or here</li><li><span>5</span>Track the real receipt</li></ol>
      </div>
    </section>
  );
}

function AuditTrail({ events, integrity, onRefresh }: { events: AuditEvent[]; integrity: boolean | null; onRefresh: () => void }) {
  return (
    <section className="audit-section" aria-labelledby="audit-title">
      <div className="section-heading">
        <div><p className="eyebrow">Tamper-evident history</p><h2 id="audit-title">Audit trail</h2></div>
        <div className="audit-controls">
          <span className={`integrity ${integrity === true ? "valid" : integrity === false ? "invalid" : "unknown"}`}>
            {integrity === true ? "Chain valid" : integrity === false ? "Chain broken" : "Not checked"}
          </span>
          <button className="button button-secondary" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      <AuditTerminal events={events} integrity={integrity} />
      {events.length === 0 ? (
        <EmptyState title="No audit events yet" detail="Policy changes, approvals, refusals, and receipts will form a verifiable chain here." />
      ) : (
        <ol className="audit-list">
          {events.map((event) => (
            <li key={event.id}>
              <span className="audit-node" />
              <div>
                <strong>{event.eventType.replaceAll(".", " ")}</strong>
                <span>{new Date(event.createdAt).toLocaleString()}</span>
              </div>
              <code title={event.eventHash}>#{event.sequence} · {event.eventHash.slice(0, 12)}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ControlRoom({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<unknown>(null);
  const [mandate, setMandate] = useState<StoredMandate | null>(null);
  const [editingMandate, setEditingMandate] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrity, setIntegrity] = useState<boolean | null>(null);
  const [positions, setPositions] = useState<TrackedPosition[]>([]);
  const [protectionEvents, setProtectionEvents] = useState<ProtectionEvent[]>([]);
  const [confirmations, setConfirmations] = useState<ConfirmationReview[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mandateResult, capabilityResult, auditResult, integrityResult, positionResult, protectionResult, confirmationResult] = await Promise.all([
        api<{ mandate: StoredMandate }>("/v1/mandates/active").catch((reason) => {
          if (reason instanceof ApiError && reason.status === 404) return { mandate: null };
          throw reason;
        }),
        api<Capabilities>("/v1/capabilities"),
        api<{ events: AuditEvent[] }>("/v1/audit?limit=20"),
        api<{ integrity: { valid: boolean } }>("/v1/audit/integrity"),
        api<{ positions: TrackedPosition[] }>("/v1/positions"),
        api<{ events: ProtectionEvent[] }>("/v1/protection-events"),
        api<{ confirmations: ConfirmationReview[] }>("/v1/confirmations/pending")
      ]);
      setMandate(mandateResult.mandate);
      setCapabilities(capabilityResult);
      setEvents(auditResult.events);
      setIntegrity(integrityResult.integrity.valid);
      setPositions(positionResult.positions);
      setProtectionEvents(protectionResult.events);
      setConfirmations(confirmationResult.confirmations);
      setLoadState("ready");
    } catch (nextError) {
      setError(nextError);
      setLoadState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const connected = capabilities?.binance.accountState === "connected";
  const executionConnected = capabilities?.binance.execution === "connected";
  const agentConnected = (capabilities?.agentGateway.connections.length ?? 0) > 0;
  const readiness = [
    { label: "Mandate", value: mandate ? "Active" : "Required", ok: Boolean(mandate) },
    { label: "Binance account", value: connected ? "Connected" : "Disconnected", ok: connected },
    { label: "Agent", value: agentConnected ? "Connected" : "Not linked", ok: agentConnected },
    { label: "Execution", value: executionConnected ? "Ready" : "Locked", ok: executionConnected },
    { label: "Audit chain", value: integrity === true ? "Verified" : integrity === false ? "Broken" : "Checking", ok: integrity === true }
  ];
  const readyCount = readiness.filter((item) => item.ok).length;

  async function logout() {
    try { await api<void>("/v1/auth/logout", { method: "POST" }); } finally { onLogout(); }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <a className="wordmark small" href="#overview" aria-label="Scout and Sentinel home"><span className="brand-mark" aria-hidden="true">S</span><span>Scout <b>+</b> Sentinel</span></a>
        <nav className="topnav" aria-label="Workspace sections">
          <a href="#connect">Start</a><a href="#mandate">Mandate</a><a href="#watch">Watch</a><a href="#audit">Audit</a>
        </nav>
        <div className="operator"><span>{user.email ?? "Private agent workspace"}</span><button className="button-link" onClick={() => void logout()}>Leave workspace</button></div>
      </header>
      <main className="workspace" id="main-content">
        <aside className="status-rail" aria-label="Control plane readiness">
          <p className="eyebrow">Control status</p>
          <div className="status-list">
            {readiness.map((item) => <div key={item.label}><span className={`status-dot ${item.ok ? "status-ok" : "status-warn"}`} /><span>{item.label}</span><strong>{item.value}</strong></div>)}
          </div>
          <div className="readiness-meter" aria-label={`${readyCount} of ${readiness.length} controls ready`}>
            <div>{readiness.map((item) => <span className={item.ok ? "ready" : "waiting"} key={item.label} />)}</div>
            <small>{readyCount}/{readiness.length} controls ready</small>
          </div>
          <div className="principle"><span>Permission first</span><p>Scout reads. Sentinel checks. You approve exact terms before any real order.</p></div>
        </aside>
        <div className="content-column">
          {loadState === "loading" && <DashboardSkeleton />}
          {loadState === "error" && <div className="error-state"><span className="error-mark" aria-hidden="true">!</span><div><p className="eyebrow">State unavailable</p><h1>We couldn’t verify the control plane.</h1><ErrorNotice error={error} /><button className="button button-secondary" onClick={() => void load()}>Try again</button></div></div>}
          {loadState === "ready" && (
            <>
              <section className="overview-section" id="overview" aria-labelledby="overview-title">
                <div>
                  <p className="eyebrow">Binance Agent OS · live control room</p>
                  <h1 id="overview-title">Capital moves only <em>inside your rules.</em></h1>
                  <p>Scout finds the route. Sentinel checks every boundary. You approve the exact action.</p>
                  <div className="hero-actions">
                    <a className="button button-primary" href="#connect">Connect your agent</a>
                    <a className="text-link" href="#mandate">Review mandate <span aria-hidden="true">↘</span></a>
                  </div>
                </div>
                <article className={`system-state ${executionConnected ? "state-ready" : "state-locked"}`}>
                  <span className="system-orbit" aria-hidden="true"><i /></span>
                  <div>
                    <small>Current posture</small>
                    <strong>{executionConnected ? "Ready, approval required" : "Execution locked"}</strong>
                    <p>{executionConnected ? "Binance is connected. Every trade still needs a fresh check." : "Explore safely. No order can leave this system until Binance execution is connected."}</p>
                  </div>
                </article>
              </section>
              <div id="connect">
                {capabilities ? <AgentSetup capabilities={capabilities} hasMandate={Boolean(mandate)} onRefresh={() => void load()} /> : null}
              </div>
              <section className="mandate-section section-surface" id="mandate" aria-labelledby="mandate-title">
                <div className="section-heading"><div><p className="eyebrow">Active policy</p><h2 id="mandate-title">Mandate</h2></div></div>
                {!mandate || editingMandate
                  ? <MandateEditor initial={mandate ?? undefined} onSaved={(next) => { setMandate(next); setEditingMandate(false); void load(); }} onCancel={mandate ? () => setEditingMandate(false) : undefined} />
                  : <MandateView mandate={mandate} onReplace={() => setEditingMandate(true)} />}
              </section>
              <ApprovalQueue confirmations={confirmations} onApproved={() => void load()} />
              <AgentLane capabilities={capabilities} hasMandate={Boolean(mandate)} />
              <div id="watch"><PositionWatch positions={positions} alerts={protectionEvents} /></div>
              <div id="audit"><AuditTrail events={events} integrity={integrity} onRefresh={() => void load()} /></div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [startupError, setStartupError] = useState<unknown>(null);
  const [accessError, setAccessError] = useState<unknown>(null);
  const [showOperatorAccess, setShowOperatorAccess] = useState(false);

  useEffect(() => {
    async function start() {
      const params = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
      const accessToken = params.get("access");
      if (accessToken) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        try {
          const restored = await api<{ user: User }>("/v1/auth/agent-access", { method: "POST", body: JSON.stringify({ token: accessToken }) });
          setUser(restored.user);
          return;
        } catch (error) {
          setAccessError(error);
        }
      }
      try {
        const result = await api<{ user: User | null }>("/v1/auth/me");
        setUser(result.user);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setUser(null);
        else setStartupError(error);
      }
    }
    void start().finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="boot-screen"><div className="boot-mark" aria-hidden="true"><span /></div><div className="wordmark"><span className="brand-mark" aria-hidden="true">S</span>Scout <b>+</b> Sentinel</div><p>Checking trusted state…</p></main>;
  if (startupError) return <main className="boot-screen"><div className="wordmark"><span className="brand-mark" aria-hidden="true">S</span>Scout <b>+</b> Sentinel</div><ErrorNotice error={startupError} /><button className="button button-secondary" onClick={() => window.location.reload()}>Retry</button></main>;
  if (!user && showOperatorAccess) return <AuthScreen onAuthenticated={setUser} onBack={() => setShowOperatorAccess(false)} />;
  if (!user) return <PublicLanding onOperatorAccess={() => setShowOperatorAccess(true)} accessError={accessError} />;
  return <ControlRoom user={user} onLogout={() => { setUser(null); setShowOperatorAccess(false); }} />;
}
