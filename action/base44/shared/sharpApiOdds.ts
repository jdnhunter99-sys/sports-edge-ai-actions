// SharpAPI connector for the SharpOddsDatabase collector.
//
// Extracted from base44/functions/refreshSharpOddsDatabase/entry.ts to keep the
// entry file under the platform size limit. Extended with rate-limit handling:
// the SharpAPI free tier allows only 12 requests per minute, so the paginated
// feed is fetched through a local request gate plus wait-and-retry logic for
// HTTP 429 / rate_limited responses (whose payload carries retryAfter / reset_at).
// The whole fetch runs under a wall-clock budget so a slow, rate-limited pull
// fails this connector gracefully instead of hanging the refresh.

import {
  AnyObject, SourceGame, addBookObservation, hasSourceGamePrice, makeSourceGame,
  normalizeBookKey, normalizeMarketPeriod, normalizeMarketType, normalizeRawMarketType,
  parseAmericanOdds, parseLineFromSelection, parseMatchupTitle, priceObject,
  americanToProbability, probabilityOrNull, probabilityToAmerican,
  finiteOrNull, firstNonEmpty, isoOrNull, maxIso, normalizeText,
  sleep, safeJson, startIsInWindow,
} from './sharpOddsCommon.ts';
import { inferTeamSideForSport } from './sharpOddsSports.ts';

export const SHARP_BASE_URL = 'https://api.sharpapi.io/api/v1/odds';
export const SHARP_EXCLUDED_BOOKS = new Set(['kalshi']);

// SharpAPI free tier: 12 requests per minute, reset per server-side window.
const RATE_LIMIT_PER_MINUTE = 12;
const RATE_WINDOW_MS = 61_000;
const SHARP_FETCH_BUDGET_MS = 150_000;
const SHARP_PAGE_ATTEMPTS = 8;

let rateWindowStart = 0;
let rateWindowUsed = 0;
let rateLimitWaits = 0;

function sharpRetryWaitMs(payload: AnyObject | null) {
  const retrySeconds = Number(payload?.retryAfter ?? payload?.retry_after_seconds);
  if (Number.isFinite(retrySeconds) && retrySeconds >= 0) return retrySeconds * 1000;
  const retryEpochMs = Number(payload?.retry_after);
  if (Number.isFinite(retryEpochMs) && retryEpochMs > 1e12) return Math.max(0, retryEpochMs - Date.now());
  const resetIso = payload?.reset_at || payload?.resetAt;
  if (resetIso) {
    const resetMs = new Date(resetIso).getTime();
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - Date.now());
  }
  return null;
}

async function sharpRateGate() {
  const now = Date.now();
  if (!rateWindowStart || now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowUsed = 0;
  }
  if (rateWindowUsed >= RATE_LIMIT_PER_MINUTE) {
    await sleep(Math.max(0, rateWindowStart + RATE_WINDOW_MS - Date.now()) + 500);
    rateWindowStart = Date.now();
    rateWindowUsed = 0;
  }
  rateWindowUsed += 1;
}

async function fetchSharpPage(url: string, apiKey: string, deadlineMs: number): Promise<AnyObject | null> {
  for (let attempt = 0; attempt < SHARP_PAGE_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadlineMs) throw new Error('SharpAPI fetch budget exceeded while paging the feed (rate limited at 12 requests/minute on the free tier).');
    await sharpRateGate();
    let response = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    }
    const payload = await safeJson(response);
    if (response.ok) return payload;
    const isRateLimit = response.status === 429
      || payload?.code === 'rate_limited'
      || /rate limit/i.test(String(payload?.message || ''));
    if (!isRateLimit) {
      throw new Error(payload?.message || (payload?.error != null ? JSON.stringify(payload.error).slice(0, 300) : `SharpAPI HTTP ${response.status}`));
    }
    // Server-side quota (shared across invocations) is exhausted: wait for the
    // advertised reset window and try again instead of failing the connector.
    const waitMs = sharpRetryWaitMs(payload) ?? Math.min(5000 * (attempt + 1), 30_000);
    await sleep(Math.min(waitMs + 250, 70_000));
    rateLimitWaits += 1;
    rateWindowStart = Date.now();
    rateWindowUsed = 0;
  }
  throw new Error('SharpAPI rate limit: retries exhausted while paging the feed.');
}

export async function fetchSharpOdds(cfg: any, apiKey: string, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  if (!apiKey) return { games: [], debug: { ok: false, configured: false, error: 'Missing SHARP_API_KEY secret.' } };

  const deadlineMs = Date.now() + SHARP_FETCH_BUDGET_MS;
  const allRows: AnyObject[] = [];
  let cursor = '';
  let pages = 0;
  let lastStatus = 0;
  let reportedTotal: number | null = null;

  // Request the documented max page size and follow every cursor. If the feed
  // ever exceeds the defensive ceiling, fail the connector rather than silently
  // write a partial snapshot.
  const maxPages = 1000;
  let paginationComplete = false;
  let paginationRestarts = 0;
  for (let page = 0; page < maxPages; page += 1) {
    // Free tier = DraftKings/FanDuel only at 12 requests/minute, and the live
    // feed's pagination store rotates every ~15s, so any scan that pauses for a
    // rate window loses its cursor. Full-game main markets (moneyline, spread,
    // total) fit every league in a single rate window (measured: NFL 8 pages,
    // NCAAF 5, MLB 6, WNBA 1), so the connector pulls market=main only.
    const params = new URLSearchParams({
      league: cfg.sharpLeague,
      market: 'main',
      limit: '200',
    });
    if (!includeLive) params.set('is_live', 'false');
    if (cursor) params.set('cursor', cursor);
    const url = `${SHARP_BASE_URL}?${params.toString()}`;

    let payload: AnyObject;
    try {
      payload = await fetchSharpPage(url, apiKey, deadlineMs);
    } catch (error) {
      // SharpAPI rotates its pagination store generation between rate-limit
      // windows; cursors from an older generation come back as cursor_expired
      // with restart:true. Drop the cursor and page again from the first page.
      const message = String(error?.message || '');
      if (/cursor_expired|restart pagination/i.test(message) && paginationRestarts < 3) {
        paginationRestarts += 1;
        cursor = '';
        allRows.length = 0;
        pages = 0;
        page = -1;
        continue;
      }
      throw error;
    }
    lastStatus = 200;

    const pageRows = flattenSharpRows(payload);
    allRows.push(...pageRows);
    pages += 1;
    const pagination = payload?.pagination || payload?.meta?.pagination || {};
    console.info(`sharp page ${pages} rows=${pageRows.length} totalRows=${allRows.length} reportedTotal=${pagination?.total ?? 'na'} hasMore=${pagination?.has_more ?? pagination?.hasMore ?? 'na'}`);
    const total = Number(pagination?.total ?? payload?.total);
    if (Number.isFinite(total)) reportedTotal = total;
    const next = String(pagination?.next_cursor ?? pagination?.nextCursor ?? payload?.next_cursor ?? '').trim();
    const hasMore = pagination?.has_more === true || pagination?.hasMore === true || Boolean(next);
    if (!hasMore) { paginationComplete = true; break; }
    if (!next) throw new Error('SharpAPI reported more pages but returned no next cursor. Refusing to store a partial snapshot.');
    if (next === cursor) throw new Error('SharpAPI pagination cursor repeated before the feed completed. Refusing to store a partial snapshot.');
    cursor = next;
  }
  if (!paginationComplete) throw new Error(`SharpAPI exceeded ${maxPages} pages. Refusing to store a partial snapshot.`);
  if (reportedTotal != null && allRows.length < reportedTotal) {
    throw new Error(`SharpAPI pagination incomplete: received ${allRows.length} of ${reportedTotal} reported rows.`);
  }

  const rows = allRows.filter((row) => {
    const bookKey = normalizeBookKey(row?.sportsbook || row?.book || row?.bookmaker);
    return Boolean(bookKey) && !SHARP_EXCLUDED_BOOKS.has(bookKey);
  });
  const grouped = new Map<string, SourceGame>();
  const bookRowCounts: AnyObject = {};
  let liveRowsSkipped = 0;
  let unmatchedTeamRows = 0;
  let outOfWindowRows = 0;
  let unpricedRows = 0;
  let retainedObservations = 0;

  for (const row of rows) {
    const bookKey = normalizeBookKey(row?.sportsbook || row?.book || row?.bookmaker);
    if (!bookKey || SHARP_EXCLUDED_BOOKS.has(bookKey)) continue;
    bookRowCounts[bookKey] = Number(bookRowCounts[bookKey] || 0) + 1;
    if (!includeLive && row?.is_live === true) { liveRowsSkipped += 1; continue; }

    const eventName = String(row?.event || row?.event_name || row?.eventName || row?.market_event_name || '').trim();
    const matchupFromEvent = parseMatchupTitle(eventName);
    const home = String(row?.home_team || row?.homeTeam || matchupFromEvent?.home || '').trim();
    const away = String(row?.away_team || row?.awayTeam || matchupFromEvent?.away || '').trim();
    const canonicalHome = cfg.canonical(home);
    const canonicalAway = cfg.canonical(away);

    const startTime = isoOrNull(row?.event_start_time || row?.start_time || row?.eventStartTime || row?.startTime || row?.close_time || row?.closeTime);
    const isCanonicalMatchup = Boolean(canonicalHome && canonicalAway && canonicalHome.abbr !== canonicalAway.abbr);
    // The lookahead window limits ordinary game snapshots. Non-matchup league
    // markets (futures/awards/outrights) are retained regardless of settle date
    // so the raw store does not silently lose them.
    if (isCanonicalMatchup && !startIsInWindow(startTime, gameDate, lookaheadDays)) { outOfWindowRows += 1; continue; }

    const rawEventId = row?.event_uuid || row?.event_id || row?.external_event_id || row?.eventId || row?.market_event_id || row?.marketEventId;
    const sourceEventId = String(rawEventId || `${eventName || away || 'event'}:${home || 'na'}:${startTime || gameDate}`);
    const key = `${bookKey}:${sourceEventId}`;
    let game = grouped.get(key);
    if (!game) {
      game = makeSourceGame('sharp', sourceEventId, away, home, startTime, bookKey, row?.timestamp || row?.updated_at || row?.updatedAt || null, row?.is_live === true);
      game.eventName = eventName || firstNonEmpty([row?.market_name, row?.marketName, row?.description, sourceEventId]);
      game.eventType = firstNonEmpty([row?.event_type, row?.eventType, row?.market_scope, row?.marketScope]);
      game.rawEvent = !isCanonicalMatchup;
      if (game.rawEvent) unmatchedTeamRows += 1;
      grouped.set(key, game);
    }

    const rawMarketType = row?.market_type || row?.market || row?.marketType || row?.market_name || row?.marketName || 'other';
    const marketType = normalizeMarketType(rawMarketType);
    const normalizedMarketType = marketType || normalizeRawMarketType(rawMarketType);
    const selection = String(row?.selection || row?.outcome || row?.name || '').trim();
    const selectionType = normalizeText(row?.selection_type || row?.selectionType || row?.side);
    const sharpProbability = probabilityOrNull(row?.odds_probability ?? row?.probability ?? row?.implied_probability);
    const odds = parseAmericanOdds(row?.odds_american ?? row?.american_odds ?? row?.oddsAmerican ?? row?.odds)
      ?? (sharpProbability == null ? null : probabilityToAmerican(sharpProbability));
    if (odds == null && sharpProbability == null) unpricedRows += 1;
    const line = finiteOrNull(row?.line ?? parseLineFromSelection(selection));
    const sourceUpdatedAt = isoOrNull(row?.timestamp || row?.updated_at || row?.updatedAt);
    if (sourceUpdatedAt) game.book.source_updated_at = maxIso(game.book.source_updated_at, sourceUpdatedAt);

    const periodDescriptor = firstNonEmpty([
      row?.market_segment, row?.marketSegment, row?.period_name, row?.periodName, row?.period, row?.segment_name, row?.segmentName, row?.segment,
      row?.market_name, row?.marketName, row?.description,
    ]);
    const period = isSharpFullGameRow(row) ? 'full_game' : normalizeMarketPeriod(periodDescriptor);
    let side: string | null = null;
    const documentedTeamSide = normalizeText(row?.team_side || row?.teamSide);
    if (marketType === 'moneyline' || marketType === 'spread') {
      side = ['away', 'home', 'draw'].includes(documentedTeamSide)
        ? documentedTeamSide
        : inferTeamSideForSport(cfg, selectionType, selection, away, home);
    } else if (marketType === 'total' || selectionType.includes('over') || selectionType.includes('under')) {
      side = selectionType.includes('over') || /^o(?:ver)?\b/i.test(selection) ? 'over'
        : selectionType.includes('under') || /^u(?:nder)?\b/i.test(selection) ? 'under' : null;
    }
    if (!side) side = String(row?.selection_type || row?.selectionType || row?.side || selection || '').trim() || null;

    const price = priceObject(odds, marketType === 'moneyline' ? null : line, row);
    addBookObservation(game.book, {
      ...price,
      odds,
      market_type: normalizedMarketType,
      market_key: firstNonEmpty([row?.prop, row?.prop_key, row?.market_key, row?.marketKey, rawMarketType]),
      market_name: firstNonEmpty([row?.market_name, row?.marketName, row?.description, rawMarketType]),
      period,
      side,
      selection,
      participant: firstNonEmpty([row?.player_name, row?.playerName, row?.player, row?.participant_name, row?.participant]),
      participant_id: firstNonEmpty([row?.player_id, row?.playerId, row?.participant_id, row?.participantId]),
      prop_key: firstNonEmpty([row?.stat_category, row?.statCategory, row?.prop, row?.prop_key, row?.stat, row?.stat_type]),
      line: marketType === 'moneyline' ? null : line,
      is_main_line: row?.is_main_line,
      is_alternate_line: row?.is_alternate_line,
      raw_market_type: String(rawMarketType || ''),
      raw_market_name: firstNonEmpty([row?.market_name, row?.marketName, row?.description]),
      raw_selection_type: firstNonEmpty([row?.selection_type, row?.selectionType, row?.side]),
      source_outcome_id: firstNonEmpty([row?.selection_id, row?.selectionId]),
      available: row?.is_active !== false,
      raw_probability: sharpProbability,
      raw: {
        event_uuid: row?.event_uuid ?? null,
        external_event_id: row?.external_event_id ?? null,
        deep_link: row?.deep_link ?? null,
        stat_category: row?.stat_category ?? null,
        public_bet_pct: row?.public_bet_pct ?? null,
        max_bet: row?.max_bet ?? null,
        is_live: row?.is_live ?? null,
        is_player_prop: row?.is_player_prop ?? null,
        stale_pregame: row?.stale_pregame ?? null,
      },
    });
    retainedObservations += 1;

    // Maintain the old full-game main-line maps for backward compatibility.
    // They are no longer the storage source of truth.
    const isMain = row?.is_alternate_line !== true && row?.is_main_line !== false;
    if (period === 'full_game' && isMain && marketType === 'moneyline' && (side === 'away' || side === 'home')) {
      game.book.moneyline[side] = price;
    } else if (period === 'full_game' && isMain && marketType === 'spread' && (side === 'away' || side === 'home') && line != null) {
      game.book.spread[side] = price;
    } else if (period === 'full_game' && isMain && marketType === 'total' && (side === 'over' || side === 'under') && line != null) {
      game.book._sharp_total_candidates = game.book._sharp_total_candidates || {};
      const totalKey = String(line);
      game.book._sharp_total_candidates[totalKey] = game.book._sharp_total_candidates[totalKey] || {};
      game.book._sharp_total_candidates[totalKey][side] = price;
    }
  }

  for (const game of grouped.values()) finalizeSharpPrimaryTotal(game.book);
  const games = [...grouped.values()].filter(hasSourceGamePrice);
  const booksFound = [...new Set(games.map((g) => g.book.bookmaker_id))].sort();
  return {
    games,
    debug: {
      url: SHARP_BASE_URL,
      status: lastStatus,
      pages,
      pagination_restarts: paginationRestarts,
      rate_limit_waits: rateLimitWaits,
      market_filter: 'main',
      raw_rows: allRows.length,
      filtered_rows: rows.length,
      reported_total: reportedTotal,
      kalshi_rows_excluded: allRows.length - rows.length,
      live_rows_skipped: liveRowsSkipped,
      non_matchup_source_events_retained: unmatchedTeamRows,
      unmatched_team_rows: 0,
      out_of_window_rows: outOfWindowRows,
      unpriced_rows: unpricedRows,
      retained_observations: retainedObservations,
      book_rows: bookRowCounts,
      source_games: games.length,
      unique_matchups: new Set(games.map((g) => `${cfg.canonical(g.awayTeam)?.abbr}:${cfg.canonical(g.homeTeam)?.abbr}`)).size,
      books_found: booksFound,
    },
  };
}

export async function fetchSharpPlayerPropRows(cfg: any, apiKey: string, gameDate: string, includeLive = false, lookaheadDays = 0) {
  if (!apiKey) {
    return { rows: [], debug: { ok: false, configured: false, error: 'Missing SHARP_API_KEY secret.' } };
  }

  const deadlineMs = Date.now() + SHARP_FETCH_BUDGET_MS;
  const allRows: AnyObject[] = [];
  let cursor = '';
  let pages = 0;
  let reportedTotal: number | null = null;
  let paginationRestarts = 0;
  let paginationComplete = false;

  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({
      league: cfg.sharpLeague,
      market: 'player_prop',
      limit: '200',
    });
    if (!includeLive) params.set('is_live', 'false');
    if (cursor) params.set('cursor', cursor);

    let payload: AnyObject;
    try {
      payload = await fetchSharpPage(`${SHARP_BASE_URL}?${params.toString()}`, apiKey, deadlineMs) || {};
    } catch (error) {
      const message = String(error?.message || '');
      if (/cursor_expired|restart pagination/i.test(message) && paginationRestarts < 3) {
        paginationRestarts += 1;
        cursor = '';
        allRows.length = 0;
        pages = 0;
        page = -1;
        continue;
      }
      throw error;
    }

    const pageRows = flattenSharpRows(payload);
    allRows.push(...pageRows);
    pages += 1;
    const pagination = payload?.pagination || payload?.meta?.pagination || {};
    const total = Number(pagination?.total ?? payload?.total);
    if (Number.isFinite(total)) reportedTotal = total;
    const next = String(pagination?.next_cursor ?? pagination?.nextCursor ?? payload?.next_cursor ?? '').trim();
    const hasMore = pagination?.has_more === true || pagination?.hasMore === true || Boolean(next);
    if (!hasMore) {
      paginationComplete = true;
      break;
    }
    if (!next || next === cursor) throw new Error('SharpAPI player prop pagination returned an invalid cursor.');
    cursor = next;
  }

  if (!paginationComplete) throw new Error('SharpAPI player prop pagination exceeded 1000 pages.');
  if (reportedTotal != null && allRows.length < reportedTotal) {
    throw new Error(`SharpAPI player prop pagination incomplete: received ${allRows.length} of ${reportedTotal} rows.`);
  }

  const rows = allRows.filter((row) => {
    const market = normalizeText(row?.market || row?.market_type || row?.marketType || row?.market_name || row?.marketName);
    const participant = firstNonEmpty([
      row?.player_name, row?.playerName, row?.player,
      row?.participant_name, row?.participant,
    ]);
    if (!participant) return false;
    if (row?.is_player_prop === false) return false;
    const startTime = isoOrNull(row?.event_start_time || row?.start_time || row?.eventStartTime || row?.startTime);
    if (startTime && !startIsInWindow(startTime, gameDate, lookaheadDays)) return false;
    return market.includes('player') || market.includes('prop') || Boolean(row?.stat_category || row?.statCategory || row?.prop || row?.prop_key);
  });

  return {
    rows,
    debug: {
      url: SHARP_BASE_URL,
      market_filter: 'player_prop',
      pages,
      raw_rows: allRows.length,
      filtered_rows: rows.length,
      reported_total: reportedTotal,
      pagination_restarts: paginationRestarts,
      rate_limit_waits: rateLimitWaits,
    },
  };
}

function flattenSharpRows(payload: any) {
  const root = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const rows: AnyObject[] = [];
  for (const item of root) {
    const inherited = { ...item };
    if (Array.isArray(item?.outcomes)) {
      for (const outcome of item.outcomes) rows.push({ ...inherited, ...outcome, market: item?.market || item?.market_type });
    } else if (Array.isArray(item?.odds)) {
      for (const odd of item.odds) rows.push({ ...inherited, ...odd, market: item?.market || item?.market_type });
    } else {
      rows.push(item);
    }
  }
  return rows;
}

function isSharpFullGameRow(row: AnyObject) {
  const descriptor = normalizeText([
    row?.period, row?.period_name, row?.periodName, row?.segment, row?.segment_name,
    row?.market_segment, row?.marketSegment,
    row?.market_name, row?.marketName, row?.description,
  ].filter(Boolean).join(' '));
  if (!descriptor) return true;
  return !/(first 5|1st 5|first five|1st five|innings? 1 5|\bf5\b|\b(?:first|second|1st|2nd) half\b|\b[12]h\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th) quarter\b|\bq[1-4]\b|\b(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth) inning\b|\bperiod\b)/.test(descriptor);
}

function finalizeSharpPrimaryTotal(book: AnyObject) {
  const candidates = book?._sharp_total_candidates || {};
  const ranked = Object.entries(candidates).map(([line, sidesRaw]) => {
    const sides: AnyObject = sidesRaw as AnyObject;
    const overP = americanToProbability(sides?.over?.odds);
    const underP = americanToProbability(sides?.under?.odds);
    const completePenalty = overP == null || underP == null ? 10 : 0;
    const balance = (overP == null ? 1 : Math.abs(overP - 0.5)) + (underP == null ? 1 : Math.abs(underP - 0.5));
    return { line: Number(line), sides, score: completePenalty + balance };
  }).filter((x) => Number.isFinite(x.line)).sort((a, b) => a.score - b.score);
  const selected = ranked[0];
  if (selected?.sides?.over) book.total.over = selected.sides.over;
  if (selected?.sides?.under) book.total.under = selected.sides.under;
  delete book._sharp_total_candidates;
}
