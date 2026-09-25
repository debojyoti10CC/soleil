# Soleil

Soleil is a Solana-native SOL options and treasury protection product.

The product has two connected surfaces:

1. **Market**: discover SOL call and put contracts, choose an expiry and strike, review the live indicative quote, and open a position through the Soleil program on Solana devnet.
2. **Guard**: read the connected wallet's SOL exposure, choose a minimum treasury value, derive a protection strike, estimate the put premium, and open a put position through the same program.

Soleil is intentionally focused on one underlying asset: SOL. The product thesis is that concentrating liquidity around SOL makes a useful options venue more practical than fragmenting liquidity across every token.

## Current product state

- Solana Wallet Adapter is wired for Devnet. The connect modal discovers Wallet Standard wallets installed in the browser and includes Phantom and Solflare adapters as legacy fallbacks.
- SOL balance is read from Solana devnet.
- SOL/USD spot and 24-hour change are fetched live.
- Strikes and indicative premiums are generated from the live spot, expiry, and an explicit pricing model. There is no fixed strike or fixed option table.
- Indicative prices are planning-only. Execution requires `VITE_SOLEIL_QUOTES_URL` to return validated maker quotes; the client will not submit an indicative price as a trade.
- Trade and Guard actions require the deployed Soleil program and a signature from the connected Solana wallet. Confirmed transaction signatures are stored locally and linked to Solana Explorer.
- The client includes typed PDA derivation plus market, quote, liquidity, open, close, and settle instruction builders. Set `VITE_SOLEIL_PROGRAM_ID` to route those transactions to the deployed venue program.
- `maker-gateway/server.mjs` is a fail-closed Devnet operator service: with a deployed program, maker keypair, and explicit liquidity settings it initializes/funds markets, publishes separate bid/ask quote accounts, and serves only on-chain quote references.
- The same gateway exposes oracle settlement for expired positions: it verifies the market and position accounts, fetches a fresh SOL/USD observation, signs the program's settle instruction as the configured oracle, and returns the confirmed signature.
- The settlement program now requires an active on-chain maker quote, consumes its remaining size, reserves funded market capacity while a position is open, transfers native SOL premiums, and handles quote-defined short collateral plus long-side payout.
- Portfolio discovery queries the deployed program's position accounts for the connected wallet; browser storage only preserves local Explorer links for already-confirmed transactions.
- `programs/soleil-settlement` contains the native Solana state machine for market initialization, position opening, close, and expiry payout calculation, with Rust unit tests.
- `programs/soleil-settlement-integration` contains a `ProgramTest` lifecycle test that executes funding, market initialization, quote publication, position opening, reserved-liquidity protection, and close against the real processor.
- Portfolio reads positions from chain when a program is configured and keeps only confirmed Explorer links in browser storage.

The options chain is currently an **indicative pricing surface**, not a claim of external market liquidity. The next protocol milestone is the deployed Soleil settlement program and a maker/quote service.

For the judge-facing walkthrough and exact operator steps, see [`docs/DEMO.md`](docs/DEMO.md).

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173/` in a browser with a Solana wallet installed, choose a wallet from the connect modal, and switch that wallet to Devnet. The Codex in-app browser does not inject extension wallets, so use Chrome, Edge, or a wallet's mobile in-app browser for signing.

For a private RPC, set `VITE_SOLANA_RPC_URL`. Without it, Soleil uses Solana's public Devnet RPC.

`VITE_SOLEIL_PROGRAM_ID` must point to a deployed Soleil settlement program. Without it, the app keeps quotes and planning visible but refuses to manufacture a receipt or pretend an order was filled.

To enable executable Devnet quotes and settlement, configure the maker gateway from `maker-gateway/README.md`, set `VITE_SOLEIL_QUOTES_URL`, and optionally set `VITE_SOLEIL_SETTLEMENT_URL`. Without a deployed program and maker/oracle keypair, both routes intentionally fail closed.

## Product flow

```text
Live SOL spot
    |
    v
Expiry + strike surface -> maker quote or indicative planning quote
    |
    v
Maker initializes/funds market + publishes quote -> taker signs premium/collateral-backed position open
    |
    v
Receipt stored in Portfolio -> Explorer link
```

Guard follows the same pattern:

```text
Wallet SOL balance + treasury floor
    |
    v
Derived protection strike + maker put quote
    |
    v
Taker signs premium-backed put position open -> program transaction confirmed on Devnet
```

## Important distinction

The current native program records the position lifecycle, reserves market liquidity against open notional, transfers native SOL premiums/collateral, and performs native SOL payout calculations. It is still a devnet protocol slice: production oracle freshness, stronger maker authorization, default isolation, and an audit are required before mainnet funds. SPL stablecoin settlement remains a later venue expansion.
