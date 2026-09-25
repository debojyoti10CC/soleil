import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

function loadDotEnv() {
  try {
    const contents = readFileSync(resolve('.env'), 'utf8')
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator < 1) continue
      const key = trimmed.slice(0, separator).trim()
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // Environment variables may be supplied by the process manager instead.
  }
}

loadDotEnv()

const PORT = Number(process.env.PORT || 8787)
const RPC_URL = process.env.SOLEIL_RPC_URL || clusterApiUrl('devnet')
const PROGRAM_ID = process.env.SOLEIL_PROGRAM_ID
const MAKER_KEYPAIR = process.env.SOLEIL_MAKER_KEYPAIR
const LIQUIDITY_LAMPORTS = Number(process.env.SOLEIL_MARKET_LIQUIDITY_LAMPORTS || 0)
const QUOTE_SIZE_LAMPORTS = Number(process.env.SOLEIL_QUOTE_SIZE_LAMPORTS || 0)
const COLLATERAL_LAMPORTS_PER_SOL = Number(process.env.SOLEIL_COLLATERAL_LAMPORTS_PER_SOL || 0)
const QUOTE_TTL_SECONDS = Number(process.env.SOLEIL_QUOTE_TTL_SECONDS || 300)
const SOLANA_DECIMALS = 1_000_000_000
const encoder = new TextEncoder()
const SPOT_CACHE_MS = 5_000
const QUOTE_CACHE_MS = 5_000
let cachedSpot = 0
let cachedSpotAt = 0
let quoteNonceSequence = BigInt(Date.now()) * 2n
const quoteCache = new Map()
let quoteQueue = Promise.resolve()
let activeQuoteSnapshot = null

const connection = new Connection(RPC_URL, 'confirmed')

function u64(value) {
  const bytes = new Uint8Array(8)
  let remaining = BigInt(Math.max(0, Math.floor(value)))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 255n)
    remaining >>= 8n
  }
  return bytes
}

function i64(value) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(Math.floor(value)), true)
  return bytes
}

function readU64(data, offset) {
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true))
}

function readI64(data, offset) {
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true))
}

function requireConfig() {
  if (![LIQUIDITY_LAMPORTS, QUOTE_SIZE_LAMPORTS, COLLATERAL_LAMPORTS_PER_SOL, QUOTE_TTL_SECONDS].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Maker amounts and quote lifetime must be positive safe integers.')
  if (!PROGRAM_ID || !MAKER_KEYPAIR || LIQUIDITY_LAMPORTS <= 0 || QUOTE_SIZE_LAMPORTS <= 0) {
    throw new Error('Set SOLEIL_PROGRAM_ID, SOLEIL_MAKER_KEYPAIR, SOLEIL_MARKET_LIQUIDITY_LAMPORTS, and SOLEIL_QUOTE_SIZE_LAMPORTS.')
  }
  if (LIQUIDITY_LAMPORTS < QUOTE_SIZE_LAMPORTS) throw new Error('Market liquidity must cover each quote size.')
  if (COLLATERAL_LAMPORTS_PER_SOL <= 0) throw new Error('Set SOLEIL_COLLATERAL_LAMPORTS_PER_SOL for executable short quotes.')
}

function loadMaker() {
  const configured = String(MAKER_KEYPAIR || '').trim()
  if (!configured) throw new Error('SOLEIL_MAKER_KEYPAIR is not configured.')
  const secret = configured.startsWith('[')
    ? JSON.parse(configured)
    : JSON.parse(readFileSync(resolve(configured), 'utf8'))
  return Keypair.fromSecretKey(Uint8Array.from(secret))
}

function programId() {
  return new PublicKey(PROGRAM_ID)
}

function deriveMarket(program, strike, expiryAt, kind) {
  return PublicKey.findProgramAddressSync([
    encoder.encode('market'),
    encoder.encode('SOL'),
    u64(strike * 100),
    i64(expiryAt),
    new Uint8Array([kind]),
  ], program)[0]
}

function deriveQuote(program, market, maker, nonce) {
  return PublicKey.findProgramAddressSync([
    encoder.encode('quote'),
    market.toBytes(),
    maker.toBytes(),
    u64(nonce),
  ], program)[0]
}

function initializeMarket(program, maker, market, strike, expiryAt, kind) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, ...i64(expiryAt), ...u64(strike * 100), kind]),
  })
}

function depositLiquidity(program, maker, market, amountLamports) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([5, ...u64(amountLamports)]),
  })
}

function publishQuote(program, maker, market, quoteAddress, quote, terms) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: quoteAddress, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([
      4,
      quote.side,
      ...u64(quote.priceCents),
      ...u64(quote.sizeLamports),
      ...i64(quote.expiresAt),
      ...u64(quote.nonce),
      ...u64(terms.premiumLamportsPerSol),
      ...u64(terms.collateralLamportsPerSol),
    ]),
  })
}

async function send(maker, instructions) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const latest = await connection.getLatestBlockhash('finalized')
      const transaction = new Transaction({
        feePayer: maker.publicKey,
        recentBlockhash: latest.blockhash,
      }).add(...instructions)
      transaction.sign(maker)
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      })
      for (let poll = 0; poll < 30; poll += 1) {
        const status = (await connection.getSignatureStatuses([signature])).value[0]
        if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error(`Transaction confirmation timed out: ${signature}`)
    } catch (error) {
      lastError = error
      if (!String(error?.message || error).toLowerCase().includes('blockhash')) throw error
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)))
    }
  }
  throw lastError
}

function quoteFromAccount(address, data, now) {
  if (!data || data.length < 122) return null
  const sizeLamports = readU64(data, 73)
  const filledLamports = readU64(data, 81)
  const expiresAt = readI64(data, 89)
  if (data[105] !== 1 || expiresAt <= now || filledLamports >= sizeLamports) return null
  return {
    quoteAddress: address.toBase58(),
    maker: new PublicKey(data.slice(0, 32)).toBase58(),
    market: new PublicKey(data.slice(32, 64)).toBase58(),
    side: data[64],
    priceCents: readU64(data, 65),
    nonce: readU64(data, 97),
    premiumLamportsPerSol: readU64(data, 106),
    collateralLamportsPerSol: readU64(data, 114),
    expiresAt,
    remainingSize: (sizeLamports - filledLamports) / SOLANA_DECIMALS,
  }
}

async function loadActiveQuotes(program, maker, now) {
  if (activeQuoteSnapshot && Date.now() - activeQuoteSnapshot.createdAt < 5_000) return activeQuoteSnapshot.quotes
  const accounts = await connection.getProgramAccounts(program, { filters: [{ dataSize: 122 }] })
  const quotes = new Map()
  for (const account of accounts) {
    const parsed = quoteFromAccount(account.pubkey, new Uint8Array(account.account.data), now)
    if (!parsed || parsed.maker !== maker.publicKey.toBase58()) continue
    quotes.set(`${parsed.market}:${parsed.side}`, parsed)
  }
  activeQuoteSnapshot = { createdAt: Date.now(), quotes }
  return quotes
}

async function liveSpot(fallbackSpot = 0) {
  if (cachedSpot > 0 && Date.now() - cachedSpotAt < SPOT_CACHE_MS) return cachedSpot
  const sources = [
    async () => {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_last_updated_at=true', { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('CoinGecko unavailable')
      return (await response.json())?.solana?.usd
    },
    async () => {
      const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('Binance unavailable')
      return Number((await response.json())?.price)
    },
    async () => fallbackSpot,
  ]
  for (const source of sources) {
    try {
      const spot = await source()
      if (typeof spot === 'number' && Number.isFinite(spot) && spot > 0) {
        cachedSpot = spot
        cachedSpotAt = Date.now()
        return spot
      }
    } catch {
      // Continue to the next independent spot source.
    }
  }
  throw new Error('Live SOL spot feeds are unavailable.')
}

function nextQuoteNonce(side) {
  const nonce = quoteNonceSequence + BigInt(side)
  quoteNonceSequence += 2n
  return Number(nonce)
}

async function settlePosition(maker, program, marketAddress, positionAddress) {
  const market = new PublicKey(marketAddress)
  const position = new PublicKey(positionAddress)
  const [marketInfo, positionInfo] = await Promise.all([
    connection.getAccountInfo(market, 'confirmed'),
    connection.getAccountInfo(position, 'confirmed'),
  ])
  if (!marketInfo || !positionInfo || marketInfo.owner.toBase58() !== program.toBase58() || positionInfo.owner.toBase58() !== program.toBase58()) {
    throw new Error('Market or position account was not found on the configured program.')
  }
  const marketData = new Uint8Array(marketInfo.data)
  const positionData = new Uint8Array(positionInfo.data)
  if (marketData.length < 106 || positionData.length < 146) throw new Error('Account layout does not match the deployed Soleil program.')
  const authority = new PublicKey(marketData.slice(32, 64))
  const positionMarket = new PublicKey(positionData.slice(32, 64))
  const owner = new PublicKey(positionData.slice(0, 32))
  const expiryAt = readI64(marketData, 64)
  const now = Math.floor(Date.now() / 1000)
  if (!authority.equals(maker.publicKey) || !positionMarket.equals(market) || marketData[80] > 1) throw new Error('The configured maker does not control this position market.')
  if (positionData[113] !== 1) throw new Error('This position is no longer open.')
  if (expiryAt > now) throw new Error('This position has not expired yet.')
  const spot = await liveSpot()
  const observedAt = Math.floor(Date.now() / 1000)
  const instruction = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: maker.publicKey, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([3, ...u64(Math.floor(spot * 100)), ...i64(observedAt)]),
  })
  const signature = await send(maker, [instruction])
  return { signature, oraclePrice: spot, observedAt }
}

async function ensureMarket(program, maker, strike, expiryAt, kind) {
  const market = deriveMarket(program, strike, expiryAt, kind)
  let account = await connection.getAccountInfo(market, 'confirmed')
  if (!account) {
    await send(maker, [initializeMarket(program, maker, market, strike, expiryAt, kind), depositLiquidity(program, maker, market, LIQUIDITY_LAMPORTS)])
    account = await connection.getAccountInfo(market, 'confirmed')
  }
  if (!account) throw new Error(`Market ${market.toBase58()} was not created.`)
  const data = new Uint8Array(account.data)
  if (data.length < 106 || new PublicKey(data.slice(0, 32)).toBase58() !== maker.publicKey.toBase58()) {
    throw new Error(`Market ${market.toBase58()} is controlled by another authority.`)
  }
  if (!account.owner.equals(program)) throw new Error('Market account belongs to another program.')
  const liquidityLamports = readU64(data, 82)
  if (liquidityLamports < QUOTE_SIZE_LAMPORTS) {
    await send(maker, [depositLiquidity(program, maker, market, QUOTE_SIZE_LAMPORTS - liquidityLamports)])
    account = await connection.getAccountInfo(market, 'confirmed')
    if (!account || readU64(new Uint8Array(account.data), 82) < QUOTE_SIZE_LAMPORTS) throw new Error(`Market ${market.toBase58()} could not be funded for quote size.`)
  }
  return market
}

async function ensureQuote(program, maker, market, quote, terms) {
  const now = Math.floor(Date.now() / 1000)
  const nonce = nextQuoteNonce(quote.side)
  const address = deriveQuote(program, market, maker.publicKey, nonce)
  const existing = quoteFromAccount(address, new Uint8Array((await connection.getAccountInfo(address, 'confirmed'))?.data || []), now)
  if (existing) return existing
  await send(maker, [publishQuote(program, maker, market, address, { ...quote, nonce }, terms)])
  const created = await connection.getAccountInfo(address, 'confirmed')
  const parsed = quoteFromAccount(address, new Uint8Array(created?.data || []), now)
  if (!parsed) throw new Error(`Quote ${address.toBase58()} was not published.`)
  return parsed
}

function formatExpiry(expiryAt) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(expiryAt * 1000))
}

function quoteRow(mid, iv, spot, sizeLamports, market, program, maker, expiryAt, kind, strike) {
  const spread = Math.max(0.02, mid * 0.045)
  return {
    bid: Math.max(0.01, mid - spread),
    ask: mid + spread,
    iv: Math.round(iv),
    async publish() {
      const bidPrice = Math.max(0.01, mid - spread)
      const askPrice = mid + spread
      const bidPremium = Math.max(1, Math.floor((bidPrice / spot) * SOLANA_DECIMALS))
      const askPremium = Math.max(1, Math.floor((askPrice / spot) * SOLANA_DECIMALS))
      const bidQuote = await ensureQuote(program, maker, market, {
        side: 0,
        priceCents: Math.floor(bidPrice * 100),
        sizeLamports,
        expiresAt: Math.min(expiryAt, Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS),
      }, { premiumLamportsPerSol: bidPremium, collateralLamportsPerSol: COLLATERAL_LAMPORTS_PER_SOL })
      const askQuote = await ensureQuote(program, maker, market, {
        side: 1,
        priceCents: Math.floor(askPrice * 100),
        sizeLamports,
        expiresAt: Math.min(expiryAt, Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS),
      }, { premiumLamportsPerSol: askPremium, collateralLamportsPerSol: COLLATERAL_LAMPORTS_PER_SOL })
      return { bidQuote, askQuote }
    },
  }
}

function buildSeries(spot, expiryDays) {
  const expiryAt = Math.floor(Date.now() / 86_400_000) * 86_400 + expiryDays * 86_400 + 28_800
  // Keep strike ladder stable as spot moves; otherwise every small move creates new PDAs and rent.
  const center = Math.max(10, Math.round(spot / 10) * 10)
  const expiry = expiryDays / 365
  return { expiryAt, strikes: [-10, -5, 0, 5, 10].map((offset) => Math.max(5, center + offset)), expiry }
}

async function makeQuotes(expiryDays, fallbackSpot) {
  requireConfig()
  const maker = loadMaker()
  const program = programId()
  const spot = await liveSpot(fallbackSpot)
  const { expiryAt, strikes, expiry } = buildSeries(spot, expiryDays)
  const activeQuotes = await loadActiveQuotes(program, maker, Math.floor(Date.now() / 1000))
  const rows = []
  for (const strike of strikes) {
    const distance = Math.abs(strike - spot) / spot
    const baseIv = 54 + distance * 120 + Math.sqrt(expiryDays) * 0.8
    const timeValue = spot * (baseIv / 100) * Math.sqrt(expiry) * 0.16
    const callMid = Math.max(0.01, Math.max(spot - strike, 0) + timeValue)
    const putMid = Math.max(0.01, Math.max(strike - spot, 0) + timeValue)
    const callMarket = deriveMarket(program, strike, expiryAt, 0)
    const putMarket = deriveMarket(program, strike, expiryAt, 1)
    const callBidQuote = activeQuotes.get(`${callMarket.toBase58()}:0`)
    const callAskQuote = activeQuotes.get(`${callMarket.toBase58()}:1`)
    const putBidQuote = activeQuotes.get(`${putMarket.toBase58()}:0`)
    const putAskQuote = activeQuotes.get(`${putMarket.toBase58()}:1`)
    if (!callBidQuote || !callAskQuote || !putBidQuote || !putAskQuote) continue
    rows.push({
      expiryDays,
      expiryAt,
      expiryLabel: formatExpiry(expiryAt),
      strike,
      call: { bid: callBidQuote.priceCents / 100, ask: callAskQuote.priceCents / 100, iv: Math.round(baseIv), bidQuote: callBidQuote, askQuote: callAskQuote },
      put: { bid: putBidQuote.priceCents / 100, ask: putAskQuote.priceCents / 100, iv: Math.round(baseIv + 1), bidQuote: putBidQuote, askQuote: putAskQuote },
    })
  }
  if (rows.length < strikes.length) {
    // Replenish expired accounts only when no complete live snapshot remains. This keeps normal polling read-only.
    const balanceLamports = await connection.getBalance(maker.publicKey, 'confirmed')
    const quoteRentLamports = await connection.getMinimumBalanceForRentExemption(122)
    const requiredLamports = quoteRentLamports * strikes.length * 2 + 500_000
    if (balanceLamports < requiredLamports) {
      throw new Error(`Maker wallet needs ${(requiredLamports / SOLANA_DECIMALS).toFixed(6)} SOL to replenish 10 quote accounts; current balance ${(balanceLamports / SOLANA_DECIMALS).toFixed(6)} SOL.`)
    }
    rows.length = 0
    for (const strike of strikes) {
      const distance = Math.abs(strike - spot) / spot
      const baseIv = 54 + distance * 120 + Math.sqrt(expiryDays) * 0.8
      const timeValue = spot * (baseIv / 100) * Math.sqrt(expiry) * 0.16
      const callMid = Math.max(0.01, Math.max(spot - strike, 0) + timeValue)
      const putMid = Math.max(0.01, Math.max(strike - spot, 0) + timeValue)
      const callMarket = await ensureMarket(program, maker, strike, expiryAt, 0)
      const putMarket = await ensureMarket(program, maker, strike, expiryAt, 1)
      const call = quoteRow(callMid, baseIv, spot, QUOTE_SIZE_LAMPORTS, callMarket, program, maker, expiryAt, 0, strike)
      const put = quoteRow(putMid, baseIv + 1, spot, QUOTE_SIZE_LAMPORTS, putMarket, program, maker, expiryAt, 1, strike)
      rows.push({
        expiryDays,
        expiryAt,
        expiryLabel: formatExpiry(expiryAt),
        strike,
        call: { bid: call.bid, ask: call.ask, iv: call.iv, ...(await call.publish()) },
        put: { bid: put.bid, ask: put.ask, iv: put.iv, ...(await put.publish()) },
      })
    }
  }
  if (rows.length === 0) throw new Error('No active funded maker quotes found for this expiry.')
  return rows
}

function cachedQuotes(expiryDays, fallbackSpot) {
  const cached = quoteCache.get(expiryDays)
  if (cached && Date.now() - cached.createdAt < QUOTE_CACHE_MS) return cached.promise
  // Serialize publications so overlapping browser polls do not race account creation.
  const promise = quoteQueue.then(() => makeQuotes(expiryDays, fallbackSpot))
  quoteQueue = promise.catch(() => undefined)
  quoteCache.set(expiryDays, { promise, createdAt: Date.now() })
  promise.catch(() => { if (quoteCache.get(expiryDays)?.promise === promise) quoteCache.delete(expiryDays) })
  return promise
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  response.end(JSON.stringify(payload))
}

export async function handleGatewayRequest(request, response) {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
    if (url.pathname === '/health') return json(response, 200, { ok: true, configured: Boolean(PROGRAM_ID && MAKER_KEYPAIR && LIQUIDITY_LAMPORTS > 0 && QUOTE_SIZE_LAMPORTS > 0 && COLLATERAL_LAMPORTS_PER_SOL > 0) })
    if (url.pathname === '/settle') {
      requireConfig()
      const marketAddress = url.searchParams.get('market')
      const positionAddress = url.searchParams.get('position')
      if (!marketAddress || !positionAddress) return json(response, 400, { error: 'market and position are required.' })
      const maker = loadMaker()
      return json(response, 200, await settlePosition(maker, programId(), marketAddress, positionAddress))
    }
    if (url.pathname !== '/quotes') return json(response, 404, { error: 'Not found' })
    const expiryDays = Number(url.searchParams.get('expiryDays') || 7)
    if (![7, 10, 14].includes(expiryDays)) return json(response, 400, { error: 'expiryDays must be 7, 10, or 14.' })
    const fallbackSpot = Number(url.searchParams.get('spot'))
    return json(response, 200, await cachedQuotes(expiryDays, fallbackSpot))
  } catch (error) {
    console.error('gateway request failed:', error)
    return json(response, 503, { error: error instanceof Error ? error.message : 'Maker gateway unavailable.' })
  }
}

if (process.env.VERCEL !== '1') {
  const server = createServer(handleGatewayRequest)
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Soleil maker gateway listening on http://127.0.0.1:${PORT}`)
  })
}
