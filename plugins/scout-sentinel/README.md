# Scout + Sentinel Codex plugin

This plugin installs the Scout + Sentinel skill and the official Binance Agent OS MCP connection.

The hosted Sentinel MCP URL is deployment-specific, so add `<PUBLIC_BASE_URL>/mcp` as a second remote MCP server after deployment. Its OAuth flow creates a private workspace without a product signup and asks the user to choose scopes.

The plugin never sends orders directly to Binance. Policy-gated execution uses Sentinel MCP and requires the user to approve the exact terms in their agent or in the optional dashboard.
