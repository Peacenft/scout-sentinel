# Risk Presets

Risk labels are product presets, not promises of safety or return. Always show the full proposed mandate and require confirmation before reading markets.

## Moderate Preservation

Use this preset when the user asks for moderate risk without exact limits:

- Goal: preserve
- Base currency: the stablecoin named by the user
- Allowed assets: BTC, ETH, and the base currency
- Venues: Spot and Convert
- Maximum drawdown: 8% of sleeve capital
- Protection exit: 8% sleeve loss
- Maximum single order: 15% of sleeve capital
- Maximum slippage: 25 basis points, equal to 0.25%
- BTC position cap: 45% of sleeve capital
- ETH position cap: 30% of sleeve capital
- Minimum retained base currency: 25% of sleeve capital
- Futures, Margin, Transfer, and withdrawals: blocked
- User confirmation: required

Round calculated USD limits down to two decimal places. The user may change any limit before confirmation.
