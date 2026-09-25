// Run locally with the maker key in .env. No transactions are sent with --check.
process.env.VERCEL = '1'
process.env.SOLEIL_MARKET_LIQUIDITY_LAMPORTS = '1000000000'
process.env.SOLEIL_QUOTE_SIZE_LAMPORTS = '1000000000'

const { estimateSeriesFunding, makeQuotes } = await import('../maker-gateway/server.mjs')
const expiries = [7, 10, 14]
const funding = []

for (const days of expiries) {
  const estimate = await estimateSeriesFunding(days)
  funding.push(estimate)
  console.log(`${days} days: ${(estimate.requiredLamports / 1e9).toFixed(3)} SOL for ${estimate.marketCount} markets and quote publication`)
}

const requiredLamports = funding.reduce((total, estimate) => total + estimate.requiredLamports, 0)
const balanceLamports = funding[0].balanceLamports
console.log(`Maker wallet: ${(balanceLamports / 1e9).toFixed(3)} SOL; full grid needs ${(requiredLamports / 1e9).toFixed(3)} SOL free`)

if (process.argv.includes('--check')) process.exit(0)
if (balanceLamports < requiredLamports) {
  throw new Error(`Fund the maker with at least ${((requiredLamports - balanceLamports) / 1e9).toFixed(3)} more Devnet SOL before seeding.`)
}

for (const days of expiries) {
  const quotes = await makeQuotes(days)
  if (quotes.length !== 5 || quotes.some((row) => [row.call.bidQuote, row.call.askQuote, row.put.bidQuote, row.put.askQuote].some((quote) => quote.remainingSize < 1))) {
    throw new Error(`${days}-day quote grid was not fully seeded at 1 SOL.`)
  }
  console.log(`${days} days: 5 strikes, 10 contracts, 1 SOL bid/ask size confirmed`)
}
