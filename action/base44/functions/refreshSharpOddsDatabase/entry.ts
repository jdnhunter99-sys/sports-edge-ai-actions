// SharpOddsDatabase unified multi-sport raw odds collector (MLB / NFL / NCAAF / WNBA).
//
// Base44 secret required:
//   SHARP_API_KEY -> every sportsbook/market enabled for the account tier via SharpAPI (Kalshi excluded).
//
// Public/read-only connectors:
//   VSiN -> every sportsbook column exposed by the VSiN line tracker
//   Novig -> NBX v2 OAuth REST preferred; official read-only GraphQL fallback for odds.
//   Polymarket -> official public Polymarket US sports API (Gamma fallback)
//   Rebet -> CloudFront sportsbook JSON (MLB: sr:sport:3 / sr:tournament:109)
//
//   Pinnacle -> Arcadia guest web API using PINNACLE_GUEST_API_KEY.
//     Matchups: /0.1/leagues/246/matchups
//     Markets:  /0.1/sports/3/markets/straight?primaryOnly=false&withSpecials=true
//
// Storage is intentionally append-only: every poll is written even when prices
// are identical to the prior poll.

import { fetchRebetOdds, rebetProbe } from '../../shared/rebetOdds.ts';
import { fetchSharpOdds } from '../../shared/sharpApiOdds.ts';
import { createSharpSnapshotWriter } from '../../shared/sharpOddsStorage.ts';
import { buildSnapshotRecord, chunkSnapshotRecord } from '../../shared/sharpOddsSnapshot.ts';
import { getSportConfig, inferTeamSideForSport } from '../../shared/sharpOddsSports.ts';
import {
  MLB_TEAMS, DEFAULT_TIMEZONE, AnyObject, SourceGame,
  normalizeText, canonicalMlbTeam, normalizeBookKey, normalizeMarketType, normalizeRawMarketType, normalizeMarketPeriod,
  parseLineFromSelection, parseAmericanOdds, formatAmerican, americanToProbability,
  probabilityToAmerican, probabilityOrNull, makeSourceGame, makeBook, hasSourceGamePrice, addBookObservation,
  dedupeSourceGames, priceObject, exchangePriceObject, polyPriceObject, exchangeProb,
  marketTeamMention, extractMarketLine, parseMatchupTitle, inferTeamSide,
  parseJsonArray, finiteOrNull, stringOrNull, isoOrNull, maxIso, maxIsoList,
  firstNonNull, firstNonEmpty, clampInt, addDaysDate, sleep, safeJson,
  todayInTimeZone, localDateForIso, dateIsInWindow, startIsInWindow,
  parseVsinAmericanOdds, parseVsinSpreadCell, parseVsinTotalCell, parseVsinUpdatedText,
  extractVsinGameTime, easternGameTimeToIso, parseEasternTimestamp,
  extractTableCells, cleanTeamText, zonedDateTimeToUtc,
} from '../../shared/sharpOddsCommon.ts';

const SOURCE = 'sharp_odds_database';
const DEFAULT_LEAGUE = 'MLB';
const DEFAULT_SPORT = 'mlb';
const POLY_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const POLY_US_BASE = 'https://gateway.polymarket.us';
const PINNACLE_ARCADIA_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
// Novig's .com API hosts sit behind a CloudFront WAF that blocks Base44's
// serverless egress with a 403. The .us hosts serve the same NBX REST + GraphQL
// APIs and are reachable from the function runtime.
const NOVIG_AUTH_URL = 'https://api.novig.us/nbx/v1/auth/emm-token';
const NOVIG_API_BASE = 'https://api.novig.us/nbx/v2';


const DIRECT_CONNECTOR_BOOKS = [
  'novig',
  'polymarket',
  'circa',
  'boomers',
  'betmgm',
  'caesars',
  'westgate',
  'stations',
  'southpoint',
  'wynn',
  'pinnacle',
  'rebet',
];

const VSIN_BOOKS = [
  { index: 0, key: 'circa' },
  { index: 1, key: 'boomers' },
  { index: 2, key: 'betmgm' },
  { index: 3, key: 'caesars' },
  { index: 4, key: 'westgate' },
  { index: 5, key: 'stations' },
  { index: 6, key: 'southpoint' },
  { index: 7, key: 'wynn' },
];



export async function handleSharpOddsRequest(req: Request, injectedBase44: any = null) {
  let base44: any = null;
  try {
    // Keep the Base44 SDK out of the GitHub Actions dependency graph. The
    // NCAAF publisher injects its file-backed writer and only needs the shared
    // collector logic; load the SDK lazily for actual Base44 invocations.
    if (injectedBase44) {
      base44 = injectedBase44;
    } else {
      const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.38');
      base44 = createClientFromRequest(req);
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'refresh').trim().toLowerCase();

    if (action === 'read') {
      const eventKey = String(body?.canonical_event_key || body?.eventKey || '').trim();
      const readSportInput = String(body?.sport || '').trim().toLowerCase();
      const readSportConfig = readSportInput ? getSportConfig(readSportInput) : null;
      const readSport = readSportConfig?.key || readSportInput;
      const league = String(body?.league || (readSportConfig?.label || (readSport ? readSport.toUpperCase() : DEFAULT_LEAGUE))).trim().toUpperCase();
      const gameDate = String(body?.gameDate || body?.date || todayInTimeZone(DEFAULT_TIMEZONE)).slice(0, 10);
      const limit = clampInt(body?.limit, 1, 500, 250);
      const filter: AnyObject = eventKey
        ? { canonical_event_key: eventKey }
        : (readSport ? { sport: readSport, game_date: gameDate } : { league, game_date: gameDate });
      const rows = await base44.asServiceRole.entities.SharpOddsDatabase
        .filter(filter, 'captured_at', limit)
        .catch(() => []);
      return Response.json({ ok: true, action: 'read', filter, count: rows?.length || 0, rows: rows || [] });
    }

    if (action === 'sources') {
      return Response.json({
        ok: true,
        entity: 'SharpOddsDatabase',
        function: 'refreshSharpOddsDatabase',
        direct_books: DIRECT_CONNECTOR_BOOKS,
        sharpapi_books: 'all_books_enabled_for_account_tier_except_kalshi',
        secrets: {
          SHARP_API_KEY: Boolean(Deno.env.get('SHARP_API_KEY')),
          PINNACLE_GUEST_API_KEY: Boolean(Deno.env.get('PINNACLE_GUEST_API_KEY')),
          NOVIG_CLIENT_ID: Boolean(Deno.env.get('NOVIG_CLIENT_ID')),
          NOVIG_CLIENT_SECRET: Boolean(Deno.env.get('NOVIG_CLIENT_SECRET')),
          REBET_API_KEY: Boolean(Deno.env.get('REBET_API_KEY')),
        },
      });
    }

    if (action === 'novig_auth') {
      const clientId = String(Deno.env.get('NOVIG_CLIENT_ID') || '').trim();
      const clientSecret = String(Deno.env.get('NOVIG_CLIENT_SECRET') || '').trim();
      if (!clientId || !clientSecret) {
        return Response.json({
          ok: false,
          action: 'novig_auth',
          source: 'novig',
          auth_url: NOVIG_AUTH_URL,
          configured: false,
          error: 'Missing NOVIG_CLIENT_ID and/or NOVIG_CLIENT_SECRET.',
        }, { status: 400 });
      }
      const started = Date.now();
      try {
        const auth = await getNovigAccessToken(clientId, clientSecret);
        return Response.json({
          ok: true,
          action: 'novig_auth',
          source: 'novig',
          configured: true,
          auth_url: NOVIG_AUTH_URL,
          auth_status: auth.status,
          token_received: Boolean(auth.token),
          token_policy: 'fresh_token_per_request',
          token_cached: false,
          elapsed_ms: Date.now() - started,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          action: 'novig_auth',
          source: 'novig',
          configured: true,
          auth_url: NOVIG_AUTH_URL,
          token_policy: 'fresh_token_per_request',
          token_cached: false,
          elapsed_ms: Date.now() - started,
          error: String(error?.message || error),
        }, { status: 502 });
      }
    }

    if (action === 'novig_graphql') {
      const probeCfg = getSportConfig(body?.sport || 'mlb');
      if (!probeCfg) {
        return Response.json({ ok: false, action: 'novig_graphql', error: 'Unsupported sport. Use mlb, nfl, ncaaf, or wnba.' }, { status: 400 });
      }
      const testDate = String(body?.gameDate || body?.date || todayInTimeZone(DEFAULT_TIMEZONE)).slice(0, 10);
      const includeLive = body?.includeLive === true;
      const started = Date.now();
      try {
        const result = await fetchNovigGraphqlMlb(probeCfg, testDate, includeLive);
        return Response.json({
          ok: true,
          action: 'novig_graphql',
          source: 'novig',
          sport: probeCfg.key,
          game_date: testDate,
          games: result.games.length,
          debug: result.debug,
          elapsed_ms: Date.now() - started,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          action: 'novig_graphql',
          source: 'novig',
          game_date: testDate,
          elapsed_ms: Date.now() - started,
          error: String(error?.message || error),
        }, { status: 502 });
      }
    }

    if (action === 'rebet_probe') {
      const started = Date.now();
      try {
        const probe = await rebetProbe({
          sport: body?.sport || 'mlb',
          sport_id: body?.sport_id,
          league_id: body?.league_id,
          tab: body?.tab,
          item_id: body?.item_id,
          event_id: body?.event_id,
        });
        return Response.json({ ...probe, action: 'rebet_probe', elapsed_ms: Date.now() - started });
      } catch (error) {
        return Response.json({
          ok: false,
          action: 'rebet_probe',
          provider: 'rebet',
          error: String(error?.message || error),
          elapsed_ms: Date.now() - started,
        }, { status: 502 });
      }
    }

    if (action !== 'refresh') {
      return Response.json({ ok: false, error: `Unsupported action: ${action}. Use refresh, read, sources, novig_auth, novig_graphql, or rebet_probe.` }, { status: 400 });
    }

    const requestedSport = String(body?.sport || String(body?.league || DEFAULT_SPORT)).trim().toLowerCase();
    const cfg = getSportConfig(requestedSport);
    if (!cfg) {
      return Response.json({ ok: false, error: `Unsupported sport "${requestedSport}". Supported sports: mlb, nfl, ncaaf, wnba.` }, { status: 400 });
    }
    // Accept legacy `cfb` payloads but persist/read the one canonical key.
    const sport = cfg.key;
    const league = cfg.label;
    const gameDate = String(body?.gameDate || body?.date || todayInTimeZone(DEFAULT_TIMEZONE)).slice(0, 10);
    const defaultLookahead = cfg.key === 'mlb' ? 2 : cfg.key === 'wnba' ? 7 : 14;
    const lookaheadDays = clampInt(body?.lookaheadDays, 0, 30, defaultLookahead);
    const dryRun = body?.dryRun === true;
    const includeLive = body?.includeLive === true;
    const capturedAt = new Date().toISOString();

    const sharpKey = Deno.env.get('SHARP_API_KEY') || '';

    const [sharpResult, vsinResult, polyResult, pinnacleResult, novigResult, rebetResult] = await Promise.all([
      runConnector('sharp', () => fetchSharpOdds(cfg, sharpKey, gameDate, includeLive, lookaheadDays)),
      runConnector('vsin', () => fetchVsinOdds(cfg, gameDate, includeLive, lookaheadDays)),
      runConnector('polymarket', () => fetchPolymarketOdds(cfg, gameDate, includeLive, lookaheadDays)),
      runConnector('pinnacle', () => fetchPinnacleOdds(cfg, gameDate, includeLive, lookaheadDays)),
      runConnector('novig', () => fetchNovigOdds(cfg, gameDate, includeLive, lookaheadDays)),
      runConnector('rebet', () => fetchRebetOdds(cfg, gameDate, includeLive, lookaheadDays)),
    ]);

    const sourceGames: SourceGame[] = [
      ...sharpResult.games,
      ...vsinResult.games,
      ...polyResult.games,
      ...pinnacleResult.games,
      ...novigResult.games,
      ...rebetResult.games,
    ];

    const sourceStatus: AnyObject = {
      sharp: sharpResult.debug,
      vsin: vsinResult.debug,
      novig: novigResult.debug,
      polymarket: polyResult.debug,
      pinnacle: pinnacleResult.debug,
      rebet: rebetResult.debug,
    };

    // Never discard a valid source-only game. Source feeds are allowed to be
    // partially populated; merge what exists and append it. Event dates are
    // derived from normalized start times when records are built.
    const merged = mergeSourceGames(sourceGames, gameDate, cfg);
    console.info(`merge complete: ${merged.length} merged games from ${sourceGames.length} source games`);

    const requestMeta = {
      league,
      sport,
      game_date: gameDate,
      lookahead_days: lookaheadDays,
      captured_at: capturedAt,
      include_live: includeLive,
      append_only: true,
      direct_books: DIRECT_CONNECTOR_BOOKS,
      sharpapi_book_policy: 'tier_books_main_markets_free_tier_12req_per_min',
      vsin_books: VSIN_BOOKS.map((x) => x.key),
      pinnacle_source: 'arcadia_guest_api',
      pinnacle_league_id: cfg.pinnacle.leagueId,
      pinnacle_sport_id: cfg.pinnacle.sportId,
      novig_source: 'nbx_v2_oauth',
      novig_market_types: 'all_open_markets',
    };

    // Build + write one game at a time: materializing every snapshot record at
    // once exhausts worker memory on large NCAAF slates. Each game's record is
    // chunked losslessly (oversized market arrays split; readers coalesce
    // chunks sharing canonical_event_key + captured_at) and written immediately.
    let snapshotDocuments = 0;
    let marketCount = 0;
    let observationCount = 0;
    const booksFound = new Set<string>();
    const previewRecords: AnyObject[] | null = body?.preview === true ? [] : null;
    const snapshotWriter = createSharpSnapshotWriter(base44);
    let payloadBytes = 0;
    let gameIndex = 0;
    for (const game of merged) {
      gameIndex += 1;
      if (gameIndex % 10 === 0) console.info(`snapshot build/write progress: ${gameIndex}/${merged.length}`);
      const record = buildSnapshotRecord(game, { league, sport, gameDate, capturedAt, sourceStatus, requestMeta });
      const chunks = chunkSnapshotRecord(record);
      if (!dryRun) await snapshotWriter.add(chunks);
      if (previewRecords) previewRecords.push(...chunks);
      for (const chunk of chunks) {
        snapshotDocuments += 1;
        marketCount += Number(chunk.market_count || 0);
        observationCount += Number(chunk.observation_count || 0);
        payloadBytes += Number(chunk.snapshot_payload_bytes_estimate || 0);
        for (const market of chunk.markets || []) {
          for (const book of market.bookmakers || []) booksFound.add(book.bookmaker_id);
        }
      }
    }
    if (!dryRun) await snapshotWriter.flush();
    console.info(`write phase complete: ${snapshotDocuments} snapshot documents across ${merged.length} games (est ${payloadBytes} bytes)`);

    return Response.json({
      ok: true,
      status: dryRun ? 'dry_run' : 'snapshots_appended',
      source: SOURCE,
      entity: 'SharpOddsDatabase',
      function: 'refreshSharpOddsDatabase',
      sport,
      league,
      game_date: gameDate,
      lookahead_days: lookaheadDays,
      captured_at: capturedAt,
      snapshots_written: dryRun ? 0 : snapshotDocuments,
      games_normalized: merged.length,
      snapshot_documents: snapshotDocuments,
      vsin_only_games_dropped: 0,
      market_count: marketCount,
      observation_count: observationCount,
      payload_bytes_estimate: payloadBytes,
      books_found: [...booksFound].sort(),
      source_status: sourceStatus,
      preview: previewRecords || undefined,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || String(error), stack: error?.stack || null }, { status: 500 });
  }
}

// Base44 loads this file as a module, so register the HTTP handler by default.
// The NCAAF GitHub publisher imports the same collector with this flag enabled
// to prevent the imported module from starting a second server.
if (Deno.env.get('SHARP_ODDS_IMPORT_ONLY') !== 'true') {
  Deno.serve((req) => handleSharpOddsRequest(req));
}

function inferMarketPeriod(...values: any[]) {
  const text = normalizeText(values.filter(Boolean).join(' '));
  if (!text) return 'full_game';
  if (/(first five|1st five|first 5|1st 5|\bf5\b)/.test(text)) return 'first_5';
  if (/(first half|1st half|\b1h\b)/.test(text)) return 'first_half';
  if (/(second half|2nd half|\b2h\b)/.test(text)) return 'second_half';
  if (/(first quarter|1st quarter|\bq1\b)/.test(text)) return 'first_quarter';
  if (/(second quarter|2nd quarter|\bq2\b)/.test(text)) return 'second_quarter';
  if (/(third quarter|3rd quarter|\bq3\b)/.test(text)) return 'third_quarter';
  if (/(fourth quarter|4th quarter|\bq4\b)/.test(text)) return 'fourth_quarter';
  if (/(first inning|1st inning)/.test(text)) return 'first_inning';
  return 'full_game';
}

async function runConnector(name: string, fn: () => Promise<any>) {
  const started = Date.now();
  try {
    const result = await fn();
    console.info(`connector ${name} ok ms=${Date.now() - started} games=${Array.isArray(result?.games) ? result.games.length : 0}`);
    return {
      games: Array.isArray(result?.games) ? result.games : [],
      rawEvents: Array.isArray(result?.rawEvents) ? result.rawEvents : [],
      debug: { source: name, ok: true, ms: Date.now() - started, ...(result?.debug || {}) },
    };
  } catch (error) {
    console.info(`connector ${name} failed ms=${Date.now() - started} error=${String(error?.message || error).slice(0, 200)}`);
    return {
      games: [], rawEvents: [],
      debug: { source: name, ok: false, ms: Date.now() - started, error: error?.message || String(error) },
    };
  }
}

// SharpAPI connector (rate-limit aware, 12 requests/minute on the free tier)
// lives in base44/shared/sharpApiOdds.ts and is imported above.

// ─────────────────────────────────────────────────────────────────────────────
// VSiN: one fetch parses every sportsbook column currently exposed by VSiN's line tracker, plus VSiN's update time.
// ─────────────────────────────────────────────────────────────────────────────
function parseVsinSlateDate(text: string, anchorDate: string) {
  const match = String(text || '').match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*,?\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:\s*,\s*(\d{4}))?/i);
  if (!match) return null;
  const months: AnyObject = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const anchorYear = Number(String(anchorDate).slice(0,4));
  const anchorMonth = Number(String(anchorDate).slice(5,7));
  const month = months[String(match[1]).slice(0,3).toLowerCase()];
  const day = Number(match[2]);
  let year = Number(match[3] || anchorYear);
  if (!match[3] && month && anchorMonth) {
    if (anchorMonth >= 11 && month <= 2) year += 1;
    else if (anchorMonth <= 2 && month >= 11) year -= 1;
  }
  if (!month || !day || !year) return null;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function vsinPeriodFromClass(className: string) {
  const c = normalizeText(className);
  if (/tbody fg|sp tbody fg|\bfg\b/.test(c)) return 'full_game';
  if (/1h|first half/.test(c)) return 'first_half';
  if (/2h|second half/.test(c)) return 'second_half';
  if (/1q|first quarter/.test(c)) return 'first_quarter';
  if (/2q|second quarter/.test(c)) return 'second_quarter';
  if (/3q|third quarter/.test(c)) return 'third_quarter';
  if (/4q|fourth quarter/.test(c)) return 'fourth_quarter';
  if (/f5|first 5|first five/.test(c)) return 'first_5';
  return normalizeMarketPeriod(c || 'full_game');
}

// VSiN: parse every sportsbook column and every period tbody it publishes.
async function fetchVsinOdds(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const vsinUrl = `https://data.vsin.com/vegas-odds-linetracker/?sportid=${cfg.vsinSportId}`;
  const response = await fetch(vsinUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: vsinUrl,
    },
  });
  if (!response.ok) throw new Error(`VSiN HTTP ${response.status}`);
  const html = await response.text();
  const sourceUpdatedRaw = parseVsinUpdatedText(html);
  const sourceUpdatedAt = sourceUpdatedRaw ? parseEasternTimestamp(sourceUpdatedRaw) : null;

  const bodies = [...html.matchAll(/<tbody([^>]*)>([\s\S]*?)<\/tbody>/gi)]
    .map((m) => ({ attrs: String(m[1] || ''), body: String(m[2] || '') }))
    .filter((x) => /sp-tbody/i.test(x.attrs));
  const periodBodies = bodies.length ? bodies : [{ attrs: 'sp-tbody-fg', body: html }];
  const games: SourceGame[] = [];
  const periodCounts: AnyObject = {};
  let openRowCount = 0;
  let unpairedTeamRows = 0;

  for (const block of periodBodies) {
    const period = vsinPeriodFromClass(block.attrs);
    const rows = [...block.body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) => extractTableCells(m[1]))
      .filter((cells) => cells.length >= 1);
    const parsedRows: AnyObject[] = [];
    let pendingTime: string | null = null;
    let pendingDate: string | null = null;
    // Each VSiN matchup is published as an OPEN row followed by its two team
    // rows. Odds cells inside the OPEN row can false-match a team alias (a "49"
    // opening total matches the 49ers), so OPEN rows must be detected before
    // team detection and pairing must never cross an OPEN-row boundary — one
    // mis-read row otherwise shifts every later pairing by one and fabricates
    // phantom matchups that steal the real games' sportsbook lines. Rows are
    // therefore chunked into per-OPEN blocks and paired strictly per block.
    const pairBlocks: { openBooks: AnyObject | null; teams: AnyObject[] }[] = [];
    let currentBlock: { openBooks: AnyObject | null; teams: AnyObject[] } | null = null;

    const parseBooks = (marketCells: string[]) => {
      const books: AnyObject = {};
      for (const def of VSIN_BOOKS) {
        const offset = def.index * 3;
        if (offset + 2 >= marketCells.length) continue;
        books[def.key] = {
          spread: parseVsinSpreadCell(marketCells[offset]),
          ml: parseVsinAmericanOdds(marketCells[offset + 1]),
          total: parseVsinTotalCell(marketCells[offset + 2]),
        };
      }
      return books;
    };

    for (const cells of rows) {
      const joined = cells.join(' ');
      const rowDate = parseVsinSlateDate(joined, gameDate);
      if (rowDate) pendingDate = rowDate;
      const time = extractVsinGameTime(joined);
      if (time) pendingTime = time;
      // VSiN publishes an OPEN row immediately before each two-team matchup.
      // It contains the opening away-side spread/moneyline plus the opening
      // total line for every displayed sportsbook. It is retained separately
      // as a distinct quote_type so no opening values disappear, while
      // current-line readers can deliberately ignore it. The OPEN check must
      // run before team detection because opening odds cells can false-match
      // a team alias.
      if (/\bOPEN\b/i.test(joined) && cells.length > 1) {
        openRowCount += 1;
        currentBlock = { openBooks: parseBooks(cells.slice(1)), teams: [] };
        pairBlocks.push(currentBlock);
        continue;
      }
      const teamIdx = cells.findIndex((cell) => Boolean(cfg.canonical(cleanTeamText(cell))));
      if (teamIdx < 0) continue;
      if (!currentBlock) {
        currentBlock = { openBooks: null, teams: [] };
        pairBlocks.push(currentBlock);
      }
      const team = cleanTeamText(cells[teamIdx]);
      const marketCells = cells.slice(teamIdx + 1);
      const books = parseBooks(marketCells);
      const row = { team, time: pendingTime, date: pendingDate, books };
      currentBlock.teams.push(row);
      parsedRows.push(row);
    }

    for (const pairBlock of pairBlocks) {
    for (let i = 0; i + 1 < pairBlock.teams.length; i += 2) {
      const awayRow = pairBlock.teams[i];
      const homeRow = pairBlock.teams[i + 1];
      const away = cfg.canonical(awayRow.team);
      const home = cfg.canonical(homeRow.team);
      if (!away || !home || away.abbr === home.abbr) continue;
      const slateDate = awayRow.date || homeRow.date || gameDate;
      if (!dateIsInWindow(slateDate, gameDate, lookaheadDays)) continue;
      const gameTime = awayRow.time || homeRow.time;
      const startTime = gameTime ? easternGameTimeToIso(slateDate, gameTime) : null;
      if (!includeLive && startTime && new Date(startTime).getTime() <= Date.now() - 2 * 60 * 1000) continue;

      for (const def of VSIN_BOOKS) {
        const awayBook = awayRow.books?.[def.key] || {};
        const homeBook = homeRow.books?.[def.key] || {};
        const openingBook = pairBlock.openBooks?.[def.key] || {};
        const sourceEventId = `vsin:${away.abbr}:${home.abbr}:${slateDate}:${gameTime || 'na'}`;
        const game = makeSourceGame('vsin', sourceEventId, away.name, home.name, startTime, def.key, sourceUpdatedAt, false);
        const add = (marketType: string, side: string, price: AnyObject | null, line: any, selection: string, quoteType = 'current') => {
          const normalizedPrice = price || priceObject(null, line, {});
          const stored = addBookObservation(game.book, {
            ...normalizedPrice,
            market_type: marketType,
            market_key: marketType,
            market_name: marketType,
            period,
            side,
            selection,
            line,
            quote_type: quoteType,
            is_main_line: quoteType === 'current' ? true : null,
            is_alternate_line: quoteType === 'current' ? false : null,
          });
          if (quoteType === 'current' && period === 'full_game' && stored?.has_price) game.book[marketType][side] = normalizedPrice;
        };

        // Preserve the explicit OPEN row separately from the current team rows.
        // VSiN's opening spread/ML are the first-listed (away) side; its opening
        // total is a line-only reference and does not identify an Over/Under price.
        if (openingBook.ml != null) add('moneyline', 'away', priceObject(openingBook.ml, null, {}), null, away.name, 'opening');
        if (openingBook.spread?.line != null || openingBook.spread?.odds != null) {
          add('spread', 'away', priceObject(openingBook.spread?.odds, openingBook.spread?.line, {}), openingBook.spread?.line, `${away.name} ${openingBook.spread?.line ?? ''}`, 'opening');
        }
        if (openingBook.total?.line != null || openingBook.total?.odds != null) {
          add('total', 'opening', priceObject(openingBook.total?.odds, openingBook.total?.line, {}), openingBook.total?.line, `Opening total ${openingBook.total?.line ?? ''}`, 'opening');
        }

        if (awayBook.ml != null) add('moneyline', 'away', priceObject(awayBook.ml, null, {}), null, away.name);
        if (homeBook.ml != null) add('moneyline', 'home', priceObject(homeBook.ml, null, {}), null, home.name);
        if (awayBook.spread?.line != null || awayBook.spread?.odds != null) add('spread', 'away', priceObject(awayBook.spread?.odds, awayBook.spread?.line, {}), awayBook.spread?.line, `${away.name} ${awayBook.spread?.line ?? ''}`);
        if (homeBook.spread?.line != null || homeBook.spread?.odds != null) add('spread', 'home', priceObject(homeBook.spread?.odds, homeBook.spread?.line, {}), homeBook.spread?.line, `${home.name} ${homeBook.spread?.line ?? ''}`);
        if (awayBook.total?.line != null || awayBook.total?.odds != null) add('total', 'over', priceObject(awayBook.total?.odds, awayBook.total?.line, {}), awayBook.total?.line, `Over ${awayBook.total?.line ?? ''}`);
        if (homeBook.total?.line != null || homeBook.total?.odds != null) add('total', 'under', priceObject(homeBook.total?.odds, homeBook.total?.line, {}), homeBook.total?.line, `Under ${homeBook.total?.line ?? ''}`);
        if (hasSourceGamePrice(game)) games.push(game);
      }
    }
      if (pairBlock.teams.length % 2 === 1) unpairedTeamRows += 1;
    }
    periodCounts[period] = (periodCounts[period] || 0) + parsedRows.length;
  }

  const dedupedGames = dedupeSourceGames(games, cfg.canonical);
  return {
    games: dedupedGames,
    debug: {
      url: vsinUrl,
      status: response.status,
      htmlLength: html.length,
      sourceUpdatedRaw,
      sourceUpdatedAt,
      books: VSIN_BOOKS.map((x) => x.key),
      periods: periodCounts,
      open_rows: openRowCount,
      unpaired_team_rows: unpairedTeamRows,
      book_game_rows: dedupedGames.length,
      unique_matchups: new Set(dedupedGames.map((g) => `${cfg.canonical(g.awayTeam)?.abbr}:${cfg.canonical(g.homeTeam)?.abbr}:${g.startTime || ''}`)).size,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Novig connector strategy
//
// 1) Prefer the production NBX REST API using the user's OAuth credentials.
// 2) Base44 can currently receive a CloudFront/WAF 403 before the OAuth request
//    reaches Novig. If NBX cannot be reached/authenticated, fall back to Novig's
//    official read-only GraphQL odds feed. Novig documents this feed for odds
//    screens and says it requires no authentication.
//
// GraphQL is a compatibility fallback only; Novig is migrating GraphQL users to
// NBX REST, so the REST path remains the preferred path whenever it works.
// ─────────────────────────────────────────────────────────────────────────────
const NOVIG_GRAPHQL_URLS = [
  'https://api.novig.us/v1/graphql',
  'https://gql.novig.us/v1/graphql',
];

async function fetchNovigOdds(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  let nbxError: string | null = null;
  try {
    const nbx = await fetchNovigMlbNbx(cfg, gameDate, includeLive, lookaheadDays);
    if (nbx?.debug?.configured !== false) return nbx;
    nbxError = String(nbx?.debug?.error || 'Novig NBX credentials are not configured.');
  } catch (error) {
    nbxError = String(error?.message || error);
  }

  const graphql: AnyObject = await fetchNovigGraphqlMlb(cfg, gameDate, includeLive, lookaheadDays);
  graphql.debug = {
    ...(graphql.debug || {}),
    preferred_source: 'nbx_v2_oauth',
    fallback_reason: nbxError,
    fallback_used: true,
  };
  return graphql;
}

async function fetchNovigGraphqlMlb(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const query = `query SportsEdgeOdds {
    event(where: {
      _and: [
        { status: { _in: ["OPEN_PREGAME", "OPEN_INGAME"] } },
        { game: { league: { _eq: "${cfg.novigLeague}" } } }
      ]
    }) {
      id
      description
      status
      game { scheduled_start }
      markets {
        id
        description
        type
        strike
        volume
        outcomes {
          id
          description
          last
          available
        }
      }
    }
  }`;

  const fetched = await postNovigGraphql(query);
  const events = Array.isArray(fetched.payload?.data?.event) ? fetched.payload.data.event : [];
  const byEvent = new Map<string, SourceGame>();
  let dateCandidates = 0;
  let rawMarkets = 0;
  let pricedOutcomes = 0;
  const marketTypesSeen = new Set<string>();

  for (const event of events) {
    const eventId = String(event?.id || '').trim();
    if (!eventId) continue;
    const startTime = isoOrNull(event?.game?.scheduled_start);
    if (!startIsInWindow(startTime, gameDate, lookaheadDays)) continue;
    dateCandidates += 1;

    const eventStatus = String(event?.status || '').toUpperCase();
    const isLive = eventStatus.includes('INGAME') || eventStatus.includes('LIVE');
    if (!includeLive && isLive) continue;

    const teams = parseNovigGraphqlEventTeams(event?.description);
    if (!teams) continue;
    const away = cfg.canonical(teams.away);
    const home = cfg.canonical(teams.home);
    if (!away || !home) continue;

    const sourceGame = makeSourceGame('novig', eventId, away.name, home.name, startTime, 'novig', null, isLive);
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    rawMarkets += markets.length;

    for (const market of markets) {
      const rawType = String(market?.type || market?.description || 'other');
      const standardType = novigGraphqlMarketType(market);
      const marketType = standardType === 'MONEY' ? 'moneyline'
        : standardType === 'SPREAD' ? 'spread'
        : standardType === 'TOTAL' ? 'total'
        : normalizeRawMarketType(rawType);
      marketTypesSeen.add(marketType);
      const period = inferMarketPeriod(market?.period, market?.description);
      const strike = finiteOrNull(market?.strike);
      const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
      if (!outcomes.length) {
        addBookObservation(sourceGame.book, {
          odds: null,
          market_type: marketType,
          market_key: firstNonEmpty([market?.type, market?.description, market?.id]),
          market_name: market?.description || rawType,
          period,
          side: null,
          selection: null,
          line: marketType === 'moneyline' ? null : strike,
          source_market_id: stringOrNull(market?.id),
          raw_market_type: rawType,
          raw_market_name: market?.description,
          available: false,
        });
      }

      for (const outcome of outcomes) {
        const p = novigGraphqlOutcomePrice(outcome);
        const desc = String(outcome?.description || '');
        let side: string | null = null;
        let line = parseNovigGraphqlLine(desc) ?? strike;
        if (marketType === 'moneyline' || marketType === 'spread') {
          side = novigGraphqlTeamSide(desc, home, away, cfg);
          if (marketType === 'spread' && side && line == null && strike != null) line = side === 'home' ? strike : -strike;
        } else if (marketType === 'total') {
          side = /\bover\b|^o\s*[-+]?\d/i.test(desc) ? 'over' : /\bunder\b|^u\s*[-+]?\d/i.test(desc) ? 'under' : null;
        }
        if (!side) side = desc || `outcome_${String(outcome?.id || '')}`;
        const price = novigGraphqlPriceObject(p, market, outcome, marketType === 'moneyline' ? null : line);
        addBookObservation(sourceGame.book, {
          ...price,
          odds: price.odds,
          market_type: marketType,
          market_key: firstNonEmpty([market?.type, market?.description, market?.id]),
          market_name: market?.description || rawType,
          period,
          side,
          selection: desc,
          line: marketType === 'moneyline' ? null : line,
          raw_market_type: rawType,
          raw_market_name: market?.description,
        });
        if (p != null) pricedOutcomes += 1;
      }
    }

    if (hasSourceGamePrice(sourceGame)) byEvent.set(eventId, sourceGame);
  }

  const games = [...byEvent.values()];
  return {
    games,
    debug: {
      configured: true,
      auth: 'none_required',
      api: 'official_read_only_graphql',
      graphql_url: fetched.url,
      graphql_status: fetched.status,
      graphql_attempts: fetched.attempts,
      events: events.length,
      date_candidates: dateCandidates,
      raw_markets: rawMarkets,
      priced_outcomes: pricedOutcomes,
      market_types_seen: [...marketTypesSeen].sort(),
      games: games.length,
      price_selection: 'available_then_last',
      market_retention: 'main_game_lines_only_all_alt_lines',
      deprecated_api_notice: 'Novig documents GraphQL as read-only for odds screens but is migrating users to NBX REST.',
    },
  };
}

async function postNovigGraphql(query: string) {
  const errors: string[] = [];
  let attempts = 0;
  for (const url of NOVIG_GRAPHQL_URLS) {
    attempts += 1;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'SportsEdgeAI/1.0',
        },
        body: JSON.stringify({ query }),
      });
      const text = await response.text();
      let payload: AnyObject | null = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (response.ok && payload?.data && !payload?.errors) {
        return { url, status: response.status, payload, attempts };
      }
      const detail = payload?.errors?.[0]?.message || payload?.message || payload?.error || text || response.statusText;
      errors.push(`${url} -> HTTP ${response.status}: ${String(detail).slice(0, 300)}`);
    } catch (error) {
      errors.push(`${url} -> ${String(error?.message || error).slice(0, 300)}`);
    }
  }
  throw new Error(`Novig GraphQL fallback failed. ${errors.join(' | ')}`);
}

function parseNovigGraphqlEventTeams(description: any) {
  const text = String(description || '').trim();
  if (!text) return null;
  let parts = text.split(/\s+@\s+/i);
  if (parts.length === 2) return { away: parts[0].trim(), home: parts[1].trim() };
  parts = text.split(/\s+(?:vs\.?|versus)\s+/i);
  if (parts.length === 2) return { away: parts[0].trim(), home: parts[1].trim() };
  return null;
}

function novigGraphqlMarketType(market: AnyObject) {
  const desc = String(market?.description || '').toLowerCase();
  if (/player|pitcher|batter|team total|strikeout|passing|rushing|receiving|hits|assists|rebounds|blocks|steals/.test(desc)) return null;
  const explicit = String(market?.type || '').trim().toUpperCase();
  if (explicit === 'MONEY' || explicit === 'MONEYLINE' || explicit === 'ML') return 'MONEY';
  if (explicit === 'SPREAD' || explicit === 'HANDICAP') return 'SPREAD';
  if (explicit === 'TOTAL' || explicit === 'TOTALS') return 'TOTAL';
  if (/\btotal\b|\bover\b|\bunder\b|\bt\s*\d/.test(desc)) return 'TOTAL';
  if (/[+-]\s*\d+(?:\.\d+)?/.test(desc)) return 'SPREAD';
  return null;
}

function novigGraphqlOutcomePrice(outcome: AnyObject) {
  return probabilityOrNull(outcome?.available ?? outcome?.last);
}

function chooseNovigGraphqlPrimaryMarket(markets: AnyObject[]) {
  if (!markets.length) return null;
  return [...markets].sort((a, b) => {
    const score = (m: AnyObject) => {
      const ps = (Array.isArray(m?.outcomes) ? m.outcomes : [])
        .map(novigGraphqlOutcomePrice)
        .filter((v: any) => v != null);
      if (ps.length >= 2) return Math.abs(ps[0] - 0.5) + Math.abs(ps[1] - 0.5);
      if (ps.length === 1) return Math.abs(ps[0] - 0.5) + 0.5;
      return 999;
    };
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return Number(b?.volume || 0) - Number(a?.volume || 0);
  })[0];
}

function novigGraphqlTeamSide(description: string, home: AnyObject, away: AnyObject, cfg: any): 'home' | 'away' | null {
  const desc = String(description || '').toLowerCase();
  const clean = desc.replace(/[+-]?\d+(?:\.\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
  const homeCandidates = [home?.name, home?.abbr].filter(Boolean).map((v: any) => String(v).toLowerCase());
  const awayCandidates = [away?.name, away?.abbr].filter(Boolean).map((v: any) => String(v).toLowerCase());
  if (homeCandidates.some((v: string) => clean.includes(v))) return 'home';
  if (awayCandidates.some((v: string) => clean.includes(v))) return 'away';
  const canonical = cfg.canonical(clean);
  if (canonical?.abbr && canonical.abbr === home?.abbr) return 'home';
  if (canonical?.abbr && canonical.abbr === away?.abbr) return 'away';
  return null;
}

function parseNovigGraphqlLine(description: string) {
  const text = String(description || '');
  const totalMatch = text.match(/(?:over|under|^o|^u)\s*([0-9]+(?:\.\d+)?)/i);
  if (totalMatch) return finiteOrNull(totalMatch[1]);
  const signed = text.match(/([+-]\s*\d+(?:\.\d+)?)/);
  if (signed) return finiteOrNull(signed[1].replace(/\s+/g, ''));
  return null;
}

function novigGraphqlPriceObject(probability: any, market: AnyObject, outcome: AnyObject, line: any) {
  const p = probabilityOrNull(probability);
  return {
    odds: probabilityToAmerican(p),
    line: finiteOrNull(line),
    raw_probability: p,
    source_market_id: stringOrNull(market?.id),
    source_outcome_id: stringOrNull(outcome?.id),
    market_volume: finiteOrNull(market?.volume),
    raw_market_type: stringOrNull(market?.type),
    raw_strike: finiteOrNull(market?.strike),
    outcome_description: stringOrNull(outcome?.description),
    novig_available_probability: probabilityOrNull(outcome?.available),
    novig_last_probability: probabilityOrNull(outcome?.last),
    price_source: outcome?.available != null ? 'available' : 'last',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Novig: preferred production NBX v2 REST API. OAuth client credentials are
// exchanged for a short-lived bearer token,
// then one league open-markets request retains every OPEN market/strike.
// Novig documents outcome index semantics as:
//   MONEY/SPREAD: index 0 = Home, index 1 = Away
//   TOTAL:        index 0 = Over, index 1 = Under
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNovigMlbNbx(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const clientId = String(Deno.env.get('NOVIG_CLIENT_ID') || '').trim();
  const clientSecret = String(Deno.env.get('NOVIG_CLIENT_SECRET') || '').trim();
  if (!clientId || !clientSecret) {
    return {
      games: [],
      debug: {
        ok: false,
        configured: false,
        auth: 'oauth_client_credentials',
        required_secrets: ['NOVIG_CLIENT_ID', 'NOVIG_CLIENT_SECRET'],
        auth_url: NOVIG_AUTH_URL,
        market_url: `${NOVIG_API_BASE}/emm/markets/open?league=${cfg.novigLeague}`,
        error: 'Missing NOVIG_CLIENT_ID and/or NOVIG_CLIENT_SECRET for preferred NBX REST access.',
      },
    };
  }

  let auth = await getNovigAccessToken(clientId, clientSecret);
  let marketsResponse = await fetchNovigOpenMarkets(auth.token, cfg.novigLeague);
  let reauthenticatedAfterMarketAuthFailure = false;
  if (marketsResponse.response.status === 401 || marketsResponse.response.status === 403) {
    auth = await getNovigAccessToken(clientId, clientSecret);
    marketsResponse = await fetchNovigOpenMarkets(auth.token, cfg.novigLeague);
    reauthenticatedAfterMarketAuthFailure = true;
  }

  const response = marketsResponse.response;
  const payload = marketsResponse.payload;
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Novig open markets HTTP ${response.status}`);

  const rawMarkets = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.markets)
        ? payload.markets
        : [];

  // Keep every OPEN market in this league. Do not collapse alternate strikes,
  // props, team totals, or period markets to one primary line.
  // Main game lines only: keep OPEN MONEY/SPREAD/TOTAL markets and skip every
  // derivative (props, player/team totals) before any order-book requests.
  const targetMarkets = rawMarkets.filter((market: AnyObject) =>
    String(market?.league || cfg.novigLeague).toUpperCase() === cfg.novigLeague
    && String(market?.status || '').toUpperCase() === 'OPEN'
    && ['MONEY', 'MONEYLINE', 'SPREAD', 'HANDICAP', 'TOTAL', 'TOTALS']
      .includes(String(market?.type || market?.marketType || '').trim().toUpperCase())
    && !/player|pitcher|batter|team total|strikeout|passing|rushing|receiving|hits|assists|rebounds|blocks|steals/i
      .test(`${market?.description || ''} ${market?.name || ''} ${market?.prop || ''} ${market?.stat || ''}`)
  );

  // Pull executable CASH books for every retained market. A failed individual
  // book request falls back to the market's last price without dropping the
  // market or any other successfully fetched result.
  const orderBooks = await fetchNovigOrderBooks(targetMarkets, auth.token);
  const byEvent = new Map<string, SourceGame>();
  let pricedOutcomes = 0;
  const marketTypesSeen = new Set<string>();

  for (const market of targetMarkets) {
    const event = market?.event || {};
    const game = event?.game || {};
    const eventId = String(market?.eventId || event?.id || game?.id || '').trim();
    if (!eventId) continue;

    const homeRaw = game?.homeTeam || {};
    const awayRaw = game?.awayTeam || {};
    const home = cfg.canonical(homeRaw?.symbol || homeRaw?.name || homeRaw?.shortName);
    const away = cfg.canonical(awayRaw?.symbol || awayRaw?.name || awayRaw?.shortName);
    if (!home || !away) continue;

    const startTime = isoOrNull(game?.scheduledStart || event?.scheduledStart);
    if (!startIsInWindow(startTime, gameDate, lookaheadDays)) continue;
    const eventStatus = String(event?.status || '').toUpperCase();
    const gameStatus = String(game?.status || '').toUpperCase();
    const isLive = eventStatus.includes('LIVE') || gameStatus.includes('LIVE') || gameStatus.includes('IN_PROGRESS') || gameStatus.includes('INPLAY');
    if (!includeLive && isLive) continue;

    let sourceGame = byEvent.get(eventId);
    if (!sourceGame) {
      sourceGame = makeSourceGame('novig', eventId, away.name, home.name, startTime, 'novig', null, isLive);
      byEvent.set(eventId, sourceGame);
    }

    const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
    const outcome0 = outcomes.find((o: AnyObject) => Number(o?.index) === 0) || outcomes[0] || null;
    const outcome1 = outcomes.find((o: AnyObject) => Number(o?.index) === 1) || outcomes[1] || null;
    const book = orderBooks.books.get(String(market?.id || '')) || null;
    const rawType = String(market?.type || market?.marketType || market?.description || 'other');
    const descriptor = normalizeText(`${market?.description || ''} ${market?.name || ''} ${market?.prop || ''} ${market?.stat || ''}`);
    const derivative = /player|pitcher|batter|team total|strikeout|passing|rushing|receiving|hits|assists|rebounds|blocks|steals/.test(descriptor);
    const upperType = rawType.toUpperCase();
    const marketType = derivative ? normalizeRawMarketType(firstNonEmpty([market?.description, market?.name, rawType]))
      : upperType === 'MONEY' || upperType === 'MONEYLINE' ? 'moneyline'
      : upperType === 'SPREAD' || upperType === 'HANDICAP' ? 'spread'
      : upperType === 'TOTAL' || upperType === 'TOTALS' ? 'total'
      : normalizeRawMarketType(rawType);
    marketTypesSeen.add(marketType);
    const strike = finiteOrNull(market?.strike);
    const period = inferMarketPeriod(market?.period, market?.description, rawType);

    if (!outcomes.length) {
      addBookObservation(sourceGame.book, {
        odds: null,
        market_type: marketType,
        market_key: firstNonEmpty([market?.marketKey, market?.type, market?.description, market?.id]),
        market_name: firstNonEmpty([market?.description, market?.name, rawType]),
        period,
        side: null,
        selection: null,
        participant: firstNonEmpty([market?.participant?.name, market?.player?.name, market?.playerName]),
        participant_id: firstNonEmpty([market?.participant?.id, market?.player?.id, market?.playerId]),
        prop_key: firstNonEmpty([market?.prop, market?.stat, market?.statType]),
        line: marketType === 'moneyline' ? null : strike,
        source_market_id: stringOrNull(market?.id),
        raw_market_type: rawType,
        raw_market_name: firstNonEmpty([market?.description, market?.name]),
        available: false,
      });
    }

    for (const outcome of outcomes) {
      const idx = Number(outcome?.index);
      const opposite = idx === Number(outcome0?.index) ? outcome1 : outcome0;
      const quote = novigOutcomeQuote(market, outcome, opposite, book);
      let side: string | null = null;
      let line: number | null = strike;
      if (marketType === 'moneyline' || marketType === 'spread') {
        if (idx === 0) side = 'home';
        else if (idx === 1) side = 'away';
        else side = novigGraphqlTeamSide(String(outcome?.description || ''), home, away, cfg);
        if (marketType === 'moneyline') line = null;
        else if (strike != null && side === 'away') line = -strike;
      } else if (marketType === 'total') {
        if (idx === 0) side = 'over';
        else if (idx === 1) side = 'under';
        if (!side) {
          const desc = normalizeText(outcome?.description);
          side = desc.includes('over') ? 'over' : desc.includes('under') ? 'under' : null;
        }
      }
      if (!side) side = String(outcome?.description || `outcome_${idx}`);
      const price = novigPriceObject(quote, market, outcome, marketType === 'moneyline' ? null : line);
      addBookObservation(sourceGame.book, {
        ...price,
        odds: price.odds,
        market_type: marketType,
        market_key: firstNonEmpty([market?.marketKey, market?.type, market?.description, market?.id]),
        market_name: firstNonEmpty([market?.description, market?.name, rawType]),
        period,
        side,
        selection: outcome?.description,
        participant: firstNonEmpty([market?.participant?.name, market?.player?.name, market?.playerName]),
        participant_id: firstNonEmpty([market?.participant?.id, market?.player?.id, market?.playerId]),
        prop_key: firstNonEmpty([market?.prop, market?.stat, market?.statType]),
        line: marketType === 'moneyline' ? null : line,
        raw_market_type: rawType,
        raw_market_name: firstNonEmpty([market?.description, market?.name]),
      });
      if (quote.price != null) pricedOutcomes += 1;
    }
  }

  const games = [...byEvent.values()].filter(hasSourceGamePrice);
  return {
    games,
    debug: {
      configured: true,
      auth: 'oauth_client_credentials',
      auth_url: NOVIG_AUTH_URL,
      market_url: `${NOVIG_API_BASE}/emm/markets/open?league=${cfg.novigLeague}`,
      order_book_pattern: `${NOVIG_API_BASE}/emm/book/{marketId}?currency=CASH`,
      auth_status: auth.status,
      token_reused: false,
      token_policy: 'fresh_token_per_refresh',
      reauthenticated_after_market_auth_failure: reauthenticatedAfterMarketAuthFailure,
      market_status: response.status,
      raw_markets: rawMarkets.length,
      retained_open_markets: targetMarkets.length,
      order_books_ok: orderBooks.ok,
      order_books_failed: orderBooks.failed,
      priced_outcomes: pricedOutcomes,
      market_types_seen: [...marketTypesSeen].sort(),
      games: games.length,
      market_retention: 'main_game_lines_only_all_alt_lines',
      price_selection: 'best_ask_then_last_then_best_bid',
    },
  };
}

async function getNovigAccessToken(clientId: string, clientSecret: string) {
  // Match Novig's documented cURL request exactly in structure:
  // POST https://api.novig.com/nbx/v1/auth/emm-token
  // Content-Type: application/json
  // { grant_type, client_id, client_secret }
  const requestBody = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(NOVIG_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  // Read the raw body first so a non-JSON Novig error (for example plain-text
  // "Forbidden") is preserved instead of being lost by response.json().
  const responseText = await response.text();
  let payload: AnyObject | null = null;
  if (responseText) {
    try { payload = JSON.parse(responseText); } catch { payload = null; }
  }

  if (!response.ok) {
    const rawDetail = firstNonEmpty([
      payload?.error_description,
      payload?.message,
      payload?.error,
      payload?.detail,
      payload?.data?.error_description,
      payload?.data?.message,
      payload?.data?.error,
      responseText,
      response.statusText,
    ]);
    let detail = rawDetail == null ? '' : String(rawDetail);
    if (clientId) detail = detail.split(clientId).join('[REDACTED_CLIENT_ID]');
    if (clientSecret) detail = detail.split(clientSecret).join('[REDACTED_CLIENT_SECRET]');
    detail = detail.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
    if (detail.length > 500) detail = `${detail.slice(0, 500)}…`;
    throw new Error(`Novig OAuth HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const token = String(
    payload?.access_token
    || payload?.accessToken
    || payload?.token
    || payload?.jwt
    || payload?.data?.access_token
    || payload?.data?.accessToken
    || payload?.data?.token
    || ''
  ).trim();
  if (!token) {
    const bodyPreview = responseText ? responseText.slice(0, 300) : '[empty response body]';
    throw new Error(`Novig OAuth HTTP ${response.status} succeeded but no access token was present. Response: ${bodyPreview}`);
  }

  return {
    token,
    fromCache: false,
    status: response.status,
  };
}

async function fetchNovigOpenMarkets(token: string, league: string) {
  const url = `${NOVIG_API_BASE}/emm/markets/open?league=${encodeURIComponent(league)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const payload = await safeJson(response);
  return { response, payload };
}

function chooseNovigPrimaryMarket(markets: AnyObject[]) {
  if (!markets.length) return null;
  return [...markets].sort((a, b) => {
    const aBalance = novigMarketBalanceScore(a);
    const bBalance = novigMarketBalanceScore(b);
    if (aBalance !== bBalance) return aBalance - bBalance;
    return Number(b?.volume || 0) - Number(a?.volume || 0);
  })[0];
}

function novigMarketBalanceScore(market: AnyObject) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const p0 = novigOutcomeProbability(outcomes.find((o: AnyObject) => Number(o?.index) === 0) || null);
  const p1 = novigOutcomeProbability(outcomes.find((o: AnyObject) => Number(o?.index) === 1) || null);
  if (p0 != null && p1 != null) return Math.abs(p0 - 0.5) + Math.abs(p1 - 0.5);
  if (p0 != null) return Math.abs(p0 - 0.5) + 0.5;
  if (p1 != null) return Math.abs(p1 - 0.5) + 0.5;
  return 999;
}

async function fetchNovigOrderBooks(markets: AnyObject[], token: string) {
  const books = new Map<string, AnyObject>();
  let ok = 0;
  let failed = 0;
  const concurrency = 8;

  for (let i = 0; i < markets.length; i += concurrency) {
    const batch = markets.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (market) => {
      const marketId = String(market?.id || '').trim();
      if (!marketId) return { marketId, ok: false, payload: null };
      const url = `${NOVIG_API_BASE}/emm/book/${encodeURIComponent(marketId)}?currency=CASH`;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const payload = await safeJson(response);
        return { marketId, ok: response.ok, payload };
      } catch (_error) {
        return { marketId, ok: false, payload: null };
      }
    }));

    for (const result of results) {
      if (result.ok && result.payload) {
        books.set(result.marketId, result.payload);
        ok += 1;
      } else {
        failed += 1;
      }
    }
  }
  return { books, ok, failed };
}

function novigOutcomeProbability(outcome: AnyObject | null) {
  if (!outcome) return null;
  return probabilityOrNull(outcome?.last ?? outcome?.price ?? outcome?.lastPrice ?? outcome?.last_price);
}

function novigOutcomeQuote(market: AnyObject, outcome: AnyObject | null, oppositeOutcome: AnyObject | null, orderBook: AnyObject | null) {
  const last = novigOutcomeProbability(outcome);
  const bidEntry = novigBestBidEntry(orderBook, String(outcome?.id || ''));
  const oppositeBidEntry = novigBestBidEntry(orderBook, String(oppositeOutcome?.id || ''));
  const bid = probabilityOrNull(bidEntry?.price);
  const oppositeBid = probabilityOrNull(oppositeBidEntry?.price);
  const ask = oppositeBid == null ? null : probabilityOrNull(1 - oppositeBid);
  const price = ask ?? last ?? bid;
  const updatedAt = maxIso(
    isoOrNull(bidEntry?.created_at),
    isoOrNull(oppositeBidEntry?.created_at),
  );
  return { price, bid, ask, last, updatedAt };
}

function novigBestBidEntry(orderBook: AnyObject | null, outcomeId: string) {
  if (!orderBook || !outcomeId) return null;
  const ladders = Array.isArray(orderBook?.outcomeLadders) ? orderBook.outcomeLadders : [];
  const ladder = ladders.find((l: AnyObject) => String(l?.outcomeId || '') === outcomeId);
  const bids = Array.isArray(ladder?.bids) ? ladder.bids : [];
  let best: AnyObject | null = null;
  let bestPrice = -Infinity;
  for (const bid of bids) {
    const p = Number(bid?.price);
    if (!Number.isFinite(p)) continue;
    if (p > bestPrice) {
      bestPrice = p;
      best = bid;
    }
  }
  return best;
}

function novigPriceObject(quote: AnyObject, market: AnyObject, outcome: AnyObject | null, line: any) {
  return {
    odds: probabilityToAmerican(quote?.price),
    line: finiteOrNull(line),
    raw_probability: probabilityOrNull(quote?.price),
    bid_probability: probabilityOrNull(quote?.bid),
    ask_probability: probabilityOrNull(quote?.ask),
    last_probability: probabilityOrNull(quote?.last),
    source_market_id: stringOrNull(market?.id),
    source_outcome_id: stringOrNull(outcome?.id),
    source_updated_at: isoOrNull(quote?.updatedAt),
    market_volume: finiteOrNull(market?.volume),
    raw_market_type: stringOrNull(market?.type),
    raw_strike: finiteOrNull(market?.strike),
    outcome_index: finiteOrNull(outcome?.index),
    outcome_description: stringOrNull(outcome?.description),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket: official public Polymarket US sports API.
//
// The league endpoint is purpose-built for MLB game markets and returns teams,
// participants, game start time, main lines, and nested market prices without an
// API key. Keep Gamma as a fallback in case the US gateway is temporarily down.
// ─────────────────────────────────────────────────────────────────────────────
// Read a response body with a hard byte cap. The US league-events endpoint can
// return gigantic payloads on large CFB slates; reading them to completion OOMs
// the worker, so bail out as soon as the size is known to exceed the cap.
async function readPolymarketBody(response: any, maxBytes: number) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Polymarket US payload too large (${declared} declared bytes); using Gamma fallback.`);
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength || 0;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error(`Polymarket US payload exceeded ${maxBytes} bytes while streaming; using Gamma fallback.`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

// Stream one page at a time. Holding every raw US league event (with nested
// markets) across all pages exhausts worker memory on large NCAAF/CFB slates,
// so each page is normalized into compact source games immediately and then
// released.
async function fetchPolymarketUsLeagueEvents(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays: number) {
  const baseUrl = `${POLY_US_BASE}/v2/leagues/${cfg.polymarketSlug}/events`;
  const pageSize = 200;
  // The league endpoint can include deep historical/futures inventory for
  // college football. Stop after a bounded scan and let the date-filtered
  // Gamma fallback serve the refresh instead of keeping a worker alive for
  // hundreds of large pages.
  const maxPages = cfg.key === 'ncaaf' ? 8 : 1000;
  const games: SourceGame[] = [];
  const marketTypesSeen = new Set<string>();
  let pages = 0;
  let eventsSeen = 0;
  let dateCandidates = 0;
  let pricedMarkets = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      type: 'sport',
      section: 'general',
    });
    const url = `${baseUrl}?${params.toString()}`;
    // The US league-events endpoint can hang for 30+ seconds on large CFB
    // slates (server-side generation of the full event/market payload). Bail
    // out quickly so the date-filtered Gamma fallback can serve the snapshot.
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const text = await readPolymarketBody(response, 25_000_000);
    console.info(`polymarket us page ${pages + 1} fetched status=${response.status} bytes=${text.length}`);
    if (!response.ok) throw new Error(`Polymarket US ${cfg.label} HTTP ${response.status}`);
    let payload: AnyObject | null = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const pageEvents = Array.isArray(payload?.events) ? payload.events : [];
    eventsSeen += pageEvents.length;
    pages += 1;
    console.info(`polymarket us page ${pages} parsed events=${pageEvents.length}`);
    const parsed = normalizePolymarketUsEvents(pageEvents, gameDate, includeLive, cfg, lookaheadDays);
    games.push(...parsed.games);
    dateCandidates += parsed.dateCandidates;
    pricedMarkets += parsed.pricedMarkets;
    for (const kind of parsed.marketTypesSeen) marketTypesSeen.add(kind);
    console.info(`polymarket us page ${pages} normalized gamesSoFar=${games.length}`);
    if (pageEvents.length < pageSize) {
      return { games, pages, baseUrl, eventsSeen, dateCandidates, pricedMarkets, marketTypesSeen: [...marketTypesSeen].sort() };
    }
  }
  throw new Error(`Polymarket US ${cfg.label} event pagination exceeded ${maxPages} pages; refusing a partial result.`);
}

async function fetchPolymarketOdds(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const usBaseUrl = `${POLY_US_BASE}/v2/leagues/${cfg.polymarketSlug}/events`;
  try {
    const fetched = await fetchPolymarketUsLeagueEvents(cfg, gameDate, includeLive, lookaheadDays);
    return {
      games: fetched.games,
      debug: {
        api: 'polymarket_us_public',
        url: fetched.baseUrl,
        pages: fetched.pages,
        status: 200,
        market_fetch_mode: 'embedded_league_event_markets_all_pages_streamed',
        events: fetched.eventsSeen,
        date_candidates: fetched.dateCandidates,
        priced_markets: fetched.pricedMarkets,
        market_types_seen: fetched.marketTypesSeen,
        games: fetched.games.length,
      },
    };
  } catch (usError) {
    console.info(`polymarket us failed, falling back to gamma: ${String(usError?.message || usError).slice(0, 200)}`);
    const gamma = await fetchPolymarketGammaFallback(cfg, gameDate, includeLive, lookaheadDays);
    return {
      games: gamma.games,
      debug: {
        api: 'gamma_fallback',
        us_url: usBaseUrl,
        us_error: usError?.message || String(usError),
        ...gamma.debug,
      },
    };
  }
}

function polymarketUsEventMatchesDate(event: AnyObject, gameDate: string, includeLive: boolean) {
  if (event?.closed === true || event?.archived === true) return false;
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const startTime = isoOrNull(
    event?.startTime
    || event?.eventDate
    || firstNonEmpty(markets.map((m: AnyObject) => m?.gameStartTime || m?.eventStartTime))
  );
  const slugDate = String(event?.slug || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  const localDate = startTime ? localDateForIso(startTime, DEFAULT_TIMEZONE) : null;
  if (localDate !== gameDate && slugDate !== gameDate) return false;
  if (!includeLive && (event?.live === true || (startTime && new Date(startTime).getTime() <= Date.now() - 2 * 60 * 1000))) {
    return false;
  }
  return true;
}



function normalizePolymarketUsEvents(events: AnyObject[], gameDate: string, includeLive: boolean, cfg: any, lookaheadDays = 0) {
  const games: SourceGame[] = [];
  let dateCandidates = 0;
  let pricedMarkets = 0;
  const marketTypesSeen = new Set<string>();

  for (const event of events) {
    if (event?.closed === true || event?.archived === true) continue;
    const matchup = parsePolymarketUsMatchup(event, cfg);
    const away = matchup ? cfg.canonical(matchup.away) : null;
    const home = matchup ? cfg.canonical(matchup.home) : null;
    const isCanonicalMatchup = Boolean(away && home && away.abbr !== home.abbr);

    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const startTime = isoOrNull(event?.startTime || event?.eventDate || firstNonEmpty(markets.map((m: AnyObject) => m?.gameStartTime || m?.eventStartTime)));
    const slugDate = String(event?.slug || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const eventDate = startTime ? localDateForIso(startTime, DEFAULT_TIMEZONE) : slugDate;
    // Normal game events use the configured pregame lookahead window. Non-game
    // league events (futures/awards/outrights) are intentionally retained even
    // when their resolution date is far away.
    if (isCanonicalMatchup && eventDate && !dateIsInWindow(eventDate, gameDate, lookaheadDays)) continue;
    dateCandidates += 1;
    if (!includeLive && (event?.live === true || (isCanonicalMatchup && startTime && new Date(startTime).getTime() <= Date.now() - 2 * 60 * 1000))) continue;

    const sourceUpdatedAt = maxIsoList([event?.updatedAt, ...markets.map((m: AnyObject) => m?.updatedAt)]);
    const sourceEventId = String(event?.gameId || event?.id || event?.slug || event?.title || 'event');
    const out = makeSourceGame(
      'polymarket', sourceEventId,
      isCanonicalMatchup ? away.name : '', isCanonicalMatchup ? home.name : '',
      startTime, 'polymarket', sourceUpdatedAt, Boolean(event?.live),
    );
    if (!isCanonicalMatchup) {
      out.rawEvent = true;
      out.eventName = firstNonEmpty([event?.title, event?.question, event?.slug, sourceEventId]);
      out.eventType = 'raw_event';
    }
    const awayRef = isCanonicalMatchup ? away : { abbr: '', name: '', aliases: [] };
    const homeRef = isCanonicalMatchup ? home : { abbr: '', name: '', aliases: [] };

    for (const market of markets) {
      const kind = normalizePolyMarketType(market) || normalizeRawMarketType(
        market?.sportsMarketTypeV2 || market?.sportsMarketType || market?.marketType || market?.type || market?.question || market?.title || 'other'
      );
      marketTypesSeen.add(kind);
      const before = out.book.observations?.length || 0;
      assignPolymarketUsMarket(out, market, awayRef, homeRef, kind, cfg);
      if ((out.book.observations?.length || 0) > before) pricedMarkets += 1;
    }

    if (hasSourceGamePrice(out)) games.push(out);
  }

  return {
    games: dedupeSourceGames(games, cfg.canonical),
    dateCandidates,
    moneylineMarketsMatched: pricedMarkets,
    pricedMarkets,
    marketTypesSeen: [...marketTypesSeen].sort(),
  };
}

function parsePolymarketUsMatchup(event: AnyObject, cfg: any) {
  const slug = String(event?.slug || '').toLowerCase();
  const slugMatch = slug.match(new RegExp(`^${cfg.polymarketSlug}-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})(?:$|-)`));
  if (slugMatch) {
    const away = cfg.canonical(slugMatch[1]);
    const home = cfg.canonical(slugMatch[2]);
    if (away && home) return { away: away.name, home: home.name };
  }

  const titleMatch = parseMatchupTitle(event?.title || event?.subtitle || '');
  if (titleMatch && cfg.canonical(titleMatch.away) && cfg.canonical(titleMatch.home)) return titleMatch;

  const teams = Array.isArray(event?.teams) ? event.teams : [];
  if (teams.length === 2) {
    const first = cfg.canonical(teams[0]?.name || teams[0]?.abbreviation);
    const second = cfg.canonical(teams[1]?.name || teams[1]?.abbreviation);
    if (first && second) return { away: first.name, home: second.name };
  }
  return null;
}

function choosePolymarketMainLine(markets: AnyObject[], targetLine: number | null) {
  if (!markets.length) return null;
  if (targetLine != null) {
    return [...markets].sort((a, b) =>
      Math.abs(Math.abs(Number(a?.line ?? 999)) - Math.abs(targetLine))
      - Math.abs(Math.abs(Number(b?.line ?? 999)) - Math.abs(targetLine))
    )[0];
  }
  return [...markets].sort((a, b) => totalMarketBalanceScore(a) - totalMarketBalanceScore(b))[0];
}

function assignPolymarketUsMarket(out: SourceGame, market: AnyObject, away: AnyObject, home: AnyObject, kind: string, cfg: any) {
  const sides = Array.isArray(market?.marketSides) ? market.marketSides : [];
  const rawType = market?.sportsMarketTypeV2 || market?.sportsMarketType || market?.sports_market_type || market?.marketType || market?.type || kind;
  const marketName = firstNonEmpty([market?.question, market?.title, market?.groupItemTitle, rawType]);
  const period = inferMarketPeriod(market?.period, market?.sportsMarketType, market?.question, market?.title, market?.slug);
  const lineBase = finiteOrNull(market?.line ?? parseLineFromSelection(`${market?.groupItemTitle || ''} ${marketName || ''}`));
  let assigned = 0;

  const record = (p: number | null, sideObj: AnyObject, side: string, line: any, selection: string) => {
    const price = polyUsPriceObject(p, market, sideObj, line);
    addBookObservation(out.book, {
      ...price,
      odds: price.odds,
      market_type: kind,
      market_key: firstNonEmpty([market?.sportsMarketTypeV2, market?.sportsMarketType, market?.slug, market?.id, rawType]),
      market_name: marketName,
      period,
      side,
      selection,
      participant: firstNonEmpty([sideObj?.team?.name, market?.playerName, market?.participant?.name]),
      participant_id: firstNonEmpty([sideObj?.team?.id, market?.playerId, market?.participant?.id]),
      line,
      is_main_line: market?.isMainLine ?? market?.is_main_line ?? null,
      is_alternate_line: market?.isAlternate ?? market?.isAlternateLine ?? market?.is_alternate_line ?? null,
      raw_market_type: String(rawType || ''),
      raw_market_name: marketName,
    });
    assigned += 1;
    if (!out.rawEvent && period === 'full_game' && ['moneyline','spread','total'].includes(kind)) {
      if ((kind === 'moneyline' || kind === 'spread') && (side === 'home' || side === 'away')) out.book[kind][side] = price;
      else if (kind === 'total' && (side === 'over' || side === 'under')) out.book.total[side] = price;
    }
  };

  for (const sideObj of sides) {
    const p = probabilityOrNull(sideObj?.quote?.value ?? sideObj?.price);
    const description = String(sideObj?.description || sideObj?.team?.name || sideObj?.identifier || '');
    let side = description || String(sideObj?.identifier || 'outcome');
    let line: any = lineBase;
    if (kind === 'moneyline' || kind === 'spread') {
      const team = cfg.canonical(sideObj?.team?.name || sideObj?.team?.abbreviation || description);
      const teamSide = team?.abbr === away.abbr ? 'away' : team?.abbr === home.abbr ? 'home' : null;
      if (teamSide) side = teamSide;
      if (kind === 'moneyline') line = null;
      else {
        const parsed = parseLineFromSelection(description);
        line = finiteOrNull(parsed);
        if (line == null && lineBase != null && teamSide) line = teamSide === 'home' ? lineBase : -lineBase;
      }
    } else if (kind === 'total') {
      const lower = normalizeText(description);
      side = lower.includes('over') ? 'over' : lower.includes('under') ? 'under' : side;
      line = lineBase;
    }
    record(p, sideObj, side, line, description);
  }

  if (assigned > 0) return;

  // Older payload compatibility: outcomes/outcomePrices arrays.
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices).map((x) => probabilityOrNull(x));
  for (let i = 0; i < outcomes.length; i += 1) {
    const p = prices[i] ?? null;
    const label = String(outcomes[i] || '');
    let side = label || `outcome_${i}`;
    let line: any = lineBase;
    if (kind === 'moneyline' || kind === 'spread') {
      const team = cfg.canonical(label);
      const teamSide = team?.abbr === away.abbr ? 'away' : team?.abbr === home.abbr ? 'home' : null;
      if (teamSide) side = teamSide;
      if (kind === 'moneyline') line = null;
      else line = finiteOrNull(parseLineFromSelection(label) ?? lineBase);
    } else if (kind === 'total') {
      const lower = normalizeText(label);
      side = lower.startsWith('over') || lower === 'yes' ? 'over' : lower.startsWith('under') || lower === 'no' ? 'under' : side;
    }
    const pseudoSide = { id: `${market?.id || 'market'}:${i}`, description: label };
    record(p, pseudoSide, side, line, label);
  }

  // Binary fallback when only one quoted Yes side exists at market level. If
  // even that quote is absent, still retain the returned market definition so
  // a temporary suspension/empty book does not erase the market from history.
  if (assigned === 0) {
    const p = probabilityOrNull(market?.lastTradePrice ?? market?.bestAsk);
    let side = 'yes';
    let line: any = lineBase;
    if (kind === 'moneyline' || kind === 'spread') {
      const team = marketTeamMention(market, away, home) || cfg.canonical(market?.groupItemTitle) || cfg.canonical(market?.title);
      if (team?.abbr && away?.abbr && team.abbr === away.abbr) side = 'away';
      else if (team?.abbr && home?.abbr && team.abbr === home.abbr) side = 'home';
      if (kind === 'moneyline') line = null;
    } else if (kind === 'total') side = 'over';
    if (p != null || line != null || market?.id || market?.slug || marketName) {
      record(p, { description: 'Yes' }, side, line, 'Yes');
    }
    // Do not fabricate the complementary binary side. Raw storage only
    // records prices explicitly returned by Polymarket.
  }
}

function polyUsPriceObject(prob: number | null, market: AnyObject, side: AnyObject, line: any) {
  const longBid = probabilityOrNull(market?.bestBidQuote?.value ?? market?.bestBid);
  const longAsk = probabilityOrNull(market?.bestAskQuote?.value ?? market?.bestAsk);
  const isShortSide = side?.long === false;
  const sideBid = isShortSide
    ? (longAsk == null ? null : probabilityOrNull(1 - longAsk))
    : longBid;
  const sideAsk = isShortSide
    ? (longBid == null ? null : probabilityOrNull(1 - longBid))
    : (probabilityOrNull(side?.quote?.value) ?? longAsk);

  return {
    odds: probabilityToAmerican(prob),
    line: finiteOrNull(line),
    raw_probability: probabilityOrNull(prob),
    quote_probability: probabilityOrNull(side?.quote?.value),
    raw_side_price: probabilityOrNull(side?.price),
    bid_probability: sideBid,
    ask_probability: sideAsk,
    last_probability: probabilityOrNull(market?.lastTradePrice),
    source_market_id: stringOrNull(market?.id || market?.slug),
    source_outcome_id: stringOrNull(side?.id || side?.identifier),
    source_updated_at: isoOrNull(side?.updatedAt || market?.updatedAt),
    outcome: stringOrNull(side?.description || side?.team?.name || side?.identifier),
    source_api: 'polymarket_us_public',
  };
}

async function fetchPolymarketGammaFallback(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const sportsRes = await fetch(`${POLY_GAMMA_BASE}/sports`, { headers: { Accept: 'application/json' } });
  const sports = await safeJson(sportsRes);
  if (!sportsRes.ok || !Array.isArray(sports)) throw new Error(`Polymarket sports HTTP ${sportsRes.status}`);
  const sportAliases = new Set([cfg.key, cfg.label, cfg.polymarketSlug, cfg.key === 'ncaaf' ? 'cfb' : ''].map(normalizeText).filter(Boolean));
  const sportMeta = sports.find((item: any) => sportAliases.has(normalizeText(item?.sport)) || sportAliases.has(normalizeText(item?.name)));
  if (!sportMeta) return { games: [], debug: { error: `${cfg.label} sport metadata not found.` } };
  console.info(`gamma sports meta resolved for ${cfg.label}`);

  const seriesId = String(sportMeta?.series || sportMeta?.seriesId || sportMeta?.series_id || '').trim();
  const tagIds = String(sportMeta?.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
  const tagId = String(sportMeta?.primaryTagId || tagIds[tagIds.length - 1] || '').trim();
  if (!seriesId && !tagId) return { games: [], debug: { error: `${cfg.label} Polymarket series/tag metadata not found.`, sport: sportMeta } };

  let fetched = seriesId ? await fetchPolymarketEventsBySeries(seriesId, gameDate, lookaheadDays) : { events: [], pages: 0, mode: 'series_unavailable' };
  if (!fetched.events.length && seriesId) fetched = await fetchPolymarketEventsBySeries(seriesId, null, lookaheadDays);
  if (!fetched.events.length && tagId) {
    const fallbackEvents = await fetchPolymarketEventsByTag(tagId);
    fetched = { events: fallbackEvents, pages: 1, mode: 'tag_fallback' };
  }

  console.info(`gamma fetch mode=${fetched.mode} pages=${fetched.pages} events=${fetched.events.length}`);
  const events = fetched.events;
  const games: SourceGame[] = [];
  let matchupCandidates = 0;
  let datedCandidates = 0;
  let pricedMarkets = 0;

  for (const event of events) {
    const matchup = parsePolymarketMatchup(event, cfg);
    const away = matchup ? cfg.canonical(matchup.away) : null;
    const home = matchup ? cfg.canonical(matchup.home) : null;
    const isCanonicalMatchup = Boolean(away && home && away.abbr !== home.abbr);
    if (isCanonicalMatchup) matchupCandidates += 1;

    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const marketStart = firstNonEmpty(markets.map((m: AnyObject) => m?.gameStartTime || m?.eventStartTime));
    const startTime = isoOrNull(marketStart || event?.startTime || event?.eventDate);
    const slugDate = String(event?.slug || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const eventDate = startTime ? localDateForIso(startTime, DEFAULT_TIMEZONE) : slugDate;
    if (isCanonicalMatchup && eventDate && !dateIsInWindow(eventDate, gameDate, lookaheadDays)) continue;
    datedCandidates += 1;
    if (!includeLive && isCanonicalMatchup && startTime && new Date(startTime).getTime() <= Date.now() - 2 * 60 * 1000) continue;

    const sourceUpdatedAt = maxIsoList([event?.updatedAt, ...markets.map((m: any) => m?.updatedAt)]);
    const sourceEventId = String(event?.id || event?.gameId || event?.slug || event?.title || 'event');
    const out = makeSourceGame(
      'polymarket', sourceEventId,
      isCanonicalMatchup ? away.name : '', isCanonicalMatchup ? home.name : '',
      startTime, 'polymarket', sourceUpdatedAt, false,
    );
    if (!isCanonicalMatchup) {
      out.rawEvent = true;
      out.eventName = firstNonEmpty([event?.title, event?.question, event?.slug, sourceEventId]);
      out.eventType = 'raw_event';
    }
    const awayRef = isCanonicalMatchup ? away : { abbr: '', name: '', aliases: [] };
    const homeRef = isCanonicalMatchup ? home : { abbr: '', name: '', aliases: [] };

    for (const market of markets) {
      const kind = normalizePolyMarketType(market) || normalizeRawMarketType(
        market?.sportsMarketTypeV2 || market?.sportsMarketType || market?.marketType || market?.type || market?.question || market?.title || 'other'
      );
      const before = out.book.observations?.length || 0;
      assignPolymarketOutcomes(out, market, awayRef, homeRef, kind, cfg);
      if ((out.book.observations?.length || 0) > before) pricedMarkets += 1;
    }

    if (hasSourceGamePrice(out)) games.push(out);
  }

  console.info(`gamma processed games=${games.length} pricedGames=${pricedMarkets}`);
  return {
    games: dedupeSourceGames(games, cfg.canonical),
    debug: {
      seriesId: seriesId || null,
      tagId: tagId || null,
      fetch_mode: fetched.mode,
      pages: fetched.pages,
      events: events.length,
      matchup_candidates: matchupCandidates,
      date_candidates: datedCandidates,
      priced_games: pricedMarkets,
      games: games.length,
    },
  };
}

async function fetchPolymarketEventsBySeries(seriesId: string, eventDate: string | null, lookaheadDays = 0) {
  const events: AnyObject[] = [];
  let afterCursor = '';
  let pages = 0;
  const maxPages = 1000;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      series_id: seriesId,
      limit: '500',
      closed: 'false',
    });
    if (eventDate) {
      params.set('start_date_min', `${eventDate}T00:00:00Z`);
      params.set('start_date_max', `${addDaysDate(eventDate, lookaheadDays + 1)}T12:00:00Z`);
    }
    if (afterCursor) params.set('after_cursor', afterCursor);
    const response = await fetch(`${POLY_GAMMA_BASE}/events/keyset?${params.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(`Polymarket events/keyset HTTP ${response.status}`);
    const pageEvents = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload?.data) ? payload.data : [];
    events.push(...pageEvents);
    pages += 1;
    console.info(`polymarket gamma page ${pages} eventsSoFar=${events.length}`);
    const next = String(payload?.next_cursor || payload?.nextCursor || '').trim();
    if (!next || next === 'LTE=') { complete = true; break; }
    if (next === afterCursor) throw new Error('Polymarket event cursor repeated before pagination completed.');
    afterCursor = next;
  }
  if (!complete) throw new Error(`Polymarket event pagination exceeded ${maxPages} pages; refusing a partial result.`);
  return { events, pages, mode: eventDate ? 'series_time_window' : 'series' };
}

async function fetchPolymarketEventsByTag(tagId: string) {
  // Gamma's modern keyset endpoint accepts tag_id and avoids the legacy
  // offset/list cap. Follow every cursor so large CFB slates are not truncated.
  const events: AnyObject[] = [];
  let afterCursor = '';
  let pages = 0;
  const maxPages = 1000;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ tag_id: tagId, closed: 'false', limit: '500' });
    if (afterCursor) params.set('after_cursor', afterCursor);
    const response = await fetch(`${POLY_GAMMA_BASE}/events/keyset?${params.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(`Polymarket tag events HTTP ${response.status}`);
    const pageEvents = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload?.data) ? payload.data : [];
    events.push(...pageEvents);
    pages += 1;
    console.info(`polymarket gamma page ${pages} eventsSoFar=${events.length}`);
    const next = String(payload?.next_cursor || payload?.nextCursor || '').trim();
    if (!next || next === 'LTE=') { complete = true; break; }
    if (next === afterCursor) throw new Error('Polymarket tag cursor repeated before pagination completed.');
    afterCursor = next;
  }
  if (!complete) throw new Error(`Polymarket tag pagination exceeded ${maxPages} pages; refusing a partial result.`);
  return events;
}

function parsePolymarketMatchup(event: AnyObject, cfg: any) {
  const byTitle = parseMatchupTitle(event?.title || event?.subtitle || '');
  if (byTitle && cfg.canonical(byTitle.away) && cfg.canonical(byTitle.home)) return byTitle;
  const slug = String(event?.slug || '').toLowerCase();
  const match = slug.match(new RegExp(`^${cfg.polymarketSlug}-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})(?:$|-)`));
  if (!match) return byTitle;
  const away = cfg.canonical(match[1]);
  const home = cfg.canonical(match[2]);
  if (!away || !home) return byTitle;
  return { away: away.name, home: home.name };
}

function normalizePolyMarketType(market: any) {
  // Prefer sportsMarketTypeV2. The older sportsMarketType is descriptive
  // (`baseball_team_full_game_winner`) and does not literally contain the word
  // moneyline, which caused embedded MLB game-winner markets to be missed.
  const raw = normalizeText(
    market?.sportsMarketTypeV2
    || market?.sportsMarketType
    || market?.sports_market_type
    || market?.marketType
    || market?.type
  ).replace(/^sports market type /, '').replace(/^sportsmarkettype /, '');
  const label = normalizeText(`${market?.question || ''} ${market?.title || ''} ${market?.groupItemTitle || ''} ${market?.spreadTotalSuffix || ''}`);
  const derivative = /player|pitcher|batter|team total|strikeout|passing|rushing|receiving|assists|rebounds|blocks|steals/.test(`${raw} ${label}`);
  if (derivative) return null;
  if (raw === 'moneyline' || raw === 'ml' || raw.includes('moneyline') || raw.includes('full game winner') || /(?:moneyline|winner|who will win|to win)/.test(label)) return 'moneyline';
  if (raw === 'spread' || raw === 'spreads' || raw === 'run line' || raw === 'run_line' || raw.includes('spread') || /(?:spread|run line)/.test(label)) return 'spread';
  if (raw === 'total' || raw === 'totals' || raw === 'total points' || raw === 'total_points' || raw.includes('game total') || /(?:total runs|over\/under|over under|o\/u)/.test(label)) return 'total';
  return null;
}

function isPolymarketFullGameMarket(market: AnyObject) {
  const rawType = normalizeText(market?.sportsMarketType || market?.sports_market_type || '');
  const slug = normalizeText(market?.slug || market?.identifier || '');
  const label = normalizeText(`${market?.question || ''} ${market?.title || ''} ${market?.description || ''}`);

  if (rawType.includes('first five') || rawType.includes('first 5')) return false;
  if (/(?:^| )f5(?: |$)/.test(slug) || label.includes('first 5 innings') || label.includes('first five innings')) return false;

  // Polymarket's MLB game-level taxonomy currently marks these as full_game.
  // If that descriptive field is absent, accept the market unless it was
  // explicitly identified as a partial-game derivative above.
  if (rawType) return rawType.includes('full game') || rawType.includes('full_game') || rawType.includes('winner');
  return true;
}

function assignPolymarketOutcomes(out: SourceGame, market: any, away: AnyObject, home: AnyObject, kind: string, cfg: any) {
  const outcomes = parseJsonArray(market?.outcomes);
  const rawPrices = parseJsonArray(market?.outcomePrices);
  const question = String(market?.question || market?.title || '');
  const marketName = firstNonEmpty([market?.question, market?.title, market?.groupItemTitle, market?.slug]);
  const marketKey = firstNonEmpty([market?.id, market?.conditionId, market?.slug, marketName]);
  const rawType = market?.sportsMarketTypeV2 || market?.sportsMarketType || market?.sports_market_type || market?.marketType || market?.type || kind;
  const period = inferMarketPeriod(market?.period, market?.sportsMarketType, market?.question, market?.title, market?.slug);
  const lineBase = finiteOrNull(market?.line ?? parseLineFromSelection(`${market?.groupItemTitle || ''} ${question}`));
  let assigned = 0;

  const record = (p: number | null, label: string, index: number, side: string, line: any) => {
    const price = polyPriceObject(p as any, market, label, line);
    addBookObservation(out.book, {
      ...price,
      odds: p == null ? null : price.odds,
      raw_probability: p,
      market_type: kind,
      market_key: marketKey,
      market_name: marketName,
      period,
      side,
      selection: label || `outcome_${index}`,
      participant: firstNonEmpty([market?.playerName, market?.participant?.name, market?.groupItemTitle]),
      participant_id: firstNonEmpty([market?.playerId, market?.participant?.id]),
      prop_key: firstNonEmpty([market?.propKey, market?.stat, market?.sportsMarketTypeV2, market?.sportsMarketType]),
      line,
      is_main_line: market?.isMainLine ?? market?.is_main_line ?? null,
      is_alternate_line: market?.isAlternate ?? market?.isAlternateLine ?? market?.is_alternate_line ?? null,
      source_outcome_id: `${marketKey || 'market'}:${index}`,
      raw_market_type: String(rawType || ''),
      raw_market_name: marketName,
    });
    assigned += 1;
    if (!out.rawEvent && period === 'full_game') {
      if (kind === 'moneyline' && (side === 'away' || side === 'home')) out.book.moneyline[side] = price;
      else if (kind === 'spread' && (side === 'away' || side === 'home') && finiteOrNull(line) != null) out.book.spread[side] = price;
      else if (kind === 'total' && (side === 'over' || side === 'under') && finiteOrNull(line) != null) out.book.total[side] = price;
    }
  };

  // Keep every explicit outcome, including temporarily unpriced outcomes. A
  // market definition with a line/selection identity still belongs in the raw
  // canonical store even when the exchange has no current trade price.
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i] || '');
    const p = probabilityOrNull(rawPrices[i]);
    let side = label || `outcome_${i}`;
    let line: any = lineBase;
    if (kind === 'moneyline' || kind === 'spread') {
      const team = cfg.canonical(label);
      const teamSide = team?.abbr && away?.abbr && team.abbr === away.abbr
        ? 'away'
        : team?.abbr && home?.abbr && team.abbr === home.abbr ? 'home' : null;
      if (teamSide) side = teamSide;
      if (kind === 'moneyline') line = null;
      else line = finiteOrNull(parseLineFromSelection(label) ?? lineBase);
    } else if (kind === 'total') {
      const lower = normalizeText(label);
      side = lower.startsWith('over') || lower === 'yes' ? 'over' : lower.startsWith('under') || lower === 'no' ? 'under' : side;
    }
    record(p, label, i, side, line);
  }

  // Some binary Gamma markets expose only a market-level Yes quote instead of
  // outcomePrices. Store that explicit quote only; never synthesize 1-p.
  if (assigned === 0) {
    const p = probabilityOrNull(market?.lastTradePrice ?? market?.bestAsk);
    if (p == null && lineBase == null && !marketKey) return;
    let side = 'yes';
    let line: any = lineBase;
    if (kind === 'moneyline' || kind === 'spread') {
      const team = marketTeamMention(market, away, home)
        || cfg.canonical(market?.groupItemTitle)
        || cfg.canonical(market?.title);
      if (team?.abbr && away?.abbr && team.abbr === away.abbr) side = 'away';
      else if (team?.abbr && home?.abbr && team.abbr === home.abbr) side = 'home';
      if (kind === 'moneyline') line = null;
      else line = finiteOrNull(lineBase ?? extractMarketLine(market));
    } else if (kind === 'total') {
      side = 'over';
    }
    record(p, 'Yes', 0, side, line);
  }
}

function totalMarketBalanceScore(market: any) {
  const sidePrices = Array.isArray(market?.marketSides)
    ? market.marketSides.map((s: AnyObject) => probabilityOrNull(s?.price)).filter((x: any) => x != null)
    : [];
  const prices = sidePrices.length
    ? sidePrices
    : parseJsonArray(market?.outcomePrices).map((x) => probabilityOrNull(x)).filter((x) => x != null);
  if (!prices.length) {
    const p = probabilityOrNull(market?.lastTradePrice ?? market?.bestAsk);
    return p == null ? 999 : Math.abs(p - 0.5);
  }
  return Math.min(...prices.map((p) => Math.abs(Number(p) - 0.5)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinnacle Arcadia guest API. The raw collector keeps every straight market,
// alternate line, period and special returned for the target league. The
// Pinnacle main line is selected later by the UI; ingestion never normalizes or
// discards another book's line.
// ─────────────────────────────────────────────────────────────────────────────
async function resolvePinnacleLeague(cfg: any, headers: AnyObject) {
  if (cfg?.pinnacle?.leagueId != null) {
    return { leagueId: Number(cfg.pinnacle.leagueId), discoveryUrl: null, leaguesSeen: [] };
  }
  const discoveryUrl = `${PINNACLE_ARCADIA_BASE}/sports/${cfg.pinnacle.sportId}/leagues?all=false`;
  const response = await fetch(discoveryUrl, { headers });
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(`Pinnacle league discovery HTTP ${response.status}`);
  const leagues = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const wanted = cfg.key === 'ncaaf'
    ? leagues.find((l: AnyObject) => /ncaa.*football|college.*football|\bncaaf?\b/i.test(String(l?.name || '')))
    : leagues.find((l: AnyObject) => normalizeText(l?.name) === normalizeText(cfg.label));
  const leagueId = finiteOrNull(wanted?.id);
  if (leagueId == null) {
    const names = leagues.slice(0, 80).map((l: AnyObject) => `${l?.id}:${l?.name}`).join(', ');
    throw new Error(`Pinnacle ${cfg.label} league not found in sport ${cfg.pinnacle.sportId}. Leagues seen: ${names}`);
  }
  return {
    leagueId,
    discoveryUrl,
    leaguesSeen: leagues.map((l: AnyObject) => ({ id: l?.id ?? null, name: l?.name ?? null })),
  };
}

function pinnacleMarketPeriod(market: AnyObject, matchup: AnyObject | null) {
  const textPeriod = inferMarketPeriod(
    market?.periodName,
    market?.description,
    market?.type,
    matchup?.units,
    matchup?.special?.description,
    matchup?.description,
  );
  if (textPeriod !== 'full_game') return textPeriod;
  const period = finiteOrNull(market?.period);
  if (period == null || period === 0) return 'full_game';
  return `period_${period}`;
}

function pinnacleParticipantName(rawMatchup: AnyObject | null, price: AnyObject) {
  const participantId = String(price?.participantId ?? '').trim();
  const participants = Array.isArray(rawMatchup?.participants) ? rawMatchup.participants : [];
  const participant = participantId
    ? participants.find((p: AnyObject) => String(p?.id ?? '') === participantId)
    : null;
  return firstNonEmpty([
    participant?.name,
    price?.participantName,
    price?.name,
    rawMatchup?.special?.description,
  ]);
}

async function fetchPinnacleOdds(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const apiKey = String(Deno.env.get('PINNACLE_GUEST_API_KEY') || '').trim();
  if (!apiKey) {
    return { games: [], debug: { configured: false, error: 'Missing PINNACLE_GUEST_API_KEY secret.' } };
  }

  const headers = { Accept: 'application/json', 'x-api-key': apiKey };
  const league = await resolvePinnacleLeague(cfg, headers);
  const matchupUrl = `${PINNACLE_ARCADIA_BASE}/leagues/${league.leagueId}/matchups`;
  // The sport-wide endpoint returns every football league's markets and is
  // unusually large for NCAAF. Use the resolved league endpoint there so the
  // worker only downloads markets that can belong to the selected CFB slate.
  const marketUrl = cfg.key === 'ncaaf'
    ? `${PINNACLE_ARCADIA_BASE}/leagues/${league.leagueId}/markets/straight?primaryOnly=false&withSpecials=false`
    : `${PINNACLE_ARCADIA_BASE}/sports/${cfg.pinnacle.sportId}/markets/straight?primaryOnly=false&withSpecials=false`;

  const [matchupResponse, marketResponse] = await Promise.all([
    fetch(matchupUrl, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(marketUrl, { headers, signal: AbortSignal.timeout(15_000) }),
  ]);
  const [matchupPayload, marketPayload] = await Promise.all([
    safeJson(matchupResponse),
    safeJson(marketResponse),
  ]);

  if (!matchupResponse.ok) throw new Error(`Pinnacle matchups HTTP ${matchupResponse.status}`);
  if (!marketResponse.ok) throw new Error(`Pinnacle markets HTTP ${marketResponse.status}`);

  const rawMatchups = Array.isArray(matchupPayload) ? matchupPayload : Array.isArray(matchupPayload?.data) ? matchupPayload.data : [];
  const rawMarkets = Array.isArray(marketPayload) ? marketPayload : Array.isArray(marketPayload?.data) ? marketPayload.data : [];
  const rawById = new Map<string, AnyObject>();
  for (const raw of rawMatchups) {
    const id = String(raw?.id || '').trim();
    if (id) rawById.set(id, raw);
  }

  // Root fixtures are canonical games. Related/special matchups inherit their
  // root fixture and are stored under that event instead of being dropped.
  const roots = new Map<string, AnyObject>();
  for (const raw of rawMatchups) {
    const id = String(raw?.id || '').trim();
    if (!id) continue;
    if (raw?.parentId != null || raw?.parent != null) continue;
    if (String(raw?.type || 'matchup').toLowerCase() !== 'matchup') continue;

    const participants = Array.isArray(raw?.participants) ? raw.participants : [];
    const home = participants.find((p: AnyObject) => String(p?.alignment || '').toLowerCase() === 'home');
    const away = participants.find((p: AnyObject) => String(p?.alignment || '').toLowerCase() === 'away');
    const homeName = String(home?.name || '').trim();
    const awayName = String(away?.name || '').trim();
    if (!cfg.canonical(homeName) || !cfg.canonical(awayName)) continue;

    const startTime = isoOrNull(raw?.startTime);
    if (!startIsInWindow(startTime, gameDate, lookaheadDays)) continue;
    const isLive = raw?.isLive === true || String(raw?.status || '').toLowerCase() === 'live';
    if (!includeLive && isLive) continue;

    roots.set(id, {
      id,
      awayName,
      homeName,
      startTime,
      isLive,
      matchupVersion: finiteOrNull(raw?.version),
      raw,
    });
  }

  function rootIdFor(matchupId: string) {
    let id = matchupId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 12 && id && !seen.has(id); depth += 1) {
      if (roots.has(id)) return id;
      seen.add(id);
      const raw = rawById.get(id);
      const parent = String(raw?.parentId ?? raw?.parent?.id ?? raw?.parent ?? '').trim();
      if (!parent) return null;
      id = parent;
    }
    return null;
  }

  function topRawMatchupFor(matchupId: string) {
    let id = matchupId;
    let last: AnyObject | null = null;
    const seen = new Set<string>();
    for (let depth = 0; depth < 12 && id && !seen.has(id); depth += 1) {
      seen.add(id);
      const raw = rawById.get(id);
      if (!raw) return last;
      last = raw;
      const parent = String(raw?.parentId ?? raw?.parent?.id ?? raw?.parent ?? '').trim();
      if (!parent) return raw;
      id = parent;
    }
    return last;
  }

  function isCanonicalPinnacleGame(raw: AnyObject | null) {
    if (!raw || String(raw?.type || 'matchup').toLowerCase() !== 'matchup') return false;
    const participants = Array.isArray(raw?.participants) ? raw.participants : [];
    const home = participants.find((x: AnyObject) => String(x?.alignment || '').toLowerCase() === 'home');
    const away = participants.find((x: AnyObject) => String(x?.alignment || '').toLowerCase() === 'away');
    const h = cfg.canonical(home?.name || '');
    const a = cfg.canonical(away?.name || '');
    return Boolean(a && h && a.abbr !== h.abbr);
  }

  const byRoot = new Map<string, SourceGame>();
  let retainedMarkets = 0;
  let retainedPrices = 0;
  let unboundMarkets = 0;
  const marketTypesSeen = new Set<string>();
  const periodsSeen = new Set<string>();

  for (const market of rawMarkets) {
    if (String(market?.status || '').toLowerCase() !== 'open') continue;
    const matchupId = String(market?.matchupId || '').trim();
    const rawMatchup = rawById.get(matchupId) || null;
    const rootId = rootIdFor(matchupId);
    const root = rootId ? roots.get(rootId) : null;

    // The straight-market endpoint is sport-wide. Never retain an unbound
    // market unless its matchup id exists in the selected league's matchup
    // payload; otherwise we could leak another league into this sport snapshot.
    if (!root && !rawMatchup) { unboundMarkets += 1; continue; }
    // A normal game can be absent from `roots` simply because it is outside the
    // configured lookahead window (or live when includeLive=false). Do not turn
    // that ordinary game or one of its child specials into a raw-event bypass.
    const rawTop = !root ? topRawMatchupFor(matchupId) : null;
    if (!root && isCanonicalPinnacleGame(rawTop)) { unboundMarkets += 1; continue; }

    const storageKey = rootId || `raw:${matchupId}`;
    let out = byRoot.get(storageKey);
    if (!out) {
      if (root) {
        out = makeSourceGame(
          'pinnacle_arcadia_guest', rootId, root.awayName, root.homeName,
          root.startTime, 'pinnacle', null, root.isLive,
        );
      } else {
        const rawStart = isoOrNull(rawMatchup?.startTime);
        const rawLive = rawMatchup?.isLive === true || String(rawMatchup?.status || '').toLowerCase() === 'live';
        if (!includeLive && rawLive) continue;
        out = makeSourceGame(
          'pinnacle_arcadia_guest', matchupId, '', '', rawStart,
          'pinnacle', null, rawLive,
        );
        out.rawEvent = true;
        out.eventName = firstNonEmpty([
          rawMatchup?.special?.description, rawMatchup?.description, rawMatchup?.name,
          Array.isArray(rawMatchup?.participants) ? rawMatchup.participants.map((x: AnyObject) => x?.name).filter(Boolean).join(' / ') : null,
          matchupId,
        ]);
        out.eventType = String(rawMatchup?.type || 'raw_event');
      }
      byRoot.set(storageKey, out);
    }

    const effectiveMatchup = rawMatchup || root?.raw || null;
    const rawType = String(market?.type || market?.units || effectiveMatchup?.units || 'other');
    const marketType = normalizeRawMarketType(rawType);
    const period = pinnacleMarketPeriod(market, effectiveMatchup);
    marketTypesSeen.add(marketType);
    periodsSeen.add(period);
    const prices = Array.isArray(market?.prices) ? market.prices : [];
    const maxRiskStake = Array.isArray(market?.limits)
      ? finiteOrNull(market.limits.find((x: AnyObject) => String(x?.type || '') === 'maxRiskStake')?.amount)
      : null;
    const isAlternate = market?.isAlternate === true;
    const isMain = market?.isAlternate !== true;
    const sourceMarketId = firstNonEmpty([market?.key, market?.id, matchupId]);
    retainedMarkets += 1;

    for (const price of prices) {
      const odds = parseAmericanOdds(price?.price);
      const designation = String(price?.designation || price?.side || price?.name || '').toLowerCase();
      let side = designation || null;
      if ((marketType === 'moneyline' || marketType === 'spread') && !['home', 'away', 'draw'].includes(side || '')) {
        const participant = pinnacleParticipantName(effectiveMatchup, price);
        side = inferTeamSideForSport(cfg, designation, participant || '', root?.awayName || '', root?.homeName || '') || side;
      }
      if (marketType === 'total' && !['over', 'under'].includes(side || '')) {
        side = designation.includes('over') ? 'over' : designation.includes('under') ? 'under' : side;
      }
      if (!side) side = firstNonEmpty([price?.name, price?.participantId, price?.designation, 'selection']);
      const line = marketType === 'moneyline' ? null : finiteOrNull(price?.points);
      const rawMeta = {
        ...price,
        marketId: sourceMarketId,
        version: market?.version,
        maxRiskStake,
        cutoffAt: market?.cutoffAt || null,
      };
      const priceObj = pinnaclePriceObject(price?.price, line, rawMeta);
      addBookObservation(out.book, {
        ...priceObj,
        odds,
        market_type: marketType,
        market_key: sourceMarketId,
        market_name: firstNonEmpty([effectiveMatchup?.special?.description, effectiveMatchup?.description, rawType]),
        period,
        side,
        selection: firstNonEmpty([price?.name, price?.designation, pinnacleParticipantName(effectiveMatchup, price)]),
        participant: pinnacleParticipantName(effectiveMatchup, price),
        participant_id: stringOrNull(price?.participantId),
        prop_key: firstNonEmpty([effectiveMatchup?.units, effectiveMatchup?.special?.category, rawType]),
        line,
        is_main_line: isMain,
        is_alternate_line: isAlternate,
        raw_market_type: rawType,
        raw_market_name: firstNonEmpty([effectiveMatchup?.special?.description, effectiveMatchup?.description]),
        raw_selection_type: designation,
      });
      retainedPrices += 1;

      // Legacy main-line mirrors only. All alternate/period/special prices stay
      // in observations even when they do not fit these fields.
      if (!out.rawEvent && period === 'full_game' && isMain) {
        if (marketType === 'moneyline' && (side === 'home' || side === 'away')) out.book.moneyline[side] = priceObj;
        else if (marketType === 'spread' && (side === 'home' || side === 'away') && line != null) out.book.spread[side] = priceObj;
        else if (marketType === 'total' && (side === 'over' || side === 'under') && line != null) out.book.total[side] = priceObj;
      }
    }

    if (!prices.length) {
      addBookObservation(out.book, {
        odds: null,
        market_type: marketType,
        market_key: sourceMarketId,
        market_name: firstNonEmpty([effectiveMatchup?.special?.description, effectiveMatchup?.description, rawType]),
        period,
        side: null,
        selection: null,
        participant: null,
        line: finiteOrNull(market?.points),
        is_main_line: isMain,
        is_alternate_line: isAlternate,
        source_market_id: sourceMarketId,
        source_version: finiteOrNull(market?.version),
        max_risk_stake: maxRiskStake,
        cutoff_at: isoOrNull(market?.cutoffAt),
        raw_market_type: rawType,
        raw_market_name: firstNonEmpty([effectiveMatchup?.special?.description, effectiveMatchup?.description]),
        available: false,
      });
    }
  }

  const games = [...byRoot.values()].filter(hasSourceGamePrice);
  return {
    games,
    debug: {
      configured: true,
      league_id: league.leagueId,
      league_discovery_url: league.discoveryUrl,
      matchup_url: matchupUrl,
      market_url: marketUrl,
      matchup_status: matchupResponse.status,
      market_status: marketResponse.status,
      raw_matchups: rawMatchups.length,
      root_matchups: roots.size,
      raw_markets: rawMarkets.length,
      retained_markets: retainedMarkets,
      retained_prices: retainedPrices,
      unbound_markets: unboundMarkets,
      market_types_seen: [...marketTypesSeen].sort(),
      periods_seen: [...periodsSeen].sort(),
      market_retention: 'main_game_lines_only_primary_alternate',
      games: games.length,
    },
  };
}

function pinnaclePriceObject(odds: any, line: any, raw: AnyObject) {
  return {
    odds: parseAmericanOdds(odds),
    line: finiteOrNull(line),
    source_market_id: stringOrNull(raw?.marketId),
    source_updated_at: null,
    source_version: finiteOrNull(raw?.version),
    max_risk_stake: finiteOrNull(raw?.maxRiskStake),
    cutoff_at: isoOrNull(raw?.cutoffAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge + storage
// ─────────────────────────────────────────────────────────────────────────────
function mergeSourceGames(sourceGames: SourceGame[], gameDate: string, cfg: any) {
  const merged: AnyObject[] = [];
  for (const sourceGame of sourceGames) {
    const away = cfg.canonical(sourceGame.awayTeam);
    const home = cfg.canonical(sourceGame.homeTeam);

    // Preserve source events that are not ordinary head-to-head matchups
    // (futures, awards, outrights, etc.). They intentionally do not merge into
    // game-detail records, but every returned market/outcome is still stored.
    // Main game lines only: futures/awards/non-matchup raw events are dropped.
    if (sourceGame.rawEvent === true) continue;
    if (!away || !home || away.abbr === home.abbr) {
      const rawId = String(sourceGame.sourceEventId || sourceGame.eventName || `${sourceGame.awayTeam || ''}:${sourceGame.homeTeam || ''}:${sourceGame.startTime || gameDate}`);
      const rawKey = `raw:${sourceGame.source}:${rawId}`;
      let rawTarget = merged.find((g) => g.canonical_event_key === rawKey);
      if (!rawTarget) {
        rawTarget = {
          away_team_id: '',
          away_team_name: sourceGame.awayTeam || '',
          away_team_abbr: '',
          home_team_id: '',
          home_team_name: sourceGame.homeTeam || '',
          home_team_abbr: '',
          event_name: sourceGame.eventName || rawId,
          event_type: sourceGame.eventType || 'raw_event',
          start_time: sourceGame.startTime || null,
          source_event_ids: {},
          books: new Map<string, AnyObject>(),
          is_live: sourceGame.isLive === true,
          canonical_event_key: rawKey,
          raw_event: true,
        };
        merged.push(rawTarget);
      }
      if (!rawTarget.start_time && sourceGame.startTime) rawTarget.start_time = sourceGame.startTime;
      if (sourceGame.sourceEventId) rawTarget.source_event_ids[sourceGame.source] = sourceGame.sourceEventId;
      rawTarget.is_live = rawTarget.is_live || sourceGame.isLive === true;
      mergeBook(rawTarget.books, sourceGame.book);
      continue;
    }
    const startMs = sourceGame.startTime ? new Date(sourceGame.startTime).getTime() : NaN;
    const candidates = merged.filter((g) => g.away_team_abbr === away.abbr && g.home_team_abbr === home.abbr);
    let target: AnyObject | null = null;
    if (candidates.length === 1) {
      const c = candidates[0];
      const cMs = c.start_time ? new Date(c.start_time).getTime() : NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(cMs) || Math.abs(startMs - cMs) <= 90 * 60 * 1000) target = c;
    } else if (candidates.length > 1 && Number.isFinite(startMs)) {
      target = candidates.slice().sort((a, b) => {
        const da = Math.abs(new Date(a.start_time || 0).getTime() - startMs);
        const db = Math.abs(new Date(b.start_time || 0).getTime() - startMs);
        return da - db;
      })[0] || null;
      if (target && Math.abs(new Date(target.start_time || 0).getTime() - startMs) > 90 * 60 * 1000) target = null;
    }
    if (!target) {
      target = {
        away_team_id: away.abbr,
        away_team_name: away.name,
        away_team_abbr: away.abbr,
        home_team_id: home.abbr,
        home_team_name: home.name,
        home_team_abbr: home.abbr,
        start_time: sourceGame.startTime || null,
        source_event_ids: {},
        books: new Map<string, AnyObject>(),
        is_live: false,
      };
      merged.push(target);
    }
    if (!target.start_time && sourceGame.startTime) target.start_time = sourceGame.startTime;
    if (sourceGame.sourceEventId) target.source_event_ids[sourceGame.source] = sourceGame.sourceEventId;
    target.is_live = target.is_live || sourceGame.isLive === true;
    mergeBook(target.books, sourceGame.book);
  }

  const finalized: AnyObject[] = merged.map((game: AnyObject) => {
    if (game.canonical_event_key) return game;
    const startToken = game.start_time ? String(game.start_time).slice(0, 16) : gameDate;
    return { ...game, canonical_event_key: `${game.away_team_abbr}:${game.home_team_abbr}:${startToken}` };
  });
  return finalized.sort((a: AnyObject, b: AnyObject) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
}

function mergeBook(bookMap: Map<string, AnyObject>, incoming: AnyObject) {
  const key = normalizeBookKey(incoming?.bookmaker_id);
  if (!key) return;
  const existing = bookMap.get(key) || makeBook(key, incoming?.source, incoming?.source_event_id, incoming?.source_updated_at);
  existing.source = incoming?.source || existing.source;
  existing.source_event_id = incoming?.source_event_id || existing.source_event_id;
  existing.source_updated_at = maxIso(existing.source_updated_at, incoming?.source_updated_at);
  existing.observations = Array.isArray(existing.observations) ? existing.observations : [];
  if (Array.isArray(incoming?.observations)) existing.observations.push(...incoming.observations);
  for (const market of ['moneyline','spread','total']) {
    existing[market] = existing[market] || {};
    for (const side of Object.keys(incoming?.[market] || {})) {
      if (incoming[market][side] != null) existing[market][side] = incoming[market][side];
    }
  }
  bookMap.set(key, existing);
}
