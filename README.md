# Slopzilla 🦖

Multiplayer browser game: collect tokens across **3 cities**, then **run from Slopzilla** when the kaiju wakes up. Works on desktop and mobile from the same URL.

**Live:** [slopzilla.vercel.app](https://slopzilla.vercel.app)

## How it works

1. Pick your name — you show up as **red** with a **YOU** tag (only on your screen).
2. Get matched into a city room with up to **8 players** (bots fill empty slots).
3. **Collect** green token orbs for 45 seconds.
4. **Slopzilla rampage** — sprint to green EXIT beacons or lose carried tokens.
5. Survive **3 cities** — most saved tokens wins the tour.

## Local dev

```bash
npm install
cp .env.example .env   # add VITE_MAPBOX_TOKEN
npm run dev:party      # PartyKit on :1999
npm run dev            # Vite on :5173
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `VITE_MAPBOX_TOKEN` | Mapbox public token for the globe |
| `VITE_PARTYKIT_HOST` | PartyKit host, e.g. `slopzilla.witchaudio.partykit.dev` |

## Deploy

### 1. PartyKit (game server)

```bash
npx partykit login
npm run deploy:party
```

Note the host: `slopzilla.<your-account>.partykit.dev`

### 2. Vercel (frontend)

Set env vars in the Vercel project, then redeploy:

- `VITE_MAPBOX_TOKEN`
- `VITE_PARTYKIT_HOST=slopzilla.<your-account>.partykit.dev`

Vite bakes env vars at build time — **redeploy after changing them**.

## Key files

| File | Purpose |
|------|---------|
| `party/index.ts` | Game server — phases, bots, Slopzilla, match logic |
| `party/matchmaker.ts` | Shards players into 4–8 player city rooms |
| `src/store/index.ts` | Client state + PartySocket connection |
| `src/map/GameMap.tsx` | Mapbox map, players, orbs, exits |
| `src/ui/mobile/` | Touch joystick + RUN button |
