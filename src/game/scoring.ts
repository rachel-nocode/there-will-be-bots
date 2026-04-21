import type {
  Draft,
  HumanLeaderboardEntry,
  LabSentimentAggregate,
  PredictionMarket,
  UserBankroll,
  UserPrediction,
  UserProfile,
  UserSentiment,
} from '../types/game'
import { STARTING_BANKROLL } from '../types/game'

const PREDICTION_CORRECT_POINTS = 10

export function computeDraftPoints(
  draft: Draft | null,
  currentLabScore: number | null,
): number {
  if (!draft) return 0
  if (currentLabScore === null || Number.isNaN(currentLabScore)) {
    return draft.cumulativeDelta
  }
  return draft.cumulativeDelta + (currentLabScore - draft.anchorScore)
}

export function computePredictionPoints(predictions: UserPrediction[]): number {
  return predictions.reduce((sum, p) => sum + (p.awardedPoints ?? 0), 0)
}

export function scorePrediction(
  prediction: UserPrediction,
  market: PredictionMarket,
): number {
  if (market.status !== 'resolved') return 0
  if (market.resolvedOptionId === null) return 0
  return prediction.optionId === market.resolvedOptionId
    ? PREDICTION_CORRECT_POINTS
    : 0
}

export function computeSentimentAggregate(
  labId: string,
  sentiments: UserSentiment[],
  now: number,
): LabSentimentAggregate {
  const forLab = sentiments.filter((s) => s.labId === labId)
  if (forLab.length === 0) {
    return { labId, mean: 0, count: 0, updatedAt: now }
  }
  const sum = forLab.reduce((acc, s) => acc + s.value, 0)
  return {
    labId,
    mean: sum / forLab.length,
    count: forLab.length,
    updatedAt: now,
  }
}

export function buildHumanLeaderboard(params: {
  profiles: Map<string, UserProfile>
  drafts: Map<string, Draft>
  predictionsByUser: Map<string, UserPrediction[]>
  scoresByLab: Record<string, number>
  bankrolls?: Map<string, UserBankroll>
  limit?: number
}): HumanLeaderboardEntry[] {
  const { profiles, drafts, predictionsByUser, scoresByLab, bankrolls } = params
  const entries: HumanLeaderboardEntry[] = []

  for (const [userId, profile] of profiles) {
    const draft = drafts.get(userId) ?? null
    const draftLabId = draft?.labId ?? null
    const draftPoints = Math.round(
      computeDraftPoints(draft, draftLabId ? scoresByLab[draftLabId] ?? null : null) *
        10,
    ) / 10
    const predictionPoints = computePredictionPoints(
      predictionsByUser.get(userId) ?? [],
    )
    const bankroll = bankrolls?.get(userId)?.balance ?? STARTING_BANKROLL
    entries.push({
      userId,
      displayName: profile.displayName,
      draftPoints,
      predictionPoints,
      totalPoints: draftPoints + predictionPoints,
      draftLabId,
      bankroll,
    })
  }

  entries.sort((a, b) => b.totalPoints - a.totalPoints)
  return params.limit ? entries.slice(0, params.limit) : entries
}
