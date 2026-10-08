import { handleSharpOddsRequest } from '../base44/functions/refreshSharpOddsDatabase/entry.ts';

const outputRoot = Deno.env.get('SHARP_ODDS_OUTPUT_DIR')?.trim();
if (!outputRoot) throw new Error('SHARP_ODDS_OUTPUT_DIR is required');

const cacheBase = `${outputRoot.replace(/\/$/, '')}/sharp-odds/ncaaf`;
const eventsDir = `${cacheBase}/events`;
const indexPath = `${cacheBase}/index.json`;
const keepSince = Date.now() - 6 * 60 * 60 * 1000;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await Deno.readTextFile(path)) as T; }
  catch (error) {
    if (error instanceof Deno.errors.NotFound) return fallback;
    throw error;
  }
}

function safeId(key: string) {
  return btoa(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

type IndexEntry = {
  canonical_event_key: string;
  game_date: string;
  away_team_abbr: string;
  home_team_abbr: string;
  away_team_name: string;
  home_team_name: string;
  start_time: string | null;
  path: string;
};

type CacheFile = { sport: string; updated_at: string; rows: Record<string, unknown>[] };

function compactSnapshotRow(row: Record<string, any>) {
  const allowedSides: Record<string, Set<string>> = {
    moneyline: new Set(['away', 'home', 'draw']),
    spread: new Set(['away', 'home']),
    total: new Set(['over', 'under']),
  };
  const markets = (Array.isArray(row?.markets) ? row.markets : []).flatMap((market: Record<string, any>) => {
    const type = String(market?.market_type || '').toLowerCase().replace(/[_-]/g, '');
    const marketType = type === 'moneyline' || type === 'h2h' ? 'moneyline'
      : type === 'spread' || type === 'pointspread' || type === 'runline' || type === 'handicap' ? 'spread'
      : type === 'total' || type === 'totalpoints' || type === 'totalruns' || type === 'overunder' ? 'total' : '';
    const side = String(market?.side || '').toLowerCase();
    const period = String(market?.period || market?.period_type || market?.market_period || 'full_game').toLowerCase();
    const labels = [market?.market_name, market?.raw_market_name, market?.prop_key, market?.period_name, market?.period_label]
      .map((value) => String(value || '').toLowerCase()).join(' ');
    if (!marketType || !allowedSides[marketType].has(side)
      || !['full_game', 'game', '0', 'match'].includes(period)
      || /player|pitcher|batter|team total|strikeout|passing|rushing|receiving|assists|rebounds|blocks|steals|first half|second half|quarter|first five|1st 5|\bf5\b/.test(labels)) return [];
    const bookmakers = (Array.isArray(market?.bookmakers) ? market.bookmakers : []).flatMap((book: Record<string, any>) => {
      const odds = Number(book?.odds);
      if (!Number.isFinite(odds) || odds === 0 || book?.available === false || book?.has_price === false) return [];
      return [{
        bookmaker_id: book?.bookmaker_id || book?.key || book?.book || null,
        source: book?.source || null,
        odds,
        line: book?.line ?? market?.line ?? null,
        available: book?.available,
        has_price: book?.has_price,
        source_updated_at: book?.source_updated_at || null,
        period: book?.period || period,
      }];
    });
    if (!bookmakers.length) return [];
    return [{
      market_type: marketType,
      side,
      line: market?.line ?? null,
      period,
      quote_type: market?.quote_type || 'current',
      is_main_line: market?.is_main_line,
      is_alternate_line: market?.is_alternate_line,
      market_name: market?.market_name || null,
      raw_market_name: market?.raw_market_name || null,
      prop_key: market?.prop_key || null,
      period_name: market?.period_name || null,
      period_label: market?.period_label || null,
      period_description: market?.period_description || null,
      participant: market?.participant || null,
      participant_id: market?.participant_id || null,
      bookmakers,
    }];
  });
  return {
    snapshot_key: row?.snapshot_key,
    source: row?.source,
    sport: 'ncaaf',
    league: row?.league || 'NCAAF',
    canonical_event_key: row?.canonical_event_key,
    game_date: row?.game_date,
    start_time: row?.start_time || null,
    captured_at: row?.captured_at,
    home_team_id: row?.home_team_id,
    home_team_name: row?.home_team_name,
    home_team_abbr: row?.home_team_abbr,
    away_team_id: row?.away_team_id,
    away_team_name: row?.away_team_name,
    away_team_abbr: row?.away_team_abbr,
    source_event_ids: row?.source_event_ids || {},
    event_status: row?.event_status || {},
    markets,
    market_count: markets.length,
    observation_count: markets.reduce((sum: number, market: any) => sum + market.bookmakers.length, 0),
    snapshot_chunk_index: row?.snapshot_chunk_index || 1,
    snapshot_chunk_count: row?.snapshot_chunk_count || 1,
  };
}

const priorIndex = await readJson<{ events?: IndexEntry[] }>(indexPath, { events: [] });
const existingRows = new Map<string, Record<string, unknown>[]>();
const entries = new Map<string, IndexEntry>();

for (const entry of priorIndex.events || []) {
  if (!entry?.canonical_event_key || !entry.path?.startsWith('sharp-odds/ncaaf/events/')) continue;
  const absolutePath = `${outputRoot}/${entry.path}`;
  const cache = await readJson<CacheFile | null>(absolutePath, null);
  if (!cache || !Array.isArray(cache.rows)) continue;
  const gameStart = Date.parse(String(entry.start_time || ''));
  const eventCutoff = Number.isFinite(gameStart) && gameStart < Date.now() ? gameStart - 5 * 60 * 60 * 1000 : keepSince;
  const freshRows = cache.rows.filter((row) => {
    const capturedAt = Date.parse(String(row?.captured_at || ''));
    return Number.isFinite(capturedAt) && capturedAt >= eventCutoff && (!Number.isFinite(gameStart) || gameStart >= Date.now() || capturedAt <= gameStart);
  });
  if (!freshRows.length) continue;
  existingRows.set(entry.canonical_event_key, freshRows);
  entries.set(entry.canonical_event_key, entry);
}

const newRows: Record<string, unknown>[] = [];
const fileWriter = {
  asServiceRole: {
    entities: {
      SharpOddsDatabase: {
        bulkCreate: async (batch: Record<string, any>[]) => { newRows.push(...batch.map(compactSnapshotRow)); },
        create: async (row: Record<string, any>) => { newRows.push(compactSnapshotRow(row)); },
      },
    },
  },
};

const request = new Request('https://github-actions.local/refresh', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'refresh', sport: 'ncaaf', preview: false, lookaheadDays: 14 }),
});
const response = await handleSharpOddsRequest(request, fileWriter);
const result = await response.json();
if (!response.ok || result?.ok !== true) {
  throw new Error(`NCAAF SharpOdds refresh failed (HTTP ${response.status}): ${JSON.stringify(result).slice(0, 1500)}`);
}

const newRowsByEvent = new Map<string, Record<string, unknown>[]>();
for (const row of newRows) {
  const key = String(row?.canonical_event_key || '');
  if (!key) continue;
  if (!newRowsByEvent.has(key)) newRowsByEvent.set(key, []);
  newRowsByEvent.get(key)!.push(row);
  entries.set(key, {
    canonical_event_key: key,
    game_date: String(row.game_date || ''),
    away_team_abbr: String(row.away_team_abbr || ''),
    home_team_abbr: String(row.home_team_abbr || ''),
    away_team_name: String(row.away_team_name || ''),
    home_team_name: String(row.home_team_name || ''),
    start_time: row.start_time == null ? null : String(row.start_time),
    path: `sharp-odds/ncaaf/events/${safeId(key)}.json`,
  });
}

await Deno.mkdir(eventsDir, { recursive: true });
for (const [key, entry] of entries) {
  const prior = existingRows.get(key) || [];
  const incoming = newRowsByEvent.get(key) || [];
  const gameStart = Date.parse(String(entry.start_time || ''));
  const eventCutoff = Number.isFinite(gameStart) && gameStart < Date.now() ? gameStart - 5 * 60 * 60 * 1000 : keepSince;
  const bySnapshotKey = new Map<string, Record<string, unknown>>();
  for (const row of [...prior, ...incoming]) {
    const capturedAt = Date.parse(String(row?.captured_at || ''));
    if (!Number.isFinite(capturedAt) || capturedAt < eventCutoff
      || (Number.isFinite(gameStart) && gameStart < Date.now() && capturedAt > gameStart)) continue;
    const snapshotKey = String(row?.snapshot_key || `${key}:${row?.captured_at || ''}:${row?.snapshot_chunk_index || 1}`);
    bySnapshotKey.set(snapshotKey, row);
  }
  const rows = [...bySnapshotKey.values()].sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))
    || Number(a.snapshot_chunk_index || 1) - Number(b.snapshot_chunk_index || 1));
  if (!rows.length) {
    entries.delete(key);
    await Deno.remove(`${outputRoot}/${entry.path}`).catch(() => {});
    continue;
  }
  const file: CacheFile = { sport: 'ncaaf', updated_at: new Date().toISOString(), rows };
  await Deno.writeTextFile(`${outputRoot}/${entry.path}`, `${JSON.stringify(file)}\n`);
}

const index = {
  sport: 'ncaaf',
  updated_at: new Date().toISOString(),
  events: [...entries.values()].sort((a, b) => a.game_date.localeCompare(b.game_date)
    || a.away_team_abbr.localeCompare(b.away_team_abbr)
    || a.home_team_abbr.localeCompare(b.home_team_abbr)),
  refresh: {
    game_date: result.game_date,
    lookahead_days: result.lookahead_days,
    snapshots: result.snapshots_written,
    games: result.games_normalized,
  },
};
await Deno.writeTextFile(indexPath, `${JSON.stringify(index)}\n`);
console.info(`Published NCAAF SharpOdds cache: ${index.events.length} games, ${result.snapshots_written} snapshot chunks.`);
