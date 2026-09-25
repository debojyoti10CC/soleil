param(
  [string]$AgaveBin = "$env:USERPROFILE\.local\share\solana\install\active_release\bin",
  [string]$Keypair = "$PSScriptRoot\..\target\deploy\soleil_settlement_devnet_20260925-keypair.json",
  [string]$PayerKeypair = "$env:USERPROFILE\.config\solana\id.json"
)
$ErrorActionPreference = 'Stop'
$solana = Join-Path $AgaveBin 'solana.exe'
$solanaKeygen = Join-Path $AgaveBin 'solana-keygen.exe'
$so = Join-Path $PSScriptRoot '..\target\deploy\soleil_settlement.so'
if (!(Test-Path $solana)) { throw "Solana CLI not found. Install Agave, then pass -AgaveBin." }
if (!(Test-Path $solanaKeygen)) { throw "solana-keygen not found in $AgaveBin." }
if (!(Test-Path $Keypair)) { throw "Program keypair not found: $Keypair. Run cargo-build-sbf first." }
if (!(Test-Path $PayerKeypair)) { throw "Payer keypair not found: $PayerKeypair. Fund a Devnet payer first." }
& $solana config set --url devnet
& $solana program deploy $so --program-id $Keypair --keypair $PayerKeypair --url devnet
if ($LASTEXITCODE -ne 0) { throw 'Devnet deployment failed. Check deployer balance and faucet limits.' }
$programId = (& $solanaKeygen pubkey $Keypair).Trim()
Write-Output "VITE_SOLEIL_PROGRAM_ID=$programId"
Write-Output "Explorer: https://explorer.solana.com/address/$programId?cluster=devnet"
