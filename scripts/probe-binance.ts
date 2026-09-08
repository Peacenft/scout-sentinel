import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.BINANCE_MCP_URL ?? "https://agent.binance.com/mcp/agentic");
const client = new Client({ name: "scout-sentinel-capability-probe", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  // MCP SDK 1.x transport declarations are not exactOptionalPropertyTypes-safe.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  const discovered: Array<{ name: string; description?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    discovered.push(...page.tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  process.stdout.write(`${JSON.stringify({ endpoint: endpoint.origin, toolCount: discovered.length, tools: discovered }, null, 2)}\n`);
} finally {
  await client.close();
}
