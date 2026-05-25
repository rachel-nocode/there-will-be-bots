import type { DataOrb, EscapeZone, Godzilla, HeistPhase, HeistPlayer } from '../multiplayer/contracts'

function distance(latA: number, lngA: number, latB: number, lngB: number) {
  const dLat = latA - latB
  const dLng = (lngA - lngB) * Math.cos((latA * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

function nearestPoint<T extends { lat: number; lng: number }>(
  player: HeistPlayer,
  points: T[],
) {
  if (points.length === 0) return null
  return points.reduce((best, point) => {
    const bestDist = distance(player.lat, player.lng, best.lat, best.lng)
    const pointDist = distance(player.lat, player.lng, point.lat, point.lng)
    return pointDist < bestDist ? point : best
  })
}

function headingFromPlayer(player: HeistPlayer) {
  if (player.targetLat != null && player.targetLng != null) {
    const dLat = player.targetLat - player.lat
    const dLng = player.targetLng - player.lng
    const dist = Math.hypot(dLat, dLng)
    if (dist > 0.000001) {
      return { dLat: dLat / dist, dLng: dLng / dist }
    }
  }
  return { dLat: 0.0012, dLng: 0 }
}

export function steerTarget(
  player: HeistPlayer,
  steerX: number,
  steerY: number,
  phase: HeistPhase,
  burstScale = 1,
) {
  const magnitude = Math.hypot(steerX, steerY)
  if (magnitude < 0.001) {
    return { lat: player.lat, lng: player.lng }
  }

  const normX = steerX / magnitude
  const normY = steerY / magnitude
  const power = Math.min(1, magnitude)
  const step =
    (phase === 'rampage' ? 0.0036 : 0.0024) * burstScale * power
  const lngScale = step / Math.cos((player.lat * Math.PI) / 180)

  return {
    lat: player.lat - normY * step,
    lng: player.lng + normX * lngScale,
  }
}

export function pickRunTarget(
  player: HeistPlayer,
  phase: HeistPhase,
  orbs: DataOrb[],
  escapeZones: EscapeZone[],
  godzillas: Godzilla[],
  burstScale = 1,
  steering?: { x: number; y: number } | null,
) {
  if (steering && Math.hypot(steering.x, steering.y) > 0.22) {
    return steerTarget(player, steering.x, steering.y, phase, burstScale * 1.35)
  }

  const step =
    (phase === 'rampage' ? 0.0034 : 0.0021) * burstScale

  if (phase === 'collect') {
    const cleanOrbs = orbs.filter((orb) => orb.kind === 'clean')
    const nearestOrb = nearestPoint(player, cleanOrbs)
    if (nearestOrb) {
      return { lat: nearestOrb.lat, lng: nearestOrb.lng }
    }
  }

  if (phase === 'rampage') {
    const nearestExit = nearestPoint(player, escapeZones)
    if (nearestExit) {
      return { lat: nearestExit.lat, lng: nearestExit.lng }
    }
  }

  let heading = headingFromPlayer(player)

  if (phase === 'rampage' && godzillas.length > 0) {
    const threat = godzillas[0]
    const awayLat = player.lat - threat.lat
    const awayLng = player.lng - threat.lng
    const awayDist = Math.hypot(awayLat, awayLng) || 0.00001
    heading = { dLat: awayLat / awayDist, dLng: awayLng / awayDist }
  }

  return {
    lat: player.lat + heading.dLat * step,
    lng: player.lng + heading.dLng * step,
  }
}
