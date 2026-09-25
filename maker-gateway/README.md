# Soleil Maker Gateway

This is the local operator service for executable quotes. It is deliberately fail-closed: without a deployed program, maker keypair, liquidity budget, and quote size it returns an error instead of serving pretend liquidity.

## Configure

Set the variables in `.env.example` in the shell that starts the gateway:

```powershell
$env:SOLEIL_PROGRAM_ID = "<deployed-program-id>"
$env:SOLEIL_MAKER_KEYPAIR = "C:\path\to\maker-keypair.json"
$env:SOLEIL_MARKET_LIQUIDITY_LAMPORTS = "5000000000"
$env:SOLEIL_QUOTE_SIZE_LAMPORTS = "1000000000"
$env:SOLEIL_COLLATERAL_LAMPORTS_PER_SOL = "1000000000"
$env:VITE_SOLEIL_QUOTES_URL = "http://127.0.0.1:8787/quotes"
```

The maker keypair must control the initialized market authority and have enough SOL for account rent, market funding, quote rent, and transaction fees.

## Run

```bash
npm run maker:dev
npm run dev
```

`GET /quotes?underlying=SOL&spot=<client-spot>&expiryDays=7` (also 10 or 14) fetches a fresh SOL spot, derives five strikes, and returns only active quote PDAs that exist on-chain. Normal polling reads the funded maker snapshot; the gateway replenishes expired quotes for the selected expiry when no complete snapshot remains. The client uses `expiryAt` from this response when deriving the market and position PDAs.

The service publishes two quote accounts per option row: a maker-buy quote for the bid and a maker-sell quote for the ask. A sell order therefore cannot accidentally reuse the ask-side account.

`GET /settle?market=<market-pda>&position=<position-pda>` reads the expired position, fetches a fresh SOL/USD price, and submits the oracle-signed settlement transaction with the configured maker keypair. The client uses this route for expired positions because the trader wallet is not the oracle signer.

## Safety boundary

This is an operator reference implementation for Devnet. It does not custody a production key securely, rotate keys, provide oracle dispute handling, or implement high-availability quote distribution. Do not use a hot key with meaningful funds until the program and gateway have been reviewed.
