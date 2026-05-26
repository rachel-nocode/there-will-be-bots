import { useEffect, useState } from 'react'
import { useGameStore } from './store'
import GameMap from './map/GameMap'
import HeistHud from './ui/HeistHud'
import MobileControls from './ui/mobile/MobileControls'
import NameGate from './ui/NameGate'
import ToastNotification from './ui/ToastNotification'
import { hasSavedPlayerName } from './utils/playerIdentity'

export default function App() {
  const connectionStatus = useGameStore((state) => state.connectionStatus)
  const connectPlayer = useGameStore((state) => state.connectPlayer)
  const [nameReady, setNameReady] = useState(hasSavedPlayerName)

  useEffect(() => {
    if (!nameReady || connectionStatus !== 'idle') return
    connectPlayer()
  }, [connectPlayer, connectionStatus, nameReady])

  useEffect(() => {
    if (connectionStatus !== 'error' || !nameReady) return
    const timeoutId = window.setTimeout(() => {
      connectPlayer()
    }, 1500)
    return () => window.clearTimeout(timeoutId)
  }, [connectPlayer, connectionStatus, nameReady])

  const handleNameComplete = () => {
    setNameReady(true)
  }

  return (
    <div className="mobile-game-shell relative h-full w-full overflow-hidden">
      <GameMap />
      <HeistHud />
      <MobileControls />
      <ToastNotification />

      {!nameReady ? <NameGate onComplete={handleNameComplete} /> : null}

      {nameReady && connectionStatus === 'connecting' ? (
        <div className="pointer-events-none absolute inset-x-0 top-[max(4.5rem,calc(env(safe-area-inset-top)+3.5rem))] z-50 flex justify-center px-4 md:top-24">
          <p className="rounded-full border border-white/10 bg-black/75 px-4 py-2 text-center text-sm text-white/80 backdrop-blur-md">
            Finding an open city…
          </p>
        </div>
      ) : null}
    </div>
  )
}
