import { describe, expect, it } from 'vitest'

import { buildOptionSeries, buildStrategyLegs, calculateGreeks, payoffAtExpiry, strategyPayoffAtExpiry } from './domain'

describe('indicative options domain', () => {
  it('changes the chain when expiry changes', () => {
    const week = buildOptionSeries(120, 7)
    const fortnight = buildOptionSeries(120, 14)
    expect(week).toHaveLength(5)
    expect(fortnight[2].put.ask).toBeGreaterThan(week[2].put.ask)
    expect(fortnight[2].expiryDays).toBe(14)
  })

  it('returns directional greeks around the at-the-money strike', () => {
    const call = calculateGreeks(120, 120, 7, 60, 'call')
    const put = calculateGreeks(120, 120, 7, 60, 'put')
    expect(call.delta).toBeGreaterThan(0)
    expect(put.delta).toBeLessThan(0)
    expect(call.gamma).toBeGreaterThan(0)
    expect(call.vega).toBeGreaterThan(0)
  })

  it('shows long and short payoff with opposite signs', () => {
    expect(payoffAtExpiry(100, 110, 'put', 'buy', 3)).toBe(7)
    expect(payoffAtExpiry(100, 110, 'put', 'sell', 3)).toBe(-7)
  })

  it('builds a two-leg collar and combines its payoff', () => {
    const chain = buildOptionSeries(120, 7)
    const legs = buildStrategyLegs('collar', chain, 120)
    expect(legs).toHaveLength(2)
    expect(legs[0].kind).toBe('put')
    expect(legs[1].side).toBe('sell')
    expect(strategyPayoffAtExpiry(120, legs)).toBeLessThan(0)
  })
})
