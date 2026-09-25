import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import type { OptionKind, TradeSide } from './domain'

const configuredProgramId = import.meta.env.VITE_SOLEIL_PROGRAM_ID as string | undefined
const encoder = new TextEncoder()

export const getSettlementProgramId = () => {
  if (!configuredProgramId) return null
  try { return new PublicKey(configuredProgramId) } catch { return null }
}

const numberBytes = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Transaction values must be nonnegative safe integers.')
  const bytes = new Uint8Array(8)
  let remaining = BigInt(Math.max(0, Math.floor(value)))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 255n)
    remaining >>= 8n
  }
  return bytes
}

const priceUnits = (value: number) => numberBytes(Math.round(value * 100))
const solUnits = (value: number) => numberBytes(Math.round(value * 1_000_000_000))
const lamportsPerSol = (value: number) => numberBytes(value)
const kindByte = (kind: OptionKind) => kind === 'call' ? 0 : 1
const sideByte = (side: TradeSide) => side === 'buy' ? 0 : 1
const quoteBytes = (value: number) => numberBytes(value)

export function quoteTotalLamports(perSol: number, quantitySol: number) {
  if (!Number.isSafeInteger(perSol) || perSol <= 0 || !Number.isFinite(quantitySol) || quantitySol <= 0 || !Number.isSafeInteger(Math.round(quantitySol * 1_000_000_000))) throw new Error('Invalid quote amount or quantity.')
  const perSolLamports = BigInt(Math.max(0, Math.floor(perSol)))
  const quantityLamports = BigInt(Math.max(0, Math.floor(quantitySol * 1_000_000_000)))
  const total = perSolLamports * quantityLamports / 1_000_000_000n
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quote amount exceeds browser integer precision.')
  return Number(total)
}

export const deriveMarketPda = (
  programId: PublicKey,
  strike: number,
  expiryAt: number,
  kind: OptionKind,
  underlying = 'SOL',
) => PublicKey.findProgramAddressSync([
  encoder.encode('market'),
  encoder.encode(underlying),
  priceUnits(strike),
  numberBytes(expiryAt),
  new Uint8Array([kindByte(kind)]),
], programId)[0]

export const derivePositionPda = (
  programId: PublicKey,
  owner: PublicKey,
  market: PublicKey,
  expiryAt: number,
) => PublicKey.findProgramAddressSync([
  encoder.encode('position'),
  owner.toBytes(),
  market.toBytes(),
  numberBytes(expiryAt),
], programId)[0]

export const deriveQuotePda = (
  programId: PublicKey,
  market: PublicKey,
  maker: PublicKey,
  nonce: number,
) => PublicKey.findProgramAddressSync([
  encoder.encode('quote'),
  market.toBytes(),
  maker.toBytes(),
  quoteBytes(nonce),
], programId)[0]

export interface PublishQuoteInstructionInput {
  programId: PublicKey
  maker: PublicKey
  kind: OptionKind
  strike: number
  expiryAt: number
  side: TradeSide
  price: number
  size: number
  expiresAt: number
  nonce: number
  premiumLamportsPerSol: number
  collateralLamportsPerSol: number
}

export function buildPublishQuoteInstruction(input: PublishQuoteInstructionInput) {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  const quote = deriveQuotePda(input.programId, market, input.maker, input.nonce)
  const data = new Uint8Array([
    4,
    sideByte(input.side),
    ...priceUnits(input.price),
    ...solUnits(input.size),
    ...numberBytes(input.expiresAt),
    ...numberBytes(input.nonce),
    ...lamportsPerSol(input.premiumLamportsPerSol),
    ...lamportsPerSol(input.collateralLamportsPerSol),
  ])
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.maker, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: quote, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: data as any,
  })
}

export interface InitializeMarketInstructionInput {
  programId: PublicKey
  authority: PublicKey
  kind: OptionKind
  strike: number
  expiryAt: number
}

export function buildInitializeMarketInstruction(input: InitializeMarketInstructionInput) {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  const data = new Uint8Array([
    0,
    ...numberBytes(input.expiryAt),
    ...priceUnits(input.strike),
    kindByte(input.kind),
  ])
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: data as any,
  })
}

export interface LiquidityInstructionInput {
  programId: PublicKey
  authority: PublicKey
  kind: OptionKind
  strike: number
  expiryAt: number
  amountLamports: number
}

export function buildDepositLiquidityInstruction(input: LiquidityInstructionInput) {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([5, ...numberBytes(input.amountLamports)]) as any,
  })
}

export function buildWithdrawLiquidityInstruction(input: LiquidityInstructionInput) {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([6, ...numberBytes(input.amountLamports)]) as any,
  })
}

export interface OpenPositionInstructionInput {
  programId: PublicKey
  owner: PublicKey
  kind: OptionKind
  side: TradeSide
  strike: number
  quantity: number
  premium: number
  floor?: number
  maker: PublicKey
  quoteNonce: number
  quoteAddress?: string
  expiryAt: number
  premiumLamports: number
  collateralLamports: number
}

export function buildOpenPositionInstruction(input: OpenPositionInstructionInput) {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  const quote = deriveQuotePda(input.programId, market, input.maker, input.quoteNonce)
  if (input.quoteAddress && input.quoteAddress !== quote.toBase58()) throw new Error('Maker quote address does not match its PDA.')
  const position = derivePositionPda(input.programId, input.owner, market, input.expiryAt)
  const data = new Uint8Array([
    1,
    sideByte(input.side),
    ...solUnits(input.quantity),
    ...priceUnits(input.premium),
    ...priceUnits(input.floor ?? 0),
    ...numberBytes(input.quoteNonce),
    ...numberBytes(input.expiryAt),
    ...numberBytes(input.premiumLamports),
    ...numberBytes(input.collateralLamports),
  ])
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: quote, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: data as any,
  })
}

export interface ProtectionInstructionInput {
  programId: PublicKey
  owner: PublicKey
  strike: number
  quantity: number
  floor: number
  premium?: number
  maker: PublicKey
  quoteNonce: number
  quoteAddress?: string
  expiryAt: number
  premiumLamports: number
  collateralLamports?: number
}

export function buildProtectionInstruction(input: ProtectionInstructionInput) {
  return buildOpenPositionInstruction({
    programId: input.programId,
    owner: input.owner,
    kind: 'put',
    side: 'buy',
    strike: input.strike,
    quantity: input.quantity,
    premium: input.premium ?? 0,
    floor: input.floor,
    maker: input.maker,
    quoteNonce: input.quoteNonce,
    quoteAddress: input.quoteAddress,
    expiryAt: input.expiryAt,
    premiumLamports: input.premiumLamports,
    collateralLamports: input.collateralLamports ?? 0,
  })
}

export interface PositionReference {
  programId: PublicKey
  owner: PublicKey
  kind: OptionKind
  strike: number
  expiryAt: number
}

const positionAccounts = (input: PositionReference) => {
  const market = deriveMarketPda(input.programId, input.strike, input.expiryAt, input.kind)
  const position = derivePositionPda(input.programId, input.owner, market, input.expiryAt)
  return { market, position }
}

export function buildClosePositionInstruction(input: PositionReference) {
  const { market, position } = positionAccounts(input)
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([2]) as any,
  })
}

export interface SettlePositionInstructionInput extends PositionReference {
  oracle: PublicKey
  oraclePrice: number
  oracleObservedAt: number
}

export function buildSettlePositionInstruction(input: SettlePositionInstructionInput) {
  const { market, position } = positionAccounts(input)
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.oracle, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.owner, isSigner: false, isWritable: true },
    ],
    data: new Uint8Array([3, ...priceUnits(input.oraclePrice), ...numberBytes(input.oracleObservedAt)]) as any,
  })
}
