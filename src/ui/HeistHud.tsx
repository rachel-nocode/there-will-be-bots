import { useEffect, useMemo, useState } from 'react'
import { CITIES } from '../data/cities'
import { HEIST_CONFIG } from '../heist/config'
import { useIsTouchDevice } from '../hooks/useIsTouchDevice'
import { formatRoomLabel } from '../multiplayer/matchmaking'
import {
  useGameStore,
  useSecondsRemaining,
  useSelfPlayer,
} from '../store'
import { SELF_PLAYER_COLOR } from '../utils/playerIdentity'

const PHASE_LABELS = {
  lobby: 'Lobby',
  briefing: 'Next city',
  collect: 'Grab tokens',
  rampage: 'RUN!',
  extract: 'Scoring',
  'tour-end': 'Done',
} as const

export default function HeistHud() {
  const isTouch = useIsTouchDevice()
  const phase = useGameStore((state) => state.phase)
  const partyRoomId = useGameStore((state) => state.partyRoomId)
  const humanCount = useGameStore((state) => state.humanCount)
  const tourRound = useGameStore((state) => state.tourRound)
  const tourCities = useGameStore((state) => state.tourCities)
  const activeCityId = useGameStore((state) => state.activeCityId)
  const players = useGameStore((state) => state.players)
  const phaseEndsAt = useGameStore((state) => state.phaseEndsAt)
  const lobbyCountdownAt = useGameStore((state) => state.lobbyCountdownAt)
  const tick = useGameStore((state) => state.tick)
  const winnerId = useGameStore((state) => state.winnerId)
  const connectionStatus = useGameStore((state) => state.connectionStatus)
  const self = useSelfPlayer()

  const [, bump] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => bump((value) => value + 1), 250)
    return () => window.clearInterval(id)
  }, [])

  const phaseSeconds = useSecondsRemaining(phaseEndsAt, tick)
  const lobbySeconds = useSecondsRemaining(lobbyCountdownAt, tick)
  const activeCity = CITIES.find((city) => city.id === activeCityId)
  const winner = players.find((player) => player.id === winnerId)

  const tourLabels = useMemo(
    () =>
      tourCities.map(
        (cityId) => CITIES.find((city) => city.id === cityId)?.name ?? cityId,
      ),
    [tourCities],
  )

  const rankedPlayers = players
    .filter((player) => player.connected || player.isBot)
    .slice(0, HEIST_CONFIG.MAX_PLAYERS)

  const footerHint =
    phase === 'collect'
      ? isTouch
        ? 'Joystick to steer · RUN to sprint toward tokens'
        : 'Click the map to move · grab green token orbs'
      : phase === 'rampage'
        ? self?.escaped
          ? 'You escaped — tokens saved!'
          : isTouch
            ? 'Steer toward green exits · spam RUN'
            : 'RUN — click toward EXIT beacons before Slopzilla stomps you'
        : phase === 'lobby' && isTouch
          ? 'Matched into a city · bots fill the room · 3-city tour'
          : 'Collect tokens, then survive Slopzilla'

  const timerLabel =
    phase === 'lobby' && lobbySeconds != null
      ? `${lobbySeconds}s`
      : phaseSeconds != null
        ? `${phaseSeconds}s`
        : '—'

  const headerTone =
    phase === 'rampage'
      ? 'border-red-500/40 bg-red-950/80'
      : 'border-white/10 bg-black/70'

  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center px-3 pt-[max(0.65rem,env(safe-area-inset-top))] md:px-4 md:pt-4">
        <div
          className={`pointer-events-auto w-full max-w-3xl rounded-2xl border px-3 py-2.5 backdrop-blur-md md:rounded-xl md:px-4 md:py-3 ${headerTone}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-[0.24em] text-cyan-300/80 md:text-[10px] md:tracking-[0.28em]">
                Slopzilla
              </p>
              <h1
                className={`truncate text-base font-semibold md:text-lg ${
                  phase === 'rampage' ? 'text-red-200' : 'text-white'
                }`}
              >
                {PHASE_LABELS[phase]}
                {tourRound > 0
                  ? ` · ${tourRound}/${HEIST_CONFIG.TOUR_ROUNDS}`
                  : ''}
              </h1>
              <p className="truncate text-xs text-white/70 md:text-sm">
                {activeCity?.name ?? formatRoomLabel(partyRoomId)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[9px] uppercase tracking-[0.18em] text-white/45 md:text-[10px]">
                {connectionStatus === 'connected' ? 'Live' : connectionStatus}
              </p>
              <p
                className={`font-mono text-xl leading-none md:text-2xl ${
                  phase === 'rampage' ? 'text-red-300' : 'text-cyan-300'
                }`}
              >
                {timerLabel}
              </p>
              <p className="text-[10px] text-white/55 md:text-xs">
                {humanCount}/{HEIST_CONFIG.MAX_PLAYERS}
              </p>
            </div>
          </div>

          {tourLabels.length > 0 ? (
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 md:mt-3 md:flex-wrap md:gap-2">
              {tourLabels.map((label, index) => (
                <span
                  key={`${label}-${index}`}
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider md:px-2.5 md:py-1 md:text-[10px] ${
                    index + 1 === tourRound
                      ? phase === 'rampage'
                        ? 'bg-red-500/25 text-red-100'
                        : 'bg-cyan-400/20 text-cyan-200'
                      : index + 1 < tourRound
                        ? 'bg-white/10 text-white/50'
                        : 'bg-white/5 text-white/35'
                  }`}
                >
                  <span className="md:hidden">{index + 1}</span>
                  <span className="hidden md:inline">{label}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {isTouch ? (
        <div className="pointer-events-none absolute inset-x-0 top-[calc(max(0.65rem,env(safe-area-inset-top))+5.75rem)] z-30 px-3 md:hidden">
          <div className="pointer-events-auto overflow-x-auto rounded-xl border border-white/10 bg-black/55 px-2 py-2 backdrop-blur-md">
            <ul className="flex min-w-max gap-3">
              {rankedPlayers.map((player, index) => (
                <li
                  key={player.id}
                  className={`flex items-center gap-1.5 text-[11px] ${
                    player.id === self?.id ? 'text-red-200' : 'text-white/85'
                  }`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        player.id === self?.id
                          ? SELF_PLAYER_COLOR
                          : player.color,
                    }}
                  />
                  <span className="max-w-[5.5rem] truncate">
                    {player.id === self?.id ? 'YOU · ' : ''}
                    {index + 1}. {player.name}
                    {player.isBot ? ' 🤖' : ''}
                  </span>
                  <span className="font-mono text-cyan-200">{player.bankedData}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <aside className="pointer-events-none absolute right-4 top-36 z-40 hidden w-56 md:block">
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/60 p-3 backdrop-blur-md">
            <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-white/45">
              Survivors
            </p>
            <ul className="space-y-2">
              {rankedPlayers.map((player, index) => (
                <li
                  key={player.id}
                  className={`flex items-center justify-between gap-2 text-sm ${
                    player.id === self?.id ? 'rounded-lg bg-red-500/10 px-1 py-0.5' : ''
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        player.id === self?.id ? 'ring-2 ring-red-300/70' : ''
                      }`}
                      style={{
                        backgroundColor:
                          player.id === self?.id
                            ? SELF_PLAYER_COLOR
                            : player.color,
                      }}
                    />
                    <span
                      className={`truncate ${
                        player.id === self?.id
                          ? 'font-semibold text-red-100'
                          : 'text-white/90'
                      }`}
                    >
                      {player.id === self?.id ? (
                        <span className="mr-1 rounded bg-red-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                          You
                        </span>
                      ) : null}
                      {index + 1}. {player.name}
                      {player.isBot ? ' 🤖' : ''}
                      {player.escaped ? ' ✓' : ''}
                    </span>
                  </span>
                  <span className="font-mono text-cyan-200">
                    {player.bankedData}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}

      {self ? (
        <footer
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 md:px-4 md:pb-4 ${
            isTouch
              ? 'pb-[calc(9.5rem+env(safe-area-inset-bottom))]'
              : 'pb-4'
          }`}
        >
          <div
            className={`pointer-events-auto w-full max-w-3xl rounded-2xl border backdrop-blur-md md:rounded-xl ${
              phase === 'rampage'
                ? 'border-red-500/30 bg-red-950/80'
                : 'border-white/10 bg-black/70'
            } ${isTouch ? 'px-3 py-2.5' : 'p-4'}`}
          >
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[9px] uppercase tracking-[0.2em] text-white/45 md:text-[10px] md:tracking-[0.24em]">
                  {self.name}
                  <span className="ml-2 rounded bg-red-500 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white">
                    You
                  </span>
                </p>
                <p className="font-mono text-lg text-white md:text-xl">
                  <span className="text-cyan-300">{self.carryingData}</span>
                  <span className="text-white/40"> · </span>
                  <span className="text-emerald-300">{self.bankedData}</span>
                  <span className="text-white/40"> saved</span>
                </p>
              </div>
              {phase === 'lobby' && isTouch ? (
                <p className="shrink-0 text-[10px] text-white/55">🤖 bots join</p>
              ) : null}
            </div>
            <p
              className={`text-white/70 ${isTouch ? 'mt-1 line-clamp-2 text-[11px] leading-snug' : 'mt-1 text-xs'}`}
            >
              {footerHint}
            </p>
          </div>
        </footer>
      ) : null}

      {phase === 'lobby' && !isTouch ? (
        <div className="pointer-events-none absolute left-4 top-[19rem] z-30 hidden w-64 rounded-xl border border-white/10 bg-black/55 p-3 text-sm text-white/70 backdrop-blur-md md:block">
          <p className="text-[10px] uppercase tracking-[0.24em] text-white/45">
            How to play
          </p>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
            <li>3 cities · collect token orbs each round.</li>
            <li>Slopzilla wakes up — sprint to EXIT beacons.</li>
            <li>Bots fill empty slots up to {HEIST_CONFIG.MAX_PLAYERS} runners.</li>
            <li>Get stomped and you lose carried tokens.</li>
          </ul>
        </div>
      ) : null}

      {phase === 'tour-end' && winner ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-yellow-400/30 bg-black/80 px-6 py-5 text-center backdrop-blur-md md:max-w-md md:px-8 md:py-6">
            <p className="text-[10px] uppercase tracking-[0.28em] text-yellow-300/80">
              Tour survivor
            </p>
            <p className="mt-2 text-2xl font-semibold text-white md:text-3xl">
              {winner.name}
            </p>
            <p className="mt-1 font-mono text-cyan-200">
              {winner.bankedData} tokens saved
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
