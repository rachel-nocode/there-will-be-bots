import PartySocket from 'partysocket'
import { create } from 'zustand'
import { HEIST_CONFIG } from '../heist/config'
import { assignGameRoom } from '../multiplayer/matchmaking'
import {
  PARTYKIT_ROOM_ID,
  type ClientMessage,
  type HeistPhase,
  type HeistPlayer,
  type HeistSnapshot,
  type ServerMessage,
} from '../multiplayer/contracts'
import type { Toast } from '../types'
import { generateId } from '../utils/formatters'

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

interface GameStore {
  connectionStatus: ConnectionStatus
  partyHost: string
  partyRoomId: string | null
  playerId: string
  players: HeistPlayer[]
  orbs: HeistSnapshot['orbs']
  godzillas: HeistSnapshot['godzillas']
  escapeZones: HeistSnapshot['escapeZones']
  toasts: Toast[]
  tick: number
  phase: HeistPhase
  phaseEndsAt: number | null
  lobbyCountdownAt: number | null
  tourRound: number
  tourCities: string[]
  activeCityId: string | null
  winnerId: string | null
  humanCount: number
  error: string | null
  connectPlayer: () => void
  removeToast: (id: string) => void
  moveTo: (lat: number, lng: number) => void
  setDisplayName: (name: string) => void
}

const PLAYER_ID_STORAGE_KEY = 'heist.player-id'

let socket: PartySocket | null = null

function loadPlayerId() {
  if (typeof window === 'undefined') {
    return `merc-${Math.random().toString(36).slice(2, 9)}`
  }
  const existing = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY)
  if (existing) return existing
  const created = `merc-${generateId()}`
  window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, created)
  return created
}

function getPartyHost() {
  if (import.meta.env.VITE_PARTYKIT_HOST) {
    return import.meta.env.VITE_PARTYKIT_HOST
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return `${window.location.hostname}:1999`
  }
  return '127.0.0.1:1999'
}

function pushToast(toasts: Toast[], toast: Toast) {
  return [...toasts.slice(-HEIST_CONFIG.MAX_TOASTS + 1), toast]
}

function makeLocalToast(message: string, type: Toast['type']): Toast {
  return {
    id: generateId(),
    message,
    type,
    timestamp: Date.now(),
  }
}

function applySnapshot(snapshot: HeistSnapshot) {
  return {
    players: snapshot.players,
    orbs: snapshot.orbs,
    godzillas: snapshot.godzillas,
    escapeZones: snapshot.escapeZones,
    tick: snapshot.tick,
    phase: snapshot.phase,
    phaseEndsAt: snapshot.phaseEndsAt,
    lobbyCountdownAt: snapshot.lobbyCountdownAt,
    tourRound: snapshot.tourRound,
    tourCities: snapshot.tourCities,
    activeCityId: snapshot.activeCityId,
    winnerId: snapshot.winnerId,
    humanCount: snapshot.humanCount,
  }
}

function sendClientMessage(message: ClientMessage) {
  if (!socket) return
  socket.send(JSON.stringify(message))
}

const initialPlayerId = loadPlayerId()

export const useGameStore = create<GameStore>((set, get) => ({
  connectionStatus: 'idle',
  partyHost: getPartyHost(),
  partyRoomId: null,
  playerId: initialPlayerId,
  players: [],
  orbs: [],
  godzillas: [],
  escapeZones: [],
  toasts: [],
  tick: 0,
  phase: 'lobby',
  phaseEndsAt: null,
  lobbyCountdownAt: null,
  tourRound: 0,
  tourCities: [],
  activeCityId: null,
  winnerId: null,
  humanCount: 0,
  error: null,

  connectPlayer: async () => {
    if (socket) {
      socket.close()
      socket = null
    }

    set({ connectionStatus: 'connecting', error: null })

    const host = getPartyHost()
    let roomId = PARTYKIT_ROOM_ID

    try {
      const assignment = await assignGameRoom(host)
      roomId = assignment.roomId
      set({ partyRoomId: roomId })
    } catch {
      set({
        partyRoomId: roomId,
        toasts: pushToast(
          get().toasts,
          makeLocalToast(
            'Matchmaker unavailable — joining a default city.',
            'warning',
          ),
        ),
      })
    }

    const nextSocket = new PartySocket({
      host,
      room: roomId,
      query: async () => ({
        playerId: initialPlayerId,
        name: 'Mercenary',
      }),
    })

    socket = nextSocket

    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return
      set({ connectionStatus: 'connected', error: null })
    })

    nextSocket.addEventListener('message', (event) => {
      if (socket !== nextSocket || typeof event.data !== 'string') return

      let payload: ServerMessage
      try {
        payload = JSON.parse(event.data) as ServerMessage
      } catch {
        set((current) => ({
          toasts: pushToast(
            current.toasts,
            makeLocalToast('Could not read a server update.', 'warning'),
          ),
        }))
        return
      }

      if (payload.type === 'toast') {
        set((current) => ({
          toasts: pushToast(current.toasts, payload.toast),
        }))
        return
      }

      if (payload.type === 'user-state') {
        set({ playerId: payload.userState.playerId })
        return
      }

      set(() => ({
        connectionStatus: 'connected',
        error: null,
        ...applySnapshot(payload.snapshot),
      }))
    })

    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return
      set({
        connectionStatus: 'connecting',
        error: 'Reconnecting to public room…',
      })
    })

    nextSocket.addEventListener('error', () => {
      if (socket !== nextSocket) return
      set({
        connectionStatus: 'error',
        error: 'Could not reach the game room.',
      })
    })
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  moveTo: (lat, lng) => sendClientMessage({ type: 'move', lat, lng }),
  setDisplayName: (name) => sendClientMessage({ type: 'set-display-name', name }),
}))

export function useSelfPlayer() {
  const playerId = useGameStore((state) => state.playerId)
  const players = useGameStore((state) => state.players)
  return players.find((player) => player.id === playerId) ?? null
}

export function useSecondsRemaining(
  endsAt: number | null,
  tick: number,
): number | null {
  if (!endsAt) return null
  void tick
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
}
