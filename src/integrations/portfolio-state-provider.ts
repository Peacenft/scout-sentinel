import type { MandateInput, PortfolioState } from "../domain/schemas.js";

export interface PortfolioStateProvider {
  readonly providerName: "binance_agent_os";
  getPortfolioState(input: { userId: string; mandate: MandateInput; signal?: AbortSignal }): Promise<PortfolioState>;
}
