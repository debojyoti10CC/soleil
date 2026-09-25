export type View = 'market' | 'guard' | 'portfolio'
export type OptionKind = 'call' | 'put'
export type TradeSide = 'buy' | 'sell'
export type StrategyKind = 'protective-put' | 'collar' | 'covered-call' | 'bull-call-spread' | 'bear-put-spread'

export interface QuoteTerms {
  quoteAddress: string
  maker: string
  nonce: number
  premiumLamportsPerSol: number
  collateralLamportsPerSol: number
  expiresAt: number
  remainingSize: number
}

export interface OptionQuote {
  bid: number
  ask: number
  iv: number
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
  /** The on-chain maker quote backing the bid. */
  bidQuote?: QuoteTerms
  /** The on-chain maker quote backing the ask. */
  askQuote?: QuoteTerms
}

export interface OptionGreeks {
  delta: number
  gamma: number
  theta: number
  vega: number
}

export interface StrategyLeg {
  kind: OptionKind
  side: TradeSide
  strike: number
  premium: number
}

export interface OptionSeries {
  expiryDays: number
  expiryLabel: string
  expiryAt?: number
  strike: number
  call: OptionQuote
  put: OptionQuote
}

export interface Position {
  id: string
  kind: OptionKind
  side: TradeSide
  strike: number
  expiryLabel: string
  expiryDays: number
  expiryAt?: number
  quantity: number
  entry: number
  mark: number
  status: 'Open' | 'Closed' | 'Settled'
  premiumLamports?: number
  collateralLamports?: number
  payoutLamports?: number
  reservedLamports?: number
  receipt?: string
  positionAddress?: string
  marketAddress?: string
}

export interface ExposureComponent {
  label: string
  detail: string
  quantity: number
  tone: 'sol' | 'lst' | 'short'
}

export interface PortfolioSnapshot {
  spot: number
  walletValue: number
  netExposure: number
  components: ExposureComponent[]
  positions: Position[]
}

const formatExpiry = (days: number) => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(Date.now() + days * 86_400_000))

const normalPdf = (value: number) => Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI)

const normalCdf = (value: number) => {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const polynomial = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * polynomial)
}

/** Black-Scholes-style risk metrics for the indicative chain. These are display values until a venue supplies maker greeks. */
export function calculateGreeks(spot: number, strike: number, expiryDays: number, ivPercent: number, kind: OptionKind): OptionGreeks {
  const time = Math.max(expiryDays, 1) / 365
  const volatility = Math.max(ivPercent, 1) / 100
  const d1 = (Math.log(Math.max(spot, 0.01) / Math.max(strike, 0.01)) + (volatility ** 2 / 2) * time) / (volatility * Math.sqrt(time))
  const d2 = d1 - volatility * Math.sqrt(time)
  const delta = kind === 'call' ? normalCdf(d1) : normalCdf(d1) - 1
  const gamma = normalPdf(d1) / (Math.max(spot, 0.01) * volatility * Math.sqrt(time))
  const theta = (-(Math.max(spot, 0.01) * normalPdf(d1) * volatility) / (2 * Math.sqrt(time))) / 365
  const vega = Math.max(spot, 0.01) * normalPdf(d1) * Math.sqrt(time) / 100
  // Keep d2 used in the formula path so future rates/dividends can be added without changing the API.
  void d2
  return { delta, gamma, theta, vega }
}

export function payoffAtExpiry(spot: number, strike: number, kind: OptionKind, side: TradeSide, premium: number) {
  const intrinsic = kind === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  const longPayoff = intrinsic - premium
  return side === 'buy' ? longPayoff : -longPayoff
}

const seriesQuote = (series: OptionSeries, kind: OptionKind, side: TradeSide) => side === 'buy' ? series[kind].ask : series[kind].bid

/** Build display-only multi-leg strategies from the current chain. Execution remains single-leg until atomic RFQ is available. */
export function buildStrategyLegs(kind: StrategyKind, series: OptionSeries[], anchorStrike: number): StrategyLeg[] {
  const ordered = [...series].sort((a, b) => a.strike - b.strike)
  const anchorIndex = Math.max(0, ordered.findIndex((item) => item.strike === anchorStrike))
  const anchor = ordered[anchorIndex]
  if (!anchor) return []
  const higher = ordered[anchorIndex + 1] ?? anchor
  if (kind === 'protective-put') return [{ kind: 'put', side: 'buy', strike: anchor.strike, premium: seriesQuote(anchor, 'put', 'buy') }]
  if (kind === 'covered-call') return [{ kind: 'call', side: 'sell', strike: anchor.strike, premium: seriesQuote(anchor, 'call', 'sell') }]
  if (kind === 'collar') return [
    { kind: 'put', side: 'buy', strike: anchor.strike, premium: seriesQuote(anchor, 'put', 'buy') },
    { kind: 'call', side: 'sell', strike: higher.strike, premium: seriesQuote(higher, 'call', 'sell') },
  ]
  if (kind === 'bull-call-spread') return [
    { kind: 'call', side: 'buy', strike: anchor.strike, premium: seriesQuote(anchor, 'call', 'buy') },
    { kind: 'call', side: 'sell', strike: higher.strike, premium: seriesQuote(higher, 'call', 'sell') },
  ]
  return [
    { kind: 'put', side: 'buy', strike: higher.strike, premium: seriesQuote(higher, 'put', 'buy') },
    { kind: 'put', side: 'sell', strike: anchor.strike, premium: seriesQuote(anchor, 'put', 'sell') },
  ]
}

export function strategyPayoffAtExpiry(spot: number, legs: StrategyLeg[]) {
  return legs.reduce((total, leg) => total + payoffAtExpiry(spot, leg.strike, leg.kind, leg.side, leg.premium), 0)
}

const quote = (mid: number, iv: number, greeks: OptionGreeks): OptionQuote => {
  const spread = Math.max(0.02, mid * 0.045)
  return { bid: Math.max(0.01, mid - spread), ask: mid + spread, iv: Math.round(iv), ...greeks }
}

/** Indicative Black-Scholes-style quotes from the live SOL spot feed until Soleil's venue is deployed. */
export function buildOptionSeries(spot: number, expiryDays: number): OptionSeries[] {
  if (!Number.isFinite(spot) || spot <= 0) return []
  const center = Math.round(spot / 5) * 5
  const expiry = expiryDays / 365
  const expiryAt = Math.floor(Date.now() / 1000) + expiryDays * 86_400
  const strikes = [-10, -5, 0, 5, 10].map((offset) => Math.max(5, center + offset))
  return strikes.map((strike) => {
    const distance = Math.abs(strike - spot) / spot
    const baseIv = 54 + distance * 120 + Math.sqrt(expiryDays) * 0.8
    const timeValue = spot * (baseIv / 100) * Math.sqrt(expiry) * 0.16
    const callMid = Math.max(0.01, Math.max(spot - strike, 0) + timeValue)
    const putMid = Math.max(0.01, Math.max(strike - spot, 0) + timeValue)
    const callGreeks = calculateGreeks(spot, strike, expiryDays, baseIv, 'call')
    const putGreeks = calculateGreeks(spot, strike, expiryDays, baseIv + 1, 'put')
    return {
      expiryDays,
      expiryLabel: formatExpiry(expiryDays),
      expiryAt,
      strike,
      call: quote(callMid, baseIv, callGreeks),
      put: quote(putMid, baseIv + 1, putGreeks),
    }
  })
}
