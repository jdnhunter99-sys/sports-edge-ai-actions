import { handleCFBTeamStatsRefresh } from '../base44/functions/refreshCFBGameDetailTeamStatsCache/entry.ts';
import { normalizeCFBSchool } from '../base44/shared/cfbTeamIdentity.ts';

const outputRoot = Deno.env.get('CFB_STATS_OUTPUT_DIR')?.trim();
if (!outputRoot) throw new Error('CFB_STATS_OUTPUT_DIR is required');
if (!Deno.env.get('CFBD_API_KEY')?.trim()) throw new Error('CFBD_API_KEY is required');

const CACHE_VERSION = 27;
const cacheRoot = `${outputRoot.replace(/\/$/, '')}/cfb-team-stats/v${CACHE_VERSION}`;
const indexPath = `${outputRoot.replace(/\/$/, '')}/cfb-team-stats/index.json`;
const TIMEFRAMES = ['season', 'L5', 'L10', 'L15'];
const currentSeason = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
})();
const previousSeason = currentSeason - 1;
const refreshPrevious = Deno.env.get('CFB_REFRESH_PREVIOUS_SEASON') === 'true';
const integrityDiscrepancies: string[] = [];

type TeamRecord = Record<string, any>;
type FrameManifest = { path: string; teams: number; scraped_at: string };
type CacheIndex = {
  sport?: string;
  cacheVersion?: number;
  updated_at?: string;
  seasons?: Record<string, { season: number; updated_at: string; timeframes: Record<string, FrameManifest> }>;
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await Deno.readTextFile(path)) as T; }
  catch (error) {
    if (error instanceof Deno.errors.NotFound) return fallback;
    throw error;
  }
}

function recordPath(season: number, timeframe: string) {
  return `${cacheRoot}/${season}/${timeframe.toLowerCase()}.json`;
}

function gameLogPath(season: number) {
  return `${cacheRoot}/${season}/game-logs.json`;
}

const index = await readJson<CacheIndex>(indexPath, { seasons: {} });
const seasons = { ...(index.seasons || {}) };
const teamRows = new Map<string, TeamRecord>();
let syntheticId = 0;

function matchesFilter(row: TeamRecord, filter: TeamRecord = {}) {
  for (const [key, expected] of Object.entries(filter)) {
    if (expected && typeof expected === 'object' && Array.isArray((expected as any).$in)) {
      if (!(expected as any).$in.map(String).includes(String(row[key]))) return false;
    } else if (String(row[key] ?? '') !== String(expected ?? '')) return false;
  }
  return true;
}

const statsEntity = {
  filter: async (filter: TeamRecord = {}) => [...teamRows.values()].filter((row) => matchesFilter(row, filter)),
  create: async (row: TeamRecord) => {
    const saved = { ...row, id: row.id || `cfb-stats-${++syntheticId}` };
    teamRows.set(String(saved.cache_key), saved);
    return saved;
  },
  update: async (id: string, row: TeamRecord) => {
    const existing = [...teamRows.values()].find((item) => String(item.id) === String(id));
    const saved = { ...existing, ...row, id: String(id) };
    teamRows.set(String(saved.cache_key), saved);
    return saved;
  },
};

// The stats engine's source-cache writes are no-ops here: every refresh is a
// single process that fetches source rows once, then shares them across all
// requested timeframes in memory. Published output contains only materialized
// team stats, not the much larger raw game/play payloads.
const sourceEntity = {
  filter: async (_filter: TeamRecord = {}) => [],
  create: async (row: TeamRecord) => row,
  update: async (_id: string, row: TeamRecord) => row,
  bulkCreate: async (_rows: TeamRecord[]) => [],
  bulkUpdate: async (_rows: TeamRecord[]) => [],
  deleteMany: async (_filter: TeamRecord) => ({ deleted: 0 }),
};

const base44Adapter = {
  asServiceRole: {
    entities: {
      CFBGameDetailTeamStatsCache: statsEntity,
      CFBGameDetailSourceCache: sourceEntity,
    },
  },
};

async function refreshSeason(season: number, isPrevious: boolean) {
  teamRows.clear();
  const priorSeasonLogs = await readJson<any>(gameLogPath(season - 1), null);
  const request = new Request('https://github-actions.local/cfb-stats-refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      season,
      previousSeason: isPrevious,
      priorSeasonLogs,
      includeGameLogs: true,
      timeframes: TIMEFRAMES,
      limit: 180,
      offset: 0,
      force: true,
    }),
  });
  const response = await handleCFBTeamStatsRefresh(request, base44Adapter);
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error(`CFB stats refresh failed for ${season} (HTTP ${response.status}): ${JSON.stringify(result).slice(0, 1600)}`);
  }
  for (const discrepancy of Array.isArray(result?.discrepancies) ? result.discrepancies : []) {
    integrityDiscrepancies.push(`${season}: ${String(discrepancy)}`);
  }

  if (result?.gameLogs?.teams && Number(result?.gameLogs?.season) === season) {
    await Deno.mkdir(`${cacheRoot}/${season}`, { recursive: true });
    await Deno.writeTextFile(gameLogPath(season), `${JSON.stringify(result.gameLogs)}\n`);
  } else {
    throw new Error(`CFB refresh did not return game logs for ${season}; rolling windows cannot be refreshed safely.`);
  }

  const writtenFrames: Record<string, FrameManifest> = {};
  let snapshotId = '';
  for (const timeframe of TIMEFRAMES) {
    const teamPayloads: Record<string, TeamRecord> = {};
    let latest = '';
    for (const row of teamRows.values()) {
      if (Number(row?.season) !== season || String(row?.timeframe) !== timeframe || row?.side !== 'team') continue;
      let payload: TeamRecord;
      try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
      catch { continue; }
      if (!payload?.stats || Number(payload?.cacheVersion) !== Number(result.cacheVersion)) continue;
      if (!['passed', 'completed_with_discrepancies'].includes(String(payload?.integrity?.status || ''))) {
        throw new Error(`${payload?.team || row.team_abbr} ${timeframe} has no completed integrity validation; refusing to publish.`);
      }
      if (Number(payload?.teamsRanked) !== Number(result.fbsTeamCount)) {
        throw new Error(`${payload?.team || row.team_abbr} ${timeframe} was ranked against ${payload?.teamsRanked} teams, expected ${result.fbsTeamCount}.`);
      }
      const rowSnapshotId = String(payload?.snapshotId || '');
      if (!rowSnapshotId) throw new Error(`${payload?.team || row.team_abbr} ${timeframe} is missing its source snapshot ID.`);
      if (snapshotId && rowSnapshotId !== snapshotId) {
        throw new Error(`Mixed source snapshots detected while materializing ${season} ${timeframe}.`);
      }
      snapshotId ||= rowSnapshotId;
      // Treat the full source team name as authoritative. Cached abbreviations
      // can collide across providers or divisions; a trustworthy name lets us
      // canonicalize the team without carrying a stale/wrong key forward.
      const key = normalizeCFBSchool(payload.team || payload.teamKey || row.team_abbr || '');
      if (!key) continue;
      teamPayloads[key] = payload;
      if (String(row.scraped_at || '') > latest) latest = String(row.scraped_at);
    }
    if (!Object.keys(teamPayloads).length) throw new Error(`No team records were materialized for ${season} ${timeframe}`);
    if (Object.keys(teamPayloads).length !== Number(result.fbsTeamCount)) {
      throw new Error(`Refusing to publish incomplete ${season} ${timeframe}: ${Object.keys(teamPayloads).length}/${result.fbsTeamCount} eligible FBS teams.`);
    }
    const virginiaTechKey = normalizeCFBSchool('VT');
    if (!teamPayloads[virginiaTechKey]) {
      const likelyVirginiaTechRows = Object.entries(teamPayloads)
        .filter(([key, payload]) => /virginia|hokie|\bvt\b/i.test(`${key} ${payload?.team || ''} ${payload?.teamKey || ''}`))
        .map(([key, payload]) => `${key}:${payload?.team || payload?.teamKey || ''}`)
        .slice(0, 8);
      const details = likelyVirginiaTechRows.length ? ` Similar rows: ${likelyVirginiaTechRows.join(', ')}.` : '';
      throw new Error(`Virginia Tech (${virginiaTechKey}) is missing from ${season} ${timeframe}; refusing to publish an incomplete CFB frame.${details}`);
    }
    const path = `cfb-team-stats/v${result.cacheVersion}/${season}/${timeframe.toLowerCase()}.json`;
    const fullPath = `${outputRoot.replace(/\/$/, '')}/${path}`;
    await Deno.mkdir(`${cacheRoot}/${season}`, { recursive: true });
    await Deno.writeTextFile(fullPath, `${JSON.stringify({
      sport: 'cfb',
      schemaVersion: 1,
      cacheVersion: result.cacheVersion,
      season,
      timeframe,
      updated_at: latest || result.scrapedAt || new Date().toISOString(),
      snapshot_id: snapshotId,
      rank_population: 'eligible FBS teams with at least one completed game in the selected timeframe',
      metric_definitions: result.metricDefinitions || {},
      team_count: Object.keys(teamPayloads).length,
      teams: teamPayloads,
    })}\n`);
    writtenFrames[timeframe] = {
      path,
      teams: Object.keys(teamPayloads).length,
      scraped_at: latest || result.scrapedAt || new Date().toISOString(),
    };
  }

  seasons[String(season)] = {
    season,
    updated_at: new Date().toISOString(),
    timeframes: writtenFrames,
  };
  console.info(`Materialized CFB season ${season}: ${result.fbsTeamCount} FBS teams, ${Object.keys(writtenFrames).length} timeframes.`);
  return result;
}

const historicalFramePaths = TIMEFRAMES.map((timeframe) => seasons[String(previousSeason)]?.timeframes?.[timeframe]?.path || '');
const historicalHasCurrentVersion = historicalFramePaths.every((path) => path.includes(`/v${CACHE_VERSION}/${previousSeason}/`));
const historicalGameLogsExist = await Deno.stat(gameLogPath(previousSeason)).then(() => true).catch(() => false);
const historicalAlreadyPresent = historicalHasCurrentVersion && historicalGameLogsExist;
let refreshedSeasonCount = 0;
let quotaExhausted = false;
async function refreshUnlessQuotaExceeded(season: number, isPrevious: boolean) {
  try {
    await refreshSeason(season, isPrevious);
    refreshedSeasonCount++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/monthly call quota exceeded/i.test(message)) {
      if (isPrevious) {
        integrityDiscrepancies.push(`${season}: previous-season refresh could not complete: ${message}`);
        console.warn(`Previous-season refresh failed for ${season}; retaining any existing cache and continuing with ${currentSeason}: ${message}`);
        return;
      }
      throw error;
    }
    quotaExhausted = true;
    console.warn(`CFBD monthly quota is exhausted; keeping the last published cache for ${season}.`);
  }
}
// Current-season stats are the primary output, so spend quota on them first.
// A prior-season integrity error can no longer prevent this season from being
// materialized; it is logged as a warning above and any existing cache remains.
await refreshUnlessQuotaExceeded(currentSeason, false);
if (!quotaExhausted && (refreshPrevious || !historicalAlreadyPresent)) {
  await refreshUnlessQuotaExceeded(previousSeason, true);
} else if (!refreshPrevious && historicalAlreadyPresent) {
  console.info(`Keeping existing previous-season (${previousSeason}) materialization; set CFB_REFRESH_PREVIOUS_SEASON=true to rebuild it.`);
}

const finalIndex = {
  sport: 'cfb',
  schemaVersion: 1,
  cacheVersion: CACHE_VERSION,
  updated_at: refreshedSeasonCount > 0 ? new Date().toISOString() : (index.updated_at || new Date().toISOString()),
  seasons,
};
await Deno.mkdir(`${outputRoot.replace(/\/$/, '')}/cfb-team-stats`, { recursive: true });
await Deno.writeTextFile(indexPath, `${JSON.stringify(finalIndex, null, 2)}\n`);
const discrepancyReport = {
  sport: 'cfb',
  cacheVersion: CACHE_VERSION,
  generated_at: new Date().toISOString(),
  discrepancy_count: integrityDiscrepancies.length,
  discrepancies: integrityDiscrepancies,
};
await Deno.writeTextFile(
  `${outputRoot.replace(/\/$/, '')}/cfb-team-stats/integrity-discrepancies.json`,
  `${JSON.stringify(discrepancyReport, null, 2)}\n`,
);
console.info(`Published CFB stats cache index for seasons ${Object.keys(seasons).sort().join(', ')}.`);
if (integrityDiscrepancies.length) {
  console.warn(`CFB integrity discrepancies (${integrityDiscrepancies.length}):`);
  for (const discrepancy of integrityDiscrepancies) console.warn(`- ${discrepancy}`);
} else {
  console.info('CFB integrity discrepancies: none.');
}
