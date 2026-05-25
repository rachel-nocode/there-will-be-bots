import type { Toast } from '../types'

export const PARTYKIT_ROOM_ID = 'city-0'

/** @deprecated Use matchmaking.assignGameRoom — kept as dev fallback only */
export const LEGACY_ROOM_ID = 'main-world'

export type HeistPhase =
  | 'lobby'
  | 'briefing'
  | 'collect'
  | 'rampage'
  | 'extract'
  | 'tour-end'

export interface HeistPlayer {
  id: string
  name: string
  color: string
  lat: number
  lng: number
  targetLat: number | null
  targetLng: number | null
  carryingData: number
  bankedData: number
  roundBanked: number
  connected: boolean
  stunnedUntil: number
  isBot: boolean
  escaped: boolean
}

export interface DataOrb {
  id: string
  lat: number
  lng: number
  kind: 'clean' | 'trap'
}

export interface Godzilla {
  id: string
  name: string
  lat: number
  lng: number
  targetLat: number
  targetLng: number
}

export interface EscapeZone {
  id: string
  label: string
  lat: number
  lng: number
}

export interface HeistSnapshot {
  phase: HeistPhase
  tick: number
  phaseEndsAt: number | null
  lobbyCountdownAt: number | null
  tourRound: number
  tourCities: string[]
  activeCityId: string | null
  players: HeistPlayer[]
  orbs: DataOrb[]
  godzillas: Godzilla[]
  escapeZones: EscapeZone[]
  winnerId: string | null
  humanCount: number
}

export interface UserState {
  playerId: string
}

export type ClientMessage =
  | { type: 'join'; playerId: string; name: string }
  | { type: 'move'; lat: number; lng: number }
  | { type: 'set-display-name'; name: string }

export type ServerMessage =
  | { type: 'snapshot'; snapshot: HeistSnapshot }
  | { type: 'toast'; toast: Toast }
  | { type: 'user-state'; userState: UserState }
