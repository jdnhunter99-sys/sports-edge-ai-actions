// Shared normalization helpers for the SharpOddsDatabase MLB odds collector.
//
// Extracted from base44/functions/refreshSharpOddsDatabase/entry.ts so the
// entry file stays within the platform line limit, and so future connectors
// (or other functions) can reuse the same normalization layer.

export const DEFAULT_TIMEZONE = 'America/Chicago';

export type AnyObject = Record<string, any>;
export type SourceGame = {
  source: string;
  sourceEventId: string | null;
  awayTeam: string;
  homeTeam: string;
  startTime: string | null;
  eventName?: string | null;
  eventType?: string | null;
  rawEvent?: boolean;
  sourceUpdatedAt?: string | null;
  isLive?: boolean;
  book: AnyObject;
};

export const MLB_TEAMS = [
  { abbr: 'ARI', name: 'Arizona Diamondbacks', aliases: ['ari','az','arizona','arizona diamondbacks','diamondbacks','dbacks'] },
  { abbr: 'ATL', name: 'Atlanta Braves', aliases: ['atl','atlanta','atlanta braves','braves'] },
  { abbr: 'BAL', name: 'Baltimore Orioles', aliases: ['bal','baltimore','baltimore orioles','orioles'] },
  { abbr: 'BOS', name: 'Boston Red Sox', aliases: ['bos','boston','boston red sox','red sox'] },
  { abbr: 'CHC', name: 'Chicago Cubs', aliases: ['chc','chicago c','chicago cubs','cubs'] },
  { abbr: 'CWS', name: 'Chicago White Sox', aliases: ['cws','chw','chicago ws','chicago white sox','white sox'] },
  { abbr: 'CIN', name: 'Cincinnati Reds', aliases: ['cin','cincinnati','cincinnati reds','reds'] },
  { abbr: 'CLE', name: 'Cleveland Guardians', aliases: ['cle','cleveland','cleveland guardians','guardians'] },
  { abbr: 'COL', name: 'Colorado Rockies', aliases: ['col','colorado','colorado rockies','rockies'] },
  { abbr: 'DET', name: 'Detroit Tigers', aliases: ['det','detroit','detroit tigers','tigers'] },
  { abbr: 'HOU', name: 'Houston Astros', aliases: ['hou','houston','houston astros','astros'] },
  { abbr: 'KC', name: 'Kansas City Royals', aliases: ['kc','kcr','kansas city','kansas city royals','royals'] },
  { abbr: 'LAA', name: 'Los Angeles Angels', aliases: ['laa','los angeles a','los angeles angels','la angels','angels'] },
  { abbr: 'LAD', name: 'Los Angeles Dodgers', aliases: ['lad','los angeles d','los angeles dodgers','la dodgers','dodgers'] },
  { abbr: 'MIA', name: 'Miami Marlins', aliases: ['mia','miami','miami marlins','marlins'] },
  { abbr: 'MIL', name: 'Milwaukee Brewers', aliases: ['mil','milwaukee','milwaukee brewers','brewers'] },
  { abbr: 'MIN', name: 'Minnesota Twins', aliases: ['min','minnesota','minnesota twins','twins'] },
  { abbr: 'NYM', name: 'New York Mets', aliases: ['nym','new york m','new york mets','ny mets','mets'] },
  { abbr: 'NYY', name: 'New York Yankees', aliases: ['nyy','new york y','new york yankees','ny yankees','yankees'] },
  { abbr: 'ATH', name: 'Athletics', aliases: ['ath','oak','athletics','oakland athletics','sacramento athletics','a’s','as'] },
  { abbr: 'PHI', name: 'Philadelphia Phillies', aliases: ['phi','philadelphia','philadelphia phillies','phillies'] },
  { abbr: 'PIT', name: 'Pittsburgh Pirates', aliases: ['pit','pittsburgh','pittsburgh pirates','pirates'] },
  { abbr: 'SD', name: 'San Diego Padres', aliases: ['sd','sdp','san diego','san diego padres','padres'] },
  { abbr: 'SF', name: 'San Francisco Giants', aliases: ['sf','sfg','san francisco','san francisco giants','giants'] },
  { abbr: 'SEA', name: 'Seattle Mariners', aliases: ['sea','seattle','seattle mariners','mariners'] },
  { abbr: 'STL', name: 'St. Louis Cardinals', aliases: ['stl','st louis','st. louis','st louis cardinals','st. louis cardinals','cardinals'] },
  { abbr: 'TB', name: 'Tampa Bay Rays', aliases: ['tb','tbr','tampa bay','tampa bay rays','rays'] },
  { abbr: 'TEX', name: 'Texas Rangers', aliases: ['tex','texas','texas rangers','rangers'] },
  { abbr: 'TOR', name: 'Toronto Blue Jays', aliases: ['tor','toronto','toronto blue jays','blue jays'] },
  { abbr: 'WSH', name: 'Washington Nationals', aliases: ['wsh','wsn','washington','washington nationals','nationals'] },
];

export function makeSourceGame(source: string, sourceEventId: string | null, awayTeam: string, homeTeam: string, startTime: string | null, bookmaker: string, sourceUpdatedAt: any, isLive = false): SourceGame {
  return {
    source, sourceEventId, awayTeam, homeTeam, startTime, sourceUpdatedAt: isoOrNull(sourceUpdatedAt), isLive,
    book: makeBook(bookmaker, source, sourceEventId, sourceUpdatedAt),
  };
}

export function makeBook(bookmaker: string, source: string, sourceEventId: any, sourceUpdatedAt: any) {
  return {
    bookmaker_id: normalizeBookKey(bookmaker),
    source,
    source_event_id: sourceEventId == null ? null : String(sourceEventId),
    source_updated_at: isoOrNull(sourceUpdatedAt),
    moneyline: {}, spread: {}, total: {}, observations: [],
  };
}

export function hasSourceGamePrice(game: SourceGame) {
  const b = game?.book || {};
  if (Array.isArray(b?.observations) && b.observations.length > 0) return true;
  return ['moneyline','spread','total'].some((m) => Object.values(b?.[m] || {}).some(Boolean));
}

// Canonical raw observation writer. SharpOddsDatabase is intentionally a raw
// append-only store: every source market/outcome/line returned by a connector
// is retained here, including temporarily unpriced/unavailable rows when the
// provider still supplies a meaningful market/selection/line identifier.
// Legacy moneyline/spread/total maps remain on each
// book only for compatibility with older callers; storage is built primarily
// from this observation array.
// Main game line filter. The SharpOddsDatabase pipeline stores only each
// game's full-game moneyline, spread, and total (main + alternate lines)
// from every book. Derivative markets (props, player totals), period
// markets (halves, quarters, first 5 innings), and non-game events are
// intentionally dropped at ingestion.
export function isMainGameLineObservation(obs: AnyObject) {
  if (!obs) return false;
  if (normalizeMarketPeriod(obs?.period) !== 'full_game') return false;
  const type = String(obs?.market_type ?? obs?.raw_market_type ?? '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['moneyline', 'money_line', 'h2h', 'ml'].includes(type)) return true;
  if (['spread', 'spreads', 'point_spread', 'run_line', 'runline', 'handicap'].includes(type)) return true;
  if (['total', 'totals', 'total_points', 'total_runs', 'game_total', 'over_under', 'overunder'].includes(type)) return true;
  return false;
}

export function addBookObservation(book: AnyObject, observation: AnyObject) {
  if (!book) return null;
  if (!isMainGameLineObservation(observation)) return null;
  const odds = parseAmericanOdds(observation?.odds);
  const rawProbability = probabilityOrNull(observation?.raw_probability);
  const line = finiteOrNull(observation?.line);
  const meaningfulUnpricedRow = Boolean(
    line != null
    || stringOrNull(observation?.source_market_id)
    || stringOrNull(observation?.source_outcome_id)
    || stringOrNull(observation?.market_key)
    || stringOrNull(observation?.market_name)
    || stringOrNull(observation?.selection)
    || stringOrNull(observation?.participant)
    || stringOrNull(observation?.participant_id)
    || stringOrNull(observation?.raw_market_type)
  );
  if (odds == null && rawProbability == null && !meaningfulUnpricedRow) return null;
  const item = {
    source: stringOrNull(observation?.source) || stringOrNull(book?.source),
    source_event_id: stringOrNull(observation?.source_event_id) || stringOrNull(book?.source_event_id),
    bookmaker_id: normalizeBookKey(observation?.bookmaker_id || book?.bookmaker_id),
    market_type: normalizeRawMarketType(observation?.market_type),
    market_key: stringOrNull(observation?.market_key),
    market_name: stringOrNull(observation?.market_name),
    period: normalizeMarketPeriod(observation?.period),
    side: stringOrNull(observation?.side),
    selection: stringOrNull(observation?.selection),
    participant: stringOrNull(observation?.participant),
    participant_id: stringOrNull(observation?.participant_id),
    prop_key: stringOrNull(observation?.prop_key),
    line,
    odds,
    has_price: odds != null || rawProbability != null,
    available: observation?.available !== false,
    quote_type: stringOrNull(observation?.quote_type) || 'current',
    is_main_line: observation?.is_main_line == null ? null : observation.is_main_line === true,
    is_alternate_line: observation?.is_alternate_line == null ? null : observation.is_alternate_line === true,
    source_market_id: stringOrNull(observation?.source_market_id),
    source_outcome_id: stringOrNull(observation?.source_outcome_id),
    source_updated_at: isoOrNull(observation?.source_updated_at),
    raw_probability: rawProbability,
    bid_probability: probabilityOrNull(observation?.bid_probability),
    ask_probability: probabilityOrNull(observation?.ask_probability),
    last_probability: probabilityOrNull(observation?.last_probability),
    source_version: finiteOrNull(observation?.source_version),
    max_risk_stake: finiteOrNull(observation?.max_risk_stake),
    cutoff_at: isoOrNull(observation?.cutoff_at),
    raw_market_type: stringOrNull(observation?.raw_market_type),
    raw_market_name: stringOrNull(observation?.raw_market_name),
    raw_selection_type: stringOrNull(observation?.raw_selection_type),
    raw: observation?.raw && typeof observation.raw === 'object' ? observation.raw : undefined,
  };
  book.observations = Array.isArray(book.observations) ? book.observations : [];
  book.observations.push(item);
  if (item.source_updated_at) book.source_updated_at = maxIso(book.source_updated_at, item.source_updated_at);
  return item;
}

export function normalizeRawMarketType(value: any) {
  const known = normalizeMarketType(value);
  if (known) return known;
  const raw = normalizeText(value).replace(/\s+/g, '_').replace(/[^a-z0-9_+.-]/g, '');
  return raw || 'other';
}

export function normalizeMarketPeriod(value: any) {
  const raw = normalizeText(value);
  if (!raw || raw === '0' || raw === 'game' || raw === 'full game' || raw === 'full_game' || raw === 'match') return 'full_game';
  if (/first five|1st five|first 5|1st 5|f5/.test(raw)) return 'first_5';
  if (/first half|1st half|1h/.test(raw)) return 'first_half';
  if (/second half|2nd half|2h/.test(raw)) return 'second_half';
  if (/first quarter|1st quarter|q1/.test(raw)) return 'first_quarter';
  if (/second quarter|2nd quarter|q2/.test(raw)) return 'second_quarter';
  if (/third quarter|3rd quarter|q3/.test(raw)) return 'third_quarter';
  if (/fourth quarter|4th quarter|q4/.test(raw)) return 'fourth_quarter';
  if (/first inning|1st inning/.test(raw)) return 'first_inning';
  return raw.replace(/\s+/g, '_');
}

export function dedupeSourceGames(games: SourceGame[], canonical: any = canonicalMlbTeam) {
  const map = new Map<string, SourceGame>();
  for (const game of games) {
    const a = canonical(game.awayTeam)?.abbr || normalizeText(game.awayTeam);
    const h = canonical(game.homeTeam)?.abbr || normalizeText(game.homeTeam);
    // Futures/awards/outrights may have no away/home teams (and often no useful
    // start time), so source event id is the only lossless dedupe identity.
    const rawIdentity = game.rawEvent === true
      ? `raw:${game.source}:${game.sourceEventId || game.eventName || `${a}:${h}:${game.startTime || ''}`}`
      : `${a}:${h}:${game.startTime || ''}`;
    const key = `${game.book.bookmaker_id}:${rawIdentity}`;
    const existing = map.get(key);
    if (!existing) map.set(key, game);
    else mergeBookEntries(existing.book, game.book);
  }
  return [...map.values()];
}

// Merge one book object's prices into another book object that shares the same
// bookmaker key (kept private to this module; the entry owns cross-game merges).
function mergeBookEntries(target: AnyObject, incoming: AnyObject) {
  target.observations = Array.isArray(target.observations) ? target.observations : [];
  if (Array.isArray(incoming?.observations)) target.observations.push(...incoming.observations);
  for (const market of ['moneyline','spread','total']) {
    target[market] = target[market] || {};
    for (const side of Object.keys(incoming?.[market] || {})) {
      if (incoming[market][side] != null) target[market][side] = incoming[market][side];
    }
  }
}

export function priceObject(odds: any, line: any, raw: AnyObject) {
  return {
    odds: parseAmericanOdds(odds),
    line: finiteOrNull(line),
    source_market_id: stringOrNull(raw?.market_id || raw?.marketId || raw?.id),
    source_outcome_id: stringOrNull(raw?.selection_id || raw?.selectionId || raw?.outcome_id || raw?.outcomeId),
    available: raw?.is_active !== false && raw?.active !== false,
    source_updated_at: isoOrNull(raw?.timestamp || raw?.updated_at || raw?.updatedAt),
    source_version: finiteOrNull(raw?.version),
    max_risk_stake: finiteOrNull(raw?.maxRiskStake || raw?.max_risk_stake),
    cutoff_at: isoOrNull(raw?.cutoffAt || raw?.cutoff_at),
    raw_probability: probabilityOrNull(raw?.probability || raw?.odds_probability),
  };
}

export function exchangePriceObject(prob: number, market: AnyObject, side: 'yes' | 'no', line: any) {
  return {
    odds: probabilityToAmerican(prob), line: finiteOrNull(line), raw_probability: prob,
    bid_probability: probabilityOrNull(market?.[`${side}_bid_dollars`]),
    ask_probability: probabilityOrNull(market?.[`${side}_ask_dollars`]),
    last_probability: side === 'yes' ? probabilityOrNull(market?.last_price_dollars) : null,
    source_market_id: stringOrNull(market?.ticker),
    source_updated_at: isoOrNull(market?.updated_time),
  };
}

export function polyPriceObject(prob: number, market: AnyObject, outcome: string, line: any) {
  return {
    odds: probabilityToAmerican(prob), line: finiteOrNull(line), raw_probability: prob,
    bid_probability: probabilityOrNull(market?.bestBid), ask_probability: probabilityOrNull(market?.bestAsk),
    last_probability: probabilityOrNull(market?.lastTradePrice),
    source_market_id: stringOrNull(market?.id || market?.conditionId),
    source_updated_at: isoOrNull(market?.updatedAt), outcome,
  };
}

export function exchangeProb(market: AnyObject, side: 'yes' | 'no') {
  const bid = probabilityOrNull(market?.[`${side}_bid_dollars`]);
  const ask = probabilityOrNull(market?.[`${side}_ask_dollars`]);
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (bid != null) return bid;
  if (ask != null) return ask;
  const lastYes = probabilityOrNull(market?.last_price_dollars);
  if (lastYes == null) return null;
  return side === 'yes' ? lastYes : 1 - lastYes;
}

export function marketTeamMention(market: AnyObject, away: AnyObject, home: AnyObject) {
  const text = normalizeText(`${market?.title || ''} ${market?.yes_sub_title || ''} ${market?.subtitle || ''} ${market?.question || ''}`);
  if ((away?.aliases || []).some((a: string) => text.includes(normalizeText(a)))) return away;
  if ((home?.aliases || []).some((a: string) => text.includes(normalizeText(a)))) return home;
  return null;
}

export function extractMarketLine(market: AnyObject) {
  const direct = finiteOrNull(market?.line ?? market?.floor_strike ?? market?.cap_strike ?? market?.functional_strike);
  if (direct != null) return Math.abs(direct);
  const text = `${market?.title || ''} ${market?.yes_sub_title || ''} ${market?.subtitle || ''}`;
  const m = text.match(/(?:over|more than|by)\s+([0-9]+(?:\.[0-9]+)?)/i) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:runs?|points?)/i);
  return m ? Number(m[1]) : null;
}

export function parseMatchupTitle(value: any) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*:\s*(?:Spread|Total(?: Runs)?|First.*|Home Runs|Strikeouts|Hits.*|Winner)\b.*$/i, '').replace(/\s+Winner\??$/i, '').trim();
  let parts = text.split(/\s+@\s+/i);
  if (parts.length === 2) return { away: cleanMatchupSide(parts[0]), home: cleanMatchupSide(parts[1]) };
  parts = text.split(/\s+(?:vs\.?|v\.?)\s+/i);
  if (parts.length === 2) return { away: cleanMatchupSide(parts[0]), home: cleanMatchupSide(parts[1]) };
  return null;
}

function cleanMatchupSide(value: any) {
  return String(value || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalMlbTeam(value: any): AnyObject | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  for (const team of MLB_TEAMS) {
    if (normalizeText(team.name) === normalized || normalizeText(team.abbr) === normalized) return team;
    if (team.aliases.some((alias) => normalizeText(alias) === normalized)) return team;
  }
  for (const team of MLB_TEAMS) {
    if (team.aliases.some((alias) => {
      const a = normalizeText(alias);
      return a.length >= 4 && (normalized.includes(a) || a.includes(normalized));
    })) return team;
  }
  return null;
}

export function inferTeamSide(selectionType: string, selection: string, away: string, home: string) {
  if (selectionType === 'away' || selectionType.includes('away')) return 'away';
  if (selectionType === 'home' || selectionType.includes('home')) return 'home';
  const selected = canonicalMlbTeam(selection);
  const a = canonicalMlbTeam(away);
  const h = canonicalMlbTeam(home);
  if (selected?.abbr && selected.abbr === a?.abbr) return 'away';
  if (selected?.abbr && selected.abbr === h?.abbr) return 'home';
  return null;
}

export function normalizeMarketType(value: any) {
  // normalizeText collapses every non-alphanumeric character to a space, so
  // multi-word provider market names arrive as "point spread" / "total points"
  // and would otherwise never match their underscore aliases below. Fold
  // spaces and dashes into underscores before the known-market lists.
  const raw = normalizeText(value).replace(/[-\s]+/g, '_');
  if (['moneyline','h2h','ml','money_line'].includes(raw)) return 'moneyline';
  if (['spread','spreads','point_spread','run_line','runline','handicap'].includes(raw)) return 'spread';
  if (['total','totals','total_points','total_runs','game_total','over_under','overunder'].includes(raw)) return 'total';
  return null;
}

export function parseLineFromSelection(value: any) {
  const text = String(value || '').replace(/−/g, '-');
  const matches = [...text.matchAll(/([+-]?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (!matches.length) return null;
  return matches[matches.length - 1];
}

export function parseAmericanOdds(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase().replace(/▲|▼/g, '');
  if (raw === 'even' || raw === 'ev') return 100;
  const n = Number(raw.replace('+', ''));
  if (Number.isFinite(n) && Math.abs(n) >= 100) return Math.round(n);
  const match = raw.match(/[+-]\d{2,4}/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatAmerican(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n));
}

export function americanToProbability(value: any) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : (-odds) / ((-odds) + 100);
}

export function probabilityToAmerican(value: any) {
  const p = probabilityOrNull(value);
  if (p == null) return null;
  if (Math.abs(p - 0.5) < 1e-12) return 100;
  const raw = p > 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
  return Math.round(raw);
}

export function probabilityOrNull(value: any) {
  if (value === null || value === undefined || value === '') return null;
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n /= 100;
  if (!(n > 0 && n < 1)) return null;
  return n;
}

export function parseVsinAmericanOdds(value: any) {
  const raw = String(value || '').trim().toLowerCase().replace(/▲|▼/g, '');
  if (!raw || raw === '-' || raw === '--') return null;
  if (raw === 'even') return 100;
  const match = raw.match(/[+-]\d{2,4}/);
  return match ? Number(match[0]) : null;
}

export function parseVsinSpreadCell(value: any) {
  const raw = String(value || '').replace(/\s+/g, '').replace(/▲|▼/g, '').trim();
  if (!raw || raw === '-' || raw === '--') return { line: null, odds: null };
  if (/^pk/i.test(raw)) return { line: 0, odds: parseVsinAmericanOdds(raw.slice(2)) };
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)([+-]\d{2,4}|even)?$/i);
  return match ? { line: Number(match[1]), odds: match[2] ? parseVsinAmericanOdds(match[2]) : null } : { line: null, odds: null };
}

export function parseVsinTotalCell(value: any) {
  const raw = String(value || '').replace(/▲|▼/g, '').trim();
  if (!raw || raw === '-' || raw === '--') return { line: null, odds: null };
  const match = raw.match(/(\d+(?:\.\d+)?)\s*[ou]?\s*([+-]\d{2,4}|even)?/i);
  return match ? { line: Number(match[1]), odds: match[2] ? parseVsinAmericanOdds(match[2]) : null } : { line: null, odds: null };
}

export function parseVsinUpdatedText(html: string) {
  const text = stripTags(html);
  const match = text.match(/Odds updated:\s*([0-9/]+\s+[0-9:]+\s*(?:AM|PM)\s*ET)/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

export function extractVsinGameTime(text: string) {
  const match = /(\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET)/i.exec(text);
  return match ? match[1].toUpperCase().replace(/\s+/g, ' ').trim() : null;
}

export function easternGameTimeToIso(gameDate: string, timeText: string) {
  const m = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return zonedDateTimeToUtc(gameDate, hour, minute, 0, 'America/New_York');
}

export function parseEasternTimestamp(value: string) {
  const m = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = Number(m[4]);
  if (m[6].toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (m[6].toUpperCase() === 'AM' && hour === 12) hour = 0;
  const date = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  return zonedDateTimeToUtc(date, hour, Number(m[5]), 0, 'America/New_York');
}

export function extractTableCells(rowHtml: string) {
  const cells: string[] = [];
  for (const match of rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripTags(match[1]));
  return cells;
}

export function cleanTeamText(value: any) {
  return stripTags(String(value || '')).replace(/^image:\s*/i, '').replace(/\s*\|.*$/, '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripTags(value: any) {
  return htmlDecode(String(value || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlDecode(value: any) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/');
}

export function normalizeBookKey(value: any) {
  return normalizeText(value).replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

export function normalizeText(value: any) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9.+-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export function finiteOrNull(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function stringOrNull(value: any) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function isoOrNull(value: any) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function maxIso(a: any, b: any) {
  const aa = isoOrNull(a); const bb = isoOrNull(b);
  if (!aa) return bb; if (!bb) return aa;
  return new Date(aa).getTime() >= new Date(bb).getTime() ? aa : bb;
}

export function maxIsoList(values: any[]) {
  let out: string | null = null;
  for (const value of values) out = maxIso(out, value);
  return out;
}

export function firstNonNull(values: any[]) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function firstNonEmpty(values: any[]) {
  return values.find((v) => v !== null && v !== undefined && v !== '') ?? null;
}

export function clampInt(value: any, min: number, max: number, fallback: number) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function addDaysDate(dateStr: string, days: number) {
  const [year, month, day] = String(dateStr || '').split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function safeJson(response: Response) {
  try { return await response.json(); } catch { return null; }
}

export function todayInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const map: AnyObject = {}; for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export function localDateForIso(iso: string, timeZone: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const map: AnyObject = {}; for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export function dateIsInWindow(dateValue: any, anchorDate: string, lookaheadDays = 0) {
  const date = String(dateValue || '').slice(0, 10);
  if (!date) return true;
  const end = addDaysDate(anchorDate, Math.max(0, Number(lookaheadDays) || 0));
  return date >= anchorDate && date <= end;
}

export function startIsInWindow(startTime: any, anchorDate: string, lookaheadDays = 0) {
  const iso = isoOrNull(startTime);
  if (!iso) return true;
  return dateIsInWindow(localDateForIso(iso, DEFAULT_TIMEZONE), anchorDate, lookaheadDays);
}

export function zonedDateTimeToUtc(dateStr: string, hour: number, minute: number, second: number, timeZone: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const desiredUtcClock = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desiredUtcClock;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const v: AnyObject = {}; for (const part of parts) v[part.type] = part.value;
    const representedAsUtc = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour), Number(v.minute), Number(v.second));
    guess = desiredUtcClock - (representedAsUtc - guess);
  }
  return new Date(guess).toISOString();
}