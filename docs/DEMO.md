# Soleil Demo and Operator Walkthrough

## What Soleil does

Soleil is a SOL-only options venue with a treasury protection workflow. The Market view lets a trader choose a SOL call or put, expiry, strike, and buy or sell side. Guard turns a wallet's native SOL balance and a chosen minimum treasury value into a put-position plan.

The product is deliberately honest about execution:

- Live SOL/USD data powers the display and planning surface.
- Indicative prices are visible when no maker gateway is available, but cannot be submitted.
- Executable rows contain on-chain quote addresses, maker identity, nonce, premium terms, and collateral terms.
- The deployed Soleil program verifies the quote, consumes its remaining size, transfers native SOL, and records the position.

## Judge flow

1. Open the app at `http://127.0.0.1:4173/`, open the wallet modal, choose any detected Solana wallet, and switch it to Devnet. Wallet Standard wallets are discovered automatically; Phantom and Solflare are included as adapter fallbacks.
2. Show the Market view: the spot, expiry dates, live-derived strikes, TradingView chart, and quote-status badge.
3. Select a call or put and switch between Buy and Sell. The order ticket changes price, premium, and collateral requirements with the side.
4. In executable mode, review the maker quote PDA and exact SOL terms in the transaction review, then sign with Phantom.
5. Open Portfolio and show the confirmed position loaded from the program account, not from a fake local order book.
6. Close before expiry with the owner wallet. The program releases reserved capacity and returns short collateral when applicable.
7. After expiry, use the configured maker/oracle gateway to submit the fresh-price settlement. The gateway returns the confirmed Explorer signature and Portfolio reflects the settled state.

## Guard flow

1. Open Guard and connect a Solana wallet on Devnet.
2. Soleil reads the connected wallet's native SOL balance from Devnet and calculates the USD value from the live spot.
3. Choose the minimum treasury value and protection period.
4. Guard selects the closest live put strike and displays the quantity, premium, and payoff preview.
5. With a maker quote available, review and sign the put position. The position uses the same on-chain market and quote lifecycle as Market.

## Operator setup

Copy `.env.example` to `.env`, deploy the program, and set:

```text
VITE_SOLEIL_PROGRAM_ID=<deployed-program-id>
VITE_SOLEIL_QUOTES_URL=http://127.0.0.1:8787/quotes
SOLEIL_PROGRAM_ID=<deployed-program-id>
SOLEIL_MAKER_KEYPAIR=<maker-keypair-path>
SOLEIL_MARKET_LIQUIDITY_LAMPORTS=5000000000
SOLEIL_QUOTE_SIZE_LAMPORTS=1000000000
SOLEIL_COLLATERAL_LAMPORTS_PER_SOL=1000000000
```

Run the two processes from the project root:

```bash
npm run maker:dev
npm run dev
```

The gateway initializes missing SOL strike markets, deposits liquidity, publishes separate bid and ask quote accounts for the 7, 10, and 14 day tabs, and exposes `/settle` for expired positions. It fails closed when the program, maker keypair, liquidity, quote size, or collateral settings are absent.

## What is not claimed

This is a Devnet reference implementation, not a mainnet-ready derivatives venue. Before real funds, Soleil needs an audited program, an independent production oracle with confidence/dispute handling, maker authentication and rate limits, default isolation, and monitored keeper infrastructure. The UI keeps execution disabled until the deployed program and validated maker quotes exist.
