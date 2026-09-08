# Binance Agent OS Tools

These tool names and schemas were discovered from the authenticated official Binance Agent OS MCP server on 7 September 2026. Use `tool_search` again when a tool is missing or its schema changes. Do not guess.

## Account Reads

- `spot.getAccount` with `{ "omitZeroBalances": true }`
- `wallet.queryUserWalletBalance` through `tool_execute` with `{ "quoteAsset": "USDT" }`

Account reads may return an empty balance list. An empty list is real state, not a provider failure.

## Spot Market Reads

- `spot.exchangeInfo`: optional `symbol`, `symbols`, `permissions`, `showPermissionSets`, `symbolStatus`
- `spot.tickerPrice`: optional `symbol`, `symbols`, `symbolStatus`
- `spot.tickerBookTicker`: optional `symbol`, `symbols`, `symbolStatus`
- `spot.depth`: required `symbol`; optional `limit` up to 5000 and `symbolStatus`
- `spot.klines`: required `symbol` and `interval`; optional `startTime`, `endTime`, `timeZone`, and `limit` up to 1000

Use `symbolStatus: "TRADING"` where supported. Request only the symbols required by the mandate.

## Known Write Tools

The authenticated server exposes these write tools, but this skill version must not call them:

- `spot.newOrder`
- `spot.deleteOrder`
- `spot.deleteOpenOrders`
- `convert.sendQuoteRequest`
- `convert.acceptQuote`
- `convert.placeLimitOrder`

Read-only status tools include `spot.getOrder`, `spot.getOpenOrders`, `spot.allOrders`, and `convert.orderStatus`.

## Normalization

- Keep all amounts and prices as decimal strings.
- Calculate best-book spread as `(ask - bid) / midpoint * 10000` basis points.
- Use the provider observation time when available. Otherwise record the local receipt time and label it as receipt time.
- Exclude zero balances from exposure, but keep the base-currency cash balance.
- Do not calculate profit and loss without a verified cost basis. If cost basis is unavailable, Sentinel must fail closed for drawdown-dependent actions.
