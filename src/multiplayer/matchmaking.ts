import { HEIST_CONFIG } from '../heist/config'

const ROOM_STORAGE_KEY = 'heist.room-id'
const MATCHMAKER_ROOM_ID = 'lobby'

export type RoomAssignment = {
  roomId: string
  humanCount: number
  maxPlayers: number
  phase: string
  created?: boolean
}

export type RoomMeta = {
  humanCount: number
  phase: string
  maxPlayers: number
  hasSpace: boolean
  acceptingPlayers: boolean
  roomId: string
}

function getPartyHttpBase(host: string) {
  const isLocal =
    host.includes('localhost') ||
    host.startsWith('127.') ||
    host.startsWith('0.0.0.0')
  return `${isLocal ? 'http' : 'https'}://${host}`
}

export async function fetchRoomMeta(
  host: string,
  roomId: string,
): Promise<RoomMeta | null> {
  const base = getPartyHttpBase(host)
  try {
    const response = await fetch(
      `${base}/parties/main/${encodeURIComponent(roomId)}?meta=1`,
    )
    if (!response.ok) return null
    return (await response.json()) as RoomMeta
  } catch {
    return null
  }
}

export async function assignGameRoom(host: string): Promise<RoomAssignment> {
  if (typeof window !== 'undefined') {
    const cachedRoomId = window.sessionStorage.getItem(ROOM_STORAGE_KEY)
    if (cachedRoomId) {
      const cachedMeta = await fetchRoomMeta(host, cachedRoomId)
      if (cachedMeta?.acceptingPlayers && cachedMeta.hasSpace) {
        return {
          roomId: cachedRoomId,
          humanCount: cachedMeta.humanCount,
          maxPlayers: cachedMeta.maxPlayers,
          phase: cachedMeta.phase,
        }
      }
    }
  }

  const base = getPartyHttpBase(host)
  const response = await fetch(
    `${base}/parties/matchmaker/${MATCHMAKER_ROOM_ID}?assign=1`,
  )
  if (!response.ok) {
    throw new Error('Could not find an open city room.')
  }

  const assignment = (await response.json()) as RoomAssignment
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(ROOM_STORAGE_KEY, assignment.roomId)
  }
  return assignment
}

export function formatRoomLabel(roomId: string | null) {
  if (!roomId) return `${HEIST_CONFIG.MIN_PLAYERS}–${HEIST_CONFIG.MAX_PLAYERS} per city`
  if (roomId.startsWith('city-')) {
    const suffix = roomId.slice('city-'.length)
    return `City ${suffix} · max ${HEIST_CONFIG.MAX_PLAYERS}`
  }
  return `City run · max ${HEIST_CONFIG.MAX_PLAYERS}`
}
