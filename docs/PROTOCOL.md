# Soleil Protocol Surface

This document is the contract between the React client and the native Solana program in `programs/soleil-settlement`.

## Account derivation

Market PDA:

```text
["market", "SOL", strike_cents_le, expiry_at_le, kind]
```

Position PDA:

```text
["position", owner, market, expiry_at_le]
```

Quote PDA:

```text
["quote", market, maker, nonce_le]
```

`kind` is `0` for a call and `1` for a put. Display prices are represented in USD cents, option sizes in lamports of SOL notional, and executable premium/collateral terms in SOL lamports per SOL notional. Expiry is a signed Unix timestamp encoded as little-endian `i64`.

## Instruction bytes

All instructions are Borsh enum variants. The first byte is the variant index.

| Variant | Payload |
| --- | --- |
| `0` InitializeMarket | `i64 expiry_at`, `u64 strike_cents`, `u8 kind` |
| `1` OpenPosition | `u8 side`, `u64 quantity_units`, `u64 premium_cents`, `u64 floor_cents`, `u64 quote_nonce`, `i64 expiry_at`, `u64 premium_lamports`, `u64 collateral_lamports` |
| `2` ClosePosition | none |
| `3` Settle | `u64 oracle_price_cents`, `i64 observed_at` |
| `4` PublishQuote | `u8 side`, `u64 price_cents`, `u64 size_units`, `i64 expires_at`, `u64 nonce`, `u64 premium_lamports_per_unit`, `u64 collateral_lamports_per_unit` |
| `5` DepositLiquidity | `u64 amount_lamports` |
| `6` WithdrawLiquidity | `u64 amount_lamports` |

The TypeScript builders in `src/settlement.ts` are deliberately explicit about this layout. Any change to the Rust enum must update this document and the client in the same change.

## Account layouts

The Borsh account sizes used by the indexer are:

| Account | Size | Important fields |
| --- | ---: | --- |
| `Market` | 106 bytes | authority, oracle, expiry, strike, liquidity lamports, reserved units, reserved lamports |
| `Quote` | 122 bytes | maker, market, side, price, size, filled size, expiry, nonce, premium and collateral terms |
| `Position` | 146 bytes | owner, market, side, quantity, premium, lifecycle status, trader collateral, payout, reserved lamports |

`reserved_lamports` is separate from trader-posted `collateral_lamports`: long positions reserve maker payout capacity, while short positions post collateral and also reserve the amount against market withdrawals.

## Quote gateway

`VITE_SOLEIL_QUOTES_URL` is an external maker gateway boundary. The client sends `underlying=SOL`, live `spot`, and `expiryDays`, then accepts only a JSON array (or `{ "quotes": [...] }`) whose rows contain `expiryDays`, exact `expiryAt`, `expiryLabel`, `strike`, and validated bid/ask/IV values for both calls and puts. Each row carries separate `bidQuote` and `askQuote` references with quote PDA, maker, nonce, `premiumLamportsPerSol`, and positive `collateralLamportsPerSol`. Indicative model values never pass this execution boundary.

## Lifecycle

1. A market authority derives a market PDA for a single SOL strike/expiry/kind and initializes it.
2. The market authority deposits SOL liquidity into the market PDA.
3. The market authority publishes an on-chain quote account with price, available size, expiry, and nonce.
4. A taker derives the quote and position PDAs. The program verifies that the quote is active, unexpired, opposite-side, and has enough remaining size before consuming quantity. It also reserves the position's SOL notional against available market liquidity and transfers the quote's lamport premium. A buy-side position pays premium into the market; a sell-side position posts quote-defined collateral and receives premium from the market.
5. The owner may close an open position before expiry. The program validates both PDAs, releases the reserved notional, and returns short-side collateral.
6. After expiry, the market oracle signer may settle an open position. The signed observation must be no more than five minutes old. Long-side intrinsic payout is converted to SOL using the settlement price and paid from market liquidity. Short-side collateral covers the recorded obligation and any excess is returned. The reserved notional is released.

## Current boundary

The quote account, fill-size checks, liquidity deposit/withdraw transfers, open-notional reservation, premium transfer, short collateral, native SOL settlement transfers, and five-minute observation-age check are real and testable. The current program still needs an independent production oracle adapter with confidence checks, stronger maker authorization, default isolation, and an audit before it is a production trading venue. The frontend refuses to submit without both validated maker-quote metadata and a configured program.

Market accounts track both reserved SOL units and reserved lamports. A long option reserves the maker's quoted collateral before it can be opened; a short option posts that collateral from the trader. Each position stores the reserved lamports separately from trader-posted collateral so closing or settling either side releases the correct amount.
