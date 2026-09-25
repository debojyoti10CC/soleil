import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { clusterApiUrl } from '@solana/web3.js'
import '@fontsource/poppins/latin-400.css'
import '@fontsource/poppins/latin-500.css'
import '@fontsource/poppins/latin-600.css'
import '@fontsource/poppins/latin-700.css'
import App from './App'
import './styles.css'
import '@solana/wallet-adapter-react-ui/styles.css'

const network = WalletAdapterNetwork.Devnet
const endpoint = import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl(network)
const walletAdapters = [
  new PhantomWalletAdapter(),
  new SolflareWalletAdapter({ network }),
]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={walletAdapters} autoConnect onError={(error) => {
        window.dispatchEvent(new CustomEvent('soleil-wallet-error', { detail: error instanceof Error ? error.message : 'Wallet connection failed.' }))
      }}>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
)
