# Deployment Checklist

## Local verification

```bash
cargo test -p soleil-settlement
cargo test -p soleil-settlement-integration
npm run check
npm run build
npm run maker:check
```

`soleil-settlement-integration` runs the full `ProgramTest` account lifecycle (funding, market initialization, liquidity, quote publication, open, reserved-withdrawal rejection, and close). The core package tests run with `cargo test -p soleil-settlement --lib`; the integration command may require an unrestricted Rust executor because Solana test dependencies compile native build scripts.

## Program deployment

The BPF build succeeds with Agave's `cargo-build-sbf`. The current Devnet deployment is:

- Program: [`3xZZq7Wd23M1eyggca8KCbhNx6FcNpsKTHGJq751n66k`](https://explorer.solana.com/address/3xZZq7Wd23M1eyggca8KCbhNx6FcNpsKTHGJq751n66k?cluster=devnet)
- Program-data account: [`GyBq7QKwRBM51XWYLxD847kaJCxdsv9s51Uiu2mBTz4p`](https://explorer.solana.com/address/GyBq7QKwRBM51XWYLxD847kaJCxdsv9s51Uiu2mBTz4p?cluster=devnet)
- Deployment transaction: [`4okq6ufR6Ejur8EuxmnyVHNwqnehcsREiFKCtmXtoxSNaPRCyzTabCtGV96o2Qq1TETF4RREWRt6baKXLQqLWM6T`](https://explorer.solana.com/tx/4okq6ufR6Ejur8EuxmnyVHNwqnehcsREiFKCtmXtoxSNaPRCyzTabCtGV96o2Qq1TETF4RREWRt6baKXLQqLWM6T?cluster=devnet)
- Deployment slot/time: `503929520` · `2026-09-25T09:47:17Z`
- RPC: [`https://api.devnet.solana.com`](https://api.devnet.solana.com)

The deployed program-data payload is byte-for-byte identical to `target/deploy/soleil_settlement.so`: 120,552 bytes, SHA-256 `8852b216462933aa9489607a4ece4a08e3135c76b43679baa117e4ad80efb3a0`. `VITE_SOLEIL_PROGRAM_ID` is set to this program in `.env.local`. The `soleil-settlement-integration` crate is a local `ProgramTest` harness and is not a second on-chain program.

The configured local maker gateway is live at [`http://127.0.0.1:8787/health`](http://127.0.0.1:8787/health) and returns on-chain quote references from [`/quotes`](http://127.0.0.1:8787/quotes?underlying=SOL&spot=111.94&expiryDays=7). It initializes/funds missing Devnet markets and publishes bounded quotes using the configured maker keypair; it does not fabricate fills.

### Vercel deployment

The repository includes Vercel-compatible serverless routes in `api/quotes.mjs`, `api/settle.mjs`, and `api/health.mjs`. Import `vercel.env` into the Vercel project for the public client settings. Import the local `vercel-server.env` separately for `SOLEIL_RPC_URL`, `SOLEIL_PROGRAM_ID`, the maker keypair, and maker limits. `vercel-server.env` is intentionally ignored by Git because it contains the server signing key. After deployment, verify `/api/health` returns `configured: true` and `/api/quotes?underlying=SOL&spot=111.94&expiryDays=7` returns live on-chain quote accounts.

For a fresh program ID, fund the payer and run `powershell -ExecutionPolicy Bypass -File scripts/deploy-devnet.ps1 -Keypair .\target\deploy\soleil_settlement_devnet_20260925-keypair.json -PayerKeypair $env:USERPROFILE\.config\solana\id.json`. Copy its printed `VITE_SOLEIL_PROGRAM_ID` into `.env.local`, then restart Vite. For an upgrade to an existing program, `-PayerKeypair` must be the current upgrade-authority keypair.

Before setting `VITE_SOLEIL_PROGRAM_ID`, the deployer must:

1. Build the program for the target Solana BPF toolchain.
2. Create a dedicated upgrade authority.
3. Deploy to Devnet.
4. Initialize the SOL market PDA with an oracle authority.
5. Fund the market PDA and publish executable quotes with lamport premium/collateral terms.
6. Run an end-to-end open, close, and expiry-settlement test.
7. Set `VITE_SOLEIL_PROGRAM_ID` only after the end-to-end program flow succeeds. The frontend intentionally has no Memo fallback.

For the reference Devnet flow, start `npm run maker:dev` after setting `SOLEIL_PROGRAM_ID`, `SOLEIL_MAKER_KEYPAIR`, liquidity, quote size, and collateral. Set `VITE_SOLEIL_QUOTES_URL` to `/quotes`; the app derives `/settle` from the same gateway unless `VITE_SOLEIL_SETTLEMENT_URL` overrides it. Expired positions are settled by the gateway's oracle signer, not by the trader wallet.

## Production requirements

- Replace public RPC with a dedicated provider.
- Use a production oracle with freshness and confidence checks.
- The current program rejects oracle observations older than five minutes; replace this signer-based check with a production oracle adapter before mainnet.
- Add SPL token vault transfers only if stablecoin-denominated settlement is introduced.
- Add maker quote authentication and nonce replay protection.
- Add liquidation and default-isolation rules.
- Audit the program before mainnet deployment.
