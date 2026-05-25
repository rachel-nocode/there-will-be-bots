import { useCallback, useEffect, useRef } from 'react'
import { HEIST_CONFIG } from '../../heist/config'
import { useIsTouchDevice } from '../../hooks/useIsTouchDevice'
import { useSteeringStore } from '../../store/steering'
import {
  useGameStore,
  useSelfPlayer,
} from '../../store'
import { pickRunTarget, steerTarget } from '../../utils/movement'
import VirtualJoystick from './VirtualJoystick'

const STEER_INTERVAL_MS = 85
const MIN_TAP_GAP_MS = 70

export default function MobileControls() {
  const isTouch = useIsTouchDevice()
  const phase = useGameStore((state) => state.phase)
  const orbs = useGameStore((state) => state.orbs)
  const escapeZones = useGameStore((state) => state.escapeZones)
  const godzillas = useGameStore((state) => state.godzillas)
  const moveTo = useGameStore((state) => state.moveTo)
  const self = useSelfPlayer()
  const steerX = useSteeringStore((state) => state.x)
  const steerY = useSteeringStore((state) => state.y)
  const steeringActive = useSteeringStore((state) => state.active)
  const lastTapAt = useRef(0)

  const canMove =
    (phase === 'collect' || phase === 'rampage') && self && !self.escaped

  useEffect(() => {
    if (!isTouch || !canMove) return

    const intervalId = window.setInterval(() => {
      const { x, y, active } = useSteeringStore.getState()
      if (!active || Math.hypot(x, y) < 0.16) return

      const { players, playerId, phase: livePhase, moveTo: sendMove } =
        useGameStore.getState()
      const currentSelf = players.find((player) => player.id === playerId)
      if (
        !currentSelf ||
        currentSelf.escaped ||
        (livePhase !== 'collect' && livePhase !== 'rampage')
      ) {
        return
      }

      const target = steerTarget(currentSelf, x, y, livePhase, 1)
      sendMove(target.lat, target.lng)
    }, STEER_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [canMove, isTouch])

  const handleRun = useCallback(() => {
    if (!self || !canMove) return
    const now = Date.now()
    if (now - lastTapAt.current < MIN_TAP_GAP_MS) return
    lastTapAt.current = now

    const steering =
      steeringActive && Math.hypot(steerX, steerY) > 0.16
        ? { x: steerX, y: steerY }
        : null
    const target = pickRunTarget(
      self,
      phase,
      orbs,
      escapeZones,
      godzillas,
      1.2,
      steering,
    )
    moveTo(target.lat, target.lng)

    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(phase === 'rampage' ? 14 : 9)
    }
  }, [
    canMove,
    escapeZones,
    godzillas,
    moveTo,
    orbs,
    phase,
    self,
    steerX,
    steerY,
    steeringActive,
  ])

  if (!isTouch) return null

  const runLabel =
    phase === 'rampage'
      ? self?.escaped
        ? 'Safe'
        : 'RUN!'
      : phase === 'collect'
        ? 'RUN'
        : '—'

  const showControls = phase === 'collect' || phase === 'rampage'

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex items-end justify-between px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div
        className={`pointer-events-auto pl-[max(0.25rem,env(safe-area-inset-left))] transition-opacity ${
          showControls ? 'opacity-100' : 'opacity-40'
        }`}
      >
        <VirtualJoystick disabled={!canMove} />
        {showControls ? (
          <p className="mt-1 text-center text-[9px] uppercase tracking-[0.2em] text-white/45">
            Steer
          </p>
        ) : null}
      </div>

      <div
        className={`pointer-events-auto pr-[max(0.25rem,env(safe-area-inset-right))] transition-opacity ${
          showControls ? 'opacity-100' : 'opacity-40'
        }`}
      >
        <button
          type="button"
          aria-label={runLabel}
          disabled={!canMove}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            handleRun()
          }}
          className={`flex h-28 w-28 touch-manipulation select-none items-center justify-center rounded-full border-2 text-sm font-bold uppercase tracking-[0.16em] shadow-lg backdrop-blur-md transition active:scale-95 disabled:opacity-35 ${
            phase === 'rampage'
              ? 'border-red-300/50 bg-red-500/25 text-red-50 shadow-red-500/30'
              : 'border-cyan-300/40 bg-cyan-400/15 text-cyan-50 shadow-cyan-400/20'
          }`}
        >
          <span className="pointer-events-none drop-shadow-[0_0_12px_rgba(255,255,255,0.35)]">
            {runLabel}
          </span>
        </button>
        {showControls ? (
          <p className="mt-1 text-center text-[9px] uppercase tracking-[0.2em] text-white/45">
            Sprint
          </p>
        ) : null}
      </div>

      {showControls ? (
        <div className="pointer-events-none absolute inset-x-20 bottom-[calc(100%+0.35rem)] text-center">
          <p className="text-[10px] text-white/50">
            {phase === 'rampage'
              ? `Exit before Slopzilla · ${HEIST_CONFIG.RAMPAGE_MS / 1000}s`
              : `Grab tokens · ${HEIST_CONFIG.COLLECT_MS / 1000}s left`}
          </p>
        </div>
      ) : null}
    </div>
  )
}
