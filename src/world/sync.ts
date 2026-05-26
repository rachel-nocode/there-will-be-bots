import { COMPANY_BOTS } from '../data/companies'
import { GAME_CONFIG } from '../data/config'
import type {
  AIProduct,
  CompanyStrategy,
  Resources,
  SourceBackedStats,
  WorldCompanySignal,
  WorldContractTemplate,
  WorldEvent,
  WorldSnapshot,
  WorldSourceStatus,
} from '../types'
import { computeAgiScore } from '../utils/agiScore'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type ParsedLeaderboardRow = {
  companyId: string
  companyName: string
  rank: number
  score: number | null
  modelName: string
  url: string
}

type OfficialHeadline = {
  companyId: string
  companyName: string
  title: string
  url: string
}

const AI_KEYWORDS = /(model|ai|api|launch|release|pricing|agent|reasoning|grok|claude|gemini|gpt|qwen|deepseek|llama|compute|inference)/i
const MODEL_PREFIX_TO_COMPANY: Array<{ companyId: string; pattern: RegExp }> = [
  { companyId: 'bot-openai', pattern: /\b(gpt|codex|o3|o4)\b/i },
  { companyId: 'bot-google', pattern: /\bgemini\b/i },
  { companyId: 'bot-anthropic', pattern: /\bclaude\b/i },
  { companyId: 'bot-xai', pattern: /\bgrok\b/i },
  { companyId: 'bot-meta', pattern: /\b(llama|muse)\b/i },
  { companyId: 'bot-deepseek', pattern: /\bdeepseek\b/i },
  { companyId: 'bot-alibaba', pattern: /\bqwen\b/i },
  { companyId: 'bot-microsoft', pattern: /\b(microsoft|mai|phi)\b/i },
]

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripTags(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeUrl(baseUrl: string, href: string) {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return baseUrl
  }
}

function createEmptyStats(): SourceBackedStats {
  return {
    computePower: 900,
    publicOpinion: 60,
    vcFunding: 5_000,
    artificialAnalysisRank: null,
    artificialAnalysisScore: null,
    arenaRank: null,
    arenaScore: null,
    confidence: 0.2,
    launches: [],
    agiScore: 0,
    agiScoreTrend: 'flat',
  }
}

function getCompanyById(companyId: string) {
  return COMPANY_BOTS.find((company) => company.id === companyId)
}

function findCompanyIdFromAlias(value: string, source: 'aa' | 'arena') {
  const lowerValue = value.toLowerCase()
  for (const company of COMPANY_BOTS) {
    const aliases = source === 'aa' ? company.sourceAliases : company.arenaAliases
    if (aliases.some((alias) => lowerValue.includes(alias.toLowerCase()))) {
      return company.id
    }
  }

  for (const entry of MODEL_PREFIX_TO_COMPANY) {
    if (entry.pattern.test(value)) {
      return entry.companyId
    }
  }

  return null
}

// AA rows render as a fixed schema:
//   <Model Name>  <Context Window>  <Creator>  <Intelligence Score>  …
// The context window always looks like `128k`, `1M`, `32.8k`, `1.05M`.
// We anchor the parse on that token so the *creator* column (and nothing else)
// decides which bot owns the row. This kills two classes of bugs:
//   1. Bots attributed by stray text elsewhere in the row (e.g. a row
//      produced by NVIDIA that contains "Llama" ending up under Meta).
//   2. DeepSeek's "DeepSeek V3.2 128k DeepSeek …" rows producing an empty
//      model name because the old parser split at the first occurrence of
//      the company alias (position 0) and took everything before it.
// Context window units on AA are always `k` or `M` (tokens in thousands/millions).
// We deliberately do NOT accept `B` — that suffix appears in model names
// (e.g. "Gemma 4 31B" = 31 billion params) and would cause the parser to
// split the row at the parameter count instead of the context window.
const AA_ROW_PATTERN = /^(.+?)\s+(\d+(?:\.\d+)?[kKmM])\s+(.+?)\s+(\d+(?:\.\d+)?)(?:\s|$)/

function parseArtificialAnalysisRow(rowText: string): {
  modelName: string
  creator: string
  score: number | null
} | null {
  const match = rowText.match(AA_ROW_PATTERN)
  if (!match) return null

  const [, modelName, , creator, scoreRaw] = match
  return {
    modelName: modelName.trim(),
    creator: creator.trim(),
    score: Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null,
  }
}

function matchCompanyByCreator(creator: string) {
  const lower = creator.toLowerCase()
  for (const company of COMPANY_BOTS) {
    if (company.sourceAliases.some((alias) => lower === alias.toLowerCase())) {
      return company.id
    }
  }
  // Permit a looser contains-match only when the creator column is a
  // multi-word label that wraps the alias, e.g. "Microsoft Azure" vs the
  // aliases `Microsoft Azure` / `Microsoft AI`.
  for (const company of COMPANY_BOTS) {
    if (company.sourceAliases.some((alias) => lower.includes(alias.toLowerCase()))) {
      return company.id
    }
  }
  return null
}

function parseArtificialAnalysisRows(html: string): ParsedLeaderboardRow[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  const parsedRows: ParsedLeaderboardRow[] = []

  for (const [index, match] of rows.entries()) {
    const rowText = stripTags(match[1])
    if (!rowText || rowText.startsWith('Model Context Window Creator')) {
      continue
    }

    const parsed = parseArtificialAnalysisRow(rowText)
    if (!parsed) continue

    const companyId = matchCompanyByCreator(parsed.creator)
    if (!companyId) continue

    const company = getCompanyById(companyId)
    if (!company) continue

    if (!parsed.modelName) continue

    parsedRows.push({
      companyId,
      companyName: company.name,
      rank: index,
      score: parsed.score,
      modelName: parsed.modelName,
      url: 'https://artificialanalysis.ai/leaderboards/models/',
    })
  }

  return parsedRows
}

function parseArenaRows(html: string): ParsedLeaderboardRow[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  const parsedRows: ParsedLeaderboardRow[] = []

  for (const match of rows) {
    const rowText = stripTags(match[1])
    const rowMatch = rowText.match(/^(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)$/)
    if (!rowMatch) {
      continue
    }

    const rank = Number(rowMatch[1])
    const label = rowMatch[2]
    const score = Number(rowMatch[3])
    const companyId = findCompanyIdFromAlias(label, 'arena')
    if (!companyId) {
      continue
    }

    const company = getCompanyById(companyId)
    if (!company) {
      continue
    }

    let modelName = label
    for (const alias of company.arenaAliases) {
      modelName = modelName.replace(new RegExp(`^${escapeRegExp(alias)}\\s+`, 'i'), '')
    }

    parsedRows.push({
      companyId,
      companyName: company.name,
      rank,
      score,
      modelName: modelName.trim(),
      url: 'https://arena.ai/leaderboard/',
    })
  }

  return parsedRows
}

function parseOfficialHeadlines(html: string, baseUrl: string, companyId: string, companyName: string) {
  const headlines: OfficialHeadline[] = []
  const anchors = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]

  for (const match of anchors) {
    const title = stripTags(match[2])
    if (
      title.length < 24
      || title.length > 140
      || !AI_KEYWORDS.test(title)
      || title.toLowerCase() === companyName.toLowerCase()
    ) {
      continue
    }

    headlines.push({
      companyId,
      companyName,
      title,
      url: normalizeUrl(baseUrl, match[1]),
    })
  }

  return headlines.slice(0, 2)
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false
    }
    seen.add(item.id)
    return true
  })
}

function average(numbers: number[]) {
  if (numbers.length === 0) {
    return 0
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function makeGameStats(
  companyId: string,
  aaRows: ParsedLeaderboardRow[],
  arenaRows: ParsedLeaderboardRow[],
  launches: string[],
): SourceBackedStats {
  const company = getCompanyById(companyId)
  const stats = createEmptyStats()
  const bestAa = aaRows[0] ?? null
  const bestArena = arenaRows[0] ?? null
  const aaScores = aaRows.map((row) => row.score ?? 40)
  const arenaScores = arenaRows.map((row) => row.score ?? 1300)
  const platformWeight = company?.platformWeight ?? 1
  const capabilityBase = bestAa ? clamp(70 - bestAa.rank * 3 + average(aaScores), 25, 90) : 38
  const publicBase = bestArena ? clamp(30 + (1510 - bestArena.rank * 6) + (average(arenaScores) - 1450) * 0.12, 32, 92) : 58
  const valueBase = clamp(capabilityBase * 22 + publicBase * 18 * platformWeight + launches.length * 260, 2_800, 8_800)

  stats.computePower = Math.round(350 + capabilityBase * 24)
  stats.publicOpinion = Math.round(publicBase)
  stats.vcFunding = Math.round(valueBase)
  stats.artificialAnalysisRank = bestAa?.rank ?? null
  stats.artificialAnalysisScore = bestAa?.score ?? null
  stats.arenaRank = bestArena?.rank ?? null
  stats.arenaScore = bestArena?.score ?? null
  stats.confidence = clamp(
    0.25
      + (bestAa ? 0.25 : 0)
      + (bestArena ? 0.25 : 0)
      + Math.min(0.25, launches.length * 0.08),
    0.2,
    0.95,
  )
  stats.launches = launches.slice(0, 4)
  stats.agiScore = computeAgiScore(stats, platformWeight)
  stats.agiScoreTrend = 'flat'
  return stats
}

function makeEventEffects(stats: SourceBackedStats): Partial<Resources> {
  return {
    computePower: Math.max(120, Math.round(stats.computePower * 0.12)),
    publicOpinion: Math.max(3, Math.round((stats.publicOpinion - 50) * 0.18)),
    vcFunding: Math.max(180, Math.round(stats.vcFunding * 0.05)),
  }
}

function buildContracts(companies: WorldCompanySignal[]): WorldContractTemplate[] {
  const byCompute = [...companies].sort(
    (left, right) => right.sourceBackedStats.computePower - left.sourceBackedStats.computePower,
  )
  const byOpinion = [...companies].sort(
    (left, right) => right.sourceBackedStats.publicOpinion - left.sourceBackedStats.publicOpinion,
  )
  const byFunding = [...companies].sort(
    (left, right) => right.sourceBackedStats.vcFunding - left.sourceBackedStats.vcFunding,
  )

  const computeLeader = byCompute[0]
  const opinionLeader = byOpinion[0]
  const fundingLeader = byFunding[0]

  return dedupeById([
    {
      id: 'world-capability-window',
      title: `${computeLeader?.name ?? 'Frontier'} Capability Window`,
      description: `${computeLeader?.name ?? 'A rival'} is setting the pace on the capability boards. Ship a product before the window closes to steal the next headline.`,
      kind: 'launch',
      target: 1,
      rewardLabel: '+460 compute, +8 opinion, and momentum',
      rewards: { computePower: 460, publicOpinion: 8 },
      sourceLabel: 'Artificial Analysis',
      sourceUrl: 'https://artificialanalysis.ai/leaderboards/models/',
    },
    {
      id: 'world-arena-surge',
      title: `${opinionLeader?.name ?? 'Chat'} Preference Surge`,
      description: `${opinionLeader?.name ?? 'One lab'} is winning live preference votes. Land the next executive move to own the story for a cycle.`,
      kind: 'ops',
      target: 1,
      rewardLabel: '+1100 VC, +220 compute',
      rewards: { vcFunding: 1_100, computePower: 220 },
      sourceLabel: 'Arena',
      sourceUrl: 'https://arena.ai/leaderboard/',
    },
    {
      id: 'world-distribution-push',
      title: `${fundingLeader?.name ?? 'Platform'} Distribution Push`,
      description: `${fundingLeader?.name ?? 'A platform player'} has the biggest war chest right now. Build two fresh regions before the market settles around them.`,
      kind: 'build',
      target: 2,
      rewardLabel: '+1450 VC, +220 compute, and momentum',
      rewards: { vcFunding: 1_450, computePower: 220, publicOpinion: 5 },
      sourceLabel: 'World Snapshot',
      sourceUrl: fundingLeader?.sourceLinks[0] ?? 'https://artificialanalysis.ai/leaderboards/models/',
    },
    {
      id: 'world-compute-repricing',
      title: 'Compute Repricing Cycle',
      description: 'The market is repricing capability and distribution again. Gain raw compute before the next sync locks in a new pecking order.',
      kind: 'compute',
      target: 900,
      rewardLabel: '+980 VC and +7 opinion',
      rewards: { vcFunding: 980, publicOpinion: 7 },
      sourceLabel: 'World Snapshot',
      sourceUrl: 'https://arena.ai/leaderboard/',
    },
  ])
}

function buildProductCatalog(companies: WorldCompanySignal[]): Omit<AIProduct, 'unlocked' | 'launched'>[] {
  const launches = companies.flatMap((company) =>
    company.recentLaunches.map((launch, index) => ({
      id: `${company.id}-launch-${index}`,
      name: launch,
      description: `${company.name} is part of the live race window right now. Shipping against this launch buys recurring compute and narrative control.`,
      cost: 700 + index * 350 + Math.round(company.sourceBackedStats.computePower * 0.3),
      revenuePerTick: Math.max(6, Math.round(company.sourceBackedStats.computePower / 160)),
      opinionEffect: clamp(Math.round((company.sourceBackedStats.publicOpinion - 50) / 7), -6, 12),
    })),
  )

  if (launches.length > 0) {
    return launches.slice(0, 12)
  }

  return [
    {
      id: 'fallback-model-window',
      name: 'Frontier Model Window',
      description: 'A live release slot tied to the current leaderboard cycle.',
      cost: 1_000,
      revenuePerTick: 8,
      opinionEffect: 4,
    },
  ]
}

function buildFallbackSnapshot(now: number): WorldSnapshot {
  const companies = COMPANY_BOTS.map((company, index) => {
    const launches = [`${company.name} frontier release`, `${company.name} API update`]
    const stats = createEmptyStats()
    stats.computePower += index * 140
    stats.publicOpinion += (index % 3) * 4
    stats.vcFunding += index * 420
    stats.launches = launches
    stats.confidence = 0.25

    return {
      id: company.id,
      name: company.name,
      color: company.color,
      tagline: company.tagline,
      strategy: company.strategy,
      sourceBackedStats: stats,
      recentLaunches: launches,
      sourceLinks: [company.officialNewsUrl],
      lastUpdatedAt: now,
    }
  })

  return {
    asOf: now,
    windowStart: now - GAME_CONFIG.WORLD_SYNC_INTERVAL_MS,
    windowEnd: now,
    status: 'fallback',
    sources: COMPANY_BOTS.map((company) => ({
      id: `${company.id}-fallback`,
      label: `${company.name} fallback`,
      url: company.officialNewsUrl,
      status: 'error',
      checkedAt: now,
      detail: 'Using bundled fallback data because live fetch failed.',
    })),
    companies,
    events: companies.slice(0, 4).map((company, index) => ({
      id: `fallback-event-${company.id}`,
      title: `${company.name} stays in the race`,
      summary: `${company.name} is still represented in the live mirror while the next external sync is unavailable.`,
      companyIds: [company.id],
      sourceLabel: 'Bundled fallback',
      sourceUrl: company.sourceLinks[0] ?? 'https://artificialanalysis.ai/leaderboards/models/',
      publishedAt: now - index * 60_000,
      impacts: [
        {
          companyId: company.id,
          effects: {
            computePower: 120 + index * 20,
            publicOpinion: 3,
            vcFunding: 220 + index * 35,
          },
        },
      ],
    })),
    contracts: buildContracts(companies),
    productCatalog: buildProductCatalog(companies),
  }
}

async function fetchText(fetchImpl: FetchLike, url: string) {
  const response = await fetchImpl(url, {
    headers: {
      'user-agent': 'slopzilla/1.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return await response.text()
}

export async function buildWorldSnapshot(fetchImpl: FetchLike = fetch, now = Date.now()): Promise<WorldSnapshot> {
  const sources: WorldSourceStatus[] = []
  const aaRows: ParsedLeaderboardRow[] = []
  const arenaRows: ParsedLeaderboardRow[] = []
  const officialHeadlines: OfficialHeadline[] = []

  try {
    const html = await fetchText(fetchImpl, 'https://artificialanalysis.ai/leaderboards/models/')
    aaRows.push(...parseArtificialAnalysisRows(html))
    sources.push({
      id: 'artificial-analysis',
      label: 'Artificial Analysis',
      url: 'https://artificialanalysis.ai/leaderboards/models/',
      status: 'ok',
      checkedAt: now,
      detail: `Parsed ${aaRows.length} leaderboard rows.`,
    })
  } catch (error) {
    sources.push({
      id: 'artificial-analysis',
      label: 'Artificial Analysis',
      url: 'https://artificialanalysis.ai/leaderboards/models/',
      status: 'error',
      checkedAt: now,
      detail: error instanceof Error ? error.message : 'Unknown fetch error.',
    })
  }

  try {
    const html = await fetchText(fetchImpl, 'https://arena.ai/leaderboard/')
    arenaRows.push(...parseArenaRows(html))
    sources.push({
      id: 'arena',
      label: 'Arena',
      url: 'https://arena.ai/leaderboard/',
      status: 'ok',
      checkedAt: now,
      detail: `Parsed ${arenaRows.length} leaderboard rows.`,
    })
  } catch (error) {
    sources.push({
      id: 'arena',
      label: 'Arena',
      url: 'https://arena.ai/leaderboard/',
      status: 'error',
      checkedAt: now,
      detail: error instanceof Error ? error.message : 'Unknown fetch error.',
    })
  }

  for (const company of COMPANY_BOTS) {
    try {
      const html = await fetchText(fetchImpl, company.officialNewsUrl)
      const parsed = parseOfficialHeadlines(html, company.officialNewsUrl, company.id, company.name)
      officialHeadlines.push(...parsed)
      sources.push({
        id: `${company.id}-official`,
        label: `${company.name} official`,
        url: company.officialNewsUrl,
        status: 'ok',
        checkedAt: now,
        detail: parsed.length > 0 ? `Found ${parsed.length} headline(s).` : 'Fetched with no usable AI headline.',
      })
    } catch (error) {
      sources.push({
        id: `${company.id}-official`,
        label: `${company.name} official`,
        url: company.officialNewsUrl,
        status: 'error',
        checkedAt: now,
        detail: error instanceof Error ? error.message : 'Unknown fetch error.',
      })
    }
  }

  if (aaRows.length === 0 && arenaRows.length === 0) {
    return buildFallbackSnapshot(now)
  }

  const companies: WorldCompanySignal[] = COMPANY_BOTS.map((company) => {
    const companyAaRows = aaRows
      .filter((row) => row.companyId === company.id)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 4)
    const companyArenaRows = arenaRows
      .filter((row) => row.companyId === company.id)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 4)
    const launches = dedupeById(
      [...companyAaRows, ...companyArenaRows].map((row, index) => ({
        id: `${company.id}-launch-${index}-${row.modelName}`,
        value: row.modelName,
      })),
    ).map((entry) => entry.value)

    const sourceBackedStats = makeGameStats(company.id, companyAaRows, companyArenaRows, launches)
    const sourceLinks = dedupeById(
      [...companyAaRows, ...companyArenaRows].map((row, index) => ({
        id: `${company.id}-source-link-${index}`,
        value: row.url,
      })),
    ).map((entry) => entry.value)

    return {
      id: company.id,
      name: company.name,
      color: company.color,
      tagline: company.tagline,
      strategy: company.strategy as CompanyStrategy,
      sourceBackedStats,
      recentLaunches: launches.slice(0, 4),
      sourceLinks: sourceLinks.length > 0 ? sourceLinks : [company.officialNewsUrl],
      lastUpdatedAt: now,
    }
  })

  const events: WorldEvent[] = dedupeById([
    ...companies
      .filter((company) => company.recentLaunches.length > 0)
      .map((company, index) => ({
        id: `leaderboard-launch-${company.id}`,
        title: `${company.name} is in the current leaderboard cycle`,
        summary: `${company.name} is showing fresh launch pressure through ${company.recentLaunches[0]}.`,
        companyIds: [company.id],
        sourceLabel: company.sourceBackedStats.artificialAnalysisRank ? 'Artificial Analysis' : 'Arena',
        sourceUrl: company.sourceLinks[0] ?? 'https://artificialanalysis.ai/leaderboards/models/',
        publishedAt: now - index * 120_000,
        impacts: [
          {
            companyId: company.id,
            effects: makeEventEffects(company.sourceBackedStats),
          },
        ],
      })),
    ...officialHeadlines.map((headline, index) => {
      const company = companies.find((candidate) => candidate.id === headline.companyId)
      const baseStats = company?.sourceBackedStats ?? createEmptyStats()
      return {
        id: `official-${headline.companyId}-${index}`,
        title: headline.title,
        summary: `${headline.companyName} posted a fresh official update that is now part of the race mirror.`,
        companyIds: [headline.companyId],
        sourceLabel: `${headline.companyName} official`,
        sourceUrl: headline.url,
        publishedAt: now - index * 180_000,
        impacts: [
          {
            companyId: headline.companyId,
            effects: {
              computePower: Math.max(80, Math.round(baseStats.computePower * 0.08)),
              publicOpinion: 4,
              vcFunding: Math.max(120, Math.round(baseStats.vcFunding * 0.03)),
            },
          },
        ],
      }
    }),
  ]).slice(0, 12)

  const okSources = sources.filter((source) => source.status === 'ok').length
  const status = okSources >= 2 ? 'fresh' : 'stale'

  return {
    asOf: now,
    windowStart: now - GAME_CONFIG.WORLD_SYNC_INTERVAL_MS,
    windowEnd: now,
    status,
    sources,
    companies,
    events,
    contracts: buildContracts(companies),
    productCatalog: buildProductCatalog(companies),
  }
}
