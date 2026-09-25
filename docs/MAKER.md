# Maker and Market Operator Runbook

Soleil is not executable from an indicative browser quote. A maker service must publish real quote metadata and a funded market must exist on the deployed Solana program. This runbook describes that path.

## 1. Initialize a market

For one SOL strike, expiry, and option kind, the authority signs `InitializeMarket` using `buildInitializeMarketInstruction` from `src/settlement.ts`.

The market PDA is derived from:

```text
["market", "SOL", strike_cents_le, expiry_at_le, kind]
```

The authority is also the current oracle signer. That is a devnet boundary only; production settlement needs a fresh, independently secured oracle.

## 2. Fund the market

The authority signs `DepositLiquidity` with a positive lamport amount. The program transfers SOL into the market PDA and records the amount in `Market.liquidity_lamports`.

The matching client builder is `buildDepositLiquidityInstruction`. `WithdrawLiquidity` is authority-only and cannot reduce the market below its rent floor.

Funding is intentionally separate from quotes. A quote can describe available size, but the market authority must decide how much SOL is available to support that risk.

## 3. Publish a bounded quote

The maker signs `PublishQuote` with:

- `side`: the maker side of the option
- `price`: premium in USD cents per SOL notional
- `size`: the maximum SOL notional the quote can fill
- `expiresAt`: a short quote lifetime, never after market expiry
- `nonce`: a unique maker sequence
- `premiumLamportsPerSol`: executable premium in SOL lamports per SOL notional
- `collateralLamportsPerSol`: short collateral in SOL lamports per SOL notional

The quote PDA is:

```text
["quote", market, maker, nonce_le]
```

The gateway returns separate bid and ask quote references. The browser rejects a row unless both references contain a matching `quoteAddress`, `maker`, `nonce`, and executable lamport terms.

## 4. Taker execution

The taker selects buy or sell. Soleil derives the market, quote, and position PDAs locally and submits `OpenPosition` with the quote nonce and exact lamport terms. The program rejects stale, oversized, wrong-side, replayed, or mismatched quotes and increments `filled_units` atomically. Buy-side takers pay premium into the market. Sell-side takers post the quote's collateral and receive premium from the market.

The frontend does not fabricate a receipt when this gateway is unavailable. It remains in planning mode until `VITE_SOLEIL_QUOTES_URL` and `VITE_SOLEIL_PROGRAM_ID` are configured.

## 5. Close and settle

Before expiry, the position owner may close an open position and receive any short collateral back. After expiry, the configured oracle signer may settle it. Long-side payout SOL is converted from the oracle price and paid from market liquidity; short-side collateral covers the recorded obligation and excess is returned.

Production still needs audited vault accounting, stronger maker authorization, oracle freshness and dispute handling, and default isolation before meaningful funds should be accepted.

The reference gateway exposes `/settle?market=<market-pda>&position=<position-pda>`. It verifies the configured maker controls the market, fetches a fresh SOL/USD price, and signs the settlement instruction as the market oracle. The trader does not sign settlement; the position owner is included as the payout destination. This route is a Devnet operator boundary and must be replaced by a monitored oracle/keeper service for production.

## Quote gateway contract

`GET VITE_SOLEIL_QUOTES_URL?underlying=SOL&spot=<live spot>&expiryDays=<days>` must return either an array or `{ "quotes": [...] }`. Each series must include `expiryDays`, `expiryAt`, `expiryLabel`, `strike`, and both call and put rows. Each row must include numeric `bid`, `ask`, and `iv`, plus separate on-chain terms for the bid and ask:

```json
{
  "bidQuote": {
    "quoteAddress": "<bid quote PDA>",
    "maker": "<maker public key>",
    "nonce": 42,
    "premiumLamportsPerSol": 18000000,
    "collateralLamportsPerSol": 1000000000
  },
  "askQuote": {
    "quoteAddress": "<ask quote PDA>",
    "maker": "<maker public key>",
    "nonce": 43,
    "premiumLamportsPerSol": 20000000,
    "collateralLamportsPerSol": 1000000000
  }
}
```

The service should refresh quotes before their `expiresAt` and stop serving rows when the maker has no remaining size.
