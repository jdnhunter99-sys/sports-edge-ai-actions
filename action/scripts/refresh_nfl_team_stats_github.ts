import {
  handleNFLTeamStatsRefresh,
  NFL_TEAM_STATS_TEAMS,
} from '../base44/functions/refreshNFLGameDetailTeamStatsCache/entry.ts';

const outputRoot = Deno.env.get('NFL_TEAM_STATS_OUTPUT_DIR')?.trim();
if (!outputRoot) throw new Error('NFL_TEAM_STATS_OUTPUT_DIR is required');

const CACHE_VERSION = 1;
const sportRoot = `${outputRoot.replace(/\/$/, '')}/nfl-team-stats`;
const cacheRoot = `${sportRoot}/v${CACHE_VERSION}`;
const updatedAt = new Date().toISOString();

// Match the two season selectors currently shown in NFL game detail.
const TIMEFRAMES = ['2025', '2026', 'L5', 'L10', 'L15'];

type RecordValue = Record<string, any>;

function matchesFilter(row: RecordValue, filter: RecordValue = {}) {
  for (const [key, expected] of Object.entries(filter || {})) {
    const actual = row[key];
    if (expected && typeof expected === 'object' && Array.isArray((expected as any).$in)) {
      if (!(expected as any).$in.map(String).includes(String(actual ?? ''))) return false;
    } else if (expected && typeof expected === 'object' && '$ne' in (expected as any)) {
      if (String(actual ?? '') === String((expected as any).$ne ?? '')) return false;
    } else if (String(actual ?? '') !== String(expected ?? '')) {
      return false;
    }
  }
  return true;
}

function createMemoryEntity(name: string) {
  const rows = new Map<string, RecordValue>();
  let sequence = 0;

  return {
    rows,
    filter: async (filter: RecordValue = {}, orderBy = '', limit?: number) => {
      let selected = [...rows.values()].filter((row) => matchesFilter(row, filter));
      // The NFL refresh engine only relies on exact filter matches. Keep the
      // adapter's order/limit behavior for compatibility with its Base44 reads.
      if (typeof orderBy === 'string' && orderBy) {
        const descending = orderBy.startsWith('-');
        const field = descending ? orderBy.slice(1) : orderBy;
        selected = selected.sort((a, b) => {
          const comparison = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
          return descending ? -comparison : comparison;
        });
      }
      return Number.isFinite(Number(limit)) ? selected.slice(0, Number(limit)) : selected;
    },
    create: async (record: RecordValue) => {
      const saved = { ...record, id: record.id || `github-${name}-${++sequence}` };
      // The engine keeps the full league context in its own process-memory map.
      // Avoid duplicating those large serialized snapshots in this adapter.
      if (name === 'LineupCache' && String(saved.cache_date || '').startsWith('nflverse_league_context_')) return saved;
      rows.set(String(saved.id), saved);
      return saved;
    },
    update: async (id: string, record: RecordValue) => {
      const existing = rows.get(String(id)) || {};
      const saved = { ...existing, ...record, id: String(id) };
      if (!(name === 'LineupCache' && String(saved.cache_date || '').startsWith('nflverse_league_context_'))) {
        rows.set(String(id), saved);
      }
      return saved;
    },
    deleteMany: async (filter: RecordValue = {}) => {
      let deleted = 0;
      for (const [id, row] of rows.entries()) {
        if (!matchesFilter(row, filter)) continue;
        rows.delete(id);
        deleted += 1;
      }
      return { deleted };
    },
  };
}

const teamStatsEntity = createMemoryEntity('NFLGameDetailTeamStatsCache');
const base44 = {
  asServiceRole: {
    entities: {
      NFLGameDetailTeamStatsCache: teamStatsEntity,
      NFLGameDetailCache: createMemoryEntity('NFLGameDetailCache'),
      LineupCache: createMemoryEntity('LineupCache'),
    },
  },
};

const request = new Request('https://github-actions.local/nfl-team-stats-refresh', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeframes: TIMEFRAMES }),
});
const response = await handleNFLTeamStatsRefresh(request, base44);
const refreshResult = await response.json();
if (!response.ok || refreshResult?.ok !== true) {
  throw new Error(`NFL stats refresh failed (HTTP ${response.status}): ${JSON.stringify(refreshResult).slice(0, 2400)}`);
}

function normalizeTeamAbbr(value: unknown) {
  const raw = String(value || '').trim().toUpperCase();
  const aliases: Record<string, string> = {
    ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', GNB: 'GB', JAC: 'JAX', KAN: 'KC',
    LA: 'LAR', OAK: 'LV', SD: 'LAC', SFO: 'SF', TAM: 'TB', WAS: 'WSH',
    WFT: 'WSH', WDC: 'WSH',
  };
  return aliases[raw] || raw;
}

function parsePayload(row: RecordValue) {
  if (!row?.payload) return null;
  try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

function completeTeamPayload(rows: RecordValue[], season: number, timeframe: string, teamAbbr: string) {
  const baseKey = `nflverse_team_${season}_${timeframe}_${teamAbbr}`;
  const exact = rows
    .filter((row) => row.cache_key === baseKey)
    .map((row) => ({ row, payload: parsePayload(row) }))
    .find(({ payload }) => Array.isArray(payload?.stats) && payload.stats.length > 0 &&
      (!Number.isFinite(Number(payload.parts)) || Number(payload.parts) <= 1));
  if (exact) return exact;

  const parts = rows
    .filter((row) => String(row.cache_key || '').startsWith(`${baseKey}_p`))
    .map((row) => ({
      row,
      payload: parsePayload(row),
      index: Number(String(row.cache_key).slice(`${baseKey}_p`.length)),
    }))
    .filter((part) => Number.isInteger(part.index) && Array.isArray(part.payload?.stats));
  const requiredParts = parts.length ? Number(parts[0].payload.parts || 0) : 0;
  const partMap = new Map(parts.map((part) => [part.index, part]));
  if (!requiredParts || requiredParts > 10 || partMap.size !== requiredParts) return null;
  const ordered = Array.from({ length: requiredParts }, (_, index) => partMap.get(index)!);
  if (ordered.some((part) => !part)) return null;
  const latestScrapedAt = ordered
    .map((part) => String(part.row.scraped_at || ''))
    .sort()[0] || '';
  return {
    row: { scraped_at: latestScrapedAt },
    payload: {
      ...ordered[0].payload,
      stats: ordered.flatMap((part) => part.payload.stats),
      statsCount: ordered.reduce((count, part) => count + part.payload.stats.length, 0),
    },
  };
}

const indexSeasons: Record<string, any> = {};
for (const frame of refreshResult.frames || []) {
  const season = Number(frame.season);
  const timeframe = String(frame.timeframe);
  if (!Number.isInteger(season) || !timeframe) throw new Error('Refresh returned an invalid NFL season/timeframe frame.');
  if (Number(frame.cached_team_count) !== NFL_TEAM_STATS_TEAMS.length) {
    throw new Error(`Refusing to publish incomplete NFL ${season} ${timeframe}: ${frame.cached_team_count}/${NFL_TEAM_STATS_TEAMS.length} teams.`);
  }

  const rows = await teamStatsEntity.filter({ season, timeframe, side: 'team' });
  const teams: Record<string, RecordValue> = {};
  for (const expectedTeam of NFL_TEAM_STATS_TEAMS) {
    const teamAbbr = normalizeTeamAbbr(expectedTeam);
    const matchedRows = rows.filter((row) => normalizeTeamAbbr(row.team_abbr) === teamAbbr);
    const complete = completeTeamPayload(matchedRows, season, timeframe, teamAbbr);
    if (!complete?.payload?.stats?.length) {
      throw new Error(`Refusing to publish NFL ${season} ${timeframe}: ${teamAbbr} has no complete stats payload.`);
    }
    const scrapedAt = String(complete.row?.scraped_at || frame.scraped_at || updatedAt);
    teams[teamAbbr] = {
      ...complete.payload,
      teamAbbr,
      timeframe,
      scrapedAt,
      cacheVersion: CACHE_VERSION,
    };
  }

  const teamCount = Object.keys(teams).length;
  if (teamCount !== NFL_TEAM_STATS_TEAMS.length) {
    throw new Error(`Refusing to publish incomplete NFL ${season} ${timeframe}: materialized ${teamCount}/${NFL_TEAM_STATS_TEAMS.length} teams.`);
  }

  const frameUpdatedAt = Object.values(teams)
    .map((team) => String(team.scrapedAt || ''))
    .sort()
    .at(-1) || updatedAt;
  const snapshotId = `nfl-${season}-${timeframe.toLowerCase()}-${Date.parse(frameUpdatedAt) || Date.now()}`;
  const relativePath = `nfl-team-stats/v${CACHE_VERSION}/${season}/${timeframe.toLowerCase()}.json`;
  const fullPath = `${outputRoot.replace(/\/$/, '')}/${relativePath}`;
  await Deno.mkdir(`${cacheRoot}/${season}`, { recursive: true });
  await Deno.writeTextFile(fullPath, `${JSON.stringify({
    sport: 'nfl',
    schemaVersion: 1,
    cacheVersion: CACHE_VERSION,
    season,
    timeframe,
    updated_at: frameUpdatedAt,
    snapshot_id: snapshotId,
    rank_population: 'all 32 NFL teams',
    team_count: teamCount,
    teams,
  })}\n`);

  if (!indexSeasons[String(season)]) {
    indexSeasons[String(season)] = {
      season,
      updated_at: frameUpdatedAt,
      timeframes: {},
    };
  }
  indexSeasons[String(season)].updated_at = frameUpdatedAt;
  indexSeasons[String(season)].timeframes[timeframe] = {
    path: relativePath,
    teams: teamCount,
    scraped_at: frameUpdatedAt,
  };
  console.info(`Materialized NFL season ${season} ${timeframe}: ${teamCount} teams.`);
}

await Deno.mkdir(sportRoot, { recursive: true });
await Deno.writeTextFile(`${sportRoot}/index.json`, `${JSON.stringify({
  sport: 'nfl',
  schemaVersion: 1,
  cacheVersion: CACHE_VERSION,
  updated_at: new Date().toISOString(),
  seasons: indexSeasons,
})}\n`);
console.info(`Published ${Object.values(indexSeasons).reduce((sum: number, season: any) => sum + Object.keys(season.timeframes).length, 0)} NFL timeframe frames.`);
