// Rebet sportsbook odds integration for the SharpOddsDatabase collector.
//
// Rebet serves structured Sportradar/Betradar-style sportsbook JSON from its
// CloudFront API. Requests are made with Accept: application/json only — no
// browser user-agent or browser-only headers. The optional REBET_API_KEY app
// secret is attached as x-api-key ONLY when it is configured, for the case
// where Rebet later requires it.
//
// Verified request configuration (tab=MKT&item_id=GAMES plus sport/league ids):
//   MLB:  sr:sport:3  / sr:tournament:109  (main markets 251 / 256 / 258)
//   NFL:  sr:sport:16 / sr:tournament:31   (main markets 219 / 223 / 225)
//   WNBA: sr:sport:2  / sr:tournament:486
//
// Every active market/outcome with a usable price is normalized into the raw
// observation stream. Verified main full-game markets are also mirrored into
// the legacy moneyline/spread/total fields for backward compatibility.

import {
  AnyObject, SourceGame,
  canonicalMlbTeam, makeSourceGame, hasSourceGamePrice, addBookObservation,
  parseAmericanOdds, finiteOrNull, stringOrNull, isoOrNull, probabilityOrNull, normalizeText, normalizeRawMarketType,
  DEFAULT_TIMEZONE, localDateForIso, addDaysDate,
} from './sharpOddsCommon.ts';

export const REBET_BOOK_KEY = 'rebet';
const REBET_BASE_URL = 'https://d18egz9kdmewpc.cloudfront.net/sportsbook/v3/events';

// Sportradar sport IDs used by Rebet. A sport ID never identifies a league:
// NBA/WNBA/NCAAB share sr:sport:2 and NFL/NCAAF share sr:sport:16, so a league
// is only activated together with its verified tournament ID below.
export const REBET_SPORT_IDS: Record<string, string> = {
  mlb: 'sr:sport:3',
  wnba: 'sr:sport:2',
  nba: 'sr:sport:2',
  ncaab: 'sr:sport:2',
  nfl: 'sr:sport:16',
  ncaaf: 'sr:sport:16',
  nhl: 'sr:sport:4',
};

// Verified Rebet league/tournament IDs. Never invent tournament IDs — a league
// is added here only after its ID is confirmed against the live Rebet feed.
export const REBET_LEAGUE_IDS: Record<string, string> = {
  mlb: 'sr:tournament:109',
  nfl: 'sr:tournament:31',
  wnba: 'sr:tournament:486',
};

// Verified Rebet main full-game market IDs (Betradar). Classification also
// falls back to market names so the parser never depends on IDs alone.
export const REBET_MAIN_MARKET_IDS: Record<string, Record<string, 'moneyline' | 'spread' | 'total'>> = {
  mlb: { '251': 'moneyline', '256': 'spread', '258': 'total' },
  // Verified live: NFL feeds use overtime-inclusive market IDs.
  nfl: { '219': 'moneyline', '223': 'spread', '225': 'total' },
};


// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchRebetEvents({
  sportId, leagueId, tab = 'MKT', itemId = 'GAMES', eventId = null,
}: { sportId: string; leagueId?: string | null; tab?: string; itemId?: string; eventId?: string | null }) {
  const url = new URL(REBET_BASE_URL);
  url.searchParams.set('tab', tab);
  url.searchParams.set('sport_id', sportId);
  url.searchParams.set('item_id', itemId);
  if (leagueId) url.searchParams.set('league_id', leagueId);
  if (eventId) url.searchParams.set('event_id', eventId);

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = getRebetApiKey();
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(url.toString(), { method: 'GET', headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Rebet HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload: AnyObject | null = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (payload == null) {
    throw new Error(`Rebet response was not JSON (length ${text.length}): ${text.slice(0, 200)}`);
  }
  return payload;
}

function getRebetApiKey(): string {
  const deno = (globalThis as any)?.Deno;
  const value = deno?.env?.get?.('REBET_API_KEY');
  return typeof value === 'string' ? value.trim() : '';
}

function extractRebetEvents(payload: any): AnyObject[] {
  if (Array.isArray(payload)) return payload;
  // Verified live shape: { success, message, data: { events: [...] } }
  if (Array.isArray(payload?.data?.events)) return payload.data.events;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

// Verified live shape stores markets under event.odds.market; keep a fallback
// for event.markets in case other Rebet tabs use it.
function rebetEventMarkets(event: any): AnyObject[] {
  if (Array.isArray(event?.markets)) return event.markets;
  if (Array.isArray(event?.odds?.market)) return event.odds.market;
  return [];
}

function rebetOutcomeUsable(outcome: any) {
  return String(outcome?.active ?? '1') !== '0';
}

function rebetMarketOutcomes(market: any): AnyObject[] {
  if (Array.isArray(market?.outcomes)) return market.outcomes;
  if (Array.isArray(market?.outcome)) return market.outcome;
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing / normalization
// ─────────────────────────────────────────────────────────────────────────────
function classifyRebetMainMarket(market: any, sportKey: string): 'moneyline' | 'spread' | 'total' | null {
  const byId = (REBET_MAIN_MARKET_IDS[sportKey] || {})[String(market?.id ?? '')];
  if (byId) return byId;
  const name = normalizeText(market?.name);
  if (!name) return null;
  // Never let a partial-game / derivative / special market masquerade as a
  // full-game main market.
  if (/(first|1st) ?(5|five)|inning|period|quarter|half|team total|both teams|odd even|correct score|draw no bet|double chance|race to|next|special/.test(name)) return null;
  if (/winner|moneyline|money line/.test(name)) return 'moneyline';
  if (/handicap|spread|run ?line/.test(name)) return 'spread';
  if (/\btotal\b|over under/.test(name)) return 'total';
  return null;
}

function rebetEventStartIso(event: any): string | null {
  const raw = event?.scheduled_ts ?? event?.scheduled ?? event?.start_time ?? null;
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()))) {
    // Rebet supplies epoch seconds, e.g. "1788973800.0".
    const seconds = Number(raw);
    const ms = seconds > 1e11 ? seconds : seconds * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return isoOrNull(raw);
}

// Home/away come from the competitor qualifier only. Array order is never
// used to infer home/away.
function rebetHomeAway(event: any) {
  const list = Array.isArray(event?.competitors) ? event.competitors : [];
  const home = list.find((c) => String(c?.qualifier || '').toLowerCase() === 'home') || null;
  const away = list.find((c) => String(c?.qualifier || '').toLowerCase() === 'away') || null;
  if (!home || !away) return null;
  const homeName = String(home?.name || home?.abbreviation || '').trim();
  const awayName = String(away?.name || away?.abbreviation || '').trim();
  if (!homeName || !awayName) return null;
  return {
    homeName, awayName,
    homeId: String(home?.id || ''), awayId: String(away?.id || ''),
  };
}

// Match an outcome to home/away via its qualifier, its team name (through the
// same canonical MLB team normalization used by every other connector), or a
// competitor id reference — never via array position.
function rebetOutcomeTeamSide(outcome: any, teamMeta: any): 'home' | 'away' | null {
  const qualifier = String(outcome?.qualifier || '').toLowerCase();
  if (qualifier === 'home') return 'home';
  if (qualifier === 'away') return 'away';
  const team = teamMeta.canonical(outcome?.name || outcome?.description || '');
  if (team?.abbr) {
    if (teamMeta.home.abbr === team.abbr) return 'home';
    if (teamMeta.away.abbr === team.abbr) return 'away';
  }
  const competitorId = String(outcome?.competitor_id || outcome?.competitorId || '');
  if (competitorId) {
    if (teamMeta.home.id && teamMeta.home.id === competitorId) return 'home';
    if (teamMeta.away.id && teamMeta.away.id === competitorId) return 'away';
  }
  return null;
}

function rebetTotalSide(outcome: any): 'over' | 'under' | null {
  const text = normalizeText(`${outcome?.name || ''} ${outcome?.description || ''}`);
  if (!text) return null;
  if (/\bover\b|\bmore\b/.test(text)) return 'over';
  if (/\bunder\b|\bless\b/.test(text)) return 'under';
  return null;
}

// Rebet already provides American odds — use them directly and only fall back
// to a decimal conversion when the American price is absent.
function rebetOutcomeAmericanOdds(outcome: any) {
  const american = parseAmericanOdds(outcome?.display_odds?.american ?? outcome?.american);
  if (american != null) return american;
  const decimal = Number(outcome?.display_odds?.decimal ?? outcome?.decimal);
  if (Number.isFinite(decimal) && decimal > 1) {
    return Math.round(decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1));
  }
  return null;
}

// Specifiers arrive as "hcp=-1.5", "total=8.5" style strings (or objects).
function rebetSpecifierNumber(specifiers: any, key: string) {
  if (specifiers && typeof specifiers === 'object' && !Array.isArray(specifiers)) {
    return finiteOrNull((specifiers as AnyObject)[key]);
  }
  const match = String(specifiers || '').match(new RegExp(`(?:^|;)${key}=([-+]?[0-9]+(?:\\.[0-9]+)?)`));
  return match ? finiteOrNull(match[1]) : null;
}

// Outcome-level signed handicap line, e.g. "Baltimore Orioles -1.5". Lines are
// small numbers; anything ≥ 100 magnitude is an odds value, not a line.
function rebetOutcomeSignedLine(outcome: any) {
  const text = String(outcome?.name || outcome?.description || '');
  const match = text.match(/([-+]\s*[0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const line = finiteOrNull(match[1].replace(/\s+/g, ''));
  if (line == null || Math.abs(line) >= 100) return null;
  return line;
}

function rebetOutcomeTotalLine(outcome: any) {
  const text = String(outcome?.name || outcome?.description || '');
  const match = text.match(/(?:over|under|more|less)?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const line = finiteOrNull(match[1]);
  if (line == null || line >= 100) return null;
  return line;
}

function rebetPriceObject(odds: number | null, line: any, market: any, outcome: any) {
  return {
    odds,
    line: finiteOrNull(line),
    raw_probability: probabilityOrNull(outcome?.probabilities),
    decimal_odds: finiteOrNull(outcome?.display_odds?.decimal),
    easy_read_line: stringOrNull(outcome?.easy_read_line),
    source_market_id: stringOrNull(market?.id),
    source_outcome_id: stringOrNull(outcome?.id),
    source_updated_at: isoOrNull(market?.updated_at ?? market?.last_change ?? null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic market discovery — every unique market id/name/tab/specifier seen in
// a response is inventoried, and non-main markets are kept as raw Rebet data.
// ─────────────────────────────────────────────────────────────────────────────
function collectRebetMarketInventory(inventory: Record<string, AnyObject>, market: any) {
  const id = String(market?.id ?? 'unknown');
  let entry = inventory[id];
  if (!entry) {
    entry = inventory[id] = { name: String(market?.name ?? ''), tabs: [], specifier_samples: [], market_count: 0 };
  }
  entry.market_count += 1;
  if (!entry.name && market?.name) entry.name = String(market.name);
  const tab = market?.tab_name ?? market?.tab ?? null;
  if (tab != null && !entry.tabs.includes(tab)) entry.tabs.push(tab);
  if (market?.specifiers != null) {
    const sample = String(market.specifiers);
    if (!entry.specifier_samples.includes(sample) && entry.specifier_samples.length < 8) entry.specifier_samples.push(sample);
  }
}

function rebetRawMarketRecord(event: any, market: any, sportId: string, leagueId: string | null): AnyObject {
  const outcomes = rebetMarketOutcomes(market);
  return {
    provider: REBET_BOOK_KEY,
    eventId: stringOrNull(event?.id),
    sportId: stringOrNull(event?.sport_id) || sportId,
    tournamentId: stringOrNull(event?.tournament_id) || leagueId,
    marketId: String(market?.id ?? ''),
    marketName: stringOrNull(market?.name),
    marketStatus: stringOrNull(market?.status),
    specifiers: market?.specifiers ?? null,
    tab: market?.tab_name ?? market?.tab ?? null,
    outcomes: outcomes.map((outcome) => ({
      id: stringOrNull(outcome?.id),
      name: stringOrNull(outcome?.name),
      american: outcome?.display_odds?.american ?? outcome?.american ?? null,
      decimal: outcome?.display_odds?.decimal ?? outcome?.decimal ?? null,
      probability: outcome?.probabilities ?? null,
      easyReadLine: outcome?.easy_read_line ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical raw connector. Every active Rebet market/outcome with a usable
// price is retained in book.observations. The legacy full-game maps are merely
// compatibility mirrors for existing consumers.
// ─────────────────────────────────────────────────────────────────────────────
function rebetDateInWindow(startTime: string | null, gameDate: string, lookaheadDays: number) {
  if (!startTime) return true;
  const d = localDateForIso(startTime, DEFAULT_TIMEZONE);
  return d >= gameDate && d <= addDaysDate(gameDate, lookaheadDays);
}

function rebetMarketPeriod(market: any) {
  const text = normalizeText(`${market?.name || ''} ${market?.description || ''} ${market?.tab_name || market?.tab || ''}`);
  if (/first five|1st five|first 5|1st 5|f5/.test(text)) return 'first_5';
  if (/first half|1st half|1h/.test(text)) return 'first_half';
  if (/second half|2nd half|2h/.test(text)) return 'second_half';
  if (/first quarter|1st quarter|q1/.test(text)) return 'first_quarter';
  if (/second quarter|2nd quarter|q2/.test(text)) return 'second_quarter';
  if (/third quarter|3rd quarter|q3/.test(text)) return 'third_quarter';
  if (/fourth quarter|4th quarter|q4/.test(text)) return 'fourth_quarter';
  if (/first inning|1st inning/.test(text)) return 'first_inning';
  const inning = text.match(/(?:inning|inning\s*#?)\s*(\d+)/);
  if (inning) return `inning_${inning[1]}`;
  return 'full_game';
}

function classifyRebetRawMarket(market: any, sportKey: string) {
  const main = classifyRebetMainMarket(market, sportKey);
  if (main) return main;
  const name = normalizeText(market?.name || market?.description || '');
  // Period game markets are still normalized to the standard type so they can
  // be queried consistently, while team/player totals remain distinct markets.
  if (/team total|player|pitcher|batter|hits|runs batted|strikeout|touchdown|passing|rushing|receiving|points rebounds|assists|rebounds|blocks|steals/.test(name)) {
    return normalizeRawMarketType(market?.name || market?.id || 'other');
  }
  if (/winner|moneyline|money line/.test(name)) return 'moneyline';
  if (/handicap|spread|run ?line/.test(name)) return 'spread';
  if (/\btotal\b|over under/.test(name)) return 'total';
  return normalizeRawMarketType(market?.name || market?.id || 'other');
}

function rebetGenericSpecifierLine(specifiers: any) {
  for (const key of ['hcp', 'total', 'line', 'points', 'strike']) {
    const n = rebetSpecifierNumber(specifiers, key);
    if (n != null) return n;
  }
  if (specifiers && typeof specifiers === 'object' && !Array.isArray(specifiers)) {
    for (const value of Object.values(specifiers)) {
      const n = finiteOrNull(value);
      if (n != null && Math.abs(n) < 1000) return n;
    }
  }
  const m = String(specifiers || '').match(/(?:^|;)[^=]+=([-+]?[0-9]+(?:\.[0-9]+)?)/);
  return m ? finiteOrNull(m[1]) : null;
}

function rebetCanonicalTeam(cfg: any, value: any, strict = false) {
  if (!strict) return cfg.canonical(value);
  const normalized = normalizeText(value);
  if (!normalized) return null;
  for (const team of cfg.teams || []) {
    if (normalizeText(team?.name) === normalized || normalizeText(team?.abbr) === normalized) return team;
    if ((team?.aliases || []).some((alias: string) => normalizeText(alias) === normalized)) return team;
  }
  return null;
}

export async function fetchRebetOdds(cfg: any, gameDate: string, includeLive: boolean, lookaheadDays = 0) {
  const sportId = cfg.rebet.sportId;
  const leagueId = cfg.rebet.leagueId;
  const canonical = cfg.canonical;
  const sportKey = cfg.key;
  const payload = await fetchRebetEvents({ sportId, leagueId });
  const events = extractRebetEvents(payload);

  const games: SourceGame[] = [];
  const inventory: Record<string, AnyObject> = {};
  let marketCount = 0;
  let pricedOutcomeCount = 0;
  let wrongTournament = 0;
  let unassignedCompetitors = 0;
  let unmatchedTeams = 0;
  let dateMismatched = 0;
  let liveSkipped = 0;

  for (const event of events) {
    const tournamentId = String(event?.tournament_id || '');
    if (leagueId && tournamentId && tournamentId !== leagueId) { wrongTournament += 1; continue; }

    const isLive = event?.is_live === true;
    if (!includeLive && isLive) { liveSkipped += 1; continue; }

    const startTime = rebetEventStartIso(event);
    if (!rebetDateInWindow(startTime, gameDate, lookaheadDays)) { dateMismatched += 1; continue; }

    const sides = rebetHomeAway(event);
    if (!sides) { unassignedCompetitors += 1; continue; }
    // NCAAF currently has no hard-coded Rebet tournament id. In that case use
    // exact team aliases only; broad substring matching can turn NFL city names
    // (Houston, Buffalo, Cincinnati, etc.) into college teams.
    const strictLeagueMatch = !leagueId && sportKey === 'ncaaf';
    const away = rebetCanonicalTeam(cfg, sides.awayName, strictLeagueMatch);
    const home = rebetCanonicalTeam(cfg, sides.homeName, strictLeagueMatch);
    if (!away || !home || away.abbr === home.abbr) { unmatchedTeams += 1; continue; }

    const out = makeSourceGame(
      REBET_BOOK_KEY,
      String(event?.id || `${away.abbr}${home.abbr}:${startTime || gameDate}`),
      away.name,
      home.name,
      startTime,
      REBET_BOOK_KEY,
      isoOrNull(event?.updated_at ?? event?.updated ?? null),
      isLive,
    );
    const teamMeta = {
      home: { abbr: home.abbr, id: sides.homeId, name: sides.homeName },
      away: { abbr: away.abbr, id: sides.awayId, name: sides.awayName },
      canonical,
    };

    for (const market of rebetEventMarkets(event)) {
      marketCount += 1;
      collectRebetMarketInventory(inventory, market);
      if (String(market?.status ?? '1') === '0') continue;
      const marketType = classifyRebetRawMarket(market, sportKey);
      const mainKind = classifyRebetMainMarket(market, sportKey);
      const period = rebetMarketPeriod(market);
      const outcomes = rebetMarketOutcomes(market);
      const specifiers = market?.specifiers ?? null;
      if (!outcomes.length) {
        addBookObservation(out.book, {
          odds: null,
          market_type: marketType,
          market_key: String(market?.id ?? market?.name ?? 'other'),
          market_name: stringOrNull(market?.name),
          period,
          side: null,
          selection: null,
          prop_key: firstRebetText(market?.prop_key, market?.stat, market?.name),
          line: rebetGenericSpecifierLine(specifiers),
          is_main_line: mainKind != null && period === 'full_game',
          is_alternate_line: mainKind == null && (marketType === 'spread' || marketType === 'total'),
          source_market_id: stringOrNull(market?.id),
          raw_market_type: String(market?.id ?? ''),
          raw_market_name: stringOrNull(market?.name),
          available: false,
        });
        continue;
      }

      for (const outcome of outcomes) {
        const outcomeAvailable = rebetOutcomeUsable(outcome);
        const odds = rebetOutcomeAmericanOdds(outcome);

        const teamSide = rebetOutcomeTeamSide(outcome, teamMeta);
        const totalSide = rebetTotalSide(outcome);
        let side: string | null = null;
        let line: number | null = null;

        if (marketType === 'moneyline') {
          side = teamSide;
        } else if (marketType === 'spread') {
          side = teamSide;
          const hcp = rebetSpecifierNumber(specifiers, 'hcp');
          line = rebetOutcomeSignedLine(outcome) ?? (hcp != null && side ? (side === 'home' ? hcp : -hcp) : hcp);
        } else if (marketType === 'total') {
          side = totalSide;
          const total = rebetSpecifierNumber(specifiers, 'total');
          line = rebetOutcomeTotalLine(outcome) ?? total;
        } else {
          side = totalSide || teamSide || String(outcome?.qualifier || outcome?.name || outcome?.description || '').trim() || null;
          line = rebetOutcomeSignedLine(outcome) ?? rebetOutcomeTotalLine(outcome) ?? rebetGenericSpecifierLine(specifiers);
        }
        if (!side) side = String(outcome?.name || outcome?.description || outcome?.id || 'selection').trim();

        const price = rebetPriceObject(odds, line, market, outcome);
        addBookObservation(out.book, {
          ...price,
          odds,
          market_type: marketType,
          market_key: String(market?.id ?? market?.name ?? 'other'),
          market_name: stringOrNull(market?.name),
          period,
          side,
          selection: firstRebetText(outcome?.name, outcome?.description, outcome?.qualifier),
          participant: firstRebetText(outcome?.competitor_name, outcome?.participant_name, outcome?.player_name),
          participant_id: firstRebetText(outcome?.competitor_id, outcome?.participant_id, outcome?.player_id),
          prop_key: firstRebetText(market?.prop_key, market?.stat, market?.name),
          line,
          is_main_line: mainKind != null && period === 'full_game',
          is_alternate_line: mainKind == null && (marketType === 'spread' || marketType === 'total'),
          raw_market_type: String(market?.id ?? ''),
          raw_market_name: stringOrNull(market?.name),
          raw_selection_type: stringOrNull(outcome?.qualifier),
          available: outcomeAvailable,
        });
        if (odds != null) pricedOutcomeCount += 1;

        // Legacy mirrors are deliberately restricted to verified full-game
        // main markets. They are not used as the raw database source of truth.
        if (mainKind && period === 'full_game') {
          if (mainKind === 'moneyline' && (side === 'home' || side === 'away')) out.book.moneyline[side] = price;
          else if (mainKind === 'spread' && (side === 'home' || side === 'away') && line != null) out.book.spread[side] = price;
          else if (mainKind === 'total' && (side === 'over' || side === 'under') && line != null) out.book.total[side] = price;
        }
      }
    }

    if (hasSourceGamePrice(out)) games.push(out);
  }

  return {
    games,
    rawEvents: events,
    debug: {
      provider: REBET_BOOK_KEY,
      api: 'rebet_cloudfront_sportsbook_v3',
      sport_id: sportId,
      league_id: leagueId,
      item_id: 'GAMES',
      tab: 'MKT',
      api_key_attached: Boolean(getRebetApiKey()),
      events_seen: events.length,
      games: games.length,
      market_count: marketCount,
      priced_outcomes: pricedOutcomeCount,
      market_retention: 'all_active_markets_all_outcomes_including_temporarily_unpriced',
      markets_seen: Object.entries(inventory).map(([id, entry]) => ({
        id,
        name: entry.name,
        tabs: entry.tabs,
        specifiers: entry.specifier_samples,
        market_count: entry.market_count,
      })),
      skipped: { wrong_tournament: wrongTournament, unassigned_competitors: unassignedCompetitors, unmatched_teams: unmatchedTeams, date_mismatched: dateMismatched, live: liveSkipped },
    },
  };
}

function firstRebetText(...values: any[]) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug / market-discovery probe. Read-only: no entity writes.
// ─────────────────────────────────────────────────────────────────────────────
export async function rebetProbe(options: any = {}) {
  const sport = String(options?.sport || 'mlb').trim().toLowerCase();
  const sportId = String(options?.sport_id || REBET_SPORT_IDS[sport] || (sport.startsWith('sr:') ? sport : '')).trim();
  const leagueId = String(options?.league_id || REBET_LEAGUE_IDS[sport] || '').trim();
  const tab = String(options?.tab || 'MKT');
  const itemId = String(options?.item_id || 'GAMES');
  if (!sportId) {
    return { ok: false, provider: REBET_BOOK_KEY, sport, error: `Unknown Rebet sport "${sport}" and no sport_id supplied.` };
  }

  const payload = await fetchRebetEvents({ sportId, leagueId: leagueId || null, tab, itemId, eventId: options?.event_id || null });
  const events = extractRebetEvents(payload);
  const inventory: Record<string, AnyObject> = {};
  let marketCount = 0;
  let unknownMarketCount = 0;

  for (const event of events) {
    for (const market of rebetEventMarkets(event)) {
      marketCount += 1;
      collectRebetMarketInventory(inventory, market);
      if (!classifyRebetMainMarket(market, sport)) unknownMarketCount += 1;
    }
  }

  const marketsSeen = Object.entries(inventory)
    .map(([id, entry]) => ({ id, name: entry.name, tabs: entry.tabs, specifiers: entry.specifier_samples, market_count: entry.market_count }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const sampleEvents = events.slice(0, 5).map((event) => {
    const sides = rebetHomeAway(event);
    const markets = rebetEventMarkets(event);
    return {
      id: stringOrNull(event?.id),
      sport_id: stringOrNull(event?.sport_id),
      tournament_id: stringOrNull(event?.tournament_id),
      league_name: stringOrNull(event?.league_name),
      scheduled: rebetEventStartIso(event),
      is_live: event?.is_live === true,
      home: sides?.homeName || null,
      away: sides?.awayName || null,
      market_count: markets.length,
      markets: markets.slice(0, 40).map((market: any) => ({ id: String(market?.id ?? ''), name: stringOrNull(market?.name) })),
    };
  });

  return {
    ok: true,
    provider: REBET_BOOK_KEY,
    sport,
    sportId,
    leagueId: leagueId || null,
    tab,
    itemId,
    eventCount: events.length,
    marketCount,
    unknownMarketCount,
    marketsSeen,
    sampleEvents,
    apiKeyAttached: Boolean(getRebetApiKey()),
  };
}