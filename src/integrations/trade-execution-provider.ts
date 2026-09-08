import { z } from "zod";
import type { Proposal } from "../domain/schemas.js";

export const executionReceiptSchema = z.object({
  providerOperationId: z.string().trim().min(1).max(200),
  state: z.enum(["pending", "confirmed", "rejected", "unknown"]),
  providerStatus: z.string().trim().min(1).max(100),
  observedAt: z.iso.datetime(),
  executedBaseQuantity: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).nullable(),
  executedQuoteQuantity: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).nullable(),
  evidence: z.record(z.string(), z.unknown())
}).strict().superRefine((value, context) => {
  if (value.state !== "confirmed") return;
  if (value.executedBaseQuantity === null || Number(value.executedBaseQuantity) <= 0) {
    context.addIssue({ code: "custom", path: ["executedBaseQuantity"], message: "a confirmed order requires an executed base quantity" });
  }
  if (value.executedQuoteQuantity === null || Number(value.executedQuoteQuantity) <= 0) {
    context.addIssue({ code: "custom", path: ["executedQuoteQuantity"], message: "a confirmed order requires an executed quote quantity" });
  }
});

export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;

export type TradeExecutionRequest = {
  clientOrderId: string;
  proposal: Proposal;
  maximumQuoteNotional: string;
  maximumSlippageBps: string;
  confirmedTermsHash: string;
};

export interface TradeExecutionProvider {
  readonly providerName: "binance_agent_os";
  submitTrade(input: TradeExecutionRequest, signal?: AbortSignal): Promise<ExecutionReceipt>;
  getTradeStatus(input: {
    clientOrderId: string;
    providerOperationId: string | null;
    proposal: Proposal;
  }, signal?: AbortSignal): Promise<ExecutionReceipt>;
}

export class TradeProviderError extends Error {
  constructor(
    public readonly providerCode: string,
    message: string,
    public readonly outcome: "rejected" | "unknown"
  ) {
    super(message);
    this.name = "TradeProviderError";
  }
}
