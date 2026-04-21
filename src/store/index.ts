import PartySocket from 'partysocket'
import { create } from 'zustand'
import { GAME_CONFIG } from '../data/config'
import {
  PARTYKIT_ROOM_ID,
  type ClientMessage,
  type LeaderboardEntry,
  type MultiplayerPlayer,
  type MultiplayerSnapshot,
  type SentimentBroadcast,
  type ServerMessage,
  type UserState,
} from '../multiplayer/contracts'
import type { Toast } from '../types'
import type {
  Draft,
  HumanLeaderboardEntry,
  LabSentimentAggregate,
  PredictionMarket,
  Season,
  SentimentValue,
  UserBankroll,
  UserPrediction,
  UserProfile,
  UserSentiment,
} from '../types/game'
import { DEFAULT_WAGER } from '../types/game'
import { generateId } from '../utils/formatters'

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

interface GameStore {
  connectionStatus: ConnectionStatus
  partyHost: string
  spectatorId: string
  players: MultiplayerPlayer[]
  leaderboard: LeaderboardEntry[]
  headlines: string[]
  toasts: Toast[]
  tick: number
  roomPhase: MultiplayerSnapshot['phase']
  worldSnapshotMeta: MultiplayerSnapshot['worldSnapshotMeta']
  season: Season | null
  openMarkets: PredictionMarket[]
  resolvedMarkets: PredictionMarket[]
  sentimentByLab: Record<string, LabSentimentAggregate>
  humanLeaderboard: HumanLeaderboardEntry[]
  aiSentiment: SentimentBroadcast | null
  userProfile: UserProfile | null
  userDraft: Draft | null
  userPredictions: UserPrediction[]
  userSentiment: Record<string, UserSentiment>
  userRank: number | null
  userBankroll: UserBankroll | null
  error: string | null
  connectPlayer: () => void
  removeToast: (id: string) => void
  draftLab: (labId: string) => void
  swapLab: (labId: string) => void
  predict: (marketId: string, optionId: string, wager?: number) => void
  setSentiment: (labId: string, value: SentimentValue) => void
  setDisplayName: (name: string) => void
}

const SPECTATOR_ID_STORAGE_KEY = 'agigame.spectator-id'

let socket: PartySocket | null = null

function loadSpectatorId() {
  if (typeof window === 'undefined') {
    return `spectator-${Math.random().toString(36).slice(2, 9)}`
  }
  const existing = window.localStorage.getItem(SPECTATOR_ID_STORAGE_KEY)
  if (existing) {
    return existing
  }
  const created = `spectator-${generateId()}`
  window.localStorage.setItem(SPECTATOR_ID_STORAGE_KEY, created)
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

function sortPlayers(players: MultiplayerPlayer[]) {
  return [...players].sort(
    (left, right) =>
      (right.sourceBackedStats.agiScore ?? 0) -
      (left.sourceBackedStats.agiScore ?? 0),
  )
}

function pushToast(toasts: Toast[], toast: Toast) {
  return [...toasts.slice(-GAME_CONFIG.MAX_TOASTS + 1), toast]
}

function makeLocalToast(message: string, type: Toast['type']): Toast {
  return {
    id: generateId(),
    message,
    type,
    timestamp: Date.now(),
  }
}

function applySnapshot(snapshot: MultiplayerSnapshot) {
  return {
    players: sortPlayers(snapshot.players),
    leaderboard: snapshot.leaderboard,
    headlines: snapshot.headlines,
    tick: snapshot.tick,
    roomPhase: snapshot.phase,
    worldSnapshotMeta: snapshot.worldSnapshotMeta,
    season: snapshot.season,
    openMarkets: snapshot.openMarkets,
    resolvedMarkets: snapshot.resolvedMarkets,
    sentimentByLab: snapshot.sentimentByLab,
    humanLeaderboard: snapshot.humanLeaderboard,
    aiSentiment: snapshot.aiSentiment,
  }
}

function applyUserState(userState: UserState) {
  return {
    userProfile: userState.userProfile,
    userDraft: userState.userDraft,
    userPredictions: userState.userPredictions,
    userSentiment: userState.userSentiment,
    userRank: userState.userRank,
    userBankroll: userState.userBankroll,
  }
}

function sendClientMessage(message: ClientMessage) {
  if (!socket) return
  socket.send(JSON.stringify(message))
}

const initialSpectatorId = loadSpectatorId()

export const useGameStore = create<GameStore>((set) => ({
  connectionStatus: 'idle',
  partyHost: getPartyHost(),
  spectatorId: initialSpectatorId,
  players: [],
  leaderboard: [],
  headlines: [],
  toasts: [],
  tick: 0,
  roomPhase: 'waiting',
  worldSnapshotMeta: null,
  season: null,
  openMarkets: [],
  resolvedMarkets: [],
  sentimentByLab: {},
  humanLeaderboard: [],
  aiSentiment: null,
  userProfile: null,
  userDraft: null,
  userPredictions: [],
  userSentiment: {},
  userRank: null,
  userBankroll: null,
  error: null,

  connectPlayer: () => {
    if (socket) {
      socket.close()
      socket = null
    }

    set({
      connectionStatus: 'connecting',
      error: null,
    })

    const nextSocket = new PartySocket({
      host: getPartyHost(),
      room: PARTYKIT_ROOM_ID,
      query: async () => ({
        playerId: initialSpectatorId,
        name: 'Spectator',
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
        set(() => applyUserState(payload.userState))
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
        error: 'Trying to reconnect to the live room.',
      })
    })

    nextSocket.addEventListener('error', () => {
      if (socket !== nextSocket) return
      set({
        connectionStatus: 'error',
        error: 'Could not reach the live room.',
      })
    })
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  draftLab: (labId) => sendClientMessage({ type: 'draft-lab', labId }),
  swapLab: (labId) => sendClientMessage({ type: 'swap-lab', labId }),
  predict: (marketId, optionId, wager = DEFAULT_WAGER) =>
    sendClientMessage({ type: 'predict', marketId, optionId, wager }),
  setSentiment: (labId, value) =>
    sendClientMessage({ type: 'set-sentiment', labId, value }),
  setDisplayName: (name) =>
    sendClientMessage({ type: 'set-display-name', name }),
}))
