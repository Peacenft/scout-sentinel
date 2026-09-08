# Data Contracts

Use decimal strings for every monetary value and percentage.

## Mandate

```json
{
  "name": "Preserve sleeve",
  "baseCurrency": "USDC",
  "capitalUsd": "1000",
  "goal": "preserve",
  "maxDrawdownPct": "8",
  "maxOrderUsd": "150",
  "maxSlippageBps": "25",
  "allowedAssets": ["BTC", "ETH", "USDC"],
  "allowedVenues": ["spot", "convert"],
  "forbidFutures": true,
  "forbidWithdraw": true,
  "requireUserConfirm": true,
  "maxHoldingsUsd": { "BTC": "450", "ETH": "300" },
  "exitIfLossPct": "8",
  "minLiquidity": "can_exit_via_convert_or_spot"
}
```

## Portfolio State

```json
{
  "asOf": "2026-09-07T12:00:00.000Z",
  "totalExposureUsd": "0",
  "holdingsUsd": { "USDC": "0", "BTC": "0", "ETH": "0" },
  "realizedPnlUsd": "0",
  "unrealizedPnlUsd": "0",
  "pendingBuyNotionalUsd": {}
}
```

## Proposal

```json
{
  "id": "018f85a4-54fd-7d68-a8f2-4d90b5812ee8",
  "sourceRole": "scout",
  "type": "HOLD",
  "thesis": "No funded allocation is available.",
  "baseAsset": "BTC",
  "quoteAsset": "USDC",
  "side": "BUY",
  "venue": "spot",
  "notionalUsd": "0",
  "expectedRiskUsd": "0",
  "exitPlan": "Sell BTC into USDC through Spot.",
  "marketSnapshot": {
    "price": "1",
    "change24hPct": "0",
    "spreadBps": "0",
    "funding": null,
    "observedAt": "2026-09-07T12:00:00.000Z"
  },
  "createdAt": "2026-09-07T12:00:00.000Z"
}
```

The examples show shape only. Replace every value with current user-approved and live Binance data. Never reuse example values as runtime data.

## Evaluator Input

```json
{
  "mandateVersion": 1,
  "stateMaxAgeSeconds": 30,
  "mandate": {},
  "state": {},
  "proposal": {}
}
```

Populate the three documents with the complete shapes above.
