# Soleil Architecture

## Product goal

Soleil is a single-asset SOL options venue with a portfolio-aware protection layer. The design keeps market liquidity concentrated around SOL and makes the advanced action simple: protect an existing SOL treasury without requiring the user to understand options mechanics.

## Components

### Web application

The Vite React client owns:

- market discovery and order entry;
- Guard protection planning;
- Phantom connection and Devnet balance reads;
- transaction signing and program-account discovery;
- local presentation of confirmed program positions.

Relevant files:

- `src/App.tsx`: product views and user flows.
- `src/domain.ts`: option and position models plus the indicative quote model.
- `src/solana.ts`: Phantom, RPC, faucet, program-account, and Explorer helpers.
- `src/styles.css`: product theme and responsive layout.

### Current pricing model

`buildOptionSeries()` derives five strikes around the live SOL spot for each expiry. Premiums include intrinsic value, time value, expiry scaling, implied-volatility scaling, and a bid/ask spread. The result is explicitly planning-only.

When `VITE_SOLEIL_QUOTES_URL` is configured, `src/quotes.ts` requests validated maker quote JSON for the selected SOL expiry, including the on-chain quote PDA, maker, and nonce. The UI only enables execution when those quotes are available and the settlement program is configured. The program then verifies and consumes the referenced quote account. If the gateway is absent or offline, the chain remains visible for planning and execution stays disabled.

### Devnet program path

The client requires `VITE_SOLEIL_PROGRAM_ID` before an order can be submitted. It derives a market PDA from `(underlying, strike, expiry, kind)` and requires that the maker has already initialized and funded that market before adding a position-open instruction to the Phantom-signed transaction. No Memo transaction is used as a substitute for a position. On wallet connect, the client queries position accounts owned by that wallet and rebuilds Portfolio from chain state.

## Settlement program

The first native program implementation lives in `programs/soleil-settlement`. It currently implements and tests:

- market PDA initialization per SOL strike/expiry/kind;
- authority-published quote PDAs with bounded size and expiry;
- quote-side, nonce, and remaining-size verification when opening a position;
- funded market liquidity with reserved open notional and authority-only withdrawals;
- native SOL premium transfer, short collateral, and long-side payout settlement;
- position PDA initialization;
- owner-authorized close;
- oracle-authorized expiry settlement state transition;
- call and put intrinsic payout calculation.

The current slice moves native SOL premium, short collateral, and long-side payout through the market PDA. It does not support SPL stablecoin settlement, production oracle freshness/confidence checks, or default isolation. The frontend therefore only enables execution for validated maker quotes and a configured deployed program; indicative model values remain planning-only.

Run its local tests with `cargo test -p soleil-settlement`.

## Settlement program target

The next on-chain program should support the following accounts:

- `Market`: underlying, quote mint, expiry, strike grid, maker authority, fee settings, and status.
- `Quote`: maker, bid/ask, size, expiry, nonce, and maker signature or authority reference.
- `Position`: owner, market, side, quantity, premium, collateral, entry, and lifecycle state.
- `Vault`: PDA-owned collateral for makers and protected buyers.
- `MarginAccount`: wallet-level net SOL exposure and cross-venue adapter balances.

Required instructions:

1. `initialize_market`
2. `publish_quote`
3. `open_position`
4. `deposit_collateral`
5. `close_position`
6. `exercise_or_settle`
7. `liquidate_margin_account`
8. `register_adapter`

The first production slice should be cash-settled European puts and calls. Physical delivery and cross-venue liquidation should follow only after the basic lifecycle is audited.

## Settlement lifecycle

```text
Maker publishes signed quote
        |
Trader opens position and pays premium
        |
Program locks maker collateral and records position
        |
Oracle updates SOL mark
        |
Trader closes or expiry settles
        |
Program transfers payout and releases collateral
```

## Oracle and risk requirements

- Use a production oracle adapter for settlement, not the client price feed.
- Enforce stale-price and confidence checks.
- Cap quote size per maker and market.
- Isolate oracle, venue, and adapter failures.
- Never let an untrusted client decide settlement prices.
- Add invariant and property tests before any mainnet deployment.

## Open clearing layer

Guard is the first user-facing adapter. It currently reads native SOL directly. The adapter contract should normalize each venue into:

```text
collateral
net exposure
oracle source
liquidation threshold
unwind instruction
```

That allows Soleil to calculate net exposure and later coordinate liquidation across lending, perps, and options positions under one margin account.
