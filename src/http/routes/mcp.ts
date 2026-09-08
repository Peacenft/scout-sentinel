import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/pool.js";
import type { PortfolioStateProvider } from "../../integrations/portfolio-state-provider.js";
import type { TradeExecutionProvider } from "../../integrations/trade-execution-provider.js";
import { createSentinelMcpServer } from "../../mcp/server.js";
import { verifyAgentAccess } from "../../services/oauth.js";
import type { BinanceConnectionService } from "../../services/binance-connection.js";

type Providers = { portfolio?: PortfolioStateProvider; execution?: TradeExecutionProvider };

export async function registerMcpRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  providers: Providers,
  binanceConnections: BinanceConnectionService
): Promise<void> {
  const baseUrl = config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`;
  const resource = `${baseUrl}/mcp`;
  const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

  app.options("/mcp", async (_request, reply) => reply
    .header("access-control-allow-origin", "*")
    .header("access-control-allow-methods", "POST, OPTIONS")
    .header("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id")
    .code(204).send());

  app.post("/mcp", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) {
      return reply.code(401)
        .header("www-authenticate", `Bearer resource_metadata="${metadataUrl}"`)
        .send({ error: "invalid_token", error_description: "A bearer access token is required." });
    }
    let access;
    try {
      access = await verifyAgentAccess(database, config.sessionPepper, token, resource);
    } catch {
      return reply.code(401)
        .header("www-authenticate", `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`)
        .send({ error: "invalid_token", error_description: "The access token is invalid or expired." });
    }

    const server = createSentinelMcpServer({ database, config, access, providers, binanceConnections, logger: request.log });
    const transport = new StreamableHTTPServerTransport(
      { sessionIdGenerator: undefined, enableJsonResponse: true } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]
    );
    reply.hijack();
    try {
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error, oauthClientId: access.clientId }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) => reply.code(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
      })
    });
  }
}
