import type { OptionSeries, QuoteTerms } from './domain'

const endpoint = import.meta.env.VITE_SOLEIL_QUOTES_URL as string | undefined
const settlementEndpoint = import.meta.env.VITE_SOLEIL_SETTLEMENT_URL as string | undefined

export const quoteGatewayConfigured = Boolean(endpoint)

export interface SettlementReceipt {
  signature: string
  oraclePrice: number
  observedAt: number
}

export async function settleThroughGateway(marketAddress: string, positionAddress: string): Promise<SettlementReceipt> {
  const url = settlementEndpoint
    ? new URL(settlementEndpoint, window.location.origin)
    : endpoint
      ? new URL('./settle', new URL(endpoint, window.location.origin))
      : null
  if (!url) throw new Error('Settlement keeper is not connected.')
  url.searchParams.set('market', marketAddress)
  url.searchParams.set('position', positionAddress)
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  const payload = await response.json().catch(() => null) as Partial<SettlementReceipt> & { error?: string } | null
  if (!response.ok || typeof payload?.signature !== 'string') throw new Error(payload?.error || 'Settlement keeper is unavailable.')
  return {
    signature: payload.signature,
    oraclePrice: Number(payload.oraclePrice),
    observedAt: Number(payload.observedAt),
  }
}

const isTerms = (value: unknown): value is QuoteTerms => {
  if (!value || typeof value !== 'object') return false
  const terms = value as Record<string, unknown>
  return typeof terms.quoteAddress === 'string'
    && typeof terms.maker === 'string'
    && typeof terms.nonce === 'number'
    && Number.isSafeInteger(terms.nonce)
    && terms.nonce >= 0
    && typeof terms.premiumLamportsPerSol === 'number'
    && terms.premiumLamportsPerSol > 0
    && Number.isSafeInteger(terms.premiumLamportsPerSol)
    && typeof terms.collateralLamportsPerSol === 'number'
    && terms.collateralLamportsPerSol > 0
    && Number.isSafeInteger(terms.collateralLamportsPerSol)
    && typeof terms.expiresAt === 'number' && Number.isSafeInteger(terms.expiresAt) && terms.expiresAt > Date.now() / 1000
    && typeof terms.remainingSize === 'number' && Number.isFinite(terms.remainingSize) && terms.remainingSize > 0
}

const isQuote = (value: unknown): value is { bid: number; ask: number; iv: number; bidQuote: QuoteTerms; askQuote: QuoteTerms } => {
  if (!value || typeof value !== 'object') return false
  const quote = value as Record<string, unknown>
  return typeof quote.bid === 'number'
    && typeof quote.ask === 'number'
    && typeof quote.iv === 'number'
    && quote.bid >= 0
    && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && Number.isFinite(quote.iv)
    && quote.ask >= quote.bid
    && isTerms(quote.bidQuote)
    && isTerms(quote.askQuote)
}

const isSeries = (value: unknown): value is OptionSeries => {
  if (!value || typeof value !== 'object') return false
  const series = value as Record<string, unknown>
  return typeof series.expiryDays === 'number'
    && typeof series.expiryLabel === 'string'
    && typeof series.expiryAt === 'number'
    && Number.isInteger(series.expiryAt)
    && typeof series.strike === 'number'
    && Number.isFinite(series.strike) && series.strike > 0
    && (series.expiryAt as number) > Date.now() / 1000
    && isQuote(series.call)
    && isQuote(series.put)
}

export async function fetchMakerQuotes(spot: number, expiryDays: number): Promise<OptionSeries[] | null> {
  if (!endpoint || !Number.isFinite(spot) || spot <= 0) return null
  try {
    const url = new URL(endpoint, window.location.origin)
    url.searchParams.set('underlying', 'SOL')
    url.searchParams.set('spot', String(spot))
    url.searchParams.set('expiryDays', String(expiryDays))
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return null
    const payload = await response.json() as unknown
    const quotes = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' && Array.isArray((payload as { quotes?: unknown }).quotes) ? (payload as { quotes: unknown[] }).quotes : null)
    if (!quotes || quotes.length === 0 || !quotes.every(isSeries) || !quotes.every((row) => row.expiryDays === expiryDays)) return null
    return quotes
  } catch {
    return null
  }
}
