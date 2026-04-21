import type {
  MarketKind,
  MarketOption,
  MarketPool,
  PredictionMarket,
  UserPrediction,
} from '../types/game'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface LabLike {
  id: string
  name: string
}

export function emptyPool(): MarketPool {
  return { totalStake: 0, stakeByOption: {} }
}

export function shouldLock(market: PredictionMarket, now: number): boolean {
  return market.status === 'open' && now >= market.closesAt
}

export function shouldResolve(market: PredictionMarket, now: number): boolean {
  return (
    (market.status === 'open' || market.status === 'locked') &&
    now >= market.resolvesAt
  )
}

export function createNextSyncLeaderMarket(params: {
  seasonId: string
  labs: LabLike[]
  opensAt: number
  nextSyncAt: number
  idSeed: string
}): PredictionMarket {
  const { seasonId, labs, opensAt, nextSyncAt, idSeed } = params
  const options: MarketOption[] = labs.map((lab) => ({
    id: lab.id,
    label: lab.name,
    labId: lab.id,
  }))
  return {
    id: `market-next-sync-leader-${idSeed}`,
    seasonId,
    kind: 'next-sync-leader',
    question: 'Who leads at the next sync?',
    options,
    opensAt,
    closesAt: Math.max(opensAt, nextSyncAt - 60 * MINUTE_MS),
    resolvesAt: nextSyncAt,
    resolvedOptionId: null,
    status: 'open',
    createdAt: opensAt,
    pool: emptyPool(),
  }
}

// Season-long milestone market: which bot-lab reaches the milestone
// threshold first. Resolves early the moment a lab crosses; otherwise
// resolves at season soft-end with the top score at that moment.
export function createFirstToMilestoneMarket(params: {
  seasonId: string
  labs: LabLike[]
  opensAt: number
  seasonSoftEndsAt: number
  idSeed: string
}): PredictionMarket {
  const { seasonId, labs, opensAt, seasonSoftEndsAt, idSeed } = params
  const options: MarketOption[] = labs.map((lab) => ({
    id: lab.id,
    label: lab.name,
    labId: lab.id,
  }))
  // Lock predictions 24h before soft-end so late entries can't game it;
  // resolves at soft-end if no one crosses first.
  const lockAt = Math.max(opensAt, seasonSoftEndsAt - DAY_MS)
  return {
    id: `market-first-to-milestone-${idSeed}`,
    seasonId,
    kind: 'first-to-milestone',
    question: 'Which lab reaches the milestone first?',
    options,
    opensAt,
    closesAt: lockAt,
    resolvesAt: seasonSoftEndsAt,
    resolvedOptionId: null,
    status: 'open',
    createdAt: opensAt,
    pool: emptyPool(),
  }
}

export function resolveMarket(params: {
  market: PredictionMarket
  scoresByLab: Record<string, number>
  leaderLabIdNow: string | null
  leaderLabIdAtOpen: string | null
  firstLabToThreshold: string | null
  firstLaunchingLabSinceOpen: string | null
}): string | null {
  const {
    market,
    leaderLabIdNow,
    leaderLabIdAtOpen,
    firstLabToThreshold,
    firstLaunchingLabSinceOpen,
  } = params

  switch (market.kind) {
    case 'next-sync-leader':
      return leaderLabIdNow
    case 'lead-change-by-sync': {
      if (!leaderLabIdAtOpen || !leaderLabIdNow) return null
      const yes = market.options.find((o) => o.id === 'yes')
      const no = market.options.find((o) => o.id === 'no')
      return leaderLabIdNow !== leaderLabIdAtOpen
        ? yes?.id ?? null
        : no?.id ?? null
    }
    case 'first-to-threshold':
      return firstLabToThreshold
    case 'first-to-milestone':
      // Prefer an explicit crossing; fall back to the current leader so the
      // market always resolves to someone at soft-end.
      return firstLabToThreshold ?? leaderLabIdNow
    case 'next-launch-by-lab':
      return firstLaunchingLabSinceOpen
    default:
      return null
  }
}

export function kindSupportsAutoSeed(kind: MarketKind): boolean {
  return kind === 'next-sync-leader'
}

// Apply a wager into a market pool, returning a new pool with the totals
// bumped. Does not mutate the input.
export function addToPool(
  pool: MarketPool,
  optionId: string,
  amount: number,
): MarketPool {
  const prev = pool.stakeByOption[optionId] ?? 0
  return {
    totalStake: pool.totalStake + amount,
    stakeByOption: { ...pool.stakeByOption, [optionId]: prev + amount },
  }
}

export function removeFromPool(
  pool: MarketPool,
  optionId: string,
  amount: number,
): MarketPool {
  const prev = pool.stakeByOption[optionId] ?? 0
  const next = Math.max(0, prev - amount)
  return {
    totalStake: Math.max(0, pool.totalStake - amount),
    stakeByOption: { ...pool.stakeByOption, [optionId]: next },
  }
}

// Parimutuel payout:
// - Losers lose their stake.
// - Winners split the total pool in proportion to their stake.
// - If no one picked the winning option, everyone is refunded.
// - If the market resolved with a null winner, everyone is refunded.
// Returns the payout a single prediction receives (0 = lose everything,
// equal to wager = refund, > wager = net win).
export function computePayout(
  market: PredictionMarket,
  prediction: UserPrediction,
): number {
  if (market.status !== 'resolved') return 0
  const winningOptionId = market.resolvedOptionId
  if (winningOptionId === null) {
    // Void — refund stake.
    return prediction.wager
  }
  const winningPool = market.pool.stakeByOption[winningOptionId] ?? 0
  if (winningPool <= 0) {
    // No one picked the winner — refund everyone.
    return prediction.wager
  }
  if (prediction.optionId !== winningOptionId) {
    return 0
  }
  const share = prediction.wager / winningPool
  return Math.round(share * market.pool.totalStake)
}
