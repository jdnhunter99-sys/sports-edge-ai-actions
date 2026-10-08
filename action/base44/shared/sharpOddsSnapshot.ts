// SharpOddsDatabase snapshot record construction + lossless chunking.
//
// Extracted from base44/functions/refreshSharpOddsDatabase/entry.ts so the
// entry file stays within the platform size limit and so the refresh can
// stream one game's records at a time instead of materializing the whole
// slate in memory (which exhausts worker memory on large NCAAF slates).

import {
  AnyObject, DEFAULT_TIMEZONE,
  normalizeBookKey, normalizeRawMarketType, normalizeMarketPeriod, isMainGameLineObservation,
  parseAmericanOdds, probabilityOrNull, finiteOrNull, isoOrNull, formatAmerican,
  stringOrNull, localDateForIso,
} from './sharpOddsCommon.ts';

const SOURCE = 'sharp_odds_database';
const SNAPSHOT_MAX_JSON_BYTES = 8 * 1024 * 1024;

export function observationIdentity(obs: AnyObject) {
  return [
    stringOrNull(obs?.source) || '',
    stringOrNull(obs?.source_event_id) || '',
    normalizeBookKey(obs?.bookmaker_id) || '',
    normalizeRawMarketType(obs?.market_type),
    stringOrNull(obs?.quote_type) || 'current',
    normalizeMarketPeriod(obs?.period),
    stringOrNull(obs?.market_key) || '',
    stringOrNull(obs?.source_market_id) || '',
    stringOrNull(obs?.source_outcome_id) || '',
    stringOrNull(obs?.side) || '',
    stringOrNull(obs?.selection) || '',
    stringOrNull(obs?.participant_id) || stringOrNull(obs?.participant) || '',
    finiteOrNull(obs?.line) ?? '',
    parseAmericanOdds(obs?.odds) ?? '',
  ].join('|');
}

function legacyObservationsForBook(book: AnyObject) {
  const observations: AnyObject[] = [];
  for (const marketType of ['moneyline', 'spread', 'total']) {
    for (const [side, price] of Object.entries(book?.[marketType] || {})) {
      if (!price) continue;
      const p: AnyObject = price as AnyObject;
      observations.push({
        source: stringOrNull(book?.source),
        source_event_id: stringOrNull(book?.source_event_id),
        bookmaker_id: normalizeBookKey(book?.bookmaker_id),
        market_type: marketType,
        market_key: marketType,
        market_name: marketType,
        period: 'full_game',
        side,
        selection: side,
        participant: null,
        participant_id: null,
        prop_key: null,
        line: marketType === 'moneyline' ? null : finiteOrNull(p?.line),
        odds: parseAmericanOdds(p?.odds),
        available: p?.odds != null || p?.raw_probability != null,
        is_main_line: true,
        is_alternate_line: false,
        source_market_id: stringOrNull(p?.source_market_id),
        source_outcome_id: stringOrNull(p?.source_outcome_id),
        source_updated_at: isoOrNull(p?.source_updated_at),
        raw_probability: probabilityOrNull(p?.raw_probability),
        bid_probability: probabilityOrNull(p?.bid_probability),
        ask_probability: probabilityOrNull(p?.ask_probability),
        last_probability: probabilityOrNull(p?.last_probability),
        source_version: finiteOrNull(p?.source_version),
        max_risk_stake: finiteOrNull(p?.max_risk_stake),
        cutoff_at: isoOrNull(p?.cutoff_at),
      });
    }
  }
  return observations;
}

function legacyObservationEquivalent(a: AnyObject, b: AnyObject) {
  if (normalizeBookKey(a?.bookmaker_id) !== normalizeBookKey(b?.bookmaker_id)) return false;
  if (normalizeRawMarketType(a?.market_type) !== normalizeRawMarketType(b?.market_type)) return false;
  if ((stringOrNull(a?.quote_type) || 'current') !== (stringOrNull(b?.quote_type) || 'current')) return false;
  if (normalizeMarketPeriod(a?.period) !== normalizeMarketPeriod(b?.period)) return false;
  if (String(a?.side || '') !== String(b?.side || '')) return false;
  const lineA = finiteOrNull(a?.line);
  const lineB = finiteOrNull(b?.line);
  if (lineA == null ? lineB != null : (lineB == null || Math.abs(lineA - lineB) > 0.0001)) return false;
  if (parseAmericanOdds(a?.odds) !== parseAmericanOdds(b?.odds)) return false;
  const marketA = stringOrNull(a?.source_market_id);
  const marketB = stringOrNull(b?.source_market_id);
  if (marketA && marketB && marketA !== marketB) return false;
  const outcomeA = stringOrNull(a?.source_outcome_id);
  const outcomeB = stringOrNull(b?.source_outcome_id);
  if (outcomeA && outcomeB && outcomeA !== outcomeB) return false;
  return true;
}

function allBookObservations(book: AnyObject) {
  const explicit = Array.isArray(book?.observations) ? book.observations.filter(Boolean) : [];
  const combined = [...explicit];
  // Older/fallback connector paths may still only populate the compatibility
  // maps. Synthesize a legacy observation only when no explicit raw observation
  // already represents the same book/market/side/line/price. Selection display
  // text is deliberately ignored here because legacy rows use "home"/"away"
  // while raw rows often use the actual team name.
  for (const legacy of legacyObservationsForBook(book)) {
    if (!explicit.some((obs) => legacyObservationEquivalent(obs, legacy))) combined.push(legacy);
  }
  return combined;
}

export function buildSnapshotRecord(game: AnyObject, context: AnyObject): AnyObject {
  const books = [...game.books.values()];
  const markets: AnyObject[] = [];

  // Store one source outcome per market row. This intentionally avoids any
  // grouping/collapse that could overwrite alternate lines, player props,
  // period markets, or two selections that happen to share a display name.
  for (const book of books) {
    for (const obs of allBookObservations(book)) {
      if (!isMainGameLineObservation(obs)) continue;
      const odds = parseAmericanOdds(obs?.odds);
      const rawProbability = probabilityOrNull(obs?.raw_probability);
      const line = finiteOrNull(obs?.line);
      const bookmaker = {
        bookmaker_id: normalizeBookKey(obs?.bookmaker_id || book.bookmaker_id),
        source: stringOrNull(obs?.source) || book.source,
        source_event_id: stringOrNull(obs?.source_event_id) || book.source_event_id || null,
        source_market_id: stringOrNull(obs?.source_market_id),
        source_outcome_id: stringOrNull(obs?.source_outcome_id),
        source_updated_at: isoOrNull(obs?.source_updated_at) || book.source_updated_at || null,
        odds: formatAmerican(odds),
        line: line == null ? null : String(line),
        has_price: odds != null || rawProbability != null,
        available: obs?.available !== false,
        raw_probability: rawProbability,
        bid_probability: probabilityOrNull(obs?.bid_probability),
        ask_probability: probabilityOrNull(obs?.ask_probability),
        last_probability: probabilityOrNull(obs?.last_probability),
        source_version: finiteOrNull(obs?.source_version),
        max_risk_stake: finiteOrNull(obs?.max_risk_stake),
        cutoff_at: isoOrNull(obs?.cutoff_at),
        source_metadata: obs?.raw && typeof obs.raw === 'object' ? obs.raw : null,
      };
      markets.push({
        market_type: normalizeRawMarketType(obs?.market_type),
        quote_type: stringOrNull(obs?.quote_type) || 'current',
        market_key: stringOrNull(obs?.market_key),
        market_name: stringOrNull(obs?.market_name),
        period: normalizeMarketPeriod(obs?.period),
        side: stringOrNull(obs?.side),
        selection: stringOrNull(obs?.selection),
        participant: stringOrNull(obs?.participant),
        participant_id: stringOrNull(obs?.participant_id),
        prop_key: stringOrNull(obs?.prop_key),
        line: line == null ? null : String(line),
        is_main_line: obs?.is_main_line == null ? null : obs.is_main_line === true,
        is_alternate_line: obs?.is_alternate_line == null ? null : obs.is_alternate_line === true,
        raw_market_type: stringOrNull(obs?.raw_market_type),
        raw_market_name: stringOrNull(obs?.raw_market_name),
        raw_selection_type: stringOrNull(obs?.raw_selection_type),
        bookmakers: [bookmaker],
      });
    }
  }

  const bookmakerIDs = [...new Set(markets.flatMap((m) => m.bookmakers.map((b: AnyObject) => b.bookmaker_id)))];
  const eventGameDate = game.start_time
    ? localDateForIso(game.start_time, DEFAULT_TIMEZONE)
    : context.gameDate;
  return {
    snapshot_key: `${context.league}:${game.canonical_event_key}:${context.capturedAt}`,
    source: SOURCE,
    sport: context.sport,
    league: context.league,
    canonical_event_key: game.canonical_event_key,
    source_event_ids: game.source_event_ids,
    event_name: game.event_name || null,
    event_type: game.event_type || (game.raw_event ? 'raw_event' : 'game'),
    raw_event: game.raw_event === true,
    game_date: eventGameDate,
    start_time: game.start_time || '',
    captured_at: context.capturedAt,
    home_team_id: game.home_team_id,
    home_team_name: game.home_team_name,
    home_team_abbr: game.home_team_abbr,
    away_team_id: game.away_team_id,
    away_team_name: game.away_team_name,
    away_team_abbr: game.away_team_abbr,
    event_status: { started: game.is_live === true, live: game.is_live === true },
    markets,
    market_count: markets.length,
    bookmaker_count: bookmakerIDs.length,
    observation_count: markets.length,
    source_status: context.sourceStatus,
    request_meta: context.requestMeta,
  };
}

function jsonByteLength(value: any) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch (_error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function chunkSnapshotRecord(record: AnyObject, maxBytes = SNAPSHOT_MAX_JSON_BYTES): AnyObject[] {
  const markets = Array.isArray(record?.markets) ? record.markets : [];
  const base = {
    ...record,
    markets: [],
    market_count: 0,
    observation_count: 0,
    bookmaker_count: 0,
    snapshot_chunk_index: 1,
    snapshot_chunk_count: 1,
    snapshot_payload_bytes_estimate: 0,
  };
  const baseBytes = jsonByteLength(base);
  const marketBytes = markets.map((market: AnyObject) => jsonByteLength(market) + 2);
  const totalEstimate = baseBytes + marketBytes.reduce((sum: number, n: number) => sum + n, 0);

  if (totalEstimate <= maxBytes) {
    const single = {
      ...record,
      snapshot_chunk_index: 1,
      snapshot_chunk_count: 1,
      snapshot_payload_bytes_estimate: totalEstimate,
    };
    return [single];
  }

  // Each stored market row currently contains one bookmaker observation. If a
  // single observation ever grows past the safe document threshold because a
  // provider added unusually large metadata, drop only that optional diagnostic
  // metadata and keep the market/selection/line/odds themselves intact.
  if (markets.length === 1) {
    const compactMarket = {
      ...markets[0],
      bookmakers: (markets[0]?.bookmakers || []).map((book: AnyObject) => ({ ...book, source_metadata: null })),
    };
    const compactRecord = {
      ...record,
      markets: [compactMarket],
      snapshot_chunk_index: 1,
      snapshot_chunk_count: 1,
    };
    const compactBytes = jsonByteLength(compactRecord);
    if (compactBytes > maxBytes) {
      throw new Error(`A single SharpOddsDatabase observation is ${compactBytes} bytes and cannot be stored safely without losing odds data.`);
    }
    return [{ ...compactRecord, snapshot_payload_bytes_estimate: compactBytes }];
  }

  const chunks: AnyObject[][] = [];
  let current: AnyObject[] = [];
  let currentBytes = baseBytes;
  for (let i = 0; i < markets.length; i += 1) {
    const market = markets[i];
    const bytes = marketBytes[i];
    if (current.length && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = baseBytes;
    }
    current.push(market);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);

  const count = chunks.length;
  return chunks.map((chunkMarkets, index) => {
    const bookmakerIDs = [...new Set(chunkMarkets.flatMap((market: AnyObject) =>
      (market?.bookmakers || []).map((book: AnyObject) => book?.bookmaker_id).filter(Boolean)
    ))];
    const chunkRecord = {
      ...record,
      snapshot_key: `${record.snapshot_key}:chunk:${index + 1}-of-${count}`,
      markets: chunkMarkets,
      market_count: chunkMarkets.length,
      observation_count: chunkMarkets.reduce((sum: number, market: AnyObject) =>
        sum + (Array.isArray(market?.bookmakers) ? market.bookmakers.length : 0), 0),
      bookmaker_count: bookmakerIDs.length,
      snapshot_chunk_index: index + 1,
      snapshot_chunk_count: count,
    };
    return { ...chunkRecord, snapshot_payload_bytes_estimate: jsonByteLength(chunkRecord) };
  });
}