// Shared ScoresAndOdds NCAAF line-movement parser used by both the standalone
// fetchCFBLineMovements function and the scheduled SportOddsBundle cache.
import { normalizeCFBSchool } from './cfbTeamIdentity.ts';
import { canonicalCfbTeam } from './cfbOddsTeams.ts';

const RESPONSE_CACHE = new Map();
// Once-per-date cache of the full S&O NCAAF board: the parsed event-id/team map
// is shared by every game lookup on that date. Without this, a ~60-game slate
// re-fetched and re-parsed the multi-megabyte board once per game, which alone
// pushed the bundle refresh past the backend CPU limit.
const BOARD_CACHE = new Map();
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export async function fetchCFBLineMovement(payload: any) {
  const __t0 = Date.now();
  const { awayTeam, homeTeam, awayTeamAbbr, homeTeamAbbr, gameDate, gameId } = payload || {};
  const forceLive = payload?.forceLive === true;
  if (!gameDate) return { error: 'Missing gameDate', status: 400 };

  const dateStr = String(gameDate).slice(0, 10);
  const requestedAway = awayTeam || awayTeamAbbr || '';
  const requestedHome = homeTeam || homeTeamAbbr || '';
  const responseCacheKey = `cfb-line-movement-v2|${dateStr}|${normalizeTeamKey(requestedAway)}|${normalizeTeamKey(requestedHome)}`;
  const cached = forceLive ? null : getCacheValue(RESPONSE_CACHE, responseCacheKey);
  if (cached) return { ...cached, debug: { ...(cached.debug || {}), cache: { response: 'hit', key: responseCacheKey } } };

  const board = await loadNcaafBoard(dateStr);
  const debug: any = {
    dateStr,
    boardAttempts: board.boardAttempts || [],
    detailAttempts: [],
    boardCache: board.cacheHit ? 'hit' : 'miss',
  };
  if (!board.boardHtmlLength) return { error: 'ScoresAndOdds NCAAF page fetch failed', status: 500, debug };

  const boardTeamMap = board.boardTeamMap;
  const requestedAwayKeys = buildRequestedTeamKeys(requestedAway);
  const requestedHomeKeys = buildRequestedTeamKeys(requestedHome);
  const cleanRequestedGameId = String(gameId || '').replace(/[^0-9]/g, '');
  const matchedBoardId = findBoardMatchedGameId(boardTeamMap, requestedAwayKeys, requestedHomeKeys, cleanRequestedGameId);
  const candidateIds = matchedBoardId ? [matchedBoardId] : (board.eventIds || []);
  debug.eventIdCandidates = candidateIds;

  const parsedGames: any[] = [];
  const __detailT0 = Date.now();
  for (const id of candidateIds) {
    const detail = await fetchDetailCandidate(id, board.boardUrl);
    if (!detail.html) { debug.detailAttempts.push({ gameId: id, found: false }); continue; }
    const boardTeams = boardTeamMap.get(String(id)) || {};
    const parsed = parseLineMovementDetail(detail.html, id, {
      boardAwayTeam: boardTeams.awayTeam || null,
      boardHomeTeam: boardTeams.homeTeam || null,
      requestAwayTeam: requestedAway || null,
      requestHomeTeam: requestedHome || null,
      gameDate: dateStr,
    });
    debug.detailAttempts.push({ gameId: id, status: detail.status, found: Boolean(parsed), rowCount: parsed?.movementCount || 0 });
    if (parsed) parsedGames.push(parsed);
  }

  console.info(`[cfbMovement] ${String(requestedAway).slice(0, 14)}@${String(requestedHome).slice(0, 14)} board=${board.cacheHit ? 'hit' : 'miss'} matchedBoardId=${matchedBoardId || 'none'} candidates=${candidateIds.length} detailMs=${Date.now() - __detailT0} totalMs=${Date.now() - __t0} NOT_FOUND`);
  const matched = findParsedGame(parsedGames, requestedAwayKeys, requestedHomeKeys, cleanRequestedGameId);
  if (!matched) {
    return { error: 'No NCAAF line movement game found', status: 404, debug, available: parsedGames.map((g) => `${g.awayTeam || '?'} @ ${g.homeTeam || '?'}`) };
  }

  console.info(`[cfbMovement] ${String(requestedAway).slice(0, 14)}@${String(requestedHome).slice(0, 14)} board=${board.cacheHit ? 'hit' : 'miss'} matchedBoardId=${matchedBoardId || 'none'} candidates=${candidateIds.length} detailMs=${Date.now() - __detailT0} totalMs=${Date.now() - __t0}`);
  const result = { success: true, ...matched, debug: { ...debug, boardHtmlLength: board.boardHtmlLength, parsedGames: parsedGames.length } };
  if (!forceLive) {
    setCacheValue(RESPONSE_CACHE, responseCacheKey, result, getResponseCacheTtl(dateStr));
    trimCache(RESPONSE_CACHE, 80);
  }
  return result;
}

function getScoresAndOddsHeaders(referer = 'https://www.scoresandodds.com/ncaaf') {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
  };
}

// Warm the per-date board cache once before batch enrichment so concurrent
// per-game lookups never race each other into duplicate multi-megabyte board
// fetches + parses inside the bundle refresh.
export async function prewarmNcaafBoard(dateStr: string) {
  await loadNcaafBoard(String(dateStr || '').slice(0, 10));
}

async function loadNcaafBoard(dateStr: string) {
  const cacheKey = `cfb-board|${dateStr}`;
  const cached = getCacheValue(BOARD_CACHE, cacheKey);
  if (cached) return { ...cached, cacheHit: true };

  const boardUrls = [
    `https://www.scoresandodds.com/ncaaf/odds?date=${encodeURIComponent(dateStr)}`,
    `https://www.scoresandodds.com/ncaaf?date=${encodeURIComponent(dateStr)}`,
  ];
  const boardAttempts: any[] = [];
  let boardHtml = '';
  let boardUrl = boardUrls[0];
  for (const url of boardUrls) {
    try {
      const res = await fetch(url, { headers: getScoresAndOddsHeaders('https://www.scoresandodds.com/ncaaf') });
      const html = await res.text().catch(() => '');
      boardAttempts.push({ url, status: res.status, htmlLength: html.length });
      if (res.ok && html.length > boardHtml.length) { boardHtml = html; boardUrl = url; }
    } catch (error: any) {
      boardAttempts.push({ url, error: error?.message || String(error) });
    }
  }
  if (!boardHtml) {
    return { boardUrl, boardTeamMap: new Map(), eventIds: [] as string[], boardAttempts, boardHtmlLength: 0, cacheHit: false };
  }

  const board = {
    boardUrl,
    boardTeamMap: buildBoardEventTeamMap(boardHtml),
    eventIds: extractEventIds(boardHtml),
    boardAttempts,
    boardHtmlLength: boardHtml.length,
    cacheHit: false,
  };
  setCacheValue(BOARD_CACHE, cacheKey, board, FIVE_MINUTES);
  trimCache(BOARD_CACHE, 8);
  return board;
}

async function fetchDetailCandidate(gameId: string, referer: string) {
  const cleanId = String(gameId || '').replace(/[^0-9]/g, '');
  // The line-movements URL now serves a JS shell; the movement history table
  // with data-role="localtime" rows lives on the /details page (same layout
  // the MLB scraper uses). Fall back to the legacy URL for safety.
  const attempts = [
    `https://www.scoresandodds.com/ncaaf/events/${cleanId}/details`,
    `https://www.scoresandodds.com/ncaaf/events/${cleanId}/line-movements`,
  ];
  for (const url of attempts) {
    const res = await fetch(url, { headers: { ...getScoresAndOddsHeaders(referer), 'X-Requested-With': 'XMLHttpRequest' } });
    const html = await res.text().catch(() => '');
    if (res.ok && html) return { url, status: res.status, html };
  }
  return { url: attempts[0], status: 0, html: '' };
}

// Single-pass board parsing. The previous implementation ran
// extractTeamsNearEventId per event id, and each call scanned the ENTIRE
// multi-megabyte board HTML with 5 indexOf needles — O(ids × html), which
// alone pushed the bundle refresh past the backend CPU limit on 80+ game
// slates. Collecting all event positions, game slugs, and team links in one
// regex pass each reduces this to a handful of linear scans.
function buildBoardEventTeamMap(html: string) {
  const eventPositions = collectBoardEventPositions(html);
  const slugLinks = collectBoardSlugLinks(html);
  const teamLinks = collectBoardTeamLinks(html);
  const map = new Map();
  for (const [id, positions] of eventPositions) {
    const teams = resolveBoardTeams(positions.slice(0, 8), slugLinks, teamLinks);
    if (teams.awayTeam || teams.homeTeam) map.set(String(id), teams);
  }
  return map;
}

function collectBoardEventPositions(html: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const pattern = /ncaaf[.\-/](\d+)|\/ncaaf\/events\/(\d+)(?:\/details|\/line-movements)?/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const id = match[1] || match[2];
    if (!id) continue;
    let list = map.get(id);
    if (!list) { list = []; map.set(id, list); }
    list.push(match.index);
  }
  return map;
}

function collectBoardSlugLinks(html: string) {
  const out: { index: number; away: string; home: string }[] = [];
  const pattern = /<a[^>]*href=["']\/ncaaf\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)["'][^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    out.push({ index: match.index, away: match[1].replace(/-/g, ' '), home: match[2].replace(/-/g, ' ') });
  }
  return out;
}

function collectBoardTeamLinks(html: string) {
  const out: { index: number; name: string }[] = [];
  const pattern = /<a[^>]*href=["']\/ncaaf\/teams\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    out.push({ index: match.index, name: stripHtml(match[1]) });
  }
  return out;
}

function resolveBoardTeams(
  positions: number[],
  slugLinks: { index: number; away: string; home: string }[],
  teamLinks: { index: number; name: string }[],
) {
  const names: string[] = [];
  const add = (value: string) => {
    const name = cleanText(value);
    if (name && !names.some((existing) => normalizeTeamKey(existing) === normalizeTeamKey(name))) names.push(name);
  };
  for (const pos of positions) {
    const start = pos - 5000;
    const end = pos + 5000;
    for (const link of slugLinks) {
      if (link.index < start) continue;
      if (link.index > end) break;
      add(link.away); add(link.home);
      if (names.length >= 2) break;
    }
    if (names.length >= 2) break;
    for (const link of teamLinks) {
      if (link.index < start) continue;
      if (link.index > end) break;
      add(link.name);
      if (names.length >= 2) break;
    }
    if (names.length >= 2) break;
  }
  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function extractEventIds(html: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /id=["']ncaaf\.(\d+)["']/gi,
    /id=["']ncaaf[-.](\d+)["']/gi,
    /data-event=["']ncaaf\/(\d+)["']/gi,
    /\/ncaaf\/events\/(\d+)\/details/gi,
    /\/ncaaf\/events\/(\d+)\/line-movements/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1]) ids.add(String(match[1]));
    }
  }
  return [...ids];
}

function extractTeamsNearEventId(html: string, id: string) {
  const cleanId = String(id || '').replace(/[^0-9]/g, '');
  if (!cleanId) return { awayTeam: null, homeTeam: null };
  const positions: number[] = [];
  const needles = [`ncaaf.${cleanId}`, `ncaaf-${cleanId}`, `ncaaf/${cleanId}`, `/ncaaf/events/${cleanId}/details`, `/ncaaf/events/${cleanId}/line-movements`];
  for (const needle of needles) {
    let index = html.indexOf(needle);
    while (index !== -1) { positions.push(index); index = html.indexOf(needle, index + needle.length); }
  }
  const names: string[] = [];
  const add = (value: string) => {
    const name = cleanText(value);
    if (name && !names.some((existing) => normalizeTeamKey(existing) === normalizeTeamKey(name))) names.push(name);
  };
  for (const pos of positions.slice(0, 8)) {
    const start = Math.max(0, pos - 5000);
    const end = Math.min(html.length, pos + 5000);
    const snippet = html.slice(start, end);
    // Game links use /ncaaf/<away>-vs-<home> slugs; split them into team names.
    const slugMatches = [...snippet.matchAll(/<a[^>]*href=["']\/ncaaf\/([a-z0-9]+(?:-[a-z0-9]+)*)-vs-([a-z0-9]+(?:-[a-z0-9]+)*)["'][^>]*>/gi)];
    for (const m of slugMatches) {
      add(m[1].replace(/-/g, ' '));
      add(m[2].replace(/-/g, ' '));
      if (names.length >= 2) break;
    }
    // Look for team links or names near the event ID
    const teamMatches = [...snippet.matchAll(/<a[^>]*href=["']\/ncaaf\/teams\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of teamMatches) add(stripHtml(m[1]));
    if (names.length >= 2) break;
  }
  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function findBoardMatchedGameId(boardTeamMap: Map<string, any>, awayKeys: string[], homeKeys: string[], requestedGameId: string) {
  const cleanGameId = String(requestedGameId || '').replace(/[^0-9]/g, '');
  if (cleanGameId && boardTeamMap.has(cleanGameId)) return cleanGameId;
  for (const [id, teams] of boardTeamMap.entries()) {
    if (keysMatch(teams.awayTeam, awayKeys) && keysMatch(teams.homeTeam, homeKeys)) return String(id);
  }
  for (const [id, teams] of boardTeamMap.entries()) {
    if (keysMatch(teams.awayTeam, homeKeys) && keysMatch(teams.homeTeam, awayKeys)) return String(id);
  }
  return null;
}

function parseLineMovementDetail(html: string, gameId: string, request: any) {
  // Strip the current-odds comparison tables (one row per team, one moneyline
  // span per sportsbook column, timestamped at kickoff). They reuse the same
  // data-role="localtime" cells as the movement history, so without this their
  // per-team book prices leak into the series as a bogus final point that
  // flips both teams' current odds.
  const movementHtml = html.replace(/<tbody[^>]*(?:id|data-group)=["']odds-table[^"']*["'][^>]*>[\s\S]*?<\/tbody>/gi, '');
  const text = cleanText(movementHtml);
  const htmlTeams = extractTeamsFromHtml(html);
  const teams = {
    awayTeam: htmlTeams.awayTeam || request.boardAwayTeam || null,
    homeTeam: htmlTeams.homeTeam || request.boardHomeTeam || null,
  };

  let rows = parseTableRows(movementHtml);
  if (!rows.length) rows = parseFlattenedText(text);
  rows = cleanMovementRows(rows);

  if (!rows.length) return null;

  const moneyline = rows.filter((r) => r.awayML != null || r.homeML != null).map((r) => ({ time: r.time, label: formatLabel(r.time), awayML: r.awayML, homeML: r.homeML, away: r.awayML, home: r.homeML }));
  const spread = rows.filter((r) => r.awaySpread != null || r.homeSpread != null).map((r) => ({ time: r.time, label: formatLabel(r.time), awaySpread: r.awaySpread, homeSpread: r.homeSpread, away: r.awaySpread, home: r.homeSpread, awaySpreadOdds: r.awaySpreadOdds, homeSpreadOdds: r.homeSpreadOdds }));
  const total = rows.filter((r) => r.total != null).map((r) => ({ time: r.time, label: formatLabel(r.time), total: r.total, line: r.total, overOdds: r.overOdds, underOdds: r.underOdds, awayTotalOdds: r.overOdds, homeTotalOdds: r.underOdds }));

  const opening = rows[0];
  const current = rows[rows.length - 1];

  return {
    success: true,
    source: 'scoresandodds-detail-html',
    gameId: String(gameId || ''),
    gameDate: request.gameDate || null,
    matchup: `${teams.awayTeam || 'Away'} @ ${teams.homeTeam || 'Home'}`,
    awayTeam: teams.awayTeam || null,
    homeTeam: teams.homeTeam || null,
    openingAwayML: opening?.awayML ?? null,
    currentAwayML: current?.awayML ?? null,
    openingHomeML: opening?.homeML ?? null,
    currentHomeML: current?.homeML ?? null,
    movementCount: rows.length,
    rows,
    movements: { moneyline, spread, total },
    moneylineMovement: moneyline,
    spreadMovement: spread,
    totalMovement: total,
  };
}

function parseTableRows(html: string) {
  const out: any[] = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const timeMatch = rowHtml.match(/data-role=["']localtime["'][^>]*data-value=["']([^"']+)["']/i);
    if (!timeMatch) continue;
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
    const rowText = squashWhitespace(cells.join(' | '));
    const mlMatches = [...rowHtml.matchAll(/<span[^>]*class=["'][^"']*data-moneyline[^"']*["'][^>]*>\s*([+-]?\d+|even)\s*<\/span>/gi)];
    if (mlMatches.length < 2) continue;
    const spreadInfo = parseSpreadFromText(rowText);
    const totalInfo = parseTotalFromText(rowText);
    const awayML = parseMoneylineValue(mlMatches[mlMatches.length - 2]?.[1]);
    const homeML = parseMoneylineValue(mlMatches[mlMatches.length - 1]?.[1]);
    if (awayML == null && homeML == null) continue;
    out.push({ time: timeMatch[1], awaySpread: spreadInfo.awaySpread, homeSpread: spreadInfo.homeSpread, awaySpreadOdds: spreadInfo.awaySpreadOdds, homeSpreadOdds: spreadInfo.homeSpreadOdds, total: totalInfo.total, overOdds: totalInfo.overOdds, underOdds: totalInfo.underOdds, awayML, homeML, raw: rowText });
  }
  return out;
}

function parseFlattenedText(text: string) {
  const out: any[] = [];
  const headerMatch = /Time\s+Spread\s+Total\s+\S+\s+ML\s+\S+\s+ML/i.exec(text);
  if (!headerMatch) return out;
  const section = text.slice(headerMatch.index + headerMatch[0].length);
  const datePattern = /(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/gi;
  const starts: any[] = [];
  let m;
  while ((m = datePattern.exec(section)) !== null) starts.push({ index: m.index, value: m[0] });
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1]?.index ?? Math.min(section.length, start.index + 200);
    const chunk = squashWhitespace(section.slice(start.index, end));
    const withoutTime = squashWhitespace(chunk.replace(start.value, ''));
    const spreadInfo = parseSpreadFromText(withoutTime);
    const totalInfo = parseTotalFromText(withoutTime);
    const mlMatches = [...withoutTime.matchAll(/(?:^|\s)([+-]\d{2,4}|even)(?=\s|$)/gi)].map((x) => x[1]);
    const lastTwo = mlMatches.slice(-2);
    const awayML = parseMoneylineValue(lastTwo[0]);
    const homeML = parseMoneylineValue(lastTwo[1]);
    if (awayML == null && homeML == null) continue;
    out.push({ time: String(start.value).replace(/\s+/g, ' ').trim(), awaySpread: spreadInfo.awaySpread, homeSpread: spreadInfo.homeSpread, awaySpreadOdds: spreadInfo.awaySpreadOdds, homeSpreadOdds: spreadInfo.homeSpreadOdds, total: totalInfo.total, overOdds: totalInfo.overOdds, underOdds: totalInfo.underOdds, awayML, homeML, raw: chunk });
  }
  return out;
}

function parseSpreadFromText(text: string) {
  const result = { awaySpread: null, homeSpread: null, awaySpreadOdds: null, homeSpreadOdds: null };
  const match = /\b([+-]?\d+(?:\.5)?|PK)\s+([+-]\d{2,4})\b/i.exec(text);
  if (!match) return result;
  const line = parseLineNumber(match[1]);
  const odds = parseMoneylineValue(match[2]);
  if (line == null) return result;
  result.homeSpread = line;
  result.awaySpread = -line;
  result.homeSpreadOdds = odds;
  return result;
}

function parseTotalFromText(text: string) {
  const result = { total: null, overOdds: null, underOdds: null };
  const match = /\b([ou])\s*(\d+(?:\.5)?)\s+([+-]\d{2,4})\b/i.exec(text);
  if (!match) return result;
  result.total = parseLineNumber(match[2]);
  const odds = parseMoneylineValue(match[3]);
  if (match[1].toLowerCase() === 'o') result.overOdds = odds;
  if (match[1].toLowerCase() === 'u') result.underOdds = odds;
  return result;
}

function extractTeamsFromHtml(html: string) {
  const names: string[] = [];
  const add = (value: string) => {
    const name = cleanText(value);
    if (name && !names.some((existing) => normalizeTeamKey(existing) === normalizeTeamKey(name))) names.push(name);
  };
  const patterns = [
    /<a[^>]*href=["']\/ncaaf\/teams\/[^"']+["'][^>]*aria-label=["']([^"']+)["'][^>]*>/gi,
    /aria-label=["']([^"']+)["'][^>]*href=["']\/ncaaf\/teams\/[^"']+["']/gi,
    /<a[^>]*href=["']\/ncaaf\/teams\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) add(match[1]);
  }
  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function buildRequestedTeamKeys(teamName: string): string[] {
  return [...new Set([normalizeTeamKey(teamName)].filter(Boolean))];
}

function keysMatch(actualValue: string, requestedKeys: string[]): boolean {
  if (!requestedKeys?.length) return false;
  const actual = normalizeTeamKey(actualValue);
  if (!actual) return false;
  return requestedKeys.some((key) => {
    if (!key) return false;
    if (actual === key) return true;
    // ScoresAndOdds sometimes uses school-only labels while ESPN uses the full
    // mascot display name. Allow a conservative prefix relation for long keys;
    // exact canonical aliases above still handle ambiguous schools like Miami.
    const shorter = actual.length <= key.length ? actual : key;
    const longer = actual.length > key.length ? actual : key;
    return shorter.length >= 6 && longer.startsWith(shorter);
  });
}

function findParsedGame(games: any[], awayKeys: string[], homeKeys: string[], gameId: string) {
  const cleanGameId = String(gameId || '').replace(/[^0-9]/g, '');
  return (
    games.find((game) => cleanGameId && String(game.gameId || '').includes(cleanGameId)) ||
    games.find((game) => keysMatch(game.awayTeam, awayKeys) && keysMatch(game.homeTeam, homeKeys)) ||
    games.find((game) => keysMatch(game.awayTeam, homeKeys) && keysMatch(game.homeTeam, awayKeys)) ||
    null
  );
}

function cleanMovementRows(rows: any[]) {
  const sorted = (rows || []).filter(Boolean).sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const cleaned: any[] = [];
  for (const row of sorted) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.awayML === row.awayML && prev.homeML === row.homeML && prev.awaySpread === row.awaySpread && prev.total === row.total) continue;
    cleaned.push(row);
  }
  return cleaned;
}

function formatLabel(value: string) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return String(value);
}

function normalizeTeamKey(value: string): string {
  const team = canonicalCfbTeam(value);
  const canonical = normalizeCFBSchool(team?.abbr || value);
  return canonical || String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').trim();
}

function parseMoneylineValue(text: string): number | null {
  if (text == null || text === '') return null;
  const raw = String(text).trim().toLowerCase();
  if (raw === 'even' || raw === 'ev') return 100;
  const match = raw.match(/[+-]?\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

function parseLineNumber(value: string): number | null {
  if (value == null || value === '') return null;
  const raw = String(value).replace(/−|–/g, '-').replace(/^pk$/i, '0').replace(/^[ou]\s*/i, '').replace(/[^0-9.+-]/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value: string = ''): string {
  return htmlDecode(stripHtml(String(value || ''))).replace(/\s+/g, ' ').trim();
}

function stripHtml(value: string = ''): string {
  return String(value).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ');
}

function htmlDecode(value: string = ''): string {
  return String(value).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function squashWhitespace(value: string = ''): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

function getResponseCacheTtl(dateStr: string): number {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr > today) return THIRTY_MINUTES;
  if (dateStr === today) return FIVE_MINUTES;
  return ONE_DAY;
}

function getCacheValue(cache: Map<string, any>, key: string) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) { cache.delete(key); return null; }
  return item.value;
}

function setCacheValue(cache: Map<string, any>, key: string, value: any, ttlMs: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function trimCache(cache: Map<string, any>, maxSize: number) {
  while (cache.size > maxSize) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }

}


// Standalone slate reader for GitHub Actions. It uses the same board and detail
// page parsers as the Base44 function but does not read or write Base44 entities.
export async function fetchCFBLineMovementSlate(gameDate: string) {
  const dateStr = String(gameDate || '').slice(0, 10);
  const board = await loadNcaafBoard(dateStr);
  if (!board.boardHtmlLength) throw new Error(`ScoresAndOdds NCAAF board unavailable for ${dateStr}`);
  const ids = board.eventIds || [];
  const games = await mapWithConcurrency(ids, 6, async (id: string) => {
    try {
      const detail = await fetchDetailCandidate(id, board.boardUrl);
      if (!detail.html) return null;
      const teams = board.boardTeamMap.get(String(id)) || {};
      return parseLineMovementDetail(detail.html, id, {
        boardAwayTeam: teams.awayTeam || null,
        boardHomeTeam: teams.homeTeam || null,
        gameDate: dateStr,
      });
    } catch (error) {
      console.warn(`[cfbMovement] event ${id} failed:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  });
  return { success: true, gameDate: dateStr, games: games.filter(Boolean) };
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
