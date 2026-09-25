param(
  [string]$AgaveBin = "$env:USERPROFILE\.local\share\solana\install\active_release\bin",
  [string]$Keypair = "$PSScriptRoot\..\target\deploy\soleil_settlement-keypair.json"
)
$ErrorActionPreference = 'Stop'
$solana = Join-Path $AgaveBin 'solana.exe'
$so = Join-Path $PSScriptRoot '..\target\deploy\soleil_settlement.so'
if (!(Test-Path $solana)) { throw "Solana CLI not found. Install Agave, then pass -AgaveBin." }
if (!(Test-Path $Keypair)) { throw "Program keypair not found: $Keypair. Run cargo-build-sbf first." }
& $solana config set --url devnet
& $solana program deploy $so --program-id $Keypair --keypair $Keypair --url devnet
if ($LASTEXITCODE -ne 0) { throw 'Devnet deployment failed. Check deployer balance and faucet limits.' }
$programId = (& $solana-keygen pubkey $Keypair).Trim()
Write-Output "VITE_SOLEIL_PROGRAM_ID=$programId"
