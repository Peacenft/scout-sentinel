import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpToolClient } from "../binance/market-client.js";

export class SdkMcpToolClient implements McpToolClient {
  constructor(private readonly client: Client) {}

  async listToolNames(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        { timeout: 5_000, ...(signal ? { signal } : {}) }
      );
      for (const tool of page.tools) names.add(tool.name);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return names;
  }

  async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.client.callTool(
      { name, arguments: arguments_ },
      undefined,
      { timeout: 5_000, ...(signal ? { signal } : {}) }
    );
  }
}
