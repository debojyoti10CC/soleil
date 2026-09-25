import { clusterApiUrl, ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl('devnet')
const publicDevnetRpcUrl = clusterApiUrl('devnet')
export const solanaConnection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
const fallbackConnection = rpcUrl === publicDevnetRpcUrl ? null : new Connection(publicDevnetRpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })

const retryableRpcError = (error: unknown) => /429|rate limit|too many requests|failed to fetch|fetch failed|\b50[234]\b/i.test(String(error))

async function readWithFallback<T>(read: (connection: Connection) => Promise<T>): Promise<T> {
  try {
    return await read(solanaConnection)
  } catch (error) {
    if (!fallbackConnection || !retryableRpcError(error)) throw error
    return read(fallbackConnection)
  }
}

type PhantomProvider = {
  isPhantom?: boolean
  publicKey?: { toString: () => string }
  connect: () => Promise<{ publicKey: { toString: () => string } }>
  disconnect: () => Promise<void>
  signAndSendTransaction: (transaction: Transaction) => Promise<{ signature: string } | string>
  on?: (event: 'accountChanged' | 'disconnect', listener: (publicKey?: { toString: () => string } | null) => void) => void
  removeListener?: (event: 'accountChanged' | 'disconnect', listener: (publicKey?: { toString: () => string } | null) => void) => void
}

declare global {
  interface Window {
    solana?: PhantomProvider
    phantom?: {
      solana?: PhantomProvider
    }
  }
}

export interface WalletSession {
  address: string
  balance: number
}

export interface SolMarket {
  price: number
  change24h: number
  history: Array<{ timestamp: number; price: number }>
}

export interface OnchainPosition {
  positionAddress: string
  marketAddress: string
  kind: 'call' | 'put'
  side: 'buy' | 'sell'
  strike: number
  quantity: number
  premium: number
  premiumLamports: number
  collateralLamports: number
  payoutLamports: number
  reservedLamports: number
  expiryAt: number
  status: 'Open' | 'Closed' | 'Settled'
}

export const findPhantomProvider = () => window.phantom?.solana ?? window.solana

const getPhantom = () => {
  const provider = findPhantomProvider()
  if (!provider?.isPhantom) {
    throw new Error('Phantom is not available in this browser. Open Soleil in Chrome with the Phantom extension installed and unlocked, then switch Phantom to Devnet.')
  }
  return provider
}

export const shortAddress = (address: string) => `${address.slice(0, 4)}...${address.slice(-4)}`

export async function connectPhantom(): Promise<WalletSession> {
  const provider = getPhantom()
  const response = await provider.connect()
  const address = response.publicKey.toString()
  return { address, balance: await getSolBalance(address) }
}

export async function disconnectPhantom() {
  const provider = findPhantomProvider()
  if (provider?.publicKey) await provider.disconnect()
}

export async function getSolBalance(address: string) {
  const lamports = await readWithFallback((connection) => connection.getBalance(new PublicKey(address), 'confirmed'))
  return lamports / 1_000_000_000
}

export async function accountExists(address: PublicKey) {
  return Boolean(await readWithFallback((connection) => connection.getAccountInfo(address, 'confirmed')))
}

const readU64 = (bytes: Uint8Array, offset: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getBigUint64(offset, true)
}

const readI64 = (bytes: Uint8Array, offset: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getBigInt64(offset, true)
}

const readPubkey = (bytes: Uint8Array, offset: number) => new PublicKey(bytes.slice(offset, offset + 32))

const positionStatus = (value: number): OnchainPosition['status'] | null => {
  if (value === 1) return 'Open'
  if (value === 2) return 'Closed'
  if (value === 3) return 'Settled'
  return null
}

export async function fetchOnchainPositions(programId: PublicKey, owner: PublicKey): Promise<OnchainPosition[]> {
  const accounts = await solanaConnection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      { dataSize: 146 },
      { memcmp: { offset: 0, bytes: owner.toBase58() } },
    ],
  })
  if (accounts.length === 0) return []

  const marketKeys = accounts.map(({ account }) => readPubkey(new Uint8Array(account.data), 32))
  const markets = await solanaConnection.getMultipleAccountsInfo(marketKeys, 'confirmed')
  return accounts.flatMap(({ pubkey, account }, index) => {
    const positionBytes = new Uint8Array(account.data)
    const marketInfo = markets[index]
    if (!marketInfo) return []
    const marketBytes = new Uint8Array(marketInfo.data)
    if (positionBytes.length < 146 || marketBytes.length < 106) return []
    const expiryAt = Number(readI64(marketBytes, 64))
    const status = positionStatus(positionBytes[113])
    if (status === null) return []
    return [{
      positionAddress: pubkey.toBase58(),
      marketAddress: marketKeys[index].toBase58(),
      kind: marketBytes[80] === 1 ? 'put' : 'call',
      side: positionBytes[64] === 1 ? 'sell' : 'buy',
      strike: Number(readU64(marketBytes, 72)) / 100,
      quantity: Number(readU64(positionBytes, 65)) / 1_000_000_000,
      premium: Number(readU64(positionBytes, 73)) / 100,
      premiumLamports: Number(readU64(positionBytes, 114)),
      collateralLamports: Number(readU64(positionBytes, 122)),
      payoutLamports: Number(readU64(positionBytes, 130)),
      reservedLamports: Number(readU64(positionBytes, 138)),
      expiryAt,
      status,
    } satisfies OnchainPosition]
  })
}

export async function requestDevnetSol(address: string, amount = 1) {
  const signature = await solanaConnection.requestAirdrop(new PublicKey(address), amount * 1_000_000_000)
  const latest = await solanaConnection.getLatestBlockhash('confirmed')
  const confirmation = await solanaConnection.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (confirmation.value.err) throw new Error(`Airdrop failed: ${JSON.stringify(confirmation.value.err)}`)
  return getSolBalance(address)
}

export async function fetchSolMarket(): Promise<SolMarket | null> {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1&interval=hourly', { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      const fallback = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true', { signal: AbortSignal.timeout(10_000) })
      if (!fallback.ok) return null
      const data = await fallback.json() as { solana?: { usd?: number; usd_24h_change?: number } }
      const price = data.solana?.usd
      const change24h = data.solana?.usd_24h_change
      return typeof price === 'number' && Number.isFinite(price) && price > 0 && typeof change24h === 'number' && Number.isFinite(change24h) ? { price, change24h, history: [] } : null
    }
    const data = await response.json() as { prices?: Array<[number, number]> }
    const prices = Array.isArray(data.prices) ? data.prices.filter((item) => Array.isArray(item) && item.length >= 2 && Number.isFinite(item[0]) && Number.isFinite(item[1]) && item[1] > 0) : []
    const latest = prices.at(-1)?.[1]
    const first = prices[0]?.[1]
    if (typeof latest !== 'number' || typeof first !== 'number') return null
    return {
      price: latest,
      change24h: first > 0 ? ((latest - first) / first) * 100 : 0,
      history: prices.map(([timestamp, value]) => ({ timestamp, price: value })),
    }
  } catch {
    return null
  }
}

export async function submitSolanaTransaction(instructions: TransactionInstruction[], sendTransaction?: (transaction: Transaction, connection: Connection) => Promise<string>, ownerAddress?: string, onStage?: (stage: 'preparing' | 'wallet' | 'confirming') => void) {
  const provider = sendTransaction ? undefined : getPhantom()
  const address = ownerAddress || provider?.publicKey?.toString()
  if (!sendTransaction && !address) throw new Error('Connect a Solana wallet before signing this order.')

  const publicKey = new PublicKey(address || provider?.publicKey?.toString() || '')
  onStage?.('preparing')
  let prepared: { transaction: Transaction; connection: Connection } | null = null
  for (const connection of [solanaConnection, fallbackConnection].filter((item): item is Connection => item !== null)) {
    try {
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ...instructions,
      )
      try {
        const simulation = await connection.simulateTransaction(transaction)
        if (simulation.value.err) throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`)
      } catch (error) {
        // A fresh blockhash can be rejected by a lagging RPC during simulation.
        if (!String(error).includes('BlockhashNotFound')) throw error
      }
      prepared = { transaction, connection }
      break
    } catch (error) {
      if (connection === fallbackConnection || !fallbackConnection || !retryableRpcError(error)) throw error
    }
  }
  if (!prepared) throw new Error('Devnet RPC is unavailable. Try again shortly.')

  onStage?.('wallet')
  const signature = sendTransaction
    ? await sendTransaction(prepared.transaction, prepared.connection)
    : await (async () => {
      if (!provider) throw new Error('Connect a Solana wallet before signing this order.')
      return provider.signAndSendTransaction(prepared.transaction)
    })()
  const resolvedSignature = typeof signature === 'string' ? signature : signature.signature
  onStage?.('confirming')
  const confirmationConnections = [prepared.connection, prepared.connection === solanaConnection ? fallbackConnection : solanaConnection].filter((item): item is Connection => item !== null)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const connection of confirmationConnections) {
      try {
        const status = (await connection.getSignatureStatuses([resolvedSignature], { searchTransactionHistory: true })).value[0]
        if (status?.err) throw new Error(`Transaction failed on Solana: ${JSON.stringify(status.err)}`)
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return resolvedSignature
      } catch (error) {
        if (!retryableRpcError(error)) throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`Transaction submitted as ${resolvedSignature}, but Devnet confirmation is pending. Check Explorer before retrying.`)
}

export const getExplorerTransactionUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`

export const getExplorerAddressUrl = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`
