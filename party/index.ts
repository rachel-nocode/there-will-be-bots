import type * as Party from 'partykit/server'
import { EXECUTIVE_ACTIONS } from '../src/data/actions'
import { CITIES } from '../src/data/cities'
import { COMPANY_BOTS } from '../src/data/companies'
import { GAME_CONFIG } from '../src/data/config'
import {
  BANKROLLS_STORAGE_KEY,
  LEADERBOARD_STORAGE_KEY,
  SENTIMENT_SNAPSHOT_STORAGE_KEY,
  WORLD_SNAPSHOT_STORAGE_KEY,
  type ClientMessage,
  type LeaderboardEntry,
  type MultiplayerPlayer,
  type MultiplayerSnapshot,
  type SentimentBroadcast,
  type ServerMessage,
  type UserState,
} from '../src/multiplayer/contracts'
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
} from '../src/types/game'
import {
  MIN_WAGER,
  STARTING_BANKROLL,
} from '../src/types/game'
import {
  buildHumanLeaderboard,
  scorePrediction,
} from '../src/game/scoring'
import {
  addToPool,
  computePayout,
  createFirstToMilestoneMarket,
  createNextSyncLeaderMarket,
  emptyPool,
  removeFromPool,
  resolveMarket,
  shouldLock,
  shouldResolve,
} from '../src/game/markets'
import {
  createNextSeason,
  DEFAULT_MILESTONE_THRESHOLD,
  shouldEndSeason,
} from '../src/game/seasons'
import type {
  AIProduct,
  CitySpecialty,
  ExecutiveActionId,
  LiveContract,
  LiveContractKind,
  Resources,
  ServerFarm,
  Toast,
  WorldContractTemplate,
  WorldEvent,
  WorldSnapshot,
} from '../src/types'
import { generateId } from '../src/utils/formatters'
import { computeTrend } from '../src/utils/agiScore'
import { buildWorldSnapshot } from '../src/world/sync'
import { buildSentimentSnapshot } from '../src/world/sentimentSync'

type ConnectionState = {
  playerId: string
}

const PROFILES_STORAGE_KEY = 'profiles:v1'
const SEASONS_STORAGE_KEY = 'seasons:v1'
const DRAFTS_STORAGE_KEY = 'drafts:v1'
const MARKETS_STORAGE_KEY = 'markets:v1'
const PREDICTIONS_STORAGE_KEY = 'predictions:v1'
const SENTIMENT_STORAGE_KEY = 'sentiment:v1'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const ADJECTIVES = [
  'Quiet', 'Bold', 'Neon', 'Stealth', 'Frost', 'Sharp', 'Flash',
  'Calm', 'Lucky', 'Curious', 'Reckless', 'Patient', 'Wired', 'Sly',
]
const NOUNS = [
  'Analyst', 'Scout', 'Trader', 'Watcher', 'Forecaster', 'Oracle',
  'Reader', 'Broker', 'Pilot', 'Cipher', 'Hacker', 'Strategist',
]

function generateDisplayName(seed: string) {
  let hash = 0
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  const adj = ADJECTIVES[hash % ADJECTIVES.length]
  const noun = NOUNS[(hash >>> 5) % NOUNS.length]
  const suffix = (hash & 0xffff).toString(16).padStart(4, '0').toUpperCase()
  return `${adj} ${noun} ${suffix}`
}

type ResourceContext = 'briefing' | 'contract' | 'hostile' | 'launch' | 'milestone'

const PLAYER_COLORS = [
  '#00ffff',
  '#ff44aa',
  '#66ff66',
  '#ffaa00',
  '#7c83ff',
  '#ff6b6b',
  '#4dd0e1',
  '#ffd166',
]

const ACTION_LOOKUP = Object.fromEntries(
  EXECUTIVE_ACTIONS.map((action) => [action.id, action]),
) as Record<ExecutiveActionId, (typeof EXECUTIVE_ACTIONS)[number]>

const DEFAULT_HEADLINES = [
  'LIVE: The boardroom war now mirrors public AI race signals every 12 hours.',
  'MARKETS: Artificial Analysis, Arena, and official company posts are shaping the room.',
  'ALERT: Humans can drop in and play against the same labs showing up in the live snapshot.',
]

export default class BotWorldServer implements Party.Server {
  readonly options = {
    hibernate: false,
  }

  private players = new Map<string, MultiplayerPlayer>()
  private leaderboard: LeaderboardEntry[] = []
  private phase: MultiplayerSnapshot['phase'] = 'waiting'
  private tick = 0
  private winnerId: string | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private runtimeHeadlines: string[] = []
  private room: Party.Room
  private activeContract: LiveContract | null = null
  private contractComputeBaselines = new Map<string, number>()
  private nextContractAtTick = 1
  private resetAt: number | null = null
  private botDecisionAt = new Map<string, number>()
  private worldSnapshot: WorldSnapshot | null = null
  private worldContractTemplates: WorldContractTemplate[] = []
  private syncPromise: Promise<void> | null = null
  private aiSentiment: SentimentBroadcast | null = null
  private sentimentSyncPromise: Promise<void> | null = null
  private deliveredEventIds = new Set<string>()
  private profiles = new Map<string, UserProfile>()
  private seasons: Season[] = []
  private drafts = new Map<string, Map<string, Draft>>()
  private markets = new Map<string, PredictionMarket[]>()
  private predictions = new Map<string, Map<string, UserPrediction[]>>()
  private sentiment = new Map<string, Map<string, UserSentiment>>()
  private sentimentAggregates = new Map<string, LabSentimentAggregate>()
  private bankrolls = new Map<string, UserBankroll>()
  // Tracks the first bot lab to cross the season milestone threshold so
  // long-running markets (first-to-milestone) can resolve deterministically.
  private firstLabToMilestone = new Map<string, string>()

  constructor(room: Party.Room) {
    this.room = room
    this.startTicker()
  }

  async onStart() {
    const storedLeaderboard =
      await this.room.storage.get<LeaderboardEntry[]>(LEADERBOARD_STORAGE_KEY)
    const storedWorldSnapshot =
      await this.room.storage.get<WorldSnapshot>(WORLD_SNAPSHOT_STORAGE_KEY)
    const storedAiSentiment =
      await this.room.storage.get<SentimentBroadcast>(SENTIMENT_SNAPSHOT_STORAGE_KEY)

    this.leaderboard = storedLeaderboard ?? []
    this.worldSnapshot = storedWorldSnapshot ?? null
    this.aiSentiment = storedAiSentiment ?? null
    await this.loadGameLayers()
    await this.ensureWorldSnapshotFresh('startup')
    void this.ensureAiSentimentFresh('startup')
    this.ensureCompanyBots()
    this.ensureActiveSeason()
    this.seedOpenMarketsIfNeeded()

    if (this.players.size > 0) {
      this.phase = 'playing'
      this.nextContractAtTick = 1
      this.addHeadline('The company bots are already in the room and moving off the latest public signals.')
    }
  }

  async onConnect(connection: Party.Connection<ConnectionState>, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url)
    const playerId = this.sanitizeId(url.searchParams.get('playerId')) ?? connection.id
    const requestedName = this.sanitizeName(url.searchParams.get('name'))

    connection.setState({ playerId })

    await this.ensureWorldSnapshotFresh('connect')
    void this.ensureAiSentimentFresh('connect')
    this.ensureCompanyBots()

    const existingPlayer = this.players.get(playerId)
    const hadHumanConnections = this.hasHumanConnections()

    if (!existingPlayer && !hadHumanConnections && (this.phase === 'finished' || this.tick > 8)) {
      this.resetMatch(true)
    }

    const refreshedPlayer = this.players.get(playerId)
    const player = refreshedPlayer ?? this.createFreshPlayer(playerId, requestedName)

    player.connected = true
    player.name = requestedName || player.name

    if (!refreshedPlayer) {
      this.players.set(playerId, player)
      this.addHeadline(`${player.name} dropped into the boardroom war.`)
    } else {
      this.addHeadline(`${player.name} reconnected and resumed the chaos.`)
    }

    if (this.activeContract) {
      this.activeContract.progressByPlayer[player.id] ??= 0
      if (this.activeContract.kind === 'compute') {
        this.contractComputeBaselines.set(player.id, player.resources.computePower)
      }
    }

    if (this.phase === 'waiting') {
      this.phase = 'playing'
    }

    if (!this.activeContract) {
      this.nextContractAtTick = Math.min(this.nextContractAtTick, this.tick + 1)
    }

    this.queueBriefingsForHumans()
    await this.ensureProfile(playerId)
    this.sendSnapshot(connection)
    this.sendUserState(connection, playerId)
    this.sendToast(
      connection,
      `Connected as ${player.name}. The room is using the latest AI race snapshot.`,
      'success',
    )
    this.broadcastSnapshot()
  }

  async onMessage(message: string | ArrayBuffer | ArrayBufferView, sender: Party.Connection<ConnectionState>) {
    if (typeof message !== 'string') {
      return
    }

    let parsed: ClientMessage
    try {
      parsed = JSON.parse(message) as ClientMessage
    } catch {
      this.sendToast(sender, 'Bad message received by the room.', 'warning')
      return
    }

    const playerId = sender.state?.playerId
    if (!playerId) {
      this.sendToast(sender, 'You are not attached to a player yet.', 'warning')
      return
    }

    const player = this.players.get(playerId)
    if (!player) {
      this.sendToast(sender, 'Player was not found in the room.', 'warning')
      return
    }

    switch (parsed.type) {
      case 'join':
        player.name = this.sanitizeName(parsed.name) || player.name
        player.connected = true
        this.broadcastSnapshot()
        break
      case 'build-farm':
        this.handleBuildFarm(player, parsed.cityId, sender)
        break
      case 'launch-product':
        this.handleLaunchProduct(player, parsed.productId, sender)
        break
      case 'use-action':
        this.handleUseAction(player, parsed.actionId, parsed.targetId, sender)
        break
      case 'acknowledge-briefing':
        this.handleAcknowledgeBriefingAndBroadcast(player, parsed.briefingId, sender)
        break
      case 'submit-score':
        await this.handleSubmitScore(player, parsed.name, sender)
        break
      case 'reset-match':
        this.resetMatch(false)
        this.broadcastSnapshot()
        break
      case 'set-display-name':
        await this.handleSetDisplayName(playerId, parsed.name, sender)
        break
      case 'draft-lab':
        await this.handleDraftLab(playerId, parsed.labId, sender)
        break
      case 'swap-lab':
        await this.handleSwapLab(playerId, parsed.labId, sender)
        break
      case 'predict':
        await this.handlePredict(
          playerId,
          parsed.marketId,
          parsed.optionId,
          parsed.wager,
          sender,
        )
        break
      case 'set-sentiment':
        await this.handleSetSentiment(playerId, parsed.labId, parsed.value, sender)
        break
      default:
        this.sendToast(sender, 'Unknown action.', 'warning')
    }
  }

  onClose(connection: Party.Connection<ConnectionState>) {
    const playerId = connection.state?.playerId
    if (!playerId) {
      return
    }

    const player = this.players.get(playerId)
    if (!player || player.isBot) {
      return
    }

    player.connected = this.isPlayerStillConnected(playerId, connection.id)
    if (!player.connected) {
      this.addHeadline(`${player.name} disconnected. The bots smell weakness.`)
      this.broadcastSnapshot()
    }
  }

  private startTicker() {
    if (this.ticker) {
      return
    }

    this.ticker = setInterval(() => {
      this.advanceTick()
    }, GAME_CONFIG.TICK_INTERVAL_MS)
  }

  private advanceTick() {
    void this.ensureWorldSnapshotFresh('tick')
    void this.ensureAiSentimentFresh('tick')

    if (this.phase === 'finished') {
      if (this.resetAt && Date.now() >= this.resetAt) {
        this.resetMatch(false)
        this.broadcastSnapshot()
      }
      return
    }

    if (this.phase !== 'playing') {
      return
    }

    const activePlayers = [...this.players.values()].filter((player) => player.status === 'playing')
    if (activePlayers.length === 0) {
      return
    }

    this.tick += 1

    if (!this.activeContract && this.tick >= this.nextContractAtTick) {
      this.startContract()
    }

    for (const player of activePlayers) {
      this.applyPassiveIncome(player)
      this.refreshUnlockedProducts(player)
    }

    for (const bot of activePlayers.filter((player) => player.isBot)) {
      this.driveBot(bot, activePlayers)
    }

    for (const player of activePlayers) {
      this.handlePendingBriefingTimeout(player)
    }

    this.updateContractProgress(activePlayers)

    const winner = activePlayers.find(
      (player) => player.resources.computePower >= GAME_CONFIG.SINGULARITY_THRESHOLD,
    )

    for (const player of activePlayers) {
      this.tickDownStatuses(player)
    }

    if (winner) {
      this.finishMatch(winner.id)
    }

    void this.runGameLayerTickDuties()

    this.broadcastSnapshot()
  }

  private async runGameLayerTickDuties() {
    const now = Date.now()
    const season = this.getActiveSeason()
    if (!season) return

    let mutated = false

    const marketList = this.markets.get(season.id) ?? []
    for (const market of marketList) {
      if (shouldLock(market, now) && market.status === 'open') {
        market.status = 'locked'
        mutated = true
      }
    }

    const scoresByLab = this.getScoresByLab()
    const leaderLabIdNow = this.getLeaderLabId(scoresByLab)

    // Track the first bot lab to cross the season's milestone threshold.
    // Once set it's sticky for the rest of the season so milestone markets
    // resolve to the *first* crosser even if the leader changes later.
    const threshold = season.milestoneThreshold
    if (!this.firstLabToMilestone.has(season.id)) {
      for (const [labId, score] of Object.entries(scoresByLab)) {
        if (score >= threshold) {
          this.firstLabToMilestone.set(season.id, labId)
          this.addHeadline(
            `${this.labNameById(labId)} crossed the season milestone first.`,
          )
          mutated = true
          break
        }
      }
    }
    const firstLabToThreshold =
      this.firstLabToMilestone.get(season.id) ?? null

    for (const market of marketList) {
      if (!shouldResolve(market, now) && market.kind !== 'first-to-milestone')
        continue
      if (market.status === 'resolved' || market.status === 'void') continue
      // Milestone market can resolve early the moment a lab crosses.
      if (market.kind === 'first-to-milestone') {
        const crossed = firstLabToThreshold
        const timeReached = now >= market.resolvesAt
        if (!crossed && !timeReached) continue
      }
      const winningOption = resolveMarket({
        market,
        scoresByLab,
        leaderLabIdNow,
        leaderLabIdAtOpen: null,
        firstLabToThreshold,
        firstLaunchingLabSinceOpen: null,
      })
      market.resolvedOptionId = winningOption
      market.status = 'resolved'
      this.awardPredictionPoints(season.id, market)
      mutated = true
    }

    const endCheck = shouldEndSeason({ season, now, scoresByLab })
    if (endCheck.ended) {
      season.status = 'ended'
      season.winningLabId = endCheck.winningLabId
      const nextNumber = Math.max(
        season.number,
        ...this.seasons.map((s) => s.number),
      )
      const nextSeason = createNextSeason({
        previousNumber: nextNumber,
        now,
      })
      this.seasons = [...this.seasons.filter((s) => s.id !== season.id), season, nextSeason]
      mutated = true
      this.addHeadline(
        `${season.chapterTitle} ended${endCheck.winningLabId ? ` — ${this.labNameById(endCheck.winningLabId)} crossed the line.` : '.'}`,
      )
    }

    if (mutated) {
      await this.persistGameLayers()
      this.broadcastUserStateToAll()
    }
  }

  private awardPredictionPoints(seasonId: string, market: PredictionMarket) {
    const bySeason = this.predictions.get(seasonId)
    if (!bySeason) return
    for (const [userId, list] of bySeason) {
      let changed = false
      const next = list.map((p) => {
        if (p.marketId !== market.id) return p
        if (p.awardedPoints !== null && p.payout !== null) return p
        changed = true
        const awardedPoints =
          p.awardedPoints ?? scorePrediction(p, market)
        // Parimutuel payout: credit the user's bankroll for the share of the
        // pool they won. Losers get nothing (their stake was already deducted
        // when the wager was placed).
        const payout =
          p.payout ?? (p.wager > 0 ? computePayout(market, p) : 0)
        if (payout > 0) {
          const isWinner = market.resolvedOptionId === p.optionId
          this.adjustBankroll(
            userId,
            payout,
            isWinner ? 'payout' : 'refund',
          )
          if (isWinner && payout > p.wager) {
            const won = payout - p.wager
            this.addHeadline(
              `${this.profileName(userId)} won $${won} on "${market.question}".`,
            )
          }
        }
        return { ...p, awardedPoints, payout }
      })
      if (changed) {
        bySeason.set(userId, next)
      }
    }
  }

  private profileName(userId: string): string {
    return this.profiles.get(userId)?.displayName ?? 'A player'
  }

  private getScoresByLab(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const player of this.players.values()) {
      if (!player.isBot) continue
      out[player.id] = player.sourceBackedStats.agiScore ?? 0
    }
    return out
  }

  private getLeaderLabId(scoresByLab: Record<string, number>): string | null {
    let topId: string | null = null
    let topScore = -Infinity
    for (const [labId, score] of Object.entries(scoresByLab)) {
      if (score > topScore) {
        topScore = score
        topId = labId
      }
    }
    return topId
  }

  private labNameById(labId: string): string {
    return this.players.get(labId)?.name ?? labId
  }

  private handleBuildFarm(
    player: MultiplayerPlayer,
    cityId: string,
    sender: Party.Connection<ConnectionState> | null,
  ) {
    if (this.phase !== 'playing' || player.status !== 'playing') {
      this.sendToast(sender, 'The match is not accepting new moves right now.', 'warning')
      return
    }

    const city = CITIES.find((candidate) => candidate.id === cityId)
    if (!city) {
      this.sendToast(sender, 'That city is not available.', 'warning')
      return
    }

    if (player.buildings.some((building) => building.cityId === cityId)) {
      this.sendToast(sender, `You already own a farm in ${city.name}.`, 'warning')
      return
    }

    const farmCost = this.getFarmCost(player)
    if (player.resources.vcFunding < farmCost) {
      this.sendToast(sender, 'Not enough VC funding to build there yet.', 'warning')
      return
    }

    const offsetIndex = this.countFarmsInCity(cityId)
    const offsetLat = city.lat + ((offsetIndex % 3) - 1) * 0.4
    const offsetLng = city.lng + (Math.floor(offsetIndex / 3) - 1) * 0.4
    const scaleBoost = this.getSpecialtyCount(player, 'scale-yard') * 2
    const computePerTick = Math.round(
      GAME_CONFIG.BASE_COMPUTE_PER_TICK * city.computeBonus + scaleBoost + (city.specialty === 'scale-yard' ? 2 : 0),
    )

    const farm: ServerFarm = {
      id: generateId(),
      cityId,
      lat: offsetLat,
      lng: offsetLng,
      level: 1,
      computePerTick,
      ownerId: player.id,
      ownerName: player.name,
      ownerColor: player.color,
    }

    player.buildings.push(farm)
    player.resources = this.applyResourceDelta(player.resources, {
      vcFunding: -farmCost,
      computePower: city.specialty === 'scale-yard' ? 120 : 0,
    })

    this.refreshUnlockedProducts(player)
    this.incrementContractProgress(player.id, 'build', 1)
    this.sendToast(sender, `Server farm built in ${city.name}.`, 'success')
    this.addHeadline(`${player.name} lit up a new farm in ${city.name} (${city.specialtyName}).`)
    this.broadcastSnapshot()
  }

  private handleLaunchProduct(
    player: MultiplayerPlayer,
    productId: string,
    sender: Party.Connection<ConnectionState> | null,
  ) {
    if (this.phase !== 'playing' || player.status !== 'playing') {
      this.sendToast(sender, 'The match is not accepting product launches right now.', 'warning')
      return
    }

    const product = player.products.find((candidate) => candidate.id === productId)
    if (!product || !product.unlocked || product.launched) {
      this.sendToast(sender, 'That product is not ready to launch.', 'warning')
      return
    }

    const launchCost = this.getProductLaunchCost(player, product)
    if (player.resources.computePower < launchCost) {
      this.sendToast(sender, 'You need more compute power before launch.', 'warning')
      return
    }

    product.launched = true
    player.resources = this.applyResourceDelta(player.resources, {
      computePower: -launchCost,
    })
    player.resources = this.applyAdjustedDelta(player, player.resources, {
      publicOpinion: product.opinionEffect,
    }, 'launch')

    this.refreshUnlockedProducts(player)
    this.incrementContractProgress(player.id, 'launch', 1)
    this.sendToast(sender, `Launched "${product.name}".`, 'success')
    this.addHeadline(`${player.name} launched "${product.name}". The market pretended to understand it.`)
    this.broadcastSnapshot()
  }

  private handleUseAction(
    player: MultiplayerPlayer,
    actionId: ExecutiveActionId,
    targetId: string | undefined,
    sender: Party.Connection<ConnectionState>,
  ) {
    this.executeAction(player, actionId, targetId, sender)
    this.broadcastSnapshot()
  }

  private handleAcknowledgeBriefingAndBroadcast(
    player: MultiplayerPlayer,
    briefingId: string,
    sender: Party.Connection<ConnectionState>,
  ) {
    this.handleAcknowledgeBriefing(player, briefingId, sender)
    this.broadcastSnapshot()
  }

  private async handleSubmitScore(
    player: MultiplayerPlayer,
    requestedName: string,
    sender: Party.Connection<ConnectionState>,
  ) {
    if (this.phase !== 'finished') {
      this.sendToast(sender, 'Leaderboard entries open after the match ends.', 'warning')
      return
    }

    if (player.submittedScore) {
      this.sendToast(sender, 'You already sent this run to the leaderboard.', 'warning')
      return
    }

    player.name = this.sanitizeName(requestedName) || player.name
    player.submittedScore = true

    await this.saveLeaderboardEntry(player)
    this.sendToast(sender, 'Leaderboard entry saved.', 'success')
    this.broadcastSnapshot()
  }

  private applyPassiveIncome(player: MultiplayerPlayer) {
    const previousCompute = player.resources.computePower
    const opinionMultiplier =
      player.resources.publicOpinion < GAME_CONFIG.OPINION_PENALTY_THRESHOLD
        ? GAME_CONFIG.OPINION_PENALTY_MULTIPLIER
        : 1
    const disruptionMultiplier =
      player.effects.disruptionTicks > 0
        ? this.getSpecialtyCount(player, 'cooling-grid') > 0
          ? 0.75
          : 0.55
        : 1
    const momentumMultiplier = player.effects.momentumTicks > 0 ? 1.18 : 1

    const buildingCompute = player.buildings.reduce(
      (sum, building) => sum + building.computePerTick,
      0,
    )
    const productRevenue = player.products
      .filter((product) => product.launched)
      .reduce((sum, product) => sum + product.revenuePerTick, 0)
    const coolingBonus = this.getSpecialtyCount(player, 'cooling-grid') * 8

    const computeGain = Math.round(
      (buildingCompute + productRevenue + coolingBonus)
        * opinionMultiplier
        * disruptionMultiplier
        * momentumMultiplier,
    )

    player.resources = this.applyResourceDelta(player.resources, {
      computePower: computeGain,
    })

    const previousMilestone = Math.floor(previousCompute / GAME_CONFIG.VC_MILESTONE_INTERVAL)
    const currentMilestone = Math.floor(player.resources.computePower / GAME_CONFIG.VC_MILESTONE_INTERVAL)
    const milestonesCrossed = currentMilestone - previousMilestone

    if (milestonesCrossed > 0) {
      player.resources = this.applyAdjustedDelta(
        player,
        player.resources,
        {
          vcFunding: GAME_CONFIG.VC_MILESTONE_BONUS * milestonesCrossed,
        },
        'milestone',
      )

      this.sendToast(
        this.getPrimaryConnection(player.id),
        `VC milestone hit. Funding round closed.`,
        'success',
      )
    }
  }

  private queueWorldBriefing(player: MultiplayerPlayer, event: WorldEvent) {
    if (player.pendingBriefing) {
      return
    }

    const companies = event.companyIds
      .map((companyId) => this.worldSnapshot?.companies.find((company) => company.id === companyId)?.name)
      .filter((companyName): companyName is string => Boolean(companyName))

    player.pendingBriefing = {
      id: event.id,
      title: event.title,
      summary: event.summary,
      sourceLabel: event.sourceLabel,
      sourceUrl: event.sourceUrl,
      publishedAt: event.publishedAt,
      companyNames: companies,
      expiresAtTick: this.tick + GAME_CONFIG.BRIEFING_RESPONSE_TICKS,
    }

    this.sendToast(
      this.getPrimaryConnection(player.id),
      `Live briefing: ${event.title}.`,
      'info',
    )
  }

  private handleAcknowledgeBriefing(
    player: MultiplayerPlayer,
    briefingId: string,
    sender: Party.Connection<ConnectionState> | null,
  ) {
    if (!player.pendingBriefing || player.pendingBriefing.id !== briefingId) {
      this.sendToast(sender, 'There is no live briefing waiting for you.', 'warning')
      return
    }

    const briefingTitle = player.pendingBriefing.title
    player.pendingBriefing = null
    this.sendToast(sender, `Briefing closed: ${briefingTitle}.`, 'success')
  }

  private handlePendingBriefingTimeout(player: MultiplayerPlayer) {
    if (!player.pendingBriefing || player.pendingBriefing.expiresAtTick > this.tick) {
      return
    }

    player.pendingBriefing = null
  }

  private executeAction(
    actor: MultiplayerPlayer,
    actionId: ExecutiveActionId,
    targetId: string | undefined,
    sender: Party.Connection<ConnectionState> | null,
  ) {
    if (this.phase !== 'playing' || actor.status !== 'playing') {
      this.sendToast(sender, 'The match is not accepting executive actions right now.', 'warning')
      return
    }

    const action = ACTION_LOOKUP[actionId]
    if (!action) {
      this.sendToast(sender, 'That action does not exist.', 'warning')
      return
    }

    if (actor.actionCooldowns[actionId] > 0) {
      this.sendToast(sender, `${action.name} is still on cooldown.`, 'warning')
      return
    }

    const adjustedCost = this.getActionCost(actor, action.cost)
    if (actor.resources.vcFunding < adjustedCost) {
      this.sendToast(sender, 'You need more VC funding for that move.', 'warning')
      return
    }

    const target = action.requiresTarget
      ? this.players.get(targetId ?? '')
      : null

    if (action.requiresTarget) {
      if (!target || target.id === actor.id || target.status !== 'playing') {
        this.sendToast(sender, 'Choose a live rival for that action.', 'warning')
        return
      }
    }

    actor.resources = this.applyResourceDelta(actor.resources, {
      vcFunding: -adjustedCost,
    })
    actor.actionCooldowns[actionId] = this.getActionCooldown(actor, action.cooldown)
    this.incrementContractProgress(actor.id, 'ops', 1)

    if (action.requiresTarget && target) {
      if (target.effects.shieldTicks > 0) {
        target.effects.shieldTicks = 0
        this.sendToast(this.getPrimaryConnection(target.id), `${actor.name}'s ${action.name} bounced off your legal shield.`, 'success')
        this.sendToast(sender, `${target.name} blocked your move with a legal shield.`, 'warning')
        this.addHeadline(`${actor.name}'s ${action.name} bounced off ${target.name}'s legal shield.`)
        return
      }
    }

    switch (actionId) {
      case 'ddos':
        if (!target) {
          return
        }
        target.effects.disruptionTicks = Math.max(target.effects.disruptionTicks, 3)
        this.sendToast(this.getPrimaryConnection(target.id), `${actor.name} hit you with a DDoS blitz. Income is disrupted for 3 ticks.`, 'warning')
        this.sendToast(sender, `DDoS blitz sent toward ${target.name}.`, 'success')
        this.addHeadline(`${actor.name} launched a DDoS blitz against ${target.name}.`)
        break
      case 'smear':
        if (!target) {
          return
        }
        target.resources = this.applyAdjustedDelta(target, target.resources, {
          publicOpinion: -12,
        }, 'hostile')
        actor.resources = this.applyResourceDelta(actor.resources, {
          publicOpinion: 4,
        })
        this.sendToast(this.getPrimaryConnection(target.id), `${actor.name} kicked off a smear campaign against you.`, 'warning')
        this.sendToast(sender, `Smear campaign launched at ${target.name}.`, 'success')
        this.addHeadline(`${actor.name} dragged ${target.name} into a fresh PR disaster.`)
        break
      case 'poach':
        if (!target) {
          return
        }
        target.resources = this.applyResourceDelta(target.resources, {
          computePower: -240,
        })
        actor.resources = this.applyResourceDelta(actor.resources, {
          computePower: 240,
        })
        this.sendToast(this.getPrimaryConnection(target.id), `${actor.name} poached talent and stole some of your momentum.`, 'warning')
        this.sendToast(sender, `Talent poached from ${target.name}.`, 'success')
        this.addHeadline(`${actor.name} poached talent from ${target.name}.`)
        break
      case 'shield':
        actor.effects.shieldTicks = Math.max(
          actor.effects.shieldTicks,
          4 + this.getSpecialtyCount(actor, 'ops-bunker') * 2,
        )
        this.sendToast(sender, 'Legal shield activated.', 'success')
        this.addHeadline(`${actor.name} lawyered up with a legal shield.`)
        break
    }
  }

  private driveBot(bot: MultiplayerPlayer, activePlayers: MultiplayerPlayer[]) {
    if (bot.pendingBriefing) {
      bot.pendingBriefing = null
      this.botDecisionAt.set(bot.id, this.tick + 1)
      return
    }

    const nextDecision = this.botDecisionAt.get(bot.id) ?? 0
    if (this.tick < nextDecision) {
      return
    }

    const livingOpponents = activePlayers
      .filter((player) => player.id !== bot.id && player.status === 'playing')
      .sort((left, right) => right.resources.computePower - left.resources.computePower)

    const topTarget = livingOpponents[0]
    const contract = this.activeContract
    const launchableProducts = bot.products
      .filter((product) => product.unlocked && !product.launched)
      .sort((left, right) => right.revenuePerTick - left.revenuePerTick)

    const shouldShield =
      bot.strategy === 'defensive'
      && topTarget
      && topTarget.resources.computePower > bot.resources.computePower + 600
      && bot.effects.shieldTicks === 0
      && bot.actionCooldowns.shield === 0
      && bot.resources.vcFunding >= this.getActionCost(bot, ACTION_LOOKUP.shield.cost)

    if (shouldShield) {
      this.executeAction(bot, 'shield', undefined, null)
      this.botDecisionAt.set(bot.id, this.tick + 2)
      return
    }

    if (
      contract?.kind === 'launch'
      && launchableProducts.length > 0
      && bot.resources.computePower >= this.getProductLaunchCost(bot, launchableProducts[0])
    ) {
      this.handleLaunchProduct(bot, launchableProducts[0].id, this.getPrimaryConnection(bot.id))
      this.botDecisionAt.set(bot.id, this.tick + 2)
      return
    }

    if (
      contract?.kind === 'build'
      && bot.resources.vcFunding >= this.getFarmCost(bot)
    ) {
      const contractCity = this.pickBotCity(bot, true)
      if (contractCity) {
        this.handleBuildFarm(bot, contractCity.id, this.getPrimaryConnection(bot.id))
        this.botDecisionAt.set(bot.id, this.tick + 2)
        return
      }
    }

    if (
      topTarget
      && (bot.strategy === 'aggressive' || bot.strategy === 'balanced')
    ) {
      const preferredAction = bot.strategy === 'aggressive' ? 'ddos' : 'poach'
      const action = ACTION_LOOKUP[preferredAction]
      if (
        bot.actionCooldowns[preferredAction] === 0
        && bot.resources.vcFunding >= this.getActionCost(bot, action.cost)
      ) {
        this.executeAction(bot, preferredAction, topTarget.id, null)
        this.botDecisionAt.set(bot.id, this.tick + 3)
        return
      }
    }

    const bestProduct = launchableProducts[0]
    if (
      bestProduct
      && bot.resources.computePower >= this.getProductLaunchCost(bot, bestProduct)
      && (bot.strategy === 'product' || bot.resources.computePower > 1600)
    ) {
      this.handleLaunchProduct(bot, bestProduct.id, this.getPrimaryConnection(bot.id))
      this.botDecisionAt.set(bot.id, this.tick + 2)
      return
    }

    if (bot.resources.vcFunding >= this.getFarmCost(bot)) {
      const city = this.pickBotCity(bot, false)
      if (city) {
        this.handleBuildFarm(bot, city.id, this.getPrimaryConnection(bot.id))
        this.botDecisionAt.set(bot.id, this.tick + 2)
        return
      }
    }

    if (
      topTarget
      && bot.actionCooldowns.smear === 0
      && bot.resources.vcFunding >= this.getActionCost(bot, ACTION_LOOKUP.smear.cost)
    ) {
      this.executeAction(bot, 'smear', topTarget.id, null)
      this.botDecisionAt.set(bot.id, this.tick + 3)
      return
    }

    this.botDecisionAt.set(bot.id, this.tick + 2 + Math.floor(Math.random() * 2))
  }

  private pickBotCity(bot: MultiplayerPlayer, urgent: boolean) {
    const ownedCityIds = new Set(bot.buildings.map((building) => building.cityId))
    const cities = CITIES
      .filter((city) => !ownedCityIds.has(city.id))
      .sort((left, right) => this.scoreBotCity(bot, right, urgent) - this.scoreBotCity(bot, left, urgent))

    return cities[0] ?? null
  }

  private scoreBotCity(bot: MultiplayerPlayer, city: (typeof CITIES)[number], urgent: boolean) {
    let score = city.computeBonus * 100

    if (city.specialty === 'launch-lab' && bot.strategy === 'product') score += 55
    if (city.specialty === 'capital-hub' && bot.strategy === 'balanced') score += 40
    if (city.specialty === 'ops-bunker' && bot.strategy === 'aggressive') score += 50
    if (city.specialty === 'cooling-grid' && bot.strategy === 'defensive') score += 45
    if (city.specialty === 'scale-yard' && bot.strategy === 'expansion') score += 60
    if (urgent && city.specialty === 'scale-yard') score += 35

    return score + Math.random() * 8
  }

  private startContract() {
    const contractPool =
      this.worldContractTemplates.length > 0
        ? this.worldContractTemplates
        : this.worldSnapshot?.contracts ?? []
    const template =
      contractPool[(Math.max(0, this.tick + this.players.size) % Math.max(1, contractPool.length))]
    if (!template) {
      this.nextContractAtTick = this.tick + GAME_CONFIG.CONTRACT_GAP_TICKS
      return
    }
    const activePlayers = [...this.players.values()].filter((player) => player.status === 'playing')

    this.activeContract = {
      id: template.id,
      title: template.title,
      description: template.description,
      kind: template.kind,
      target: template.target,
      expiresAtTick: this.tick + GAME_CONFIG.CONTRACT_DURATION_TICKS,
      rewardLabel: template.rewardLabel,
      progressByPlayer: Object.fromEntries(activePlayers.map((player) => [player.id, 0])),
    }

    this.contractComputeBaselines.clear()
    if (template.kind === 'compute') {
      for (const player of activePlayers) {
        this.contractComputeBaselines.set(player.id, player.resources.computePower)
      }
    }

    this.addHeadline(`New contract live: ${template.title}. ${template.description}`)
  }

  private incrementContractProgress(playerId: string, kind: LiveContractKind, amount: number) {
    if (!this.activeContract || this.activeContract.kind !== kind) {
      return
    }

    this.activeContract.progressByPlayer[playerId] =
      (this.activeContract.progressByPlayer[playerId] ?? 0) + amount
    this.checkContractWinner()
  }

  private updateContractProgress(activePlayers: MultiplayerPlayer[]) {
    if (!this.activeContract) {
      return
    }

    if (this.activeContract.kind === 'compute') {
      for (const player of activePlayers) {
        const baseline =
          this.contractComputeBaselines.get(player.id) ?? player.resources.computePower
        this.activeContract.progressByPlayer[player.id] = Math.max(
          0,
          Math.floor(player.resources.computePower - baseline),
        )
      }
    }

    this.checkContractWinner()

    if (this.activeContract && this.tick >= this.activeContract.expiresAtTick) {
      this.addHeadline(`Contract expired: ${this.activeContract.title}. Nobody closed the deal.`)
      this.activeContract = null
      this.contractComputeBaselines.clear()
      this.nextContractAtTick = this.tick + GAME_CONFIG.CONTRACT_GAP_TICKS
    }
  }

  private checkContractWinner() {
    if (!this.activeContract) {
      return
    }

    const winner = [...this.players.values()]
      .filter((player) => player.status === 'playing')
      .find((player) => (this.activeContract?.progressByPlayer[player.id] ?? 0) >= (this.activeContract?.target ?? 0))

    if (!winner) {
      return
    }

    const rewardLabel = this.activeContract.rewardLabel
    const contractTitle = this.activeContract.title
    const template = this.worldContractTemplates.find((candidate) => candidate.id === this.activeContract?.id)
      ?? this.worldSnapshot?.contracts.find((candidate) => candidate.id === this.activeContract?.id)

    winner.resources = this.applyAdjustedDelta(
      winner,
      winner.resources,
      template?.rewards ?? {},
      'contract',
    )
    winner.effects.momentumTicks = Math.max(winner.effects.momentumTicks, 4)
    this.sendToast(this.getPrimaryConnection(winner.id), `Contract won: ${contractTitle}. ${rewardLabel}.`, 'success')
    this.addHeadline(`${winner.name} won the ${contractTitle} contract.`)

    this.activeContract = null
    this.contractComputeBaselines.clear()
    this.nextContractAtTick = this.tick + GAME_CONFIG.CONTRACT_GAP_TICKS
  }

  private finishMatch(winnerId: string) {
    if (this.phase === 'finished') {
      return
    }

    this.phase = 'finished'
    this.winnerId = winnerId
    this.resetAt = Date.now() + GAME_CONFIG.AUTO_RESET_DELAY_MS

    for (const player of this.players.values()) {
      player.status = player.id === winnerId ? 'won' : 'lost'
    }

    const winner = this.players.get(winnerId)
    if (winner) {
      this.addHeadline(`${winner.name} hit Singularity first. The room is now officially cooked.`)
      if (winner.isBot) {
        winner.submittedScore = true
        void this.saveLeaderboardEntry(winner)
      }
    }

    for (const player of this.players.values()) {
      const connection = this.getPrimaryConnection(player.id)
      if (!connection || player.isBot) {
        continue
      }

      this.sendToast(
        connection,
        player.id === winnerId
          ? 'You won the room. Submit your score before the next round auto-resets.'
          : 'Match over. Submit your score before the next round auto-resets.',
        player.id === winnerId ? 'success' : 'warning',
      )
    }
  }

  private async saveLeaderboardEntry(player: MultiplayerPlayer) {
    const entry: LeaderboardEntry = {
      id: generateId(),
      name: player.name,
      score: Math.floor(player.resources.computePower),
      farms: player.buildings.length,
      launchedProducts: player.products.filter((product) => product.launched).length,
      tick: this.tick,
      won: player.status === 'won',
      createdAt: Date.now(),
    }

    this.leaderboard = [entry, ...this.leaderboard]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        if (left.won !== right.won) {
          return Number(right.won) - Number(left.won)
        }
        return left.tick - right.tick
      })
      .slice(0, GAME_CONFIG.MAX_LEADERBOARD_ENTRIES)

    await this.room.storage.put(LEADERBOARD_STORAGE_KEY, this.leaderboard)
  }

  private resetMatch(skipBroadcast: boolean) {
    const nextPlayers = [...this.players.values()]
      .filter((player) => player.isBot || player.connected)
      .map((player) =>
        this.createFreshPlayer(
          player.id,
          player.name,
          player.color,
          {
            isBot: player.isBot,
            tagline: player.tagline,
            strategy: player.strategy,
          },
        ))

    this.players = new Map(nextPlayers.map((player) => [player.id, player]))
    this.phase = this.players.size > 0 ? 'playing' : 'waiting'
    this.tick = 0
    this.winnerId = null
    this.runtimeHeadlines = []
    this.activeContract = null
    this.contractComputeBaselines.clear()
    this.nextContractAtTick = 1
    this.resetAt = null
    this.botDecisionAt.clear()
    this.deliveredEventIds.clear()

    for (const player of this.players.values()) {
      if (player.isBot) {
        this.botDecisionAt.set(player.id, 1 + Math.floor(Math.random() * 3))
      }
    }

    this.applyWorldHeadlines()
    this.queueBriefingsForHumans()
    this.addHeadline('Fresh round started from the latest AI race snapshot.')

    if (!skipBroadcast) {
      for (const player of this.players.values()) {
        const connection = this.getPrimaryConnection(player.id)
        if (connection && !player.isBot) {
          this.sendToast(connection, 'The world has been reset for a new round.', 'info')
        }
      }
    }
  }

  private createFreshPlayer(
    playerId: string,
    requestedName: string,
    forcedColor?: string,
    options?: {
      isBot?: boolean
      tagline?: string
      strategy?: MultiplayerPlayer['strategy']
    },
  ): MultiplayerPlayer {
    const isBot = options?.isBot ?? false
    const assignedColor = forcedColor ?? this.pickAvailableColor()
    const signal = this.getWorldCompanySignal(playerId)
    const sourceStats = signal?.sourceBackedStats ?? this.getDefaultSourceStats()
    const products = this.buildPlayerProducts(signal)

    const player: MultiplayerPlayer = {
      id: playerId,
      name: requestedName || `CEO-${playerId.slice(0, 4)}`,
      color: assignedColor,
      tagline: options?.tagline ?? signal?.tagline ?? 'Human wildcard. Legal has not reviewed their plan.',
      isBot,
      strategy: options?.strategy ?? signal?.strategy ?? 'balanced',
      resources: {
        computePower: isBot ? sourceStats.computePower : GAME_CONFIG.STARTING_COMPUTE,
        publicOpinion: isBot ? sourceStats.publicOpinion : GAME_CONFIG.STARTING_OPINION,
        vcFunding: isBot ? sourceStats.vcFunding : GAME_CONFIG.STARTING_VC_FUNDING,
      },
      buildings: [],
      products: products.map((product) => ({
        ...product,
        unlocked: product.cost <= (isBot ? sourceStats.computePower * 1.6 : 1000),
        launched: false,
      })),
      status: 'playing',
      connected: isBot,
      submittedScore: false,
      pendingBriefing: null,
      effects: {
        disruptionTicks: 0,
        shieldTicks: 0,
        momentumTicks: 0,
      },
      actionCooldowns: {
        ddos: 0,
        smear: 0,
        poach: 0,
        shield: 0,
      },
      sourceBackedStats: { ...sourceStats },
      lastUpdatedAt: signal?.lastUpdatedAt ?? Date.now(),
    }

    if (isBot) {
      this.botDecisionAt.set(player.id, 1 + Math.floor(Math.random() * 3))
    }

    return player
  }

  private ensureCompanyBots() {
    for (const company of COMPANY_BOTS) {
      const existingPlayer = this.players.get(company.id)
      if (existingPlayer) {
        existingPlayer.name = company.name
        existingPlayer.color = company.color
        existingPlayer.tagline = this.getWorldCompanySignal(company.id)?.tagline ?? company.tagline
        existingPlayer.strategy = this.getWorldCompanySignal(company.id)?.strategy ?? company.strategy
        continue
      }

      this.players.set(
        company.id,
        this.createFreshPlayer(company.id, company.name, company.color, {
          isBot: true,
          tagline: company.tagline,
          strategy: company.strategy,
        }),
      )
    }
  }

  private getWorldCompanySignal(playerId: string) {
    return this.worldSnapshot?.companies.find((company) => company.id === playerId) ?? null
  }

  private getDefaultSourceStats() {
    return {
      computePower: 950,
      publicOpinion: GAME_CONFIG.STARTING_OPINION,
      vcFunding: GAME_CONFIG.STARTING_VC_FUNDING,
      artificialAnalysisRank: null,
      artificialAnalysisScore: null,
      arenaRank: null,
      arenaScore: null,
      confidence: 0.2,
      launches: [],
      agiScore: 0,
      agiScoreTrend: 'flat' as const,
    }
  }

  private buildPlayerProducts(signal: WorldSnapshot['companies'][number] | null) {
    const catalog = this.worldSnapshot?.productCatalog ?? []

    // Bots represent a specific company. They must only be able to launch
    // products tied to THEIR company — otherwise a bot picks the first
    // unlocked product from the shared catalog (which can belong to a rival)
    // and the game prints a bogus headline like
    // "Anthropic launched Gemma 4 31B" (Gemma is Google's model).
    if (signal) {
      const ownCatalogEntries = catalog.filter((product) =>
        product.id.startsWith(`${signal.id}-launch-`),
      )
      if (ownCatalogEntries.length > 0) {
        return ownCatalogEntries
      }

      if (signal.recentLaunches.length) {
        return signal.recentLaunches.map((launch, index) => ({
          id: `${signal.id}-launch-${index}`,
          name: launch,
          description: `${signal.name} is active in the current live race window.`,
          cost: 900 + index * 350,
          revenuePerTick: 6 + index * 2,
          opinionEffect: 4,
        }))
      }

      return [
        {
          id: `${signal.id}-fallback-window`,
          name: `${signal.name} Frontier Window`,
          description: `${signal.name} is still in the race but has no fresh public launch this window.`,
          cost: 1_000,
          revenuePerTick: 8,
          opinionEffect: 4,
        },
      ]
    }

    // Human players (signal === null) can launch against the full catalog.
    if (catalog.length > 0) {
      return catalog
    }

    return [
      {
        id: 'fallback-product-window',
        name: 'Frontier Product Window',
        description: 'A live market window built from the latest public model race.',
        cost: 1_000,
        revenuePerTick: 8,
        opinionEffect: 5,
      },
    ]
  }

  private applyWorldHeadlines() {
    if (!this.worldSnapshot) {
      return
    }

    this.runtimeHeadlines = this.worldSnapshot.events
      .slice(0, 12)
      .map((event) => `${event.sourceLabel}: ${event.title}`)
  }

  private queueBriefingsForHumans() {
    if (!this.worldSnapshot) {
      return
    }

    const nextEvents = this.worldSnapshot.events.filter((event) => !this.deliveredEventIds.has(event.id))
    if (nextEvents.length === 0) {
      return
    }

    for (const player of this.players.values()) {
      if (player.isBot || player.status !== 'playing' || player.pendingBriefing) {
        continue
      }

      const nextEvent = nextEvents.shift()
      if (!nextEvent) {
        break
      }

      this.queueWorldBriefing(player, nextEvent)
      this.deliveredEventIds.add(nextEvent.id)
    }
  }

  private applyWorldSnapshotToBots(previousSnapshot: WorldSnapshot | null) {
    if (!this.worldSnapshot) {
      return
    }

    this.worldContractTemplates = [...this.worldSnapshot.contracts]

    for (const company of this.worldSnapshot.companies) {
      const player = this.players.get(company.id)
      if (!player) {
        continue
      }

      const previousStats =
        previousSnapshot?.companies.find((candidate) => candidate.id === company.id)?.sourceBackedStats
        ?? player.sourceBackedStats
      const nextStats = { ...company.sourceBackedStats }
      nextStats.agiScoreTrend = computeTrend(nextStats.agiScore, previousStats?.agiScore)
      player.sourceBackedStats = nextStats
      player.lastUpdatedAt = company.lastUpdatedAt
      player.tagline = company.tagline
      player.strategy = company.strategy
      player.products = this.mergeProducts(player.products, this.buildPlayerProducts(company))

      if (!player.isBot) {
        continue
      }

      const computeDelta = company.sourceBackedStats.computePower - (previousStats?.computePower ?? 0)
      const opinionDelta = company.sourceBackedStats.publicOpinion - (previousStats?.publicOpinion ?? 0)
      const vcDelta = company.sourceBackedStats.vcFunding - (previousStats?.vcFunding ?? 0)

      if (this.hasHumanConnections() && this.phase === 'playing') {
        player.resources = this.applyAdjustedDelta(
          player,
          player.resources,
          {
            computePower: Math.round(computeDelta * 0.35),
            publicOpinion: Math.round(opinionDelta * 0.4),
            vcFunding: Math.round(vcDelta * 0.18),
          },
          'briefing',
        )
      } else {
        player.resources = {
          computePower: company.sourceBackedStats.computePower,
          publicOpinion: company.sourceBackedStats.publicOpinion,
          vcFunding: company.sourceBackedStats.vcFunding,
        }
      }

      this.refreshUnlockedProducts(player)
    }

    this.applyWorldHeadlines()
    this.queueBriefingsForHumans()
    this.ensureActiveSeason()
    this.seedOpenMarketsIfNeeded()
    void this.persistGameLayers()
  }

  private mergeProducts(existing: AIProduct[], incoming: Omit<AIProduct, 'unlocked' | 'launched'>[]) {
    const byId = new Map(existing.map((product) => [product.id, product]))
    for (const product of incoming) {
      const current = byId.get(product.id)
      byId.set(product.id, {
        ...product,
        unlocked: current?.unlocked ?? product.cost <= 1000,
        launched: current?.launched ?? false,
      })
    }

    return [...byId.values()]
  }

  private async ensureWorldSnapshotFresh(reason: 'startup' | 'connect' | 'tick') {
    const nextSyncAt = (this.worldSnapshot?.asOf ?? 0) + GAME_CONFIG.WORLD_SYNC_INTERVAL_MS
    if (this.worldSnapshot && Date.now() < nextSyncAt && reason !== 'startup') {
      return
    }

    if (this.syncPromise) {
      await this.syncPromise
      return
    }

    this.syncPromise = (async () => {
      const previousSnapshot = this.worldSnapshot
      try {
        const nextSnapshot = await buildWorldSnapshot(fetch, Date.now())
        this.worldSnapshot = nextSnapshot
        await this.room.storage.put(WORLD_SNAPSHOT_STORAGE_KEY, nextSnapshot)
        this.applyWorldSnapshotToBots(previousSnapshot)

        if (!this.hasHumanConnections() || this.phase === 'finished') {
          this.resetMatch(true)
        }
      } catch {
        if (!this.worldSnapshot) {
          this.worldSnapshot = await buildWorldSnapshot(async () => {
            throw new Error('Live sync unavailable')
          }, Date.now())
          await this.room.storage.put(WORLD_SNAPSHOT_STORAGE_KEY, this.worldSnapshot)
          this.applyWorldSnapshotToBots(previousSnapshot)
        }
      } finally {
        this.syncPromise = null
      }
    })()

    await this.syncPromise
  }

  // Refresh GDELT-derived per-country AI sentiment. This runs on the server so
  // every client gets the same result from one set of fetches, and GDELT's
  // per-IP throttle applies to one caller instead of every connected player.
  private async ensureAiSentimentFresh(reason: 'startup' | 'connect' | 'tick') {
    const SENTIMENT_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours — GDELT is rate-limited per IP
    const nextSyncAt = (this.aiSentiment?.fetchedAt ?? 0) + SENTIMENT_TTL_MS
    if (this.aiSentiment && Date.now() < nextSyncAt && reason !== 'startup') {
      return
    }

    if (this.sentimentSyncPromise) {
      return
    }

    this.sentimentSyncPromise = (async () => {
      try {
        const next = await buildSentimentSnapshot(fetch, Date.now())
        // Only persist if we got meaningful coverage (>=50% of tracked set).
        // Otherwise keep the previous snapshot so a transient 429 doesn't blank
        // the globe for every connected spectator.
        if (next.hitCount >= Math.ceil(next.trackedCount / 2)) {
          this.aiSentiment = next
          await this.room.storage.put(SENTIMENT_SNAPSHOT_STORAGE_KEY, next)
          this.broadcastSnapshot()
        } else if (!this.aiSentiment) {
          // First sync failed hard — still persist the empty result so the
          // client can render its static fallback without flickering.
          this.aiSentiment = next
          this.broadcastSnapshot()
        }
      } catch {
        // Swallow — next tick will try again.
      } finally {
        this.sentimentSyncPromise = null
      }
    })()
  }

  private refreshUnlockedProducts(player: MultiplayerPlayer) {
    player.products = player.products.map((product) =>
      product.unlocked || product.launched || product.cost <= player.resources.computePower * 2
        ? { ...product, unlocked: true }
        : product,
    )
  }

  private applyAdjustedDelta(
    player: MultiplayerPlayer,
    resources: Resources,
    delta: Partial<Resources>,
    context: ResourceContext,
  ) {
    const adjusted = { ...delta }
    const policyCount = this.getSpecialtyCount(player, 'policy-hub')
    const capitalCount = this.getSpecialtyCount(player, 'capital-hub')
    const coolingCount = this.getSpecialtyCount(player, 'cooling-grid')

    if (context === 'launch') {
      if ((adjusted.publicOpinion ?? 0) > 0) {
        adjusted.publicOpinion = (adjusted.publicOpinion ?? 0) + policyCount * 4
      } else if ((adjusted.publicOpinion ?? 0) < 0 && policyCount > 0) {
        adjusted.publicOpinion = Math.ceil((adjusted.publicOpinion ?? 0) * 0.6)
      }
    }

    if (context === 'hostile' && (adjusted.publicOpinion ?? 0) < 0 && policyCount > 0) {
      adjusted.publicOpinion = Math.ceil((adjusted.publicOpinion ?? 0) * 0.6)
    }

    if (context === 'briefing') {
      if ((adjusted.computePower ?? 0) < 0 && coolingCount > 0) {
        adjusted.computePower = Math.ceil((adjusted.computePower ?? 0) * 0.7)
      }
      if ((adjusted.publicOpinion ?? 0) > 0) {
        adjusted.publicOpinion = (adjusted.publicOpinion ?? 0) + policyCount * 3
      } else if ((adjusted.publicOpinion ?? 0) < 0 && policyCount > 0) {
        adjusted.publicOpinion = Math.ceil((adjusted.publicOpinion ?? 0) * 0.75)
      }
    }

    if ((context === 'contract' || context === 'milestone') && (adjusted.vcFunding ?? 0) > 0 && capitalCount > 0) {
      adjusted.vcFunding = (adjusted.vcFunding ?? 0) + capitalCount * 250
    }

    return this.applyResourceDelta(resources, adjusted)
  }

  private applyResourceDelta(resources: Resources, delta: Partial<Resources>): Resources {
    return {
      computePower: Math.max(0, resources.computePower + (delta.computePower ?? 0)),
      publicOpinion: Math.max(
        0,
        Math.min(100, resources.publicOpinion + (delta.publicOpinion ?? 0)),
      ),
      vcFunding: Math.max(0, resources.vcFunding + (delta.vcFunding ?? 0)),
    }
  }

  private getFarmCost(player: MultiplayerPlayer) {
    return Math.max(900, GAME_CONFIG.SERVER_FARM_COST - this.getSpecialtyCount(player, 'scale-yard') * 150)
  }

  private getProductLaunchCost(player: MultiplayerPlayer, product: AIProduct) {
    return Math.round(
      product.cost * (this.getSpecialtyCount(player, 'launch-lab') > 0 ? 0.8 : 1),
    )
  }

  private getActionCost(player: MultiplayerPlayer, cost: number) {
    return Math.round(cost * (this.getSpecialtyCount(player, 'ops-bunker') > 0 ? 0.8 : 1))
  }

  private getActionCooldown(player: MultiplayerPlayer, cooldown: number) {
    return Math.max(2, cooldown - this.getSpecialtyCount(player, 'ops-bunker') * 2)
  }

  private getSpecialtyCount(player: MultiplayerPlayer, specialty: CitySpecialty) {
    const cityById = new Map(CITIES.map((city) => [city.id, city]))
    return player.buildings.reduce((count, building) => {
      const city = cityById.get(building.cityId)
      return count + (city?.specialty === specialty ? 1 : 0)
    }, 0)
  }

  private tickDownStatuses(player: MultiplayerPlayer) {
    const nextCooldowns = { ...player.actionCooldowns }
    for (const actionId of Object.keys(nextCooldowns) as ExecutiveActionId[]) {
      nextCooldowns[actionId] = Math.max(0, nextCooldowns[actionId] - 1)
    }

    player.actionCooldowns = nextCooldowns
    player.effects = {
      disruptionTicks: Math.max(0, player.effects.disruptionTicks - 1),
      shieldTicks: Math.max(0, player.effects.shieldTicks - 1),
      momentumTicks: Math.max(0, player.effects.momentumTicks - 1),
    }
  }

  private countFarmsInCity(cityId: string) {
    return [...this.players.values()].reduce(
      (sum, player) => sum + player.buildings.filter((building) => building.cityId === cityId).length,
      0,
    )
  }

  private createSnapshot(): MultiplayerSnapshot {
    return {
      phase: this.phase,
      tick: this.tick,
      winnerId: this.winnerId,
      resetAt: this.resetAt,
      players: [...this.players.values()].map((player) => ({
        ...player,
        buildings: player.buildings.map((building) => ({ ...building })),
        products: player.products.map((product: AIProduct) => ({ ...product })),
        resources: { ...player.resources },
        pendingBriefing: player.pendingBriefing
          ? { ...player.pendingBriefing }
          : null,
        effects: { ...player.effects },
        actionCooldowns: { ...player.actionCooldowns },
        sourceBackedStats: { ...player.sourceBackedStats },
      })),
      headlines: this.runtimeHeadlines.length > 0
        ? this.runtimeHeadlines.slice(-24)
        : [...DEFAULT_HEADLINES],
      leaderboard: [...this.leaderboard],
      activeContract: this.activeContract
        ? {
            ...this.activeContract,
            progressByPlayer: { ...this.activeContract.progressByPlayer },
          }
        : null,
      worldSnapshotMeta: this.worldSnapshot
        ? {
            asOf: this.worldSnapshot.asOf,
            stale: this.worldSnapshot.status !== 'fresh',
            nextSyncAt: this.worldSnapshot.asOf + GAME_CONFIG.WORLD_SYNC_INTERVAL_MS,
            sourceCount: this.worldSnapshot.sources.filter((source) => source.status === 'ok').length,
            windowStart: this.worldSnapshot.windowStart,
            windowEnd: this.worldSnapshot.windowEnd,
            status: this.worldSnapshot.status,
          }
        : null,
      season: this.getActiveSeason(),
      openMarkets: this.getOpenMarkets(),
      resolvedMarkets: this.getRecentResolvedMarkets(),
      sentimentByLab: Object.fromEntries(this.sentimentAggregates),
      humanLeaderboard: this.buildHumanLeaderboardSlice(),
      aiSentiment: this.aiSentiment,
    }
  }

  private addHeadline(headline: string) {
    this.runtimeHeadlines = [...this.runtimeHeadlines, headline].slice(-21)
  }

  private hasHumanConnections() {
    return [...this.players.values()].some((player) => !player.isBot && player.connected)
  }

  private isPlayerStillConnected(playerId: string, closingConnectionId: string) {
    for (const connection of this.room.getConnections<ConnectionState>()) {
      if (connection.id === closingConnectionId) {
        continue
      }

      if (connection.state?.playerId === playerId) {
        return true
      }
    }

    return false
  }

  private getPrimaryConnection(playerId: string) {
    for (const connection of this.room.getConnections<ConnectionState>()) {
      if (connection.state?.playerId === playerId) {
        return connection
      }
    }

    return null
  }

  private sendSnapshot(connection: Party.Connection<ConnectionState>) {
    this.send(connection, {
      type: 'snapshot',
      snapshot: this.createSnapshot(),
    })
  }

  private broadcastSnapshot() {
    this.room.broadcast(
      JSON.stringify({
        type: 'snapshot',
        snapshot: this.createSnapshot(),
      } satisfies ServerMessage),
    )
  }

  private sendToast(
    connection: Party.Connection<ConnectionState> | null,
    message: string,
    type: Toast['type'],
  ) {
    if (!connection) {
      return
    }

    this.send(connection, {
      type: 'toast',
      toast: {
        id: generateId(),
        message,
        type,
        timestamp: Date.now(),
      },
    })
  }

  private send(connection: Party.Connection<ConnectionState>, payload: ServerMessage) {
    connection.send(JSON.stringify(payload))
  }

  private pickAvailableColor() {
    const usedColors = new Set([...this.players.values()].map((player) => player.color))
    return PLAYER_COLORS.find((color) => !usedColors.has(color)) ?? PLAYER_COLORS[0]
  }

  private sanitizeName(value: string | null) {
    if (!value) {
      return ''
    }

    return value.trim().replace(/\s+/g, ' ').slice(0, 18)
  }

  private sanitizeId(value: string | null) {
    if (!value) {
      return null
    }

    const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36)
    return sanitized || null
  }

  private async loadGameLayers() {
    const [
      profilesRaw,
      seasonsRaw,
      draftsRaw,
      marketsRaw,
      predictionsRaw,
      sentimentRaw,
      bankrollsRaw,
    ] = await Promise.all([
      this.room.storage.get<Record<string, UserProfile>>(PROFILES_STORAGE_KEY),
      this.room.storage.get<Season[]>(SEASONS_STORAGE_KEY),
      this.room.storage.get<Record<string, Record<string, Draft>>>(DRAFTS_STORAGE_KEY),
      this.room.storage.get<Record<string, PredictionMarket[]>>(MARKETS_STORAGE_KEY),
      this.room.storage.get<Record<string, Record<string, UserPrediction[]>>>(
        PREDICTIONS_STORAGE_KEY,
      ),
      this.room.storage.get<Record<string, Record<string, UserSentiment>>>(
        SENTIMENT_STORAGE_KEY,
      ),
      this.room.storage.get<Record<string, UserBankroll>>(BANKROLLS_STORAGE_KEY),
    ])

    this.profiles = new Map(Object.entries(profilesRaw ?? {}))
    this.seasons = seasonsRaw ?? []
    this.drafts = new Map(
      Object.entries(draftsRaw ?? {}).map(([seasonId, map]) => [
        seasonId,
        new Map(Object.entries(map ?? {})),
      ]),
    )
    // Backfill pool on legacy markets so older persisted rooms don't crash
    // after the wager-based redesign.
    this.markets = new Map(
      Object.entries(marketsRaw ?? {}).map(([seasonId, list]) => [
        seasonId,
        list.map((m) => ({ ...m, pool: m.pool ?? emptyPool() })),
      ]),
    )
    this.predictions = new Map(
      Object.entries(predictionsRaw ?? {}).map(([seasonId, map]) => [
        seasonId,
        new Map(
          Object.entries(map ?? {}).map(([userId, list]) => [
            userId,
            // Backfill wager/payout on legacy persisted predictions.
            // Legacy rows had neither field, so default both to 0/null
            // regardless of what TS thinks the in-memory shape is.
            list.map((p) => {
              const legacy = p as Partial<UserPrediction> & UserPrediction
              return {
                ...legacy,
                wager: legacy.wager ?? 0,
                payout: legacy.payout ?? null,
              }
            }),
          ]),
        ),
      ]),
    )
    this.sentiment = new Map(
      Object.entries(sentimentRaw ?? {}).map(([userId, map]) => [
        userId,
        new Map(Object.entries(map ?? {})),
      ]),
    )
    this.bankrolls = new Map(Object.entries(bankrollsRaw ?? {}))
    this.recomputeAllSentimentAggregates()
  }

  private async persistGameLayers() {
    const draftsObj: Record<string, Record<string, Draft>> = {}
    for (const [seasonId, map] of this.drafts) {
      draftsObj[seasonId] = Object.fromEntries(map)
    }
    const marketsObj: Record<string, PredictionMarket[]> = {}
    for (const [seasonId, list] of this.markets) {
      marketsObj[seasonId] = list
    }
    const predictionsObj: Record<string, Record<string, UserPrediction[]>> = {}
    for (const [seasonId, map] of this.predictions) {
      predictionsObj[seasonId] = Object.fromEntries(map)
    }
    const sentimentObj: Record<string, Record<string, UserSentiment>> = {}
    for (const [userId, map] of this.sentiment) {
      sentimentObj[userId] = Object.fromEntries(map)
    }

    await Promise.all([
      this.room.storage.put(PROFILES_STORAGE_KEY, Object.fromEntries(this.profiles)),
      this.room.storage.put(SEASONS_STORAGE_KEY, this.seasons),
      this.room.storage.put(DRAFTS_STORAGE_KEY, draftsObj),
      this.room.storage.put(MARKETS_STORAGE_KEY, marketsObj),
      this.room.storage.put(PREDICTIONS_STORAGE_KEY, predictionsObj),
      this.room.storage.put(SENTIMENT_STORAGE_KEY, sentimentObj),
      this.room.storage.put(
        BANKROLLS_STORAGE_KEY,
        Object.fromEntries(this.bankrolls),
      ),
    ])
  }

  private getOrCreateBankroll(userId: string): UserBankroll {
    const existing = this.bankrolls.get(userId)
    if (existing) return existing
    const fresh: UserBankroll = {
      userId,
      balance: STARTING_BANKROLL,
      lifetimeWon: 0,
      lifetimeLost: 0,
      updatedAt: Date.now(),
    }
    this.bankrolls.set(userId, fresh)
    return fresh
  }

  private adjustBankroll(
    userId: string,
    delta: number,
    kind: 'stake' | 'payout' | 'refund',
  ): UserBankroll {
    const bankroll = this.getOrCreateBankroll(userId)
    const next: UserBankroll = {
      ...bankroll,
      balance: Math.max(0, bankroll.balance + delta),
      lifetimeWon:
        kind === 'payout' && delta > 0
          ? bankroll.lifetimeWon + delta
          : bankroll.lifetimeWon,
      lifetimeLost:
        kind === 'stake' && delta < 0
          ? bankroll.lifetimeLost + -delta
          : bankroll.lifetimeLost,
      updatedAt: Date.now(),
    }
    this.bankrolls.set(userId, next)
    return next
  }

  private ensureActiveSeason() {
    const active = this.seasons.find((s) => s.status === 'active')
    if (active) return
    const highest = this.seasons.reduce((acc, s) => Math.max(acc, s.number), 0)
    const next = createNextSeason({
      previousNumber: highest,
      now: Date.now(),
      milestoneThreshold: DEFAULT_MILESTONE_THRESHOLD,
    })
    this.seasons = [...this.seasons, next]
  }

  private getActiveSeason(): Season | null {
    return this.seasons.find((s) => s.status === 'active') ?? null
  }

  private seedOpenMarketsIfNeeded() {
    const season = this.getActiveSeason()
    if (!season || !this.worldSnapshot) return

    const list = this.markets.get(season.id) ?? []
    const labs = COMPANY_BOTS.map((c) => ({ id: c.id, name: c.name }))
    const now = Date.now()
    let nextList = list

    // Short-window "who leads at the next sync" market.
    const hasOpenNextSync = list.some(
      (m) => m.kind === 'next-sync-leader' && m.status === 'open',
    )
    if (!hasOpenNextSync) {
      const nextSyncAt =
        this.worldSnapshot.asOf + GAME_CONFIG.WORLD_SYNC_INTERVAL_MS
      nextList = [
        ...nextList,
        createNextSyncLeaderMarket({
          seasonId: season.id,
          labs,
          opensAt: now,
          nextSyncAt,
          idSeed: `${season.id}-${this.worldSnapshot.asOf}`,
        }),
      ]
    }

    // Season-long milestone market — one per season.
    const hasMilestoneMarket = list.some(
      (m) => m.kind === 'first-to-milestone' && m.seasonId === season.id,
    )
    if (!hasMilestoneMarket) {
      nextList = [
        ...nextList,
        createFirstToMilestoneMarket({
          seasonId: season.id,
          labs,
          opensAt: now,
          seasonSoftEndsAt: season.softEndsAt,
          idSeed: season.id,
        }),
      ]
    }

    this.markets.set(season.id, nextList)
  }

  private async ensureProfile(userId: string) {
    if (this.profiles.has(userId)) return
    const profile: UserProfile = {
      id: userId,
      displayName: generateDisplayName(userId),
      createdAt: Date.now(),
    }
    this.profiles.set(userId, profile)
    await this.persistGameLayers()
  }

  private async handleSetDisplayName(
    userId: string,
    name: string,
    sender: Party.Connection<ConnectionState>,
  ) {
    const trimmed = this.sanitizeName(name)
    if (!trimmed) {
      this.sendToast(sender, 'Display name cannot be empty.', 'warning')
      return
    }
    const profile = this.profiles.get(userId)
    if (!profile) {
      await this.ensureProfile(userId)
    }
    const updated = this.profiles.get(userId)
    if (!updated) return
    updated.displayName = trimmed
    await this.persistGameLayers()
    this.sendUserState(sender, userId)
    this.broadcastSnapshot()
  }

  private async handleDraftLab(
    userId: string,
    labId: string,
    sender: Party.Connection<ConnectionState>,
  ) {
    const season = this.getActiveSeason()
    if (!season) {
      this.sendToast(sender, 'No active season.', 'warning')
      return
    }
    if (!COMPANY_BOTS.some((c) => c.id === labId)) {
      this.sendToast(sender, 'That lab is not in the race.', 'warning')
      return
    }
    const draftsForSeason = this.drafts.get(season.id) ?? new Map()
    if (draftsForSeason.has(userId)) {
      this.sendToast(sender, 'You already drafted. Use swap instead.', 'warning')
      return
    }
    const lab = this.players.get(labId)
    const anchorScore = lab?.sourceBackedStats.agiScore ?? 0
    const draft: Draft = {
      userId,
      seasonId: season.id,
      labId,
      pickedAt: Date.now(),
      anchorScore,
      cumulativeDelta: 0,
      swapsUsedThisWeek: 0,
      lastSwapAt: null,
    }
    draftsForSeason.set(userId, draft)
    this.drafts.set(season.id, draftsForSeason)
    await this.ensureProfile(userId)
    await this.persistGameLayers()
    this.sendUserState(sender, userId)
    this.broadcastSnapshot()
  }

  private async handleSwapLab(
    userId: string,
    labId: string,
    sender: Party.Connection<ConnectionState>,
  ) {
    const season = this.getActiveSeason()
    if (!season) return
    const draftsForSeason = this.drafts.get(season.id)
    const current = draftsForSeason?.get(userId)
    if (!current) {
      this.sendToast(sender, 'Draft a lab first.', 'warning')
      return
    }
    if (current.labId === labId) {
      this.sendToast(sender, 'Already riding that lab.', 'warning')
      return
    }
    if (!COMPANY_BOTS.some((c) => c.id === labId)) {
      this.sendToast(sender, 'That lab is not in the race.', 'warning')
      return
    }
    const now = Date.now()
    const windowOk =
      !current.lastSwapAt || now - current.lastSwapAt >= WEEK_MS
    if (!windowOk && current.swapsUsedThisWeek >= 1) {
      this.sendToast(sender, 'One swap per week. Cooldown active.', 'warning')
      return
    }
    const newLab = this.players.get(labId)
    const oldLab = this.players.get(current.labId)
    const oldCurrent = oldLab?.sourceBackedStats.agiScore ?? current.anchorScore
    const newAnchor = newLab?.sourceBackedStats.agiScore ?? 0

    const updated: Draft = {
      ...current,
      cumulativeDelta: current.cumulativeDelta + (oldCurrent - current.anchorScore),
      labId,
      anchorScore: newAnchor,
      pickedAt: now,
      swapsUsedThisWeek: windowOk ? 1 : current.swapsUsedThisWeek + 1,
      lastSwapAt: now,
    }
    draftsForSeason!.set(userId, updated)
    await this.persistGameLayers()
    this.sendUserState(sender, userId)
    this.broadcastSnapshot()
  }

  private async handlePredict(
    userId: string,
    marketId: string,
    optionId: string,
    wager: number,
    sender: Party.Connection<ConnectionState>,
  ) {
    const season = this.getActiveSeason()
    if (!season) return
    const marketList = this.markets.get(season.id) ?? []
    const marketIdx = marketList.findIndex((m) => m.id === marketId)
    if (marketIdx === -1) {
      this.sendToast(sender, 'Market not found.', 'warning')
      return
    }
    const market = marketList[marketIdx]
    if (market.status !== 'open') {
      this.sendToast(sender, 'Market is closed.', 'warning')
      return
    }
    if (!market.options.some((o) => o.id === optionId)) {
      this.sendToast(sender, 'Invalid option.', 'warning')
      return
    }
    if (!Number.isFinite(wager)) {
      this.sendToast(sender, 'Invalid wager.', 'warning')
      return
    }

    await this.ensureProfile(userId)
    const bankroll = this.getOrCreateBankroll(userId)

    const bySeason =
      this.predictions.get(season.id) ?? new Map<string, UserPrediction[]>()
    const userList = bySeason.get(userId) ?? []
    const previous = userList.find((p) => p.marketId === marketId) ?? null

    // Refund any previous wager on this market before taking the new one.
    let updatedMarket = market
    let availableBalance = bankroll.balance
    if (previous && previous.wager > 0) {
      updatedMarket = {
        ...updatedMarket,
        pool: removeFromPool(updatedMarket.pool, previous.optionId, previous.wager),
      }
      this.adjustBankroll(userId, previous.wager, 'refund')
      availableBalance += previous.wager
    }

    const normalizedWager = Math.floor(wager)
    if (normalizedWager < MIN_WAGER) {
      this.sendToast(sender, `Minimum wager is $${MIN_WAGER}.`, 'warning')
      return
    }
    if (normalizedWager > availableBalance) {
      this.sendToast(sender, 'Not enough sim cash for that wager.', 'warning')
      return
    }

    // Commit new wager.
    updatedMarket = {
      ...updatedMarket,
      pool: addToPool(updatedMarket.pool, optionId, normalizedWager),
    }
    this.adjustBankroll(userId, -normalizedWager, 'stake')

    const nextMarketList = [...marketList]
    nextMarketList[marketIdx] = updatedMarket
    this.markets.set(season.id, nextMarketList)

    const prediction: UserPrediction = {
      userId,
      marketId,
      optionId,
      wager: normalizedWager,
      payout: null,
      submittedAt: Date.now(),
      awardedPoints: null,
    }
    const withoutThisMarket = userList.filter((p) => p.marketId !== marketId)
    bySeason.set(userId, [...withoutThisMarket, prediction])
    this.predictions.set(season.id, bySeason)

    await this.persistGameLayers()
    this.sendUserState(sender, userId)
    this.broadcastSnapshot()
  }

  private async handleSetSentiment(
    userId: string,
    labId: string,
    value: SentimentValue,
    sender: Party.Connection<ConnectionState>,
  ) {
    if (!COMPANY_BOTS.some((c) => c.id === labId)) {
      this.sendToast(sender, 'Unknown lab.', 'warning')
      return
    }
    if (![-2, -1, 0, 1, 2].includes(value)) {
      this.sendToast(sender, 'Invalid sentiment value.', 'warning')
      return
    }
    const userMap = this.sentiment.get(userId) ?? new Map<string, UserSentiment>()
    const existing = userMap.get(labId)
    const now = Date.now()
    if (existing && now - existing.updatedAt < 60 * 60 * 1000) {
      this.sendToast(sender, 'Sentiment rate-limited (1/hr per lab).', 'warning')
      return
    }
    userMap.set(labId, { userId, labId, value, updatedAt: now })
    this.sentiment.set(userId, userMap)
    this.recomputeSentimentAggregate(labId)
    await this.ensureProfile(userId)
    await this.persistGameLayers()
    this.sendUserState(sender, userId)
    this.broadcastSnapshot()
  }

  private recomputeSentimentAggregate(labId: string) {
    let sum = 0
    let count = 0
    for (const userMap of this.sentiment.values()) {
      const s = userMap.get(labId)
      if (!s) continue
      sum += s.value
      count += 1
    }
    this.sentimentAggregates.set(labId, {
      labId,
      mean: count === 0 ? 0 : sum / count,
      count,
      updatedAt: Date.now(),
    })
  }

  private recomputeAllSentimentAggregates() {
    const labIds = new Set<string>()
    for (const userMap of this.sentiment.values()) {
      for (const labId of userMap.keys()) {
        labIds.add(labId)
      }
    }
    for (const labId of labIds) {
      this.recomputeSentimentAggregate(labId)
    }
  }

  private getOpenMarkets(): PredictionMarket[] {
    const season = this.getActiveSeason()
    if (!season) return []
    const list = this.markets.get(season.id) ?? []
    return list
      .filter((m) => m.status === 'open' || m.status === 'locked')
      .map((m) => ({ ...m, options: m.options.map((o) => ({ ...o })) }))
  }

  private getRecentResolvedMarkets(): PredictionMarket[] {
    const season = this.getActiveSeason()
    if (!season) return []
    const list = this.markets.get(season.id) ?? []
    return list
      .filter((m) => m.status === 'resolved')
      .sort((a, b) => b.resolvesAt - a.resolvesAt)
      .slice(0, 10)
      .map((m) => ({ ...m, options: m.options.map((o) => ({ ...o })) }))
  }

  private buildHumanLeaderboardSlice(): HumanLeaderboardEntry[] {
    const season = this.getActiveSeason()
    if (!season) return []
    const draftsForSeason = this.drafts.get(season.id) ?? new Map()
    const predictionsForSeason =
      this.predictions.get(season.id) ?? new Map<string, UserPrediction[]>()
    return buildHumanLeaderboard({
      profiles: this.profiles,
      drafts: draftsForSeason,
      predictionsByUser: predictionsForSeason,
      scoresByLab: this.getScoresByLab(),
      bankrolls: this.bankrolls,
      limit: 50,
    })
  }

  private getUserState(userId: string): UserState {
    const profile = this.profiles.get(userId) ?? null
    const season = this.getActiveSeason()
    const draft = season
      ? this.drafts.get(season.id)?.get(userId) ?? null
      : null
    const preds = season
      ? this.predictions.get(season.id)?.get(userId) ?? []
      : []
    const sentimentMap = this.sentiment.get(userId) ?? new Map()
    const sentiment: Record<string, UserSentiment> =
      Object.fromEntries(sentimentMap)

    const leaderboard = this.buildHumanLeaderboardSlice()
    const rankIndex = leaderboard.findIndex((e) => e.userId === userId)
    // Only expose the bankroll to returning users so anonymous spectators
    // don't accidentally "create" one they can't keep.
    const userBankroll = profile ? this.getOrCreateBankroll(userId) : null
    return {
      userProfile: profile,
      userDraft: draft,
      userPredictions: preds,
      userSentiment: sentiment,
      userRank: rankIndex >= 0 ? rankIndex + 1 : null,
      userBankroll,
    }
  }

  private sendUserState(
    connection: Party.Connection<ConnectionState>,
    userId: string,
  ) {
    this.send(connection, {
      type: 'user-state',
      userState: this.getUserState(userId),
    })
  }

  private broadcastUserStateToAll() {
    for (const connection of this.room.getConnections<ConnectionState>()) {
      const playerId = connection.state?.playerId
      if (!playerId) continue
      this.sendUserState(connection, playerId)
    }
  }
}
