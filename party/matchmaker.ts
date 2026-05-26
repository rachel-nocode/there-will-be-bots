import type * as Party from 'partykit/server'
import { HEIST_CONFIG } from '../src/heist/config'

type RoomMeta = {
  humanCount: number
  phase: string
  maxPlayers: number
  hasSpace: boolean
  acceptingPlayers: boolean
}

const SHARD_PREFIX = 'city-'
const MAX_SHARD_SCAN = 64

async function fetchRoomMeta(
  stub: Party.Stub,
): Promise<RoomMeta | null> {
  try {
    const response = await stub.fetch('https://partykit.internal/?meta=1')
    if (!response.ok) return null
    return (await response.json()) as RoomMeta
  } catch {
    return null
  }
}

function pickBestRoom(candidates: Array<{ roomId: string; meta: RoomMeta }>) {
  const lobbyRooms = candidates.filter(
    ({ meta }) => meta.acceptingPlayers && meta.phase === 'lobby' && meta.hasSpace,
  )
  if (lobbyRooms.length > 0) {
    lobbyRooms.sort((left, right) => right.meta.humanCount - left.meta.humanCount)
    return lobbyRooms[0]
  }

  const openRooms = candidates.filter(
    ({ meta }) => meta.acceptingPlayers && meta.hasSpace,
  )
  if (openRooms.length > 0) {
    openRooms.sort((left, right) => right.meta.humanCount - left.meta.humanCount)
    return openRooms[0]
  }

  return null
}

export default class MatchmakerServer implements Party.Server {
  private room: Party.Room

  constructor(room: Party.Room) {
    this.room = room
  }

  async onRequest(req: Party.Request) {
    const url = new URL(req.url)
    if (url.searchParams.get('assign') !== '1') {
      return Response.json({
        ok: true,
        message: 'Slopzilla matchmaker — use ?assign=1',
        maxPlayers: HEIST_CONFIG.MAX_PLAYERS,
      })
    }

    const heistParty = this.room.context.parties.main
    const candidates: Array<{ roomId: string; meta: RoomMeta }> = []

    for (let index = 0; index < MAX_SHARD_SCAN; index += 1) {
      const roomId = `${SHARD_PREFIX}${index}`
      const meta = await fetchRoomMeta(heistParty.get(roomId))
      if (!meta) continue
      candidates.push({ roomId, meta })
    }

    const best = pickBestRoom(candidates)
    if (best) {
      return Response.json({
        roomId: best.roomId,
        humanCount: best.meta.humanCount,
        maxPlayers: HEIST_CONFIG.MAX_PLAYERS,
        phase: best.meta.phase,
      })
    }

    const fallbackRoomId = `${SHARD_PREFIX}${Date.now().toString(36)}`
    return Response.json({
      roomId: fallbackRoomId,
      humanCount: 0,
      maxPlayers: HEIST_CONFIG.MAX_PLAYERS,
      phase: 'lobby',
      created: true,
    })
  }
}
