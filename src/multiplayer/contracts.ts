import type { SentimentBucket } from '../data/aiSentiment'
import type {
  AIProduct,
  CompanyStrategy,
  ExecutiveActionId,
  LiveContract,
  PlayerStatus,
  PlayerEffects,
  Resources,
  ServerFarm,
  Toast,
  WorldEventBriefing,
  WorldSnapshotMeta,
  SourceBackedStats,
} from '../types'
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

export const PARTYKIT_ROOM_ID = 'main-world'
export const LEADERBOARD_STORAGE_KEY = 'leaderboard'
export const WORLD_SNAPSHOT_STORAGE_KEY = 'world-snapshot'
export const SENTIMENT_SNAPSHOT_STORAGE_KEY = 'sentiment-snapshot:v1'
export const BANKROLLS_STORAGE_KEY = 'bankrolls:v1'

export interface CountrySentiment {
  tone: number
  bucket: SentimentBucket
  sampleSize: number
}

export interface SentimentBroadcast {
  byCountry: Record<string, CountrySentiment>
  fetchedAt: number
  hitCount: number
  trackedCount: number
}

export interface MultiplayerPlayer {
  id: string
  name: string
  color: string
  tagline: string
  isBot: boolean
  strategy: CompanyStrategy
  resources: Resources
  buildings: ServerFarm[]
  products: AIProduct[]
  status: PlayerStatus
  connected: boolean
  submittedScore: boolean
  pendingBriefing: WorldEventBriefing | null
  effects: PlayerEffects
  actionCooldowns: Record<ExecutiveActionId, number>
  sourceBackedStats: SourceBackedStats
  lastUpdatedAt: number
}

export interface LeaderboardEntry {
  id: string
  name: string
  score: number
  farms: number
  launchedProducts: number
  tick: number
  won: boolean
  createdAt: number
}

export interface MultiplayerSnapshot {
  phase: 'waiting' | 'playing' | 'finished'
  tick: number
  winnerId: string | null
  resetAt: number | null
  players: MultiplayerPlayer[]
  headlines: string[]
  leaderboard: LeaderboardEntry[]
  activeContract: LiveContract | null
  worldSnapshotMeta: WorldSnapshotMeta | null
  season: Season | null
  openMarkets: PredictionMarket[]
  resolvedMarkets: PredictionMarket[]
  sentimentByLab: Record<string, LabSentimentAggregate>
  humanLeaderboard: HumanLeaderboardEntry[]
  aiSentiment: SentimentBroadcast | null
}

export interface UserState {
  userProfile: UserProfile | null
  userDraft: Draft | null
  userPredictions: UserPrediction[]
  userSentiment: Record<string, UserSentiment>
  userRank: number | null
  userBankroll: UserBankroll | null
}

export type ClientMessage =
  | { type: 'join'; playerId: string; name: string }
  | { type: 'build-farm'; cityId: string }
  | { type: 'launch-product'; productId: string }
  | { type: 'use-action'; actionId: ExecutiveActionId; targetId?: string }
  | { type: 'acknowledge-briefing'; briefingId: string }
  | { type: 'submit-score'; name: string }
  | { type: 'reset-match' }
  | { type: 'set-display-name'; name: string }
  | { type: 'draft-lab'; labId: string }
  | { type: 'swap-lab'; labId: string }
  | { type: 'predict'; marketId: string; optionId: string; wager: number }
  | { type: 'set-sentiment'; labId: string; value: SentimentValue }

export type ServerMessage =
  | { type: 'snapshot'; snapshot: MultiplayerSnapshot }
  | { type: 'toast'; toast: Toast }
  | { type: 'user-state'; userState: UserState }
