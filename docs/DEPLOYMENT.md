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

The BPF build now succeeds with Agave's `cargo-build-sbf`. Program deployed to Devnet at `CrCvZbnNDhdHujrExPwDkVykrwnndQr3JL6xSQp56U2k`. Deployment payer is separate from program ID keypair.

After funding the generated keypair, run `powershell -ExecutionPolicy Bypass -File scripts/deploy-devnet.ps1`. Copy its printed `VITE_SOLEIL_PROGRAM_ID` into `.env.local`, then restart Vite.

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
