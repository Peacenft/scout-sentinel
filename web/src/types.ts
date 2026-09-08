export type User = { id: string; email: string | null; identityType: "operator" | "agent" };

export type MandateDocument = {
  name: string;
  baseCurrency: string;
  capitalUsd: string;
  goal: "preserve";
  maxDrawdownPct: string;
  maxOrderUsd: string;
  maxSlippageBps?: string;
  allowedAssets: string[];
  allowedVenues: Array<"spot" | "convert">;
  forbidFutures: true;
  forbidWithdraw: true;
  requireUserConfirm: true;
  maxHoldingsUsd: Record<string, string>;
  exitIfLossPct: string;
  minLiquidity: "can_exit_via_convert_or_spot";
};

export type StoredMandate = {
  id: string;
  version: number;
  document: MandateDocument;
  documentHash: string;
  createdAt: string;
};

export type AuditEvent = {
  sequence: string;
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  eventHash: string;
  createdAt: string;
};

export type Capabilities = {
  binance: {
    accountState: "connected" | "disconnected";
    portfolioState: "connected" | "disabled";
    execution: "connected" | "disabled";
    monitoring: "connected" | "disabled";
    oauthReady: boolean;
    connection: {
      connected: boolean;
      status: "disconnected" | "connected" | "expired" | "error";
      connectedAt: string | null;
      lastVerifiedAt: string | null;
      expiresAt: string | null;
      lastErrorCode: string | null;
      capabilities: {
        accountRead: true;
        accountType: string | null;
        canTrade: boolean | null;
        nonZeroAssetCount: number;
        spotTradeToolAdvertised: boolean;
        convertTradeToolsAdvertised: boolean;
        verifiedAt: string;
      } | null;
    };
  };
  agentGateway: {
    oauth: "connected";
    endpoint: string;
    connections: Array<{
      clientId: string;
      clientName: string;
      scopes: Array<"sentinel:read" | "sentinel:evaluate" | "sentinel:confirmations" | "sentinel:execute">;
      connectedAt: string;
      expiresAt: string;
    }>;
  };
};

export type ConfirmationReview = {
  id: string;
  evaluationId: string;
  termsHash: string;
  expiresAt: string;
  confirmedAt: string | null;
  proposal: {
    type: "ENTER" | "ADD" | "ROTATE" | "HOLD" | "PROTECT_EXIT";
    baseAsset: string;
    quoteAsset: string;
    side: "BUY" | "SELL";
    venue: "spot" | "convert";
    notionalUsd: string;
    expectedRiskUsd: string;
    thesis: string;
    exitPlan: string;
  };
  verdict: {
    decision: "APPROVED_NEEDS_USER" | "REJECTED" | "NO_ACTION" | "PROTECT_EXIT";
    reason: string;
    ruleIds: string[];
  };
};

export type TrackedPosition = {
  id: string;
  sourceOperationId: string;
  baseAsset: string;
  quoteAsset: string;
  venue: "spot" | "convert";
  openedBaseQuantity: string;
  openedQuoteQuantity: string;
  status: "active" | "closed";
  monitorStatus: "active" | "paused" | "completed" | "failed" | null;
  lastCheckedAt: string | null;
  monitorErrorCode: string | null;
  openedAt: string;
  closedAt: string | null;
};

export type ProtectionEvent = {
  id: string;
  positionId: string;
  eventType: "drawdown_threshold" | "position_missing";
  status: "action_required" | "acknowledged" | "resolved";
  details: {
    stateAsOf?: string;
    baseAsset?: string;
    holdingUsd?: string;
    lossUsd?: string;
    thresholdUsd?: string;
  };
  detectedAt: string;
};
