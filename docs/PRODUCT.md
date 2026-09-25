# Soleil Product Brief

## The problem

SOL users can hold an asset, borrow against it, trade perps, or buy an option, but those actions are usually isolated. A treasury can be economically hedged and still be liquidated because venues do not understand the rest of the portfolio.

## The product

Soleil combines:

- a concentrated SOL options market;
- a simple protection workflow for treasuries;
- a future open clearing layer that normalizes positions across venues.

The key action is not "place an options bet." It is "protect the SOL I already hold."

## User journey

### Market

1. Connect Phantom on Devnet.
2. Read the live SOL spot.
3. Choose 7, 10, or 14 days.
4. Choose a live-derived strike.
5. Choose Buy or Sell.
6. Review the bid/ask, estimated cost or proceeds, and payout/collateral.
7. Sign the position-open transaction.
8. Track the receipt in Portfolio.

### Guard

1. Connect a wallet.
2. Soleil reads native SOL exposure.
3. Enter the minimum treasury value to preserve.
4. Soleil derives the protection strike from floor divided by exposure.
5. Soleil prices the matching put from the selected expiry model.
6. Sign the protection position transaction.

## Why one asset

Every additional underlying fragments strikes, expiries, collateral, makers, and user attention. SOL has enough importance in the ecosystem to justify a focused venue. The product can later add adapters without turning the primary market into a long tail of empty books.

## Success criteria for the real protocol

- A maker can deposit collateral and publish a quote.
- A trader can open a cash-settled SOL option position.
- The program can verify expiry and oracle freshness.
- A trader can close or settle without a trusted frontend.
- Guard can aggregate at least native SOL and one lending/perps adapter.
- Every position and collateral movement is queryable from chain data.
