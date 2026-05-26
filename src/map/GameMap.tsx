import { useCallback, useEffect, useMemo, useRef } from 'react'
import Map, {
  Layer,
  Marker,
  Source,
  type MapMouseEvent,
  type MapRef,
} from 'react-map-gl/mapbox'
import type { FillLayerSpecification } from 'mapbox-gl'
import { CITIES } from '../data/cities'
import {
  NEGATIVE_COUNTRIES,
  NEUTRAL_COUNTRIES,
  POSITIVE_COUNTRIES,
  SENTIMENT_COLORS,
} from '../data/aiSentiment'
import { HEIST_CONFIG } from '../heist/config'
import { useIsTouchDevice } from '../hooks/useIsTouchDevice'
import { useGameStore } from '../store'
import { SELF_PLAYER_COLOR } from '../utils/playerIdentity'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

const GLOBE_VIEW = {
  longitude: 10,
  latitude: 18,
  zoom: 1.65,
  pitch: 14,
  bearing: 0,
} as const

const CITY_ZOOM = 13.2
const CITY_PITCH = 52

const COUNTRY_BOUNDARIES_SOURCE = 'mapbox://mapbox.country-boundaries-v1'
const COUNTRY_SOURCE_LAYER = 'country_boundaries'

function buildStaticSentimentFill(): FillLayerSpecification['paint'] {
  return {
    'fill-color': [
      'match',
      ['get', 'iso_3166_1'],
      POSITIVE_COUNTRIES,
      SENTIMENT_COLORS.positive,
      NEGATIVE_COUNTRIES,
      SENTIMENT_COLORS.negative,
      NEUTRAL_COUNTRIES,
      SENTIMENT_COLORS.neutral,
      'rgba(0,0,0,0)',
    ],
    'fill-opacity': 0.22,
    'fill-outline-color': 'rgba(255,255,255,0.08)',
  }
}

export default function GameMap() {
  const isTouch = useIsTouchDevice()
  const mapRef = useRef<MapRef | null>(null)
  const lastFlyKey = useRef<string>('')

  const phase = useGameStore((state) => state.phase)
  const activeCityId = useGameStore((state) => state.activeCityId)
  const tourCities = useGameStore((state) => state.tourCities)
  const players = useGameStore((state) => state.players)
  const orbs = useGameStore((state) => state.orbs)
  const godzillas = useGameStore((state) => state.godzillas)
  const escapeZones = useGameStore((state) => state.escapeZones)
  const playerId = useGameStore((state) => state.playerId)
  const moveTo = useGameStore((state) => state.moveTo)

  const activeCity = CITIES.find((city) => city.id === activeCityId)
  const selfPlayer = players.find((player) => player.id === playerId)
  const canMove =
    (phase === 'collect' || phase === 'rampage') && !selfPlayer?.escaped
  const isArena =
    (phase === 'briefing' ||
      phase === 'collect' ||
      phase === 'rampage' ||
      phase === 'extract') &&
    activeCity

  const highlightedCityIds = useMemo(() => {
    if (tourCities.length > 0) return new Set(tourCities)
    return new Set(CITIES.map((city) => city.id))
  }, [tourCities])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const flyKey = `${phase}:${activeCityId ?? 'none'}`
    if (flyKey === lastFlyKey.current) return
    lastFlyKey.current = flyKey

    if (isArena && activeCity) {
      map.flyTo({
        center: [activeCity.lng, activeCity.lat],
        zoom: CITY_ZOOM,
        pitch: CITY_PITCH,
        bearing: 0,
        duration: 1400,
        essential: true,
      })
      return
    }

    if (phase === 'lobby' || phase === 'tour-end') {
      map.flyTo({
        center: [GLOBE_VIEW.longitude, GLOBE_VIEW.latitude],
        zoom: GLOBE_VIEW.zoom,
        pitch: GLOBE_VIEW.pitch,
        bearing: GLOBE_VIEW.bearing,
        duration: 1200,
        essential: true,
      })
    }
  }, [activeCity, activeCityId, isArena, phase])

  const handleMapClick = useCallback(
    (event: MapMouseEvent) => {
      if (!canMove || isTouch) return
      moveTo(event.lngLat.lat, event.lngLat.lng)
    },
    [canMove, isTouch, moveTo],
  )

  const handleZoomIn = useCallback(() => {
    mapRef.current?.zoomIn({ duration: 260 })
  }, [])
  const handleZoomOut = useCallback(() => {
    mapRef.current?.zoomOut({ duration: 260 })
  }, [])
  const handleResetView = useCallback(() => {
    if (isArena && activeCity) {
      mapRef.current?.flyTo({
        center: [activeCity.lng, activeCity.lat],
        zoom: CITY_ZOOM,
        pitch: CITY_PITCH,
        duration: 700,
      })
      return
    }
    mapRef.current?.flyTo({
      center: [GLOBE_VIEW.longitude, GLOBE_VIEW.latitude],
      zoom: GLOBE_VIEW.zoom,
      pitch: GLOBE_VIEW.pitch,
      bearing: GLOBE_VIEW.bearing,
      duration: 700,
    })
  }, [activeCity, isArena])

  if (!MAPBOX_TOKEN) {
    return (
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(80,80,160,0.25)_0%,rgba(10,10,20,0.95)_60%)]"
      />
    )
  }

  return (
    <>
      <div className={`absolute inset-0 ${isTouch ? 'pb-28' : ''}`}>
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={GLOBE_VIEW}
          style={{ width: '100%', height: '100%' }}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          projection={{ name: 'globe' }}
          minZoom={0.8}
          maxZoom={16}
          dragRotate
          touchZoomRotate
          attributionControl={false}
          cursor={canMove ? 'crosshair' : 'grab'}
          onClick={handleMapClick}
          fog={{
            range: [0.8, 8],
            color: '#0a0a1a',
            'horizon-blend': 0.1,
            'high-color': '#1a1a3a',
            'space-color': '#050510',
            'star-intensity': 0.6,
          }}
        >
          <Source
            id="country-boundaries"
            type="vector"
            url={COUNTRY_BOUNDARIES_SOURCE}
          >
            <Layer
              id="ai-sentiment-fill"
              type="fill"
              source-layer={COUNTRY_SOURCE_LAYER}
              paint={buildStaticSentimentFill()}
            />
          </Source>

          {CITIES.map((city) => {
            const isActive = city.id === activeCityId
            const onTour = highlightedCityIds.has(city.id)
            if (isArena && !isActive) return null
            return (
              <Marker
                key={city.id}
                longitude={city.lng}
                latitude={city.lat}
                anchor="center"
              >
                <div
                  className={`rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-wider backdrop-blur-sm ${
                    isActive
                      ? 'border-cyan-300/70 bg-cyan-400/20 text-cyan-100 shadow-[0_0_20px_rgba(0,255,255,0.35)]'
                      : onTour
                        ? 'border-white/20 bg-black/50 text-white/70'
                        : 'border-white/10 bg-black/40 text-white/45'
                  }`}
                >
                  {city.name}
                </div>
              </Marker>
            )
          })}

          {isArena
            ? orbs.map((orb) => (
                <Marker
                  key={orb.id}
                  longitude={orb.lng}
                  latitude={orb.lat}
                  anchor="center"
                >
                  <div
                    className={`rounded-full shadow-lg ${
                      isTouch ? 'h-4 w-4' : 'h-3 w-3'
                    } ${
                      orb.kind === 'clean'
                        ? 'bg-emerald-400 shadow-emerald-400/60'
                        : 'bg-fuchsia-500 shadow-fuchsia-500/60'
                    }`}
                    title={orb.kind === 'clean' ? 'Token' : 'Slop trap'}
                  />
                </Marker>
              ))
            : null}

          {isArena && phase === 'rampage'
            ? escapeZones.map((zone) => (
                <Marker
                  key={zone.id}
                  longitude={zone.lng}
                  latitude={zone.lat}
                  anchor="center"
                >
                  <div className="pointer-events-none flex flex-col items-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-emerald-300/80 bg-emerald-400/20 shadow-[0_0_24px_rgba(52,211,153,0.45)]">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-100">
                        Exit
                      </span>
                    </div>
                    <span className="mt-1 rounded bg-emerald-950/80 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-emerald-100">
                      {zone.label}
                    </span>
                  </div>
                </Marker>
              ))
            : null}

          {isArena && phase === 'rampage'
            ? godzillas.map((godzilla) => (
                <Marker
                  key={godzilla.id}
                  longitude={godzilla.lng}
                  latitude={godzilla.lat}
                  anchor="center"
                >
                  <div className="pointer-events-none flex flex-col items-center">
                    <div className="relative flex h-[min(42vw,320px)] w-[min(42vw,320px)] items-center justify-center">
                      <span className="absolute -inset-10 animate-ping rounded-full bg-lime-400/10" />
                      <span className="absolute -inset-6 rounded-full border-4 border-lime-400/20 bg-lime-500/10" />
                      <span className="absolute inset-0 rounded-full border-2 border-dashed border-lime-300/25" />
                      <span
                        className="relative select-none leading-none drop-shadow-[0_0_40px_rgba(132,204,22,0.95)]"
                        style={{ fontSize: 'clamp(7rem, 18vw, 11rem)' }}
                      >
                        🦖
                      </span>
                    </div>
                    <span className="mt-3 rounded-md bg-lime-950/90 px-4 py-1.5 text-sm font-bold uppercase tracking-[0.2em] text-lime-100 shadow-[0_0_24px_rgba(132,204,22,0.45)]">
                      {godzilla.name}
                    </span>
                  </div>
                </Marker>
              ))
            : null}

          {isArena
            ? players
                .filter((player) => player.connected || player.isBot)
                .map((player) => {
                  const isSelf = player.id === playerId
                  const stunned = player.stunnedUntil > Date.now()
                  const escaped = player.escaped
                  return (
                    <Marker
                      key={player.id}
                      longitude={player.lng}
                      latitude={player.lat}
                      anchor="center"
                    >
                      <div className="group relative flex flex-col items-center">
                        {isSelf ? (
                          <span className="mb-1 rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white shadow-[0_0_16px_rgba(255,71,87,0.65)]">
                            YOU
                          </span>
                        ) : null}
                        <span
                          className={`flex items-center justify-center rounded-full border-2 ${
                            isSelf
                              ? 'h-8 w-8 animate-pulse border-red-200 shadow-[0_0_20px_rgba(255,71,87,0.85)]'
                              : escaped
                                ? 'h-5 w-5 border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.8)]'
                                : 'h-5 w-5 border-white/80'
                          } ${stunned ? 'opacity-50' : ''}`}
                          style={{
                            backgroundColor: isSelf
                              ? SELF_PLAYER_COLOR
                              : player.color,
                          }}
                        />
                        <span
                          className={`mt-1 max-w-32 truncate rounded px-1.5 py-0.5 text-[10px] ${
                            isSelf
                              ? 'bg-red-950/90 font-semibold text-red-100'
                              : 'bg-black/70 text-white/90'
                          }`}
                        >
                          {player.name}
                          {player.isBot ? ' 🤖' : ''}
                          {escaped ? ' ✓' : ''}
                          {!escaped && player.carryingData > 0
                            ? ` · ${player.carryingData}`
                            : ''}
                        </span>
                      </div>
                    </Marker>
                  )
                })
            : null}
        </Map>
      </div>

      {!isTouch ? (
        <div className="pointer-events-auto absolute left-4 top-36 z-30 flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/55 text-white/85 shadow-[0_6px_18px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label="Zoom in"
            className="flex h-9 w-9 items-center justify-center text-lg leading-none transition hover:bg-white/10"
          >
            +
          </button>
          <div className="h-px bg-white/10" />
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label="Zoom out"
            className="flex h-9 w-9 items-center justify-center text-lg leading-none transition hover:bg-white/10"
          >
            −
          </button>
          <div className="h-px bg-white/10" />
          <button
            type="button"
            onClick={handleResetView}
            aria-label="Reset view"
            className="flex h-9 w-9 items-center justify-center text-[11px] leading-none tracking-wider transition hover:bg-white/10"
          >
            ⌂
          </button>
        </div>
      ) : null}

      {phase === 'rampage' ? (
        <div className="pointer-events-none absolute inset-0 z-10 bg-red-950/20" />
      ) : null}

      {phase === 'collect' && !isTouch ? (
        <div className="pointer-events-none absolute bottom-36 left-4 z-20 rounded-lg border border-cyan-400/20 bg-black/50 px-3 py-2 text-[10px] text-white/65 backdrop-blur-md">
          <p>Grab green token orbs · avoid pink slop traps</p>
          <p>
            {HEIST_CONFIG.COLLECT_MS / 1000}s until Slopzilla wakes up — click map
            to run
          </p>
        </div>
      ) : null}

      {phase === 'rampage' && !isTouch ? (
        <>
          <div className="pointer-events-none absolute bottom-36 left-4 z-20 rounded-lg border border-red-400/30 bg-red-950/60 px-3 py-2 text-[10px] text-red-100/90 backdrop-blur-md">
            <p>🦖 SLOPZILLA — run to green EXIT beacons!</p>
            <p>Reach an exit to bank tokens · get stomped = lose carried loot</p>
            <p>
              Faster sprint · {HEIST_CONFIG.RAMPAGE_MS / 1000}s until extract
            </p>
          </div>
        </>
      ) : null}
    </>
  )
}
