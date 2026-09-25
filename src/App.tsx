import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Clock3, Copy, ExternalLink, Grid2X2, LayoutDashboard, LineChart, Menu, RefreshCw, Search, ShieldCheck, Sparkles, Wallet, X } from 'lucide-react'

import { buildOptionSeries, buildStrategyLegs, calculateGreeks, payoffAtExpiry, strategyPayoffAtExpiry, type OptionKind, type OptionQuote, type OptionSeries, type Position, type QuoteTerms, type StrategyKind, type StrategyLeg, type TradeSide, type View } from './domain'
import { fetchMakerQuotes, quoteGatewayConfigured, settleThroughGateway } from './quotes'

import { fetchOnchainPositions, fetchSolMarket, getExplorerAddressUrl, getExplorerTransactionUrl, getSolBalance, requestDevnetSol, shortAddress, submitSolanaTransaction, SubmittedTransactionPending, type OnchainPosition, type WalletSession } from './solana'
import { buildClosePositionInstruction, buildOpenPositionInstruction, buildProtectionInstruction, deriveMarketPda, derivePositionPda, getSettlementProgramId, quoteTotalLamports } from './settlement'



const expiryOptions = [

  { days: 7, label: '7 days' },

  { days: 10, label: '10 days' },
  { days: 14, label: '14 days' },
]



const money = (value: number, digits = 2) => `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

const solAmount = (lamports: number) => `${(lamports / 1_000_000_000).toFixed(4)} SOL`

const expiryDate = (days: number) => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))

const expiryUnix = (days: number) => Math.floor(Date.now() / 1000) + days * 86_400

const minimumTradeSizeSol = 0.1

type AppMode = 'planning' | 'devnet'



const onchainToPosition = (item: OnchainPosition): Position => {

  const expiryDays = Math.max(0, Math.ceil((item.expiryAt - Math.floor(Date.now() / 1000)) / 86_400))

  return {

    id: item.positionAddress,

    kind: item.kind,

    side: item.side,

    strike: item.strike,

    expiryLabel: new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(item.expiryAt * 1000)),

    expiryDays,

    expiryAt: item.expiryAt,

    quantity: item.quantity,

    entry: item.premium,

    mark: item.premium,

    status: item.status,

    premiumLamports: item.premiumLamports,

    collateralLamports: item.collateralLamports,

    payoutLamports: item.payoutLamports,

    reservedLamports: item.reservedLamports,

    positionAddress: item.positionAddress,

    marketAddress: item.marketAddress,

  }

}



const quoteForSide = (quote: OptionQuote | undefined, side: TradeSide): QuoteTerms | undefined => side === 'buy' ? quote?.askQuote : quote?.bidQuote

const hasExecutableQuote = (quote: OptionQuote | undefined, side: TradeSide, quantity = 0) => {
  const terms = quoteForSide(quote, side)
  return Boolean(terms && terms.expiresAt > Date.now() / 1000 + 15 && terms.remainingSize >= quantity)
}

const quoteSizeMessage = (quote: OptionQuote | undefined, side: TradeSide, quantity: number) => {
  const terms = quoteForSide(quote, side)
  if (!terms || terms.expiresAt <= Date.now() / 1000 + 15 || terms.remainingSize >= quantity) return null
  return `Only ${terms.remainingSize.toFixed(2)} SOL available`
}


function SolanaLogo({ className = '' }: { className?: string }) {

  return <img className={className} src="/solana-logo.svg" alt="Solana" />

}



function App() {

  const { publicKey, connected, connecting, connect, disconnect, sendTransaction, wallet, wallets, select } = useWallet()

  const { setVisible: setWalletModalVisible } = useWalletModal()
  const [view, setView] = useState<View>(() => (window.location.hash.slice(1) as View) || 'market')

  const [spot, setSpot] = useState(0)

  const [spotUpdatedAt, setSpotUpdatedAt] = useState(0)

  const [now, setNow] = useState(Date.now())

  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const walletRef = useRef('')

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])

  const [spotChange, setSpotChange] = useState(0)

  const [spotHistory, setSpotHistory] = useState<Array<{ timestamp: number; price: number }>>([])
  const [marketRefreshToken, setMarketRefreshToken] = useState(0)

  const [appMode, setAppMode] = useState<AppMode>(() => window.localStorage.getItem('soleil-app-mode') === 'planning' ? 'planning' : 'devnet')

  const [series, setSeries] = useState<OptionSeries[]>([])

  const [quoteMode, setQuoteMode] = useState<'maker' | 'indicative' | 'offline'>('indicative')

  const [expiry, setExpiry] = useState(7)

  const [selectedStrike, setSelectedStrike] = useState(0)

  const [selectedKind, setSelectedKind] = useState<OptionKind>('put')

  const [tradeSide, setTradeSide] = useState<TradeSide>('buy')

  const [search, setSearch] = useState('')

  const [walletConnected, setWalletConnected] = useState(false)

  const [walletAddress, setWalletAddress] = useState('')

  const [walletBalance, setWalletBalance] = useState(0)

  const [walletBusy, setWalletBusy] = useState(false)
  const [tradeStage, setTradeStage] = useState<'preparing' | 'wallet' | 'confirming'>('preparing')
  const [tradeError, setTradeError] = useState('')
  const [pendingTrade, setPendingTrade] = useState<{ signature: string; positionAddress: string } | null>(null)

  // Portfolio state is authoritative on Solana. Do not hydrate positions from

  // browser storage: a disconnected wallet must never display stale trades.

  const [positions, setPositions] = useState<Position[]>([])
  const [positionsLoadError, setPositionsLoadError] = useState(false)

  const [quantityText, setQuantityText] = useState(String(minimumTradeSizeSol))
  const quantity = Number(quantityText)

  const [walletMenuOpen, setWalletMenuOpen] = useState(false)

  const [mobileWalletOpen, setMobileWalletOpen] = useState(false)

  const [tradePanelOpen, setTradePanelOpen] = useState(false)

  const [guardModalOpen, setGuardModalOpen] = useState(false)

  const [toast, setToast] = useState('')

  const [guardFloor, setGuardFloor] = useState(0)

  const [guardDuration, setGuardDuration] = useState(30)

  const [guardSeries, setGuardSeries] = useState<OptionSeries[]>([])

  const [guardQuoteMode, setGuardQuoteMode] = useState<'maker' | 'indicative' | 'offline'>('indicative')

  const [portfolioFilter, setPortfolioFilter] = useState<'all' | 'open' | 'closed' | 'settled'>('all')

  useEffect(() => { window.localStorage.setItem('soleil-app-mode', appMode) }, [appMode])



  const notify = (message: string) => {

    setToast(message)

    window.setTimeout(() => setToast(''), 3000)

  }

  useEffect(() => {

    const handleWalletError = (event: Event) => {

      const detail = (event as CustomEvent<string>).detail

      notify(detail || 'Wallet connection failed. Check that the wallet is installed and unlocked.')

    }

    window.addEventListener('soleil-wallet-error', handleWalletError)

    return () => window.removeEventListener('soleil-wallet-error', handleWalletError)

  }, [])

  const syncWallet = (address: string) => {

    walletRef.current = address

    setPositions([])
    setPositionsLoadError(false)

    setWalletBalance(0)

    setGuardFloor(0)

    setWalletAddress(address)

    setWalletConnected(true)

    getSolBalance(address).then((balance) => { if (walletRef.current === address) setWalletBalance(balance) }).catch(() => undefined)

    syncOnchainPositions(address).catch(() => undefined)

  }

  const clearWallet = () => {

    walletRef.current = ''

    setWalletAddress('')

    setWalletConnected(false)

    setWalletBalance(0)

    setWalletMenuOpen(false)

    setPositions([])
    setPositionsLoadError(false)

  }



  useEffect(() => {

    let active = true

    if (appMode === 'planning') {
      setSeries(buildOptionSeries(spot, expiry))
      setQuoteMode('indicative')
      return () => { active = false }
    }

    const loadQuotes = async () => {

      const indicative = buildOptionSeries(spot, expiry)

      const maker = await fetchMakerQuotes(spot, expiry)

      if (!active) return

      setSeries(maker ?? indicative)

      setQuoteMode(maker ? 'maker' : quoteGatewayConfigured ? 'offline' : 'indicative')

    }

    loadQuotes()

    const timer = window.setInterval(loadQuotes, 30_000)

    return () => { active = false; window.clearInterval(timer) }

  }, [appMode, expiry, spot, marketRefreshToken])



  useEffect(() => {

    if (!series.some((item) => item.strike === selectedStrike)) setSelectedStrike(series[Math.floor(series.length / 2)]?.strike ?? 0)

  }, [series, selectedStrike])



  useEffect(() => {

    let active = true

    if (appMode === 'planning') {
      setGuardSeries(buildOptionSeries(spot, guardDuration))
      setGuardQuoteMode('indicative')
      return () => { active = false }
    }

    const loadGuardQuotes = async () => {

      const indicative = buildOptionSeries(spot, guardDuration)

      const maker = await fetchMakerQuotes(spot, guardDuration)

      if (!active) return

      setGuardSeries(maker ?? indicative)

      setGuardQuoteMode(maker ? 'maker' : quoteGatewayConfigured ? 'offline' : 'indicative')

    }

    loadGuardQuotes()

    const timer = window.setInterval(loadGuardQuotes, 30_000)

    return () => { active = false; window.clearInterval(timer) }

  }, [appMode, guardDuration, spot, marketRefreshToken])



  useEffect(() => {

    let active = true

    const refreshMarket = async () => {

      const market = await fetchSolMarket()

      if (!active || !market) return

      setSpotUpdatedAt(Date.now())
      setSpot(market.price)
      setSpotChange(market.change24h)
      setSpotHistory(market.history)
    }

    refreshMarket()

    const interval = window.setInterval(refreshMarket, 30_000)

    return () => { active = false; window.clearInterval(interval) }

  }, [marketRefreshToken])



  useEffect(() => {

    const address = publicKey?.toBase58()

    if (connected && address) syncWallet(address)

    else if (!connected) clearWallet()

  }, [connected, publicKey])

  useEffect(() => {

    if (guardFloor === 0 && walletBalance > 0 && spot > 0) setGuardFloor(Math.round(walletBalance * spot * 0.85 * 100) / 100)

  }, [guardFloor, spot, walletBalance])



  useEffect(() => {

    const onHashChange = () => {

      const next = window.location.hash.slice(1) as View

      if (next === 'market' || next === 'guard' || next === 'portfolio') setView(next)

    }

    window.addEventListener('hashchange', onHashChange)

    return () => window.removeEventListener('hashchange', onHashChange)

  }, [])



  const navigate = (next: View) => {

    setMobileNavOpen(false)

    window.location.hash = next

    setView(next)

  }



  const selectedSeries = series.find((item) => item.strike === selectedStrike) ?? series[2]

  const selectedQuote = selectedSeries?.[selectedKind]

  const selectedProgramId = getSettlementProgramId()
  const selectedExpiryAt = selectedSeries?.expiryAt ?? (selectedSeries ? expiryUnix(selectedSeries.expiryDays) : 0)
  const selectedPositionAddress = walletAddress && selectedSeries && selectedProgramId
    ? derivePositionPda(selectedProgramId, new PublicKey(walletAddress), deriveMarketPda(selectedProgramId, selectedSeries.strike, selectedExpiryAt, selectedKind), selectedExpiryAt).toBase58()
    : ''
  const selectedAlreadyOwned = Boolean(selectedPositionAddress && positions.some((position) => position.positionAddress === selectedPositionAddress))

  const visibleSeries = useMemo(() => series.filter((item) => !search || String(item.strike).includes(search)), [search, series])

  const tradeValue = (tradeSide === 'buy' ? selectedQuote?.ask ?? 0 : selectedQuote?.bid ?? 0) * quantity

  const requestedGuardStrike = walletBalance > 0 && spot > 0 ? Math.max(5, Math.round((guardFloor / walletBalance) / 5) * 5) : 0

  const guardQuote = guardSeries.filter((item) => item.strike >= requestedGuardStrike).sort((a, b) => a.strike - b.strike)[0]

  const guardStrike = guardQuote?.strike ?? 0

  const spotFresh = now - spotUpdatedAt < 90_000 && spot > 0

  const guardPremium = walletBalance > 0 && guardQuote ? guardQuote.put.ask * walletBalance : 0

  const executionEnabled = appMode === 'devnet' && !walletBusy && !selectedAlreadyOwned && spotFresh && Number.isFinite(quantity) && quantity >= minimumTradeSizeSol && quoteMode === 'maker' && hasExecutableQuote(selectedQuote, tradeSide, quantity) && Boolean(getSettlementProgramId())
  const guardExecutionEnabled = appMode === 'devnet' && !walletBusy && spotFresh && guardFloor > 0 && guardQuoteMode === 'maker' && hasExecutableQuote(guardQuote?.put, 'buy', walletBalance) && Boolean(getSettlementProgramId())


  const syncOnchainPositions = async (address: string) => {

    const programId = getSettlementProgramId()

    if (!programId) {

      setPositions([])

      return

    }

    try {

      const onchain = await fetchOnchainPositions(programId, new PublicKey(address))

      if (walletRef.current !== address) return

      setPositions((current) => onchain.map((item) => {

        const previous = current.find((position) => position.positionAddress === item.positionAddress)

        return { ...onchainToPosition(item), receipt: previous?.receipt }

      }))
      setPositionsLoadError(false)

    } catch {

      setPositionsLoadError(true)
      notify('Could not refresh on-chain positions')

    }

  }



  const connectWalletDirect = async (): Promise<null> => {

    if (walletBusy || connecting || connected) return null

    if (!wallet) {
      setWalletModalVisible(true)
      return null
    }

    setWalletBusy(true)

    try {
      await connect()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Wallet connection failed')
    } finally {
      setWalletBusy(false)
    }

    return null

  }

  const connectWallet = async (): Promise<null> => {
    if (walletBusy || connected) return null
    if (connecting) {
      setWalletModalVisible(true)
      return null
    }
    if (window.matchMedia('(max-width: 760px)').matches || !wallets.some(({ readyState }) => readyState === WalletReadyState.Installed)) {
      setMobileWalletOpen(true)
      return null
    }
    // A wallet name can persist after its extension is locked or removed.
    // Let the user choose an available wallet instead of silently retrying it.
    setWalletModalVisible(true)
    return null
  }

  useEffect(() => {
    if (!walletConnected || !walletAddress || view !== 'portfolio') return
    void syncOnchainPositions(walletAddress)
  }, [view, walletConnected, walletAddress])

  useEffect(() => {
    if (!pendingTrade || !walletAddress) return
    let active = true
    const check = async () => {
      try {
        const response = await fetch(`/api/transaction?signature=${pendingTrade.signature}`, { signal: AbortSignal.timeout(8_000) })
        if (!response.ok || !active) return
        const result = await response.json() as { status?: string; error?: unknown }
        if (!active) return
        if (result.status === 'confirmed') {
          setPendingTrade(null)
          setTradeError('')
          setTradePanelOpen(false)
          navigate('portfolio')
          void syncOnchainPositions(walletAddress)
          notify('Devnet position confirmed')
        } else if (result.status === 'failed') {
          setPendingTrade(null)
          setTradeError(`Transaction failed on Solana: ${JSON.stringify(result.error)}`)
        }
      } catch {
        // Keep the signature visible while Devnet is unavailable.
      }
    }
    void check()
    const interval = window.setInterval(check, 5_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [pendingTrade, walletAddress])



  const disconnectWallet = async () => {

    await disconnect()

    clearWallet()

    notify('Wallet disconnected')

  }



  const requestFaucet = async () => {

    if (!walletAddress || walletBusy) return

    setWalletBusy(true)

    try {

      const balance = await requestDevnetSol(walletAddress)

      setWalletBalance(balance)

      notify('1 SOL devnet airdrop confirmed')

    } catch (error) {

      notify(error instanceof Error ? error.message : 'Devnet faucet is rate limited')

    } finally {

      setWalletBusy(false)

    }

  }



  const chooseContract = (item: OptionSeries, kind: OptionKind) => {

    setTradeError('')
    setSelectedStrike(item.strike)

    setSelectedKind(kind)

    setTradePanelOpen(true)

  }



  const placeTrade = async () => {

    if (!walletConnected) {

      await connectWallet()

      setTradePanelOpen(true)

      return

    }

    if (!selectedSeries || !selectedQuote) return

    if (selectedAlreadyOwned) return notify('This contract is already in your Portfolio. Choose another strike or expiry.')
    if (!executionEnabled) return notify('Wait for a fresh maker quote before trading.')

    setTradeError('')
    setTradeStage('preparing')
    setWalletBusy(true)

    try {

      const programId = getSettlementProgramId()

      if (!programId || !walletAddress) throw new Error('Soleil settlement is not configured for this network yet.')

      const owner = new PublicKey(walletAddress)

      const expiryAt = selectedSeries.expiryAt ?? expiryUnix(selectedSeries.expiryDays)

      const market = deriveMarketPda(programId, selectedStrike, expiryAt, selectedKind)
      const positionAddress = derivePositionPda(programId, owner, market, expiryAt).toBase58()
      if (positions.some((position) => position.positionAddress === positionAddress)) throw new Error('You already have this contract. Choose another strike or expiry; this Devnet program permits one position per wallet and contract.')
      if (pendingTrade?.positionAddress === positionAddress) throw new Error('This order has already been submitted. Check the transaction before trying again.')

      const instructions: TransactionInstruction[] = []

      const executableQuote = quoteForSide(selectedQuote, tradeSide)

      if (!executableQuote) throw new Error('Maker quote metadata is incomplete.')

      instructions.push(buildOpenPositionInstruction({ programId, owner, kind: selectedKind, side: tradeSide, strike: selectedStrike, quantity, premium: tradeSide === 'buy' ? selectedQuote.ask : selectedQuote.bid, maker: new PublicKey(executableQuote.maker), quoteNonce: executableQuote.nonce, quoteAddress: executableQuote.quoteAddress, expiryAt, premiumLamports: quoteTotalLamports(executableQuote.premiumLamportsPerSol, quantity), collateralLamports: tradeSide === 'sell' ? quoteTotalLamports(executableQuote.collateralLamportsPerSol, quantity) : 0 }))

      const signature = await submitSolanaTransaction(instructions, sendTransaction, walletAddress, setTradeStage)

      const newPosition: Position = {

        id: `${tradeSide}-${selectedKind}-${selectedStrike}-${Date.now()}`,

        kind: selectedKind,

        side: tradeSide,

        strike: selectedStrike,

        expiryLabel: selectedSeries.expiryLabel,

        expiryDays: selectedSeries.expiryDays,

        expiryAt,

        quantity,

        entry: tradeSide === 'buy' ? selectedQuote.ask : selectedQuote.bid,

        mark: tradeSide === 'buy' ? selectedQuote.ask : selectedQuote.bid,

        status: 'Open',

        premiumLamports: quoteTotalLamports(executableQuote.premiumLamportsPerSol, quantity),

        collateralLamports: tradeSide === 'sell' ? quoteTotalLamports(executableQuote.collateralLamportsPerSol, quantity) : 0,

        payoutLamports: 0,

        receipt: signature,

        positionAddress,

        marketAddress: market.toBase58(),

      }

      if (walletRef.current !== owner.toBase58()) return

      setPositions((current) => [...current, newPosition])

      setTradePanelOpen(false)

      notify(`${tradeSide === 'buy' ? 'Buy' : 'Sell'} position opened on devnet`)

      navigate('portfolio')

      void syncOnchainPositions(owner.toBase58())
      void getSolBalance(owner.toBase58()).then((balance) => { if (walletRef.current === owner.toBase58()) setWalletBalance(balance) }).catch(() => undefined)

    } catch (error) {

      if (error instanceof SubmittedTransactionPending && selectedPositionAddress) {
        setPendingTrade({ signature: error.signature, positionAddress: selectedPositionAddress })
        setTradeError('Submitted to Devnet. Confirmation is still pending. Do not submit this contract again yet.')
        if (walletAddress) void syncOnchainPositions(walletAddress)
        return
      }

      const message = error instanceof Error ? error.message : 'Order was not submitted'
      setTradeError(message)
      notify(message)

    } finally {

      setWalletBusy(false)

    }

  }



  const closePosition = async (position: Position) => {

    if (walletBusy) return

    if (position.side === 'sell') return notify('Short positions remain collateralized until settlement.')

    if (!window.confirm('Abandon this option for no refund? This permanently gives up its future payout.')) return

    if (!walletAddress || !position.expiryAt) return notify('This saved position predates lifecycle actions.')

    const programId = getSettlementProgramId()

    if (!programId) return notify('Soleil settlement is not configured for this network yet.')

    setWalletBusy(true)

    try {

      const signature = await submitSolanaTransaction([buildClosePositionInstruction({ programId, owner: new PublicKey(walletAddress), kind: position.kind, strike: position.strike, expiryAt: position.expiryAt })], sendTransaction, walletAddress)

      setPositions((current) => current.map((item) => item.id === position.id ? { ...item, status: 'Closed', receipt: signature } : item))

      notify(`Position closed · ${signature.slice(0, 8)}...`)

    } catch (error) {

      notify(error instanceof Error ? error.message : 'Position was not closed')

    } finally {

      setWalletBusy(false)

    }

  }



  const settlePosition = async (position: Position) => {

    if (!walletAddress || !position.expiryAt || !position.marketAddress || !position.positionAddress) return notify('This saved position has no settlement reference.')

    if (position.expiryAt > Math.floor(Date.now() / 1000)) return notify('This contract has not expired yet.')

    const programId = getSettlementProgramId()

    if (!programId) return notify('Soleil settlement is not configured for this network yet.')

    setWalletBusy(true)

    try {

      const receipt = await settleThroughGateway(position.marketAddress, position.positionAddress)

      const signature = receipt.signature

      setPositions((current) => current.map((item) => item.id === position.id ? { ...item, status: 'Settled', receipt: signature } : item))

      await syncOnchainPositions(walletAddress)

      setWalletBalance(await getSolBalance(walletAddress))

      notify(`Position settled · ${signature.slice(0, 8)}...`)

    } catch (error) {

      notify(error instanceof Error ? error.message : 'Position was not settled')

    } finally {

      setWalletBusy(false)

    }

  }



  return (

    <div className="app-shell">

      <header className="topbar">

        <button className="mobile-menu" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={18} /></button>

        <a className="brand" href="#market" aria-label="Soleil home"><img className="brand-mark soleil-mark" src="/soleil-logo.png" alt="" aria-hidden="true" /><span>soleil</span></a>
        <nav className={`primary-nav ${mobileNavOpen ? 'mobile-open' : ''}`} aria-label="Primary navigation">

          <NavButton active={view === 'market'} onClick={() => navigate('market')} icon={<LineChart size={15} />}>Market</NavButton>

          <NavButton active={view === 'guard'} onClick={() => navigate('guard')} icon={<ShieldCheck size={15} />}>Guard</NavButton>

          <NavButton active={view === 'portfolio'} onClick={() => navigate('portfolio')} icon={<LayoutDashboard size={15} />}>Portfolio</NavButton>

        </nav>

        <div className="topbar-actions">

          <div className="spot-pill"><SolanaLogo className="solana-logo" /><span>SOL</span><strong>{money(spot)}</strong><span className={spotChange >= 0 ? 'up' : 'negative'}>{spotChange >= 0 ? '+' : ''}{spotChange.toFixed(2)}%</span></div>

          <div className="mode-switch" role="group" aria-label="Environment mode">
            <button className={appMode === 'planning' ? 'active' : ''} onClick={() => setAppMode('planning')}>Original</button>
            <button className={appMode === 'devnet' ? 'active' : ''} onClick={() => setAppMode('devnet')}><span className="network-dot" />Devnet</button>
          </div>

          <div className="wallet-wrap">

            <button className={`wallet-button ${walletConnected ? 'connected' : ''}`} onClick={() => walletConnected ? setWalletMenuOpen((open) => !open) : connectWallet()} disabled={walletBusy}><Wallet size={14} /><span>{walletBusy ? 'Connecting...' : walletConnected ? shortAddress(walletAddress) : connecting ? 'Choose wallet' : 'Connect wallet'}</span><ChevronDown size={13} /></button>

            {walletMenuOpen && <div className="wallet-menu"><span className="wallet-menu-title">Connected wallet</span><strong>{shortAddress(walletAddress)}</strong><span className="wallet-balance">{walletBalance.toFixed(4)} SOL on devnet</span><button className="faucet-button" onClick={requestFaucet}>Get 1 devnet SOL</button><a href={getExplorerAddressUrl(walletAddress)} target="_blank" rel="noreferrer">View on Explorer <ExternalLink size={12} /></a><button onClick={disconnectWallet}>Disconnect</button></div>}

          </div>

        </div>

      </header>



      <main className="page-container">

        {!spotFresh && <p className="feed-notice" role="status">{spotUpdatedAt ? 'Price feed is stale. Trading is paused while reconnecting.' : 'Connecting to the live SOL price feed…'}</p>}

        {walletConnected && positionsLoadError && <p className="feed-notice" role="alert">Could not load Devnet positions. <button className="text-button" onClick={() => void syncOnchainPositions(walletAddress)}>Retry</button></p>}

        {view === 'market' && <MarketView appMode={appMode} expiry={expiry} setExpiry={setExpiry} series={visibleSeries} positions={positions} selectedSeries={selectedSeries} selectedStrike={selectedStrike} selectedKind={selectedKind} side={tradeSide} setSide={setTradeSide} spot={spot} spotChange={spotChange} spotHistory={spotHistory} quoteMode={quoteMode} onSelect={(item, kind) => { setSelectedStrike(item.strike); setSelectedKind(kind) }} search={search} setSearch={setSearch} quantity={quantity} quantityText={quantityText} setQuantityText={setQuantityText} walletConnected={walletConnected} executionEnabled={executionEnabled} alreadyOwned={selectedAlreadyOwned} onOpenTrade={() => setTradePanelOpen(true)} onRefresh={() => { setMarketRefreshToken((value) => value + 1); if (walletAddress) void syncOnchainPositions(walletAddress); notify('Refreshing live spot and quotes') }} onGuard={() => navigate('guard')} />}
        {view === 'guard' && <GuardView appMode={appMode} quoteMode={guardQuoteMode} floor={guardFloor} setFloor={setGuardFloor} duration={guardDuration} setDuration={setGuardDuration} premium={guardPremium} strike={guardStrike} spot={spot} walletBalance={walletBalance} executionEnabled={guardExecutionEnabled} onGetQuotes={() => walletConnected ? (guardExecutionEnabled ? setGuardModalOpen(true) : notify(appMode === 'planning' ? 'Planning mode does not submit protection trades.' : 'Protection is paused until a live maker quote is available')) : connectWallet()} onPortfolio={() => navigate('portfolio')} />}

        {view === 'portfolio' && <PortfolioView positions={positions} series={series} quoteMode={quoteMode} spot={spot} walletBalance={walletBalance} filter={portfolioFilter} setFilter={setPortfolioFilter} onGuard={() => navigate('guard')} onClose={closePosition} onSettle={settlePosition} />}

      </main>



      {tradePanelOpen && selectedSeries && selectedQuote && <TradePanel appMode={appMode} quoteMode={quoteMode} walletBusy={walletBusy} tradeStage={tradeStage} tradeError={tradeError} pendingSignature={pendingTrade?.positionAddress === selectedPositionAddress ? pendingTrade.signature : undefined} kind={selectedKind} series={selectedSeries} side={tradeSide} setSide={setTradeSide} quantity={quantity} quantityText={quantityText} setQuantityText={setQuantityText} tradeValue={tradeValue} walletConnected={walletConnected} executionEnabled={executionEnabled} alreadyOwned={selectedAlreadyOwned} onClose={() => setTradePanelOpen(false)} onSubmit={placeTrade} />}

      {mobileWalletOpen && <MobileWalletSheet isMobile={window.matchMedia('(max-width: 760px)').matches} hasDetectedWallet={wallets.some(({ readyState }) => readyState === WalletReadyState.Installed)} onClose={() => setMobileWalletOpen(false)} onUseDetected={async () => { setMobileWalletOpen(false); const detected = wallets.find(({ readyState }) => readyState === WalletReadyState.Installed); if (!detected) return; if (wallet?.adapter.name === detected.adapter.name) await connectWalletDirect(); else select(detected.adapter.name) }} onChooseWallet={() => { setMobileWalletOpen(false); setWalletModalVisible(true) }} />}

      {guardModalOpen && <GuardModal duration={guardDuration} premium={guardPremium} strike={guardStrike} quantity={walletBalance} onClose={() => setGuardModalOpen(false)} onConfirm={async () => { if (!guardExecutionEnabled || walletBusy) return; setWalletBusy(true); try { const programId = getSettlementProgramId(); const guardTerms = guardQuote?.put.askQuote; if (!programId || !walletAddress || !guardQuote || !guardTerms || !hasExecutableQuote(guardQuote.put, 'buy')) throw new Error('A live maker quote is required for protection.'); const owner = new PublicKey(walletAddress); const expiryAt = guardQuote.expiryAt ?? expiryUnix(guardDuration); const market = deriveMarketPda(programId, guardStrike, expiryAt, 'put'); const instructions: TransactionInstruction[] = []; instructions.push(buildProtectionInstruction({ programId, owner, strike: guardStrike, quantity: walletBalance, floor: guardFloor, premium: guardQuote.put.ask, maker: new PublicKey(guardTerms.maker), quoteNonce: guardTerms.nonce, quoteAddress: guardTerms.quoteAddress, expiryAt, premiumLamports: quoteTotalLamports(guardTerms.premiumLamportsPerSol, walletBalance) })); const signature = await submitSolanaTransaction(instructions, sendTransaction, walletAddress); await syncOnchainPositions(walletAddress); setWalletBalance(await getSolBalance(walletAddress)); setGuardModalOpen(false); navigate('portfolio'); notify(`Protection position opened · ${signature.slice(0, 8)}...`) } catch (error) { notify(error instanceof Error ? error.message : 'Protection was not submitted') } finally { setWalletBusy(false) } }} />}

      {toast && <div className="toast"><span className="toast-icon"><Check size={13} /></span>{toast}</div>}

    </div>

  )

}


function MobileWalletSheet({ isMobile, hasDetectedWallet, onClose, onUseDetected, onChooseWallet }: { isMobile: boolean; hasDetectedWallet: boolean; onClose: () => void; onUseDetected: () => void | Promise<void>; onChooseWallet: () => void }) {
  const currentUrl = typeof window === 'undefined' ? '' : window.location.href
  const phantomUrl = `https://phantom.app/ul/browse/${encodeURIComponent(currentUrl)}?ref=${encodeURIComponent(window.location.origin)}`
  const solflareUrl = `https://solflare.com/ul/v1/browse/${encodeURIComponent(currentUrl)}`

  return <div className="mobile-wallet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="mobile-wallet-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-wallet-title"><div className="mobile-wallet-head"><div><p className="eyebrow">CONNECT WALLET</p><h2 id="mobile-wallet-title">Connect to Soleil</h2><p>{isMobile ? 'Open Soleil inside your wallet app to connect and sign.' : 'This browser cannot reach Phantom on your phone. Open Soleil inside Phantom on your phone, or use the Phantom extension in desktop Chrome.'}</p></div><button className="icon-button" onClick={onClose} aria-label="Close wallet options"><X size={18} /></button></div>{hasDetectedWallet && <button className="mobile-wallet-primary" onClick={onUseDetected}><Wallet size={16} />Connect in this browser <ArrowRight size={15} /></button>}{isMobile && <><button className="mobile-wallet-secondary" onClick={onChooseWallet}><Wallet size={16} />Choose another wallet <ArrowRight size={15} /></button><div className="mobile-wallet-divider"><span>Open directly in</span></div><div className="mobile-wallet-links"><a href={phantomUrl}>Phantom</a><a href={solflareUrl}>Solflare</a></div><p className="mobile-wallet-note">Stay in the wallet browser to approve and sign devnet orders.</p></>}{!isMobile && <p className="mobile-wallet-note">On your phone, open Phantom, use its browser, then visit soleil-chi-three.vercel.app. Your phone wallet cannot sign for this desktop page.</p>}</section></div>
}



function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: string }) {

  return <button className={`nav-link ${active ? 'is-active' : ''}`} onClick={onClick}>{icon}{children}</button>

}



function MarketView({ appMode, expiry, setExpiry, series, positions, selectedSeries, selectedStrike, selectedKind, side, setSide, spot, spotChange, spotHistory, quoteMode, onSelect, search, setSearch, quantity, quantityText, setQuantityText, walletConnected, executionEnabled, alreadyOwned, onOpenTrade, onRefresh, onGuard }: { appMode: AppMode; expiry: number; setExpiry: (days: number) => void; series: OptionSeries[]; positions: Position[]; selectedSeries?: OptionSeries; selectedStrike: number; selectedKind: OptionKind; side: TradeSide; setSide: (side: TradeSide) => void; spot: number; spotChange: number; spotHistory: Array<{ timestamp: number; price: number }>; quoteMode: 'maker' | 'indicative' | 'offline'; onSelect: (item: OptionSeries, kind: OptionKind) => void; search: string; setSearch: (value: string) => void; quantity: number; quantityText: string; setQuantityText: (value: string) => void; walletConnected: boolean; executionEnabled: boolean; alreadyOwned: boolean; onOpenTrade: () => void; onRefresh: () => void; onGuard: () => void }) {
  const quoteLabel = appMode === 'planning' ? 'Planning quotes' : quoteMode === 'maker' ? 'Live maker quotes' : quoteMode === 'offline' ? 'Maker service offline' : 'Waiting for maker'

  const visibleCount = series.filter((item) => !search || String(item.strike).includes(search)).length

  const openPositions = positions.filter((position) => position.status === 'Open').slice(0, 3)

  const [strategyOpen, setStrategyOpen] = useState(false)
  const [strategyKind, setStrategyKind] = useState<StrategyKind>('protective-put')
  const strategyLegs = buildStrategyLegs(strategyKind, series, selectedStrike)
  return <section aria-labelledby="market-title">

    <div className="page-heading compact-heading"><div><p className="eyebrow">SOL / USD · OPTIONS</p><h1 id="market-title">Market</h1></div><div className="heading-tools"><div className="quote-status"><span className={quoteMode === 'maker' ? 'live-dot' : 'status-dot'} />{quoteLabel} <Clock3 size={12} />Live spot</div><button className="icon-button" title="Refresh quotes" onClick={onRefresh}><RefreshCw size={15} /></button></div></div>

    <MarketSummary spot={spot} spotChange={spotChange} expiry={expiry} />
    <div className="market-toolbar"><div className="segmented" role="tablist" aria-label="Expiry">{expiryOptions.map((option) => <button key={option.days} className={`segment ${expiry === option.days ? 'is-selected' : ''}`} onClick={() => setExpiry(option.days)}>{option.label}<span>{expiryDate(option.days)}</span></button>)}</div><div className="toolbar-right"><button className={`filter-button strategy-toggle ${strategyOpen ? 'is-active' : ''}`} onClick={() => setStrategyOpen((open) => !open)}><LineChart size={14} /> Strategies</button><label className="search-box"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search strike" aria-label="Search strike" /></label><span className="filter-button filter-summary"><Grid2X2 size={14} /> {visibleCount} strikes</span></div></div>

    <div className="market-grid"><div className="market-main-column"><MarketChart spot={spot} spotChange={spotChange} /><section className="market-panel chain-panel"><div className="panel-header"><div><h2>SOL options chain</h2><p>{appMode === 'planning' ? 'Indicative planning quotes · prices in USD' : quoteMode === 'maker' ? 'Live maker quotes · prices in USD' : 'Devnet quotes are waiting for the maker service'} · {expiry} day expiry</p></div><div className="chain-meta"><span className="mini-live" />{visibleCount * 2} contracts</div></div><div className="chain-scroll"><table className="options-table"><thead><tr><th colSpan={3} className="call-heading">CALLS</th><th className="strike-heading">STRIKE</th><th colSpan={3} className="put-heading">PUTS</th></tr><tr className="subhead"><th>Bid</th><th>Ask</th><th>IV / Δ</th><th /><th>IV / Δ</th><th>Bid</th><th>Ask</th></tr></thead><tbody>{series.filter((item) => !search || String(item.strike).includes(search)).map((item) => <tr className={item.strike === selectedStrike ? 'is-selected' : ''} key={item.strike}><td onClick={() => onSelect(item, 'call')}>{money(item.call.bid)}</td><td onClick={() => onSelect(item, 'call')}>{money(item.call.ask)}</td><td>{item.call.iv}% <small className="greek-value">{item.call.delta !== undefined ? `Δ ${item.call.delta.toFixed(2)}` : ''}</small></td><td className="strike-cell" onClick={() => onSelect(item, selectedKind)}>{item.strike}</td><td>{item.put.iv}% <small className="greek-value">{item.put.delta !== undefined ? `Δ ${item.put.delta.toFixed(2)}` : ''}</small></td><td onClick={() => onSelect(item, 'put')}>{money(item.put.bid)}</td><td onClick={() => onSelect(item, 'put')}>{money(item.put.ask)}</td></tr>)}</tbody></table></div><div className="table-footer"><span>Greeks are indicative until maker data supplies them</span><span>{appMode === 'planning' ? 'Preview only' : quoteMode === 'maker' ? 'Executable quotes' : 'Awaiting maker'}</span></div></section></div><MarketTicket appMode={appMode} quoteMode={quoteMode} series={selectedSeries} kind={selectedKind} side={side} setSide={setSide} spot={spot} quantity={quantity} quantityText={quantityText} setQuantityText={setQuantityText} walletConnected={walletConnected} executionEnabled={executionEnabled} alreadyOwned={alreadyOwned} onOpenTrade={onOpenTrade} onGuard={onGuard} /></div>
    {strategyOpen && <StrategyBuilder kind={strategyKind} setKind={setStrategyKind} legs={strategyLegs} spot={spot} expiry={expiry} quoteMode={quoteMode} />}

    <section className="positions-strip market-panel"><div className="panel-header"><div><h2>Your positions</h2><p>Open contracts and current value</p></div><button className="text-button" onClick={onGuard}>Protect treasury <ArrowRight size={13} /></button></div>{openPositions.length === 0 ? <div className="empty-position-row"><div className="empty-symbol"><Sparkles size={15} /></div><div><strong>No confirmed positions yet</strong><span>Open positions appear here after the Solana program confirms them.</span></div><span className="empty-action">{walletConnected ? 'Awaiting first position' : 'Connect a wallet to begin'}</span></div> : <div className="market-position-list">{openPositions.map((position) => <div className="market-position-row" key={position.id}><div><strong>SOL {position.strike} {position.kind.toUpperCase()}</strong><span>{position.quantity} SOL · {position.expiryLabel}</span></div><span className="plan-state">{position.status}</span></div>)}</div>}</section>

  </section>

}



function StrategyBuilder({ kind, setKind, legs, spot, expiry, quoteMode }: { kind: StrategyKind; setKind: (kind: StrategyKind) => void; legs: StrategyLeg[]; spot: number; expiry: number; quoteMode: 'maker' | 'indicative' | 'offline' }) {
  const definitions: Array<{ id: StrategyKind; label: string; detail: string }> = [
    { id: 'protective-put', label: 'Protective put', detail: 'Keep upside while setting a floor.' },
    { id: 'collar', label: 'Collar', detail: 'Fund the floor by selling upside.' },
    { id: 'covered-call', label: 'Covered call', detail: 'Earn premium against held SOL.' },
    { id: 'bull-call-spread', label: 'Bull call spread', detail: 'Defined-cost upside view.' },
    { id: 'bear-put-spread', label: 'Bear put spread', detail: 'Defined-risk downside view.' },
  ]
  const netPremium = legs.reduce((total, leg) => total + (leg.side === 'buy' ? leg.premium : -leg.premium), 0)
  const payoff = strategyPayoffAtExpiry(spot, legs)

  return <section className="strategy-builder market-panel" aria-labelledby="strategy-title"><div className="panel-header"><div><p className="eyebrow">MULTI-LEG PREVIEW</p><h2 id="strategy-title">Build a strategy</h2><p>Compare a complete protection idea before requesting an atomic maker quote.</p></div><span className="strategy-status">{quoteMode === 'maker' ? 'RFQ ready' : 'Preview only'}</span></div><div className="strategy-layout"><div className="strategy-options" role="tablist" aria-label="Strategy type">{definitions.map((item) => <button key={item.id} className={kind === item.id ? 'is-selected' : ''} onClick={() => setKind(item.id)}><strong>{item.label}</strong><span>{item.detail}</span></button>)}</div><div className="strategy-detail"><div className="strategy-legs">{legs.map((leg, index) => <div key={leg.kind + leg.strike + index}><span className={leg.side === 'buy' ? 'leg-buy' : 'leg-sell'}>{leg.side === 'buy' ? 'BUY' : 'SELL'}</span><strong>SOL {leg.strike} {leg.kind.toUpperCase()}</strong><span>{money(leg.premium)} / SOL</span></div>)}</div><div className="strategy-metrics"><div><span>Net premium</span><strong>{netPremium >= 0 ? money(netPremium) : 'Credit ' + money(Math.abs(netPremium))}</strong></div><div><span>At expiry at spot</span><strong className={payoff >= 0 ? 'up' : 'negative'}>{payoff >= 0 ? '+' : ''}{money(payoff)}</strong></div><div><span>Expiry</span><strong>{expiry} days</strong></div></div><button className="primary-action strategy-action" disabled>Request atomic RFQ <ArrowRight size={15} /></button><p className="strategy-note">Multi-leg execution unlocks when multiple maker quotes and all-or-nothing settlement are connected.</p></div></div></section>
}


function MarketSummary({ spot, spotChange, expiry }: { spot: number; spotChange: number; expiry: number }) {
  return <section className="market-summary" aria-label="SOL options market summary"><div><span>Spot price</span><strong>{spot > 0 ? money(spot) : 'Loading'}</strong><small className={spotChange >= 0 ? 'up' : 'negative'}>{spot > 0 ? `${spotChange >= 0 ? '+' : ''}${spotChange.toFixed(2)}% today` : 'Waiting for feed'}</small></div><div><span>24h volume</span><strong>—</strong><small>Venue data pending</small></div><div><span>Open interest</span><strong>—</strong><small>On-chain venue pending</small></div><div><span>Next expiry</span><strong>{expiryDate(expiry)}</strong><small>{expiry} days remaining</small></div></section>
}



function MarketChart({ spot, spotChange }: { spot: number; spotChange: number }) {
  const widgetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = widgetRef.current
    if (!container) return
    container.replaceChildren()
    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget'
    const attribution = document.createElement('div')
    attribution.className = 'tradingview-widget-copyright'
    const link = document.createElement('a')
    link.href = 'https://www.tradingview.com/symbols/SOLUSD/'
    link.rel = 'noopener nofollow'
    link.target = '_blank'
    link.textContent = 'SOL / USD by TradingView'
    attribution.append(link)
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.async = true
    script.textContent = JSON.stringify({
      allow_symbol_change: false,
      calendar: false,
      details: false,
      hide_side_toolbar: true,
      hide_top_toolbar: false,
      hide_legend: false,
      show_symbol_logo: false,
      hide_volume: false,
      hotlist: false,
      interval: '60',
      locale: 'en',
      save_image: false,
      style: '1',
      symbol: 'COINBASE:SOLUSD',
      theme: 'dark',
      timezone: 'Etc/UTC',
      backgroundColor: '#171718',
      gridColor: 'rgba(242, 242, 242, 0.08)',
      watchlist: [],
      withdateranges: false,
      compareSymbols: [],
      studies: [],
      support_host: 'https://www.tradingview.com',
      autosize: true,
    })
    container.append(widget, attribution, script)
    return () => container.replaceChildren()
  }, [])

  return <section className="market-panel price-chart-panel"><div className="price-chart-head"><div className="price-identity"><span className="sol-token"><SolanaLogo className="solana-logo" /></span><div><strong>SOL / USD</strong><span>Solana · TradingView market</span></div></div><div className="price-quote"><strong>{spot > 0 ? money(spot) : 'Loading'}</strong><span className={spotChange >= 0 ? 'up' : 'negative'}>{spot > 0 ? (spotChange >= 0 ? '+' : '') + spotChange.toFixed(2) + '% · live' : 'Waiting for feed'}</span></div><span className="tradingview-status"><i className="chart-live-dot" />TradingView live</span></div><div ref={widgetRef} className="tradingview-widget-container soleil-tv-widget" aria-label="Live SOL USD chart by TradingView" /><div className="chart-stats"><span>Spot <strong>{spot > 0 ? money(spot) : '—'}</strong></span><span>Source <strong>TradingView</strong></span><span>Symbol <strong>SOL/USD</strong></span><span>Venue <strong>Coinbase</strong></span><span>24h change <strong className={spotChange >= 0 ? 'up' : 'negative'}>{spot > 0 ? (spotChange >= 0 ? '+' : '') + spotChange.toFixed(2) + '%' : '—'}</strong></span></div></section>
}


function MarketTicket({ appMode, quoteMode, series, kind, side, setSide, spot, quantity, quantityText, setQuantityText, walletConnected, executionEnabled, alreadyOwned, onOpenTrade, onGuard }: { appMode: AppMode; quoteMode: 'maker' | 'indicative' | 'offline'; series?: OptionSeries; kind: OptionKind; side: TradeSide; setSide: (side: TradeSide) => void; spot: number; quantity: number; quantityText: string; setQuantityText: (value: string) => void; walletConnected: boolean; executionEnabled: boolean; alreadyOwned: boolean; onOpenTrade: () => void; onGuard: () => void }) {
  const quote = series?.[kind]
  const sizeMessage = quoteMode === 'maker' ? quoteSizeMessage(quote, side, quantity) : null

  const executionPrice = side === 'buy' ? quote?.ask : quote?.bid

  const tradeValue = (executionPrice ?? 0) * quantity

  const payoff = series && executionPrice ? payoffAtExpiry(spot, series.strike, kind, side, executionPrice) * quantity : 0
  const greeks = series ? (() => {
    const indicative = calculateGreeks(spot, series.strike, series.expiryDays, quote?.iv ?? 0, kind)
    return { delta: quote?.delta ?? indicative.delta, gamma: quote?.gamma ?? indicative.gamma, theta: quote?.theta ?? indicative.theta, vega: quote?.vega ?? indicative.vega }
  })() : null

  const unavailableLabel = alreadyOwned ? 'Already in portfolio' : appMode === 'planning' ? 'Planning preview' : quoteMode === 'offline' ? 'Maker service offline' : sizeMessage ?? 'Maker quote required'
  const actionLabel = executionEnabled ? (walletConnected ? `Review ${side} order` : 'Connect wallet') : appMode === 'planning' ? `Preview ${side} order` : unavailableLabel
  const ticketNote = alreadyOwned ? 'This wallet already owns this contract. Choose another strike or expiry.' : executionEnabled ? 'Wallet-signed position · Solana devnet' : appMode === 'planning' ? 'Planning mode · execution paused' : quoteMode === 'offline' ? 'Devnet mode · start the maker service to enable execution' : sizeMessage ? 'Reduce the quantity or wait for a larger maker quote.' : 'Devnet mode · waiting for a live maker quote'

  return <aside className="market-ticket"><div className="ticket-head"><div><p className="eyebrow">ORDER ENTRY</p><h2>SOL {kind === 'put' ? 'Put' : 'Call'}</h2><p>Strike {series ? money(series.strike, 0) : '—'} · {series?.expiryLabel ?? 'Loading market'} · {series?.expiryDays ?? '—'} days</p></div><button className="help-button" aria-label="Order entry help" title="Quotes and settlement details"><CircleHelp size={15} /></button></div><div className="order-toggle" role="tablist" aria-label="Trade side"><button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>Buy</button><button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>Sell</button></div><div className="ticket-inputs"><label className="form-field"><span>Quantity <small>SOL</small></span><div className="input-shell"><input type="number" value={quantityText} min={minimumTradeSizeSol} step="any" inputMode="decimal" onChange={(event) => setQuantityText(event.target.value)} /><span>SOL</span></div></label><label className="form-field"><span>Limit price <small>per SOL</small></span><div className="input-shell"><input type="text" value={executionPrice?.toFixed(2) ?? '—'} readOnly /><span>USD</span></div></label></div><div className="ticket-book"><div><span>Best bid</span><strong>{quote ? money(quote.bid) : '—'}</strong></div><div><span>Best ask</span><strong>{quote ? money(quote.ask) : '—'}</strong></div><div><span>Spread</span><strong>{quote ? money(quote.ask - quote.bid) : '—'}</strong></div></div>{greeks && <div className="greeks-strip"><span><small>Δ</small>{greeks.delta.toFixed(2)}</span><span><small>Γ</small>{greeks.gamma.toFixed(3)}</span><span><small>Θ</small>{greeks.theta.toFixed(3)}</span><span><small>V</small>{greeks.vega.toFixed(2)}</span></div>}<div className="payoff-preview"><div><span>At expiry at spot</span><strong className={payoff >= 0 ? 'up' : 'negative'}>{payoff >= 0 ? '+' : ''}{money(payoff)}</strong></div><small>{side === 'buy' ? 'Maximum loss is the premium paid.' : 'Short option risk depends on locked collateral.'}</small></div><div className="ticket-summary"><div><span>{side === 'buy' ? 'Estimated cost' : 'Estimated proceeds'}</span><strong>{quote ? money(tradeValue) : '—'}</strong></div><div><span>{side === 'buy' ? 'Maker payout reserve' : 'Collateral required'}</span><strong>{quoteForSide(quote, side) ? solAmount(quoteTotalLamports(quoteForSide(quote, side)!.collateralLamportsPerSol, quantity)) : 'Quote required'}</strong></div><div><span>Settlement</span><span className="verified"><Check size={13} /> Solana program</span></div></div><button className="primary-action" onClick={onOpenTrade} disabled={!series || (appMode === 'devnet' && !executionEnabled)}>{actionLabel} <ArrowRight size={15} /></button><button className="guard-link" onClick={onGuard}><ShieldCheck size={14} /> Protect a treasury position <ArrowRight size={13} /></button><p className="ticket-note">{ticketNote}</p></aside>
}



function TradePanel({ appMode, quoteMode, walletBusy, tradeStage, tradeError, pendingSignature, kind, series, side, setSide, quantity, quantityText, setQuantityText, tradeValue, walletConnected, executionEnabled, alreadyOwned, onClose, onSubmit }: { appMode: AppMode; quoteMode: 'maker' | 'indicative' | 'offline'; walletBusy: boolean; tradeStage: 'preparing' | 'wallet' | 'confirming'; tradeError: string; pendingSignature?: string; kind: OptionKind; series: OptionSeries; side: TradeSide; setSide: (side: TradeSide) => void; quantity: number; quantityText: string; setQuantityText: (value: string) => void; tradeValue: number; walletConnected: boolean; executionEnabled: boolean; alreadyOwned: boolean; onClose: () => void; onSubmit: () => void }) {

  const quote = series[kind]
  const sizeMessage = quoteMode === 'maker' ? quoteSizeMessage(quote, side, quantity) : null

  const executionPrice = side === 'buy' ? quote.ask : quote.bid

  const terms = quoteForSide(quote, side)

  const premium = terms ? quoteTotalLamports(terms.premiumLamportsPerSol, quantity) : 0

  const collateral = side === 'sell' && terms ? quoteTotalLamports(terms.collateralLamportsPerSol, quantity) : 0

  const unavailableLabel = alreadyOwned ? 'Already in portfolio' : appMode === 'planning' ? 'Planning preview' : quoteMode === 'offline' ? 'Maker service offline' : sizeMessage ?? 'Maker quote required'
  const actionLabel = walletBusy ? tradeStage === 'preparing' ? 'Checking Devnet and quote…' : tradeStage === 'wallet' ? 'Approve in your wallet…' : 'Confirming on Devnet…' : executionEnabled ? (walletConnected ? `Sign ${side} position` : 'Connect wallet to trade') : unavailableLabel
  const drawerNote = alreadyOwned ? 'This wallet already owns this contract. Choose another strike or expiry.' : walletBusy ? tradeStage === 'wallet' ? 'Open your wallet extension and approve or reject the transaction.' : tradeStage === 'confirming' ? 'Wallet submitted the transaction. Waiting for Solana confirmation.' : 'Checking market and quote accounts before your wallet opens.' : executionEnabled ? 'Your signed order uses a validated maker quote and the deployed Soleil program.' : appMode === 'planning' ? 'Planning mode uses indicative prices only. Switch to Devnet to submit.' : quoteMode === 'offline' ? 'Devnet mode is waiting for the maker service to publish on-chain quotes.' : sizeMessage ? 'Reduce the quantity or wait for a larger maker quote.' : 'Devnet mode is waiting for a live maker quote.'

  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="trade-drawer"><div className="drawer-head"><div><p className="eyebrow">TRADE CONTRACT</p><h2>SOL {kind === 'put' ? 'Put' : 'Call'}</h2><p>Strike {money(series.strike, 0)} · {series.expiryLabel} · {series.expiryDays} days</p></div><button className="icon-button" onClick={onClose} aria-label="Close trade ticket"><X size={18} /></button></div><div className="trade-tabs" role="tablist" aria-label="Trade side"><button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>Buy</button><button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>Sell</button></div><label className="form-field"><span>Quantity <small>SOL</small></span><div className="input-shell"><input value={quantityText} type="number" min={minimumTradeSizeSol} step="any" inputMode="decimal" onChange={(event) => setQuantityText(event.target.value)} /><span>SOL</span></div></label><label className="form-field"><span>Limit price <small>per SOL</small></span><div className="input-shell"><input value={executionPrice.toFixed(2)} readOnly /><span>USD</span></div></label><div className="drawer-summary"><div><span>{side === 'buy' ? 'Best ask' : 'Best bid'}</span><strong>{money(executionPrice)}</strong></div><div><span>{side === 'buy' ? 'Estimated cost' : 'Estimated proceeds'}</span><strong>{money(tradeValue)}</strong></div><div><span>On-chain premium</span><strong>{premium > 0 ? solAmount(premium) : '—'}</strong></div>{side === 'sell' && <div><span>Collateral locked</span><strong>{collateral > 0 ? solAmount(collateral) : '—'}</strong></div>}<div><span>Settlement</span><span className="verified"><Check size={13} /> Solana program</span></div></div><button className="primary-action" onClick={onSubmit} disabled={!executionEnabled || walletBusy || Boolean(pendingSignature)}>{pendingSignature ? "Awaiting Devnet confirmation" : actionLabel} <ArrowRight size={15} /></button><p className="drawer-note">{drawerNote}</p>{tradeError && <p className="trade-error" role="alert">{tradeError}</p>}{pendingSignature && <a className="receipt-link" href={getExplorerTransactionUrl(pendingSignature)} target="_blank" rel="noreferrer">View transaction on Explorer <ExternalLink size={12} /></a>}</aside></div>

}



function GuardView({ appMode, quoteMode, floor, setFloor, duration, setDuration, premium, strike, spot, walletBalance, executionEnabled, onGetQuotes, onPortfolio }: { appMode: AppMode; quoteMode: 'maker' | 'indicative' | 'offline'; floor: number; setFloor: (value: number) => void; duration: number; setDuration: (value: number) => void; premium: number; strike: number; spot: number; walletBalance: number; executionEnabled: boolean; onGetQuotes: () => void; onPortfolio: () => void }) {

  const netExposure = walletBalance

  const unavailableLabel = appMode === 'planning' ? 'Planning preview' : quoteMode === 'offline' ? 'Maker service offline' : 'Maker quote required'
  const guardNote = executionEnabled ? 'Wallet-signed put position · Solana devnet' : appMode === 'planning' ? 'Planning mode · execution paused' : quoteMode === 'offline' ? 'Devnet mode · start the maker service to enable execution' : 'Devnet mode · waiting for a live maker quote'

  return <section aria-labelledby="guard-title"><div className="page-heading"><div><p className="eyebrow">PORTFOLIO-AWARE PROTECTION</p><h1 id="guard-title">Guard</h1><p className="page-description">Set the value your SOL treasury must preserve. Review available puts against your chosen treasury target.</p></div><div className="guard-badge"><ShieldCheck size={16} />Built for treasuries</div></div><div className="guard-layout"><div className="guard-main"><section className="market-panel exposure-panel"><div className="panel-header"><div><h2>Net SOL exposure</h2><p>Every position is visible in the calculation.</p></div><span className="text-button">Derived from wallet</span></div><div className="exposure-total"><span>{netExposure > 0 ? `${netExposure.toFixed(2)} SOL` : '—'}</span><small>{netExposure > 0 && spot > 0 ? `≈ ${money(netExposure * spot)}` : 'Connect wallet to calculate'}</small><span className="risk-label"><span className="risk-dot" />{netExposure > 0 ? 'Unprotected' : 'Connect wallet'}</span></div><div className="exposure-bars"><ExposureRow label="Native SOL" detail="Wallet balance" quantity={netExposure > 0 ? `+${netExposure.toFixed(2)} SOL` : '—'} tone="sol" width={netExposure > 0 ? '80%' : '0%'} /><ExposureRow label="LST positions" detail="Adapter not connected" quantity="—" tone="lst" width="0%" /><ExposureRow label="Short positions" detail="Adapter not connected" quantity="—" tone="short" width="0%" /></div><div className="calculation-line"><span>{netExposure > 0 ? `${netExposure.toFixed(2)} + 0.00 − 0.00` : 'Connect wallet to calculate'}</span><strong>{netExposure > 0 ? `= ${netExposure.toFixed(2)} SOL net exposure` : '—'}</strong></div></section><ProtectionChart spot={spot} floor={floor} quantity={netExposure} /></div><aside className="market-panel guard-ticket"><div className="guard-ticket-top"><span className="eyebrow">YOUR PROTECTION PLAN</span><span className="plan-state">{executionEnabled ? 'READY' : appMode === 'planning' ? 'PLANNING' : 'WAITING'}</span></div><div className="guard-result"><span>Protect at least</span><strong>{floor > 0 ? money(floor, 0) : '—'}</strong><span>for the next {duration} days</span></div><label className="large-field"><span>Minimum treasury value</span><div><span>$</span><input type="number" value={floor} min={0} step={1} onChange={(event) => setFloor(Math.max(0, Number(event.target.value)))} /></div></label><label className="select-field"><span>Protection period</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={7}>{expiryDate(7)} · 7 days</option><option value={14}>{expiryDate(14)} · 14 days</option><option value={30}>{expiryDate(30)} · 30 days</option></select></label><div className="guard-quote"><div><span>Options needed</span><strong>{netExposure > 0 ? `${netExposure.toFixed(2)} SOL puts` : '—'}</strong></div><div><span>Best premium</span><strong>{premium > 0 ? money(premium) : '—'}</strong></div><div><span>Protection strike</span><strong>{strike > 0 ? money(strike, 0) : '—'}</strong></div></div><button className="primary-action" onClick={onGetQuotes} disabled={netExposure <= 0 || strike <= 0 || !executionEnabled}>{executionEnabled ? 'Get protection quotes' : unavailableLabel} <ArrowRight size={15} /></button><button className="plain-action" onClick={onPortfolio}>View portfolio</button><p className="ticket-note">{guardNote}</p></aside></div></section>

}



function ExposureRow({ label, detail, quantity, tone, width }: { label: string; detail: string; quantity: string; tone: string; width: string }) {

  return <div className="exposure-row"><div><span className={`exposure-swatch ${tone}-swatch`} />{label}<small>{detail}</small></div><strong className={tone === 'short' ? 'negative' : ''}>{quantity}</strong><div className="bar"><span style={{ width, background: tone === 'short' ? 'var(--red)' : undefined }} /></div></div>

}



function ProtectionChart({ spot, floor, quantity }: { spot: number; floor: number; quantity: number }) {

  const prices = Array.from({ length: 7 }, (_, index) => spot > 0 ? spot * (0.7 + index * 0.1) : 0)

  const values = prices.map((price) => price * quantity)

  const maxValue = Math.max(floor * 1.35, ...values, 1)

  const toPoint = (value: number, index: number) => {

    const x = 58 + index * (677 / Math.max(prices.length - 1, 1))

    const y = 220 - (value / maxValue) * 195

    return `${x.toFixed(1)},${Math.max(25, y).toFixed(1)}`

  }

  const unprotectedPoints = values.map(toPoint).join(' ')

  const protectedPoints = values.map((value, index) => toPoint(Math.max(value, floor), index)).join(' ')

  const floorY = Math.max(25, 220 - (floor / maxValue) * 195)

  const priceLabels = prices.filter((_, index) => index % 2 === 0).map((price, index) => ({ price, x: 58 + index * (677 / 3) }))

  return <section className="guard-chart-panel market-panel"><div className="panel-header"><div><h2>Protection preview</h2><p>Target payoff illustration, before premium; not a guaranteed floor</p></div><div className="chart-legend"><span><i className="legend-line value-line" />Without Guard</span><span><i className="legend-line floor-line" />With Guard</span></div></div><div className="guard-chart"><svg viewBox="0 0 760 260" role="img" aria-label="Protection preview showing a protected floor"><line x1="58" y1="25" x2="58" y2="220" /><line x1="58" y1="220" x2="735" y2="220" /><line className="gridline" x1="58" y1="90" x2="735" y2="90" /><line className="gridline" x1="58" y1="155" x2="735" y2="155" /><text x="0" y="30">{money(maxValue)}</text><text x="0" y="95">{money(maxValue * .66)}</text><text x="0" y="160">{money(maxValue * .33)}</text><text x="0" y="225">$0</text><polyline className="unprotected-path" points={unprotectedPoints} /><polyline className="protected-path" points={protectedPoints} /><line className="floor-marker" x1="58" y1={floorY} x2="735" y2={floorY} /><text className="floor-text" x="540" y={Math.max(32, floorY - 8)}>Floor {money(floor, 0)}</text>{priceLabels.map((label) => <text key={label.x} x={label.x} y="245">{money(label.price, 0)}</text>)}</svg></div></section>

}



function PortfolioView({ positions, series, quoteMode, spot, walletBalance, filter, setFilter, onGuard, onClose, onSettle }: { positions: Position[]; series: OptionSeries[]; quoteMode: 'maker' | 'indicative' | 'offline'; spot: number; walletBalance: number; filter: 'all' | 'open' | 'closed' | 'settled'; setFilter: (filter: 'all' | 'open' | 'closed' | 'settled') => void; onGuard: () => void; onClose: (position: Position) => void; onSettle: (position: Position) => void }) {

  const visiblePositions = positions.filter((position) => filter === 'all' || position.status.toLowerCase() === filter)

  const liveMarkFor = (position: Position) => {
    if (position.status !== 'Open' || quoteMode !== 'maker') return undefined
    const row = series.find((item) => item.strike === position.strike && item.expiryAt === position.expiryAt)
    if (!row) return undefined
    return position.side === 'buy' ? row[position.kind].bid : row[position.kind].ask
  }

  const pnlFor = (position: Position, mark: number | undefined) => {
    if (mark === undefined) return undefined
    const delta = position.side === 'buy' ? mark - position.entry : position.entry - mark
    return delta * position.quantity
  }

  return <section aria-labelledby="portfolio-title"><div className="page-heading"><div><p className="eyebrow">ACCOUNT OVERVIEW</p><h1 id="portfolio-title">Portfolio</h1><p className="page-description">Your options, exposure, and protection in one place.</p></div><button className="secondary-button" onClick={onGuard}><ShieldCheck size={15} />Protect treasury</button></div><div className="portfolio-stats"><Stat label="Wallet value" value={walletBalance > 0 && spot > 0 ? money(walletBalance * spot) : '—'} detail={walletBalance > 0 ? `${walletBalance.toFixed(4)} SOL on devnet` : 'Connect wallet'} positive={walletBalance > 0} /><Stat label="Net SOL exposure" value={`${walletBalance.toFixed(2)} SOL`} detail={walletBalance > 0 ? 'Unprotected' : 'Wallet not connected'} /><Stat label="Open positions" value={String(positions.filter((position) => position.status === 'Open').length)} detail={`Across ${new Set(positions.map((p) => p.expiryDays)).size} expiries`} /><Stat label="Protection floor" value="—" detail="Guard not active" /></div><section className="portfolio-table-panel market-panel"><div className="panel-header"><div><h2>Positions</h2><p>Confirmed Soleil program positions · marks from live maker quotes</p></div><div className="table-filter"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>Open</button><button className={filter === 'closed' ? 'active' : ''} onClick={() => setFilter('closed')}>Closed</button><button className={filter === 'settled' ? 'active' : ''} onClick={() => setFilter('settled')}>Settled</button></div></div><div className="portfolio-table-wrap"><table className="portfolio-table"><thead><tr><th>Contract</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>P&L</th><th>Status</th><th>Action</th></tr></thead><tbody>{visiblePositions.length === 0 ? <tr className="portfolio-empty"><td colSpan={8}><div className="empty-symbol"><Sparkles size={15} /></div><strong>No positions in this view</strong><span>Confirmed program positions will appear here.</span></td></tr> : visiblePositions.map((position) => { const mark = liveMarkFor(position); const pnl = pnlFor(position, mark); return <tr key={position.id}><td><strong>SOL {position.strike} {position.kind.toUpperCase()}</strong><small>{position.expiryLabel}</small></td><td>{position.side === 'buy' ? 'Long' : 'Short'}</td><td>{position.quantity} SOL</td><td>{money(position.entry)}</td><td>{mark !== undefined ? money(mark) : position.status === 'Open' ? 'Mark unavailable' : money(position.mark)}</td><td className={pnl !== undefined ? pnl >= 0 ? 'up' : 'negative' : 'muted-cell'}>{pnl !== undefined ? money(pnl) : position.status === 'Settled' ? `${((position.payoutLamports ?? 0) / 1_000_000_000).toFixed(4)} SOL payout` : 'Mark unavailable'}</td><td><span className="plan-state">{position.status}</span>{position.receipt && <a className="receipt-link" href={getExplorerTransactionUrl(position.receipt)} target="_blank" rel="noreferrer">Receipt <ExternalLink size={11} /></a>}</td><td>{position.status === 'Open' && <button className="table-action" disabled={position.side === 'sell' && Boolean(position.expiryAt && position.expiryAt > Date.now() / 1000)} onClick={() => position.expiryAt && position.expiryAt <= Math.floor(Date.now() / 1000) ? onSettle(position) : onClose(position)}>{position.expiryAt && position.expiryAt <= Math.floor(Date.now() / 1000) ? 'Settle' : position.side === 'sell' ? 'Await expiry' : 'Abandon'}</button>}</td></tr> })}</tbody></table></div></section></section>

}



function Stat({ label, value, detail, positive = false }: { label: string; value: string; detail: string; positive?: boolean }) { return <div className="stat-panel market-panel"><span>{label}</span><strong>{value}</strong><small className={positive ? 'up' : ''}>{detail}</small></div> }



function GuardModal({ duration, premium, strike, quantity, onClose, onConfirm }: { duration: number; premium: number; strike: number; quantity: number; onClose: () => void; onConfirm: () => void | Promise<void> }) {

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button><div className="modal-icon"><ShieldCheck size={19} /></div><p className="eyebrow">TRANSACTION REVIEW</p><h2 id="modal-title">Confirm your protection</h2><p className="modal-description">Review the put position before signing it with Phantom on Solana devnet.</p><div className="modal-summary"><div><span>Contract</span><strong>SOL {money(strike, 0)} Put · {duration}d</strong></div><div><span>Quantity</span><strong>{quantity.toFixed(4)} SOL</strong></div><div><span>Premium estimate</span><strong>{premium > 0 ? money(premium) : '—'} USD</strong></div><div><span>Settlement</span><strong>Soleil Solana program</strong></div></div><button className="primary-action" onClick={onConfirm}>Sign protection position <ArrowRight size={15} /></button><button className="modal-cancel" onClick={onClose}>Cancel</button></section></div>

}



export default App


