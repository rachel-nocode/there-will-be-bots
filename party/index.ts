import type * as Party from 'partykit/server'
import { CITIES } from '../src/data/cities'
import { HEIST_CONFIG } from '../src/heist/config'
import {
  type ClientMessage,
  type DataOrb,
  type EscapeZone,
  type Godzilla,
  type HeistPhase,
  type HeistPlayer,
  type HeistSnapshot,
  type ServerMessage,
  type UserState,
} from '../src/multiplayer/contracts'
import type { City } from '../src/types'
import type { Toast } from '../src/types'
import { generateId } from '../src/utils/formatters'

type ConnectionState = {
  playerId: string
}

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

const ADJECTIVES = [
  'Slop',
  'Clean',
  'Token',
  'Neon',
  'Frost',
  'Bold',
  'Flash',
  'Wired',
]
const NOUNS = [
  'Raider',
  'Runner',
  'Scraper',
  'Bandit',
  'Courier',
  'Phantom',
  'Miner',
]

const BOT_ID_PREFIX = 'bot-'

const BOT_NAMES = [
  'SlopGPT',
  'WrapperBot',
  'Hallucinator',
  'Token Leech',
  'Benchmark Fake',
  'Vapor Model',
  'Context Poison',
  'Data Bro',
]

const ESCAPE_LABELS = ['North Exit', 'East Pier', 'South Gate', 'West Tunnel']

function generateDisplayName(seed: string) {
  let hash = 0
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  const adj = ADJECTIVES[hash % ADJECTIVES.length]
  const noun = NOUNS[(hash >>> 5) % NOUNS.length]
  return `${adj} ${noun}`
}

function distance(latA: number, lngA: number, latB: number, lngB: number) {
  const dLat = latA - latB
  const dLng = (lngA - lngB) * Math.cos((latA * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

function randomNearCity(city: City, min = 0.003, max = 0.011) {
  const angle = Math.random() * Math.PI * 2
  const dist = min + Math.random() * (max - min)
  return {
    lat: city.lat + Math.cos(angle) * dist,
    lng:
      city.lng +
      (Math.sin(angle) * dist) / Math.cos((city.lat * Math.PI) / 180),
  }
}

function randomEscapePoint(city: City) {
  return randomNearCity(city, 0.012, 0.02)
}

function pickTourCities() {
  const shuffled = [...CITIES].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, HEIST_CONFIG.TOUR_ROUNDS).map((city) => city.id)
}

export default class HeistServer implements Party.Server {
  readonly options = {
    hibernate: false,
  }

  private players = new Map<string, HeistPlayer>()
  private orbs: DataOrb[] = []
  private godzillas: Godzilla[] = []
  private escapeZones: EscapeZone[] = []
  private phase: HeistPhase = 'lobby'
  private tick = 0
  private phaseEndsAt: number | null = null
  private lobbyCountdownAt: number | null = null
  private tourRound = 0
  private tourCities: string[] = []
  private activeCityId: string | null = null
  private winnerId: string | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private room: Party.Room

  constructor(room: Party.Room) {
    this.room = room
  }

  async onStart() {
    this.startTicker()
  }

  onRequest(req: Party.Request) {
    const url = new URL(req.url)
    if (url.searchParams.get('meta') !== '1') {
      return new Response('Token Run city room', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    const humanCount = this.countConnectedHumans()
    const hasSpace = humanCount < HEIST_CONFIG.MAX_PLAYERS
    const acceptingPlayers =
      this.phase !== 'tour-end' && (this.phase === 'lobby' ? hasSpace : hasSpace)

    return Response.json({
      humanCount,
      phase: this.phase,
      maxPlayers: HEIST_CONFIG.MAX_PLAYERS,
      hasSpace,
      acceptingPlayers,
      roomId: this.room.id,
    })
  }

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url)
    const requestedId = url.searchParams.get('playerId')?.trim() ?? generateId()
    const requestedName =
      url.searchParams.get('name')?.trim() || generateDisplayName(requestedId)
    const playerId = requestedId.slice(0, 64)
    const humanCount = this.countConnectedHumans()

    if (humanCount >= HEIST_CONFIG.MAX_PLAYERS) {
      connection.close(4000, 'City full')
      return
    }

    if (this.phase === 'tour-end') {
      connection.close(4000, 'Round ending')
      return
    }

    connection.setState({ playerId } satisfies ConnectionState)

    let player = this.players.get(playerId)
    if (!player) {
      player = this.createPlayer(playerId, requestedName)
      this.players.set(playerId, player)
    } else {
      player.connected = true
      player.name = requestedName.slice(0, 32) || player.name
    }

    if (this.activeCityId && this.phase !== 'lobby') {
      const city = this.getActiveCity()
      const spawn = randomNearCity(city)
      player.lat = spawn.lat
      player.lng = spawn.lng
    }

    this.sendUserState(connection, playerId)
    this.sendToast(connection, `Welcome, ${player.name}.`, 'info')
    this.ensureLobbyBots()
    this.maybeStartLobbyCountdown()
    this.broadcastSnapshot()
  }

  onClose(connection: Party.Connection) {
    const state = connection.state as ConnectionState | null
    if (!state?.playerId) return
    const player = this.players.get(state.playerId)
    if (player && !player.isBot) {
      player.connected = false
      player.targetLat = null
      player.targetLng = null
    }
    this.ensureLobbyBots()
    this.broadcastSnapshot()
  }

  onMessage(message: string, sender: Party.Connection) {
    const state = sender.state as ConnectionState | null
    if (!state?.playerId) return

    let parsed: ClientMessage
    try {
      parsed = JSON.parse(message) as ClientMessage
    } catch {
      this.sendToast(sender, 'Bad message.', 'warning')
      return
    }

    const player = this.players.get(state.playerId)
    if (!player || player.isBot) return

    switch (parsed.type) {
      case 'join':
        player.name = parsed.name.slice(0, 32) || player.name
        break
      case 'move':
        this.handleMove(player, parsed.lat, parsed.lng)
        break
      case 'set-display-name':
        player.name = parsed.name.slice(0, 32) || player.name
        break
      default:
        break
    }

    this.broadcastSnapshot()
  }

  private startTicker() {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      this.advanceTick()
    }, HEIST_CONFIG.TICK_MS)
  }

  private advanceTick() {
    this.tick += 1
    const now = Date.now()

    if (this.phase === 'lobby') {
      this.ensureLobbyBots()
      if (
        this.lobbyCountdownAt &&
        now >= this.lobbyCountdownAt &&
        this.countActivePlayers() >= HEIST_CONFIG.MIN_PLAYERS
      ) {
        this.startTour()
      }
      this.broadcastSnapshot()
      return
    }

    if (this.phase === 'collect') {
      this.simulateCollectTick(now)
      if (this.tick % 3 === 0) {
        this.driveBots(now)
      }
    }

    if (this.phase === 'rampage') {
      this.simulateRampageTick(now)
      if (this.tick % 2 === 0) {
        this.driveBots(now)
      }
    }

    if (this.phaseEndsAt && now >= this.phaseEndsAt) {
      this.advancePhase()
    }

    this.broadcastSnapshot()
  }

  private advancePhase() {
    switch (this.phase) {
      case 'briefing':
        this.startCollectPhase()
        break
      case 'collect':
        this.startRampage()
        break
      case 'rampage':
        this.startExtract()
        break
      case 'extract':
        if (this.tourRound >= HEIST_CONFIG.TOUR_ROUNDS) {
          this.finishTour()
        } else {
          this.startBriefing(this.tourRound + 1)
        }
        break
      case 'tour-end':
        this.resetToLobby()
        break
      default:
        break
    }
  }

  private maybeStartLobbyCountdown() {
    if (this.phase !== 'lobby' || this.lobbyCountdownAt) return
    this.ensureLobbyBots()
    if (this.countConnectedHumans() < 1) return
    if (this.countActivePlayers() < HEIST_CONFIG.MIN_PLAYERS) return
    this.lobbyCountdownAt = Date.now() + HEIST_CONFIG.LOBBY_AUTO_START_MS
    this.room.broadcast(
      JSON.stringify({
        type: 'toast',
        toast: this.makeToast(
          `World tour starts in ${HEIST_CONFIG.LOBBY_AUTO_START_MS / 1000}s — grab tokens before Slopzilla wakes up!`,
          'info',
        ),
      } satisfies ServerMessage),
    )
  }

  private startTour() {
    this.tourCities = pickTourCities()
    this.tourRound = 1
    this.winnerId = null
    this.lobbyCountdownAt = null
    for (const player of this.players.values()) {
      player.bankedData = 0
      player.roundBanked = 0
      player.carryingData = 0
      player.escaped = false
    }
    this.startBriefing(1)
  }

  private startBriefing(round: number) {
    this.phase = 'briefing'
    this.tourRound = round
    this.activeCityId = this.tourCities[round - 1] ?? CITIES[0].id
    this.orbs = []
    this.godzillas = []
    this.escapeZones = []
    this.phaseEndsAt = Date.now() + HEIST_CONFIG.BRIEFING_MS

    const city = this.getActiveCity()
    for (const player of this.players.values()) {
      if (!this.isPlayerActive(player)) continue
      const spawn = randomNearCity(city)
      player.lat = spawn.lat
      player.lng = spawn.lng
      player.targetLat = null
      player.targetLng = null
      player.carryingData = 0
      player.roundBanked = 0
      player.stunnedUntil = 0
      player.escaped = false
    }

    this.room.broadcast(
      JSON.stringify({
        type: 'toast',
        toast: this.makeToast(
          `Round ${round}/${HEIST_CONFIG.TOUR_ROUNDS}: ${city.name} — collect tokens, then run!`,
          'info',
        ),
      } satisfies ServerMessage),
    )
  }

  private startCollectPhase() {
    this.phase = 'collect'
    this.phaseEndsAt = Date.now() + HEIST_CONFIG.COLLECT_MS
    this.spawnOrbs()
    this.room.broadcast(
      JSON.stringify({
        type: 'toast',
        toast: this.makeToast('Grab tokens while you can.', 'info'),
      } satisfies ServerMessage),
    )
  }

  private startRampage() {
    this.phase = 'rampage'
    this.phaseEndsAt = Date.now() + HEIST_CONFIG.RAMPAGE_MS
    this.spawnSlopzilla()
    this.spawnEscapeZones()

    for (const player of this.players.values()) {
      player.escaped = false
    }

    this.room.broadcast(
      JSON.stringify({
        type: 'toast',
        toast: this.makeToast(
          '🦖 SLOPZILLA AWAKENS — THE CITY IS DOOMED. RUN FOR THE EXITS!',
          'chaos',
        ),
      } satisfies ServerMessage),
    )
  }

  private startExtract() {
    this.phase = 'extract'
    this.phaseEndsAt = Date.now() + HEIST_CONFIG.EXTRACT_MS
    for (const player of this.players.values()) {
      if (!player.escaped && player.carryingData > 0) {
        player.carryingData = 0
      }
    }
    const mvp = this.getLeader()
    if (mvp) {
      this.room.broadcast(
        JSON.stringify({
          type: 'toast',
          toast: this.makeToast(
            `${mvp.name} leads with ${mvp.bankedData} tokens saved`,
            'success',
          ),
        } satisfies ServerMessage),
      )
    }
  }

  private finishTour() {
    this.phase = 'tour-end'
    this.phaseEndsAt = Date.now() + HEIST_CONFIG.TOUR_END_MS
    const winner = this.getLeader()
    this.winnerId = winner?.id ?? null
    if (winner) {
      this.room.broadcast(
        JSON.stringify({
          type: 'toast',
          toast: this.makeToast(
            `${winner.name} survived the tour with ${winner.bankedData} tokens!`,
            'success',
          ),
        } satisfies ServerMessage),
      )
    }
  }

  private resetToLobby() {
    this.phase = 'lobby'
    this.phaseEndsAt = null
    this.lobbyCountdownAt = null
    this.tourRound = 0
    this.tourCities = []
    this.activeCityId = null
    this.orbs = []
    this.godzillas = []
    this.escapeZones = []
    this.winnerId = null
    for (const player of this.players.values()) {
      player.bankedData = 0
      player.roundBanked = 0
      player.carryingData = 0
      player.targetLat = null
      player.targetLng = null
      player.escaped = false
    }
    this.ensureLobbyBots()
    this.maybeStartLobbyCountdown()
  }

  private simulateCollectTick(now: number) {
    const city = this.getActiveCity()
    for (const player of this.players.values()) {
      if (!this.isPlayerActive(player)) continue
      if (player.stunnedUntil > now) continue
      if (player.targetLat != null && player.targetLng != null) {
        this.stepToward(player, HEIST_CONFIG.MOVE_STEP_COLLECT)
      }
      this.tryCollectOrbs(player, city)
    }
  }

  private simulateRampageTick(now: number) {
    const city = this.getActiveCity()

    for (const player of this.players.values()) {
      if (!this.isPlayerActive(player) || player.escaped) continue
      if (player.stunnedUntil > now) continue
      if (player.targetLat != null && player.targetLng != null) {
        this.stepToward(player, HEIST_CONFIG.MOVE_STEP_RAMPAGE)
      }
      this.tryEscape(player)
    }

    for (const godzilla of this.godzillas) {
      this.stepGodzilla(godzilla, city)
      this.applyGodzillaStomp(godzilla, now)
    }
  }

  private stepToward(player: HeistPlayer, step: number) {
    if (player.targetLat == null || player.targetLng == null) return
    const dLat = player.targetLat - player.lat
    const dLng = player.targetLng - player.lng
    const dist = Math.hypot(dLat, dLng)
    if (dist < step) {
      player.lat = player.targetLat
      player.lng = player.targetLng
      player.targetLat = null
      player.targetLng = null
      return
    }
    const ratio = step / dist
    player.lat += dLat * ratio
    player.lng += dLng * ratio
  }

  private tryCollectOrbs(player: HeistPlayer, city: City) {
    let valueMultiplier = 1
    if (city.specialty === 'capital-hub') valueMultiplier = 2
    if (city.specialty === 'launch-lab') valueMultiplier = 1.25

    for (let index = this.orbs.length - 1; index >= 0; index -= 1) {
      const orb = this.orbs[index]
      if (
        distance(player.lat, player.lng, orb.lat, orb.lng) >
        HEIST_CONFIG.COLLECT_RADIUS
      ) {
        continue
      }
      if (orb.kind === 'clean') {
        player.carryingData += Math.round(
          HEIST_CONFIG.TOKEN_ORB_VALUE * valueMultiplier,
        )
      } else {
        player.carryingData = Math.max(
          0,
          player.carryingData - HEIST_CONFIG.TRAP_ORB_PENALTY,
        )
      }
      this.orbs.splice(index, 1)
      this.orbs.push(
        this.makeOrb(
          city,
          Math.random() < HEIST_CONFIG.TRAP_ORB_RATIO ? 'trap' : 'clean',
        ),
      )
    }
  }

  private tryEscape(player: HeistPlayer) {
    for (const zone of this.escapeZones) {
      if (
        distance(player.lat, player.lng, zone.lat, zone.lng) >
        HEIST_CONFIG.ESCAPE_RADIUS
      ) {
        continue
      }
      player.bankedData += player.carryingData
      player.roundBanked += player.carryingData
      player.carryingData = 0
      player.escaped = true
      player.targetLat = null
      player.targetLng = null
      return
    }
  }

  private handleMove(player: HeistPlayer, lat: number, lng: number) {
    if (this.phase !== 'collect' && this.phase !== 'rampage') return
    if (player.escaped) return
    if (player.stunnedUntil > Date.now()) return
    player.targetLat = lat
    player.targetLng = lng
  }

  private spawnSlopzilla() {
    const city = this.getActiveCity()
    this.godzillas = []
    const spawn = { lat: city.lat, lng: city.lng }
    const target = randomNearCity(city)
    this.godzillas.push({
      id: generateId(),
      name: 'Slopzilla',
      lat: spawn.lat,
      lng: spawn.lng,
      targetLat: target.lat,
      targetLng: target.lng,
    })
  }

  private spawnEscapeZones() {
    const city = this.getActiveCity()
    this.escapeZones = []
    for (let index = 0; index < HEIST_CONFIG.ESCAPE_ZONE_COUNT; index += 1) {
      const point = randomEscapePoint(city)
      this.escapeZones.push({
        id: generateId(),
        label: ESCAPE_LABELS[index % ESCAPE_LABELS.length],
        lat: point.lat,
        lng: point.lng,
      })
    }
  }

  private stepGodzilla(godzilla: Godzilla, city: City) {
    const dLat = godzilla.targetLat - godzilla.lat
    const dLng = godzilla.targetLng - godzilla.lng
    const dist = Math.hypot(dLat, dLng)

    if (dist < HEIST_CONFIG.GODZILLA_MOVE_STEP) {
      const next = randomNearCity(city)
      godzilla.targetLat = next.lat
      godzilla.targetLng = next.lng
      return
    }

    const ratio = HEIST_CONFIG.GODZILLA_MOVE_STEP / dist
    godzilla.lat += dLat * ratio
    godzilla.lng += dLng * ratio
  }

  private applyGodzillaStomp(godzilla: Godzilla, now: number) {
    const radius = HEIST_CONFIG.GODZILLA_STOMP_RADIUS

    this.orbs = this.orbs.filter(
      (orb) => distance(godzilla.lat, godzilla.lng, orb.lat, orb.lng) > radius,
    )

    for (const player of this.players.values()) {
      if (!this.isPlayerActive(player) || player.escaped) continue
      if (distance(godzilla.lat, godzilla.lng, player.lat, player.lng) > radius) {
        continue
      }

      player.carryingData = 0
      player.stunnedUntil = now + HEIST_CONFIG.GODZILLA_STUN_MS
      player.targetLat = null
      player.targetLng = null
      this.knockbackFrom(godzilla.lat, godzilla.lng, player, 0.003)
    }
  }

  private knockbackFrom(
    sourceLat: number,
    sourceLng: number,
    player: HeistPlayer,
    push: number,
  ) {
    const dLat = player.lat - sourceLat
    const dLng = player.lng - sourceLng
    const dist = Math.hypot(dLat, dLng) || 0.00001
    player.lat += (dLat / dist) * push
    player.lng += (dLng / dist) * push
  }

  private spawnOrbs() {
    const city = this.getActiveCity()
    const count =
      city.specialty === 'scale-yard'
        ? Math.round(HEIST_CONFIG.ORB_COUNT * 1.4)
        : HEIST_CONFIG.ORB_COUNT
    this.orbs = []
    for (let index = 0; index < count; index += 1) {
      const kind =
        Math.random() < HEIST_CONFIG.TRAP_ORB_RATIO ? 'trap' : 'clean'
      this.orbs.push(this.makeOrb(city, kind))
    }
  }

  private makeOrb(city: City, kind: DataOrb['kind']): DataOrb {
    const point = randomNearCity(city)
    return {
      id: generateId(),
      lat: point.lat,
      lng: point.lng,
      kind,
    }
  }

  private createPlayer(
    playerId: string,
    name: string,
    isBot = false,
  ): HeistPlayer {
    const index = this.players.size % PLAYER_COLORS.length
    const anchor = CITIES[0]
    const spawn = randomNearCity(anchor)
    return {
      id: playerId,
      name: name.slice(0, 32),
      color: PLAYER_COLORS[index],
      lat: spawn.lat,
      lng: spawn.lng,
      targetLat: null,
      targetLng: null,
      carryingData: 0,
      bankedData: 0,
      roundBanked: 0,
      connected: true,
      stunnedUntil: 0,
      isBot,
      escaped: false,
    }
  }

  private createBot(index: number): HeistPlayer {
    const id = `${BOT_ID_PREFIX}${index}-${generateId().slice(0, 6)}`
    const name = BOT_NAMES[index % BOT_NAMES.length]
    return this.createPlayer(id, name, true)
  }

  private ensureLobbyBots() {
    const humans = this.countConnectedHumans()
    if (humans === 0) {
      this.removeAllBots()
      this.lobbyCountdownAt = null
      return
    }

    const targetTotal = Math.min(
      HEIST_CONFIG.MAX_PLAYERS,
      Math.max(HEIST_CONFIG.MIN_PLAYERS, humans + HEIST_CONFIG.FILL_BOTS),
    )
    const targetBots = Math.max(0, targetTotal - humans)
    let botCount = this.countBots()

    while (botCount < targetBots) {
      const bot = this.createBot(botCount)
      this.players.set(bot.id, bot)
      botCount += 1
    }

    while (botCount > targetBots) {
      const removable = [...this.players.values()].find((player) => player.isBot)
      if (!removable) break
      this.players.delete(removable.id)
      botCount -= 1
    }
  }

  private removeAllBots() {
    for (const player of [...this.players.values()]) {
      if (player.isBot) {
        this.players.delete(player.id)
      }
    }
  }

  private driveBots(now: number) {
    if (this.phase === 'collect') {
      this.driveBotsCollect(now)
      return
    }
    if (this.phase === 'rampage') {
      this.driveBotsRampage(now)
    }
  }

  private driveBotsCollect(now: number) {
    const city = this.getActiveCity()
    for (const bot of this.players.values()) {
      if (!bot.isBot || !this.isPlayerActive(bot)) continue
      if (bot.stunnedUntil > now) continue

      const orb = this.findNearestCleanOrb(bot)
      if (orb) {
        bot.targetLat = orb.lat
        bot.targetLng = orb.lng
      } else {
        const wander = randomNearCity(city)
        bot.targetLat = wander.lat
        bot.targetLng = wander.lng
      }
    }
  }

  private driveBotsRampage(now: number) {
    for (const bot of this.players.values()) {
      if (!bot.isBot || !this.isPlayerActive(bot) || bot.escaped) continue
      if (bot.stunnedUntil > now) continue

      const godzilla = this.godzillas[0]
      const escape = this.findNearestEscapeZone(bot)

      if (godzilla) {
        const godzillaDist = distance(
          bot.lat,
          bot.lng,
          godzilla.lat,
          godzilla.lng,
        )
        if (godzillaDist < HEIST_CONFIG.GODZILLA_THREAT_RADIUS) {
          this.fleeFromGodzilla(bot, godzilla, escape)
          continue
        }
      }

      if (escape) {
        bot.targetLat = escape.lat
        bot.targetLng = escape.lng
      }
    }
  }

  private fleeFromGodzilla(
    player: HeistPlayer,
    godzilla: Godzilla,
    escape: EscapeZone | null,
  ) {
    if (escape) {
      player.targetLat = escape.lat
      player.targetLng = escape.lng
      return
    }

    const awayLat = player.lat - godzilla.lat
    const awayLng = player.lng - godzilla.lng
    const awayDist = Math.hypot(awayLat, awayLng) || 0.00001
    player.targetLat = player.lat + (awayLat / awayDist) * 0.018
    player.targetLng = player.lng + (awayLng / awayDist) * 0.018
  }

  private findNearestCleanOrb(bot: HeistPlayer) {
    let nearest: DataOrb | null = null
    let nearestDist = Number.POSITIVE_INFINITY
    for (const orb of this.orbs) {
      if (orb.kind !== 'clean') continue
      const dist = distance(bot.lat, bot.lng, orb.lat, orb.lng)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = orb
      }
    }
    return nearest ?? this.findNearestOrb(bot)
  }

  private findNearestOrb(bot: HeistPlayer) {
    let nearest: DataOrb | null = null
    let nearestDist = Number.POSITIVE_INFINITY
    for (const orb of this.orbs) {
      const dist = distance(bot.lat, bot.lng, orb.lat, orb.lng)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = orb
      }
    }
    return nearest
  }

  private findNearestEscapeZone(player: HeistPlayer) {
    let nearest: EscapeZone | null = null
    let nearestDist = Number.POSITIVE_INFINITY
    for (const zone of this.escapeZones) {
      const dist = distance(player.lat, player.lng, zone.lat, zone.lng)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = zone
      }
    }
    return nearest
  }

  private isPlayerActive(player: HeistPlayer) {
    return player.isBot || player.connected
  }

  private countBots() {
    return [...this.players.values()].filter((player) => player.isBot).length
  }

  private countActivePlayers() {
    return [...this.players.values()].filter((player) => this.isPlayerActive(player))
      .length
  }

  private getActiveCity(): City {
    return (
      CITIES.find((city) => city.id === this.activeCityId) ??
      CITIES[0]
    )
  }

  private getLeader() {
    return [...this.players.values()]
      .filter((player) => this.isPlayerActive(player))
      .sort((left, right) => right.bankedData - left.bankedData)[0]
  }

  private countConnectedHumans() {
    return [...this.players.values()].filter(
      (player) => !player.isBot && player.connected,
    ).length
  }

  private buildSnapshot(): HeistSnapshot {
    return {
      phase: this.phase,
      tick: this.tick,
      phaseEndsAt: this.phaseEndsAt,
      lobbyCountdownAt: this.lobbyCountdownAt,
      tourRound: this.tourRound,
      tourCities: this.tourCities,
      activeCityId: this.activeCityId,
      players: [...this.players.values()].sort(
        (left, right) => right.bankedData - left.bankedData,
      ),
      orbs: this.orbs,
      godzillas: this.godzillas,
      escapeZones: this.escapeZones,
      winnerId: this.winnerId,
      humanCount: this.countConnectedHumans(),
    }
  }

  private broadcastSnapshot() {
    const payload: ServerMessage = {
      type: 'snapshot',
      snapshot: this.buildSnapshot(),
    }
    this.room.broadcast(JSON.stringify(payload))
  }

  private sendUserState(connection: Party.Connection, playerId: string) {
    const payload: ServerMessage = {
      type: 'user-state',
      userState: { playerId } satisfies UserState,
    }
    connection.send(JSON.stringify(payload))
  }

  private sendToast(
    connection: Party.Connection,
    message: string,
    type: Toast['type'],
  ) {
    connection.send(
      JSON.stringify({
        type: 'toast',
        toast: this.makeToast(message, type),
      } satisfies ServerMessage),
    )
  }

  private makeToast(message: string, type: Toast['type']): Toast {
    return {
      id: generateId(),
      message,
      type,
      timestamp: Date.now(),
    }
  }
}
