import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemProgram, PublicKey } from '@solana/web3.js'
import { solanaConnection, submitSolanaTransaction } from './solana'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('on-chain confirmation', () => {
  it.each([null, { InstructionError: [0, { Custom: 9 }] }])('only returns successful receipts (%j)', async (err) => {
    const owner = new PublicKey(new Uint8Array(32).fill(8))
    vi.stubGlobal('window', { solana: { isPhantom: true, publicKey: owner, signAndSendTransaction: vi.fn().mockResolvedValue({ signature: 'test-signature' }) } })
    vi.spyOn(solanaConnection, 'getLatestBlockhash').mockResolvedValue({ blockhash: owner.toBase58(), lastValidBlockHeight: 100 })
    vi.spyOn(solanaConnection, 'simulateTransaction').mockResolvedValue({ context: { slot: 1 }, value: { err: null } } as never)
    vi.spyOn(solanaConnection, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [{ err, confirmationStatus: 'confirmed' }] } as never)
    const result = submitSolanaTransaction([SystemProgram.transfer({ fromPubkey: owner, toPubkey: SystemProgram.programId, lamports: 1 })])
    if (err) await expect(result).rejects.toThrow('Transaction failed on Solana')
    else await expect(result).resolves.toBe('test-signature')
  })
})
