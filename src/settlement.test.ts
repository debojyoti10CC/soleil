import { describe, expect, it } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { buildOpenPositionInstruction, deriveQuotePda, deriveMarketPda, quoteTotalLamports } from './settlement'

describe('transaction values', () => {
  it('calculates fractional SOL premiums using integer arithmetic', () => {
    expect(quoteTotalLamports(20_000_000, 0.25)).toBe(5_000_000)
  })
  it.each([NaN, Infinity, -1, 0])('rejects invalid quantities: %s', (quantity) => {
    expect(() => quoteTotalLamports(20_000_000, quantity)).toThrow()
  })
  it('rounds USD cents consistently before deriving addresses and encoding the price', () => {
    const programId = new PublicKey(new Uint8Array(32).fill(7))
    const owner = new PublicKey(new Uint8Array(32).fill(8))
    const maker = new PublicKey(new Uint8Array(32).fill(9))
    const market = deriveMarketPda(programId, 170.01, 1_900_000_000, 'put')
    const quote = deriveQuotePda(programId, market, maker, 42)
    const instruction = buildOpenPositionInstruction({ programId, owner, maker, kind: 'put', side: 'buy', strike: 170.01, expiryAt: 1_900_000_000, quantity: 0.25, premium: 1.15, premiumLamports: 5_000_000, collateralLamports: 0, quoteNonce: 42, quoteAddress: quote.toBase58() })
    expect(new DataView(instruction.data.buffer, instruction.data.byteOffset).getBigUint64(10, true)).toBe(115n)
    expect(instruction.keys[1].pubkey.equals(market)).toBe(true)
    expect(instruction.keys[2].pubkey.equals(quote)).toBe(true)
  })
})
