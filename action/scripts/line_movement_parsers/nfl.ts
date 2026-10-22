// NFL ScoresAndOdds line-movement parser for the standalone publisher.
// Uses native fetch + targeted HTML parsing; no Base44 cache dependency.

const BOARD_CACHE = new Map();

const FIVE_MINUTES = 5 * 60 * 1000;

// Standalone full-slate scraper for the GitHub publisher. It bypasses the
// request-specific matchup selection and never reads Base44 OddsCache rows.
export async function fetchNFLLineMovementSlate(gameDate: string) {
  const dateStr = String(gameDate || '').slice(0, 10);
  if (!dateStr) throw new Error('Missing NFL gameDate');
  const boardUrls = [
    `https://www.scoresandodds.com/nfl/odds?date=${encodeURIComponent(dateStr)}`,
    `https://www.scoresandodds.com/nfl?date=${encodeURIComponent(dateStr)}`,
  ];
  const debug: any = { boardAttempts: [], eventIdCandidates: [], detailAttempts: [] };
  const boardResult = await getCachedBoardHtml(dateStr, boardUrls, debug);
  if (!boardResult.html) throw new Error(`ScoresAndOdds NFL board unavailable for ${dateStr}`);

  const boardTeamMap = buildBoardEventTeamMap(boardResult.html);
  const ids = new Set<string>([
    ...boardTeamMap.keys(),
    ...extractNFLEventIds(boardResult.html),
  ]);
  const games = await mapNFLWithConcurrency([...ids], 6, async (id) => {
    try {
      const detail = await fetchNFLDetailCandidate(id, dateStr, boardResult.url || boardUrls[0]);
      if (!detail.html) return null;
      const teams = boardTeamMap.get(String(id)) || {};
      return parseNFLLineMovementDetail(detail.html, id, {
        boardAwayTeam: teams.awayTeam || null,
        boardHomeTeam: teams.homeTeam || null,
        gameDate: dateStr,
      });
    } catch (error) {
      console.warn(`[nflMovement] event ${id} failed:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  });
  return { success: true, gameDate: dateStr, games: games.filter(Boolean) };
}

async function mapNFLWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
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

function getCacheValue(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCacheValue(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function trimCache(cache, maxSize) {
  while (cache.size > maxSize) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

async function getCachedBoardHtml(dateStr, boardUrls, debug) {
  const cacheKey = `nfl-board-v3|${dateStr}`;
  const cached = getCacheValue(BOARD_CACHE, cacheKey);
  if (cached?.html) {
    debug.cache.board = 'hit';
    debug.boardAttempts.push({
      url: cached.url,
      status: 200,
      htmlLength: cached.html.length,
      cached: true,
    });
    return cached;
  }

  let boardHtml = '';
  let boardUrl = '';

  for (const url of boardUrls) {
    const res = await fetch(url, {
      headers: getScoresAndOddsHeaders('https://www.scoresandodds.com/nfl'),
    });
    const html = await res.text().catch(() => '');
    debug.boardAttempts.push({ url, status: res.status, htmlLength: html.length, cached: false });
    if (res.ok && html.length > boardHtml.length) {
      boardHtml = html;
      boardUrl = url;
    }
  }

  const result = { html: boardHtml, url: boardUrl };
  if (boardHtml) {
    setCacheValue(BOARD_CACHE, cacheKey, result, FIVE_MINUTES);
    trimCache(BOARD_CACHE, 20);
  }

  return result;
}

function findBoardMatchedGameId(boardTeamMap, awayKeys, homeKeys, requestedGameId) {
  const cleanGameId = String(requestedGameId || '').replace(/[^0-9]/g, '');
  if (cleanGameId && boardTeamMap.has(cleanGameId)) return cleanGameId;

  for (const [id, teams] of boardTeamMap.entries()) {
    if (keysMatch(teams.awayTeam, awayKeys) && keysMatch(teams.homeTeam, homeKeys)) {
      return String(id);
    }
  }

  for (const [id, teams] of boardTeamMap.entries()) {
    if (keysMatch(teams.awayTeam, homeKeys) && keysMatch(teams.homeTeam, awayKeys)) {
      return String(id);
    }
  }

  return null;
}

function getScoresAndOddsHeaders(referer = 'https://www.scoresandodds.com/nfl') {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
  };
}

async function fetchNFLDetailCandidate(gameId, dateStr, referer) {
  const cleanId = String(gameId || '').replace(/[^0-9]/g, '');
  const url = `https://www.scoresandodds.com/nfl/events/${cleanId}/details`;

  const res = await fetch(url, {
    headers: {
      ...getScoresAndOddsHeaders(referer),
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const html = await res.text().catch(() => '');

  return {
    url,
    status: res.status,
    html: res.ok ? html : '',
  };
}


function buildBoardEventTeamMap(html) {
  const ids = extractNFLEventIds(html);
  const map = new Map();

  for (const id of ids) {
    const teams = extractTeamsNearEventId(html, id);
    if (teams.awayTeam || teams.homeTeam) map.set(String(id), teams);
  }

  return map;
}

function extractTeamsNearEventId(html, id) {
  const cleanId = String(id || '').replace(/[^0-9]/g, '');
  if (!cleanId) return { awayTeam: null, homeTeam: null };

  const positions = [];
  const needles = [
    `nfl.${cleanId}`,
    `nfl-${cleanId}`,
    `nfl/${cleanId}`,
    `/nfl/events/${cleanId}/details`,
    `/nfl/events/${cleanId}/line-movements`,
    `eventId\":${cleanId}`,
    `eventID\":${cleanId}`,
    `gameId\":${cleanId}`,
  ];

  for (const needle of needles) {
    let index = html.indexOf(needle);
    while (index !== -1) {
      positions.push(index);
      index = html.indexOf(needle, index + needle.length);
    }
  }

  const names = [];
  const add = (value) => {
    const name = normalizeDisplayTeamName(value);
    if (name && !names.some((existing) => normalizeTeamKey(existing) === normalizeTeamKey(name))) names.push(name);
  };

  for (const pos of positions.slice(0, 8)) {
    const start = Math.max(0, pos - 5000);
    const end = Math.min(html.length, pos + 5000);
    const snippet = html.slice(start, end);
    const teams = extractTeamsFromHtml(snippet);
    add(teams.awayTeam);
    add(teams.homeTeam);

    if (names.length >= 2) break;
  }

  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function extractNFLEventIds(html) {
  const ids = new Set();
  const patterns = [
    /id=["']nfl\.(\d+)["']/gi,
    /id=["']nfl[-.](\d+)["']/gi,
    /data-event=["']nfl\/(\d+)["']/gi,
    /data-content=["'][^"']*nfl\/(\d+)[^"']*["']/gi,
    /\/nfl\/events\/(\d+)\/details/gi,
    /\/nfl\/events\/(\d+)\/line-movements/gi,
    /event(?:Id|ID|_id)["']?\s*[:=]\s*["']?(\d{5,})/gi,
    /game(?:Id|ID|_id)["']?\s*[:=]\s*["']?(\d{5,})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1]) ids.add(String(match[1]));
    }
  }

  return [...ids];
}

function parseNFLLineMovementDetail(html, gameId, request = {}) {
  const text = cleanText(html);
  const htmlTeams = extractTeamsFromHtml(html);
  const teams = {
    awayTeam: htmlTeams.awayTeam || request.boardAwayTeam || null,
    homeTeam: htmlTeams.homeTeam || request.boardHomeTeam || null,
  };

  const awayAbbr = teamToAbbr(teams.awayTeam || request.requestAwayTeamAbbr || request.requestAwayTeam);
  const homeAbbr = teamToAbbr(teams.homeTeam || request.requestHomeTeamAbbr || request.requestHomeTeam);

  // First parse real table rows. This avoids the sportsbook comparison matrix because
  // comparison rows do not have one row containing Time + Spread + Total + both MLs.
  let rows = parseLineMovementTableRows(html, { awayAbbr, homeAbbr });

  // Fallback: ScoresAndOdds sometimes renders a flattened text block containing
  // "Time Spread Total NE ML SEA ML" followed by repeated movement rows.
  if (!rows.length) {
    rows = parseFlattenedLineMovementText(text, { awayAbbr, homeAbbr });
  }

  rows = cleanParsedMovementRows(rows);

  if (!rows.length) return null;

  const moneyline = rows
    .filter((row) => row.awayML != null || row.homeML != null)
    .map((row) => ({
      time: row.time,
      label: formatMovementLabel(row.time),
      awayML: row.awayML,
      homeML: row.homeML,
      away: row.awayML,
      home: row.homeML,
    }));

  const spread = rows
    .filter((row) => row.awaySpread != null || row.homeSpread != null)
    .map((row) => ({
      time: row.time,
      label: formatMovementLabel(row.time),
      awaySpread: row.awaySpread,
      homeSpread: row.homeSpread,
      away: row.awaySpread,
      home: row.homeSpread,
      awaySpreadOdds: row.awaySpreadOdds,
      homeSpreadOdds: row.homeSpreadOdds,
    }));

  const total = rows
    .filter((row) => row.total != null)
    .map((row) => ({
      time: row.time,
      label: formatMovementLabel(row.time),
      total: row.total,
      line: row.total,
      overOdds: row.overOdds,
      underOdds: row.underOdds,
      awayTotalOdds: row.overOdds,
      homeTotalOdds: row.underOdds,
    }));

  const opening = rows[0];
  const current = rows[rows.length - 1];

  return {
    success: true,
    source: 'scoresandodds-detail-html',
    gameId: String(gameId || ''),
    gameDate: request.gameDate || null,
    matchup: `${teams.awayTeam || awayAbbr || 'Away'} @ ${teams.homeTeam || homeAbbr || 'Home'}`,
    awayTeam: teams.awayTeam || awayAbbr || null,
    homeTeam: teams.homeTeam || homeAbbr || null,
    awayTeamAbbr: awayAbbr || null,
    homeTeamAbbr: homeAbbr || null,

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

function parseLineMovementTableRows(html, { awayAbbr, homeAbbr }) {
  const out = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const timeMatch = rowHtml.match(/data-role=["']localtime["'][^>]*data-value=["']([^"']+)["']/i);
    if (!timeMatch) continue;

    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
    const rowText = squashWhitespace(cells.join(' | '));

    const moneylineMatches = [...rowHtml.matchAll(/<span[^>]*class=["'][^"']*data-moneyline[^"']*["'][^>]*>\s*([+-]?\d+|even)\s*<\/span>/gi)];
    if (moneylineMatches.length < 2) continue;

    const spreadInfo = parseSpreadFromText(rowText, { awayAbbr, homeAbbr });
    const totalInfo = parseTotalFromText(rowText);
    const awayML = parseMoneylineValue(moneylineMatches[moneylineMatches.length - 2]?.[1]);
    const homeML = parseMoneylineValue(moneylineMatches[moneylineMatches.length - 1]?.[1]);

    if (awayML == null && homeML == null) continue;

    out.push({
      time: timeMatch[1],
      awaySpread: spreadInfo.awaySpread,
      homeSpread: spreadInfo.homeSpread,
      awaySpreadOdds: spreadInfo.awaySpreadOdds,
      homeSpreadOdds: spreadInfo.homeSpreadOdds,
      total: totalInfo.total,
      overOdds: totalInfo.overOdds,
      underOdds: totalInfo.underOdds,
      awayML,
      homeML,
      raw: rowText,
    });
  }

  return out;
}

function parseFlattenedLineMovementText(text, { awayAbbr, homeAbbr }) {
  const out = [];
  const headerMatch = /Time\s+Spread\s+Total\s+([A-Z]{2,3})\s+ML\s+([A-Z]{2,3})\s+ML/i.exec(text);
  if (!headerMatch) return out;

  const section = text.slice(headerMatch.index + headerMatch[0].length);
  const datePattern = /(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/gi;
  const starts = [];
  let m;
  while ((m = datePattern.exec(section)) !== null) starts.push({ index: m.index, value: m[0] });

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1]?.index ?? Math.min(section.length, start.index + 200);
    const chunk = squashWhitespace(section.slice(start.index, end));
    const withoutTime = squashWhitespace(chunk.replace(start.value, ''));

    const spreadInfo = parseSpreadFromText(withoutTime, { awayAbbr, homeAbbr });
    const totalInfo = parseTotalFromText(withoutTime);
    const mlMatches = [...withoutTime.matchAll(/(?:^|\s)([+-]\d{2,4}|even)(?=\s|$)/gi)].map((x) => x[1]);
    const lastTwo = mlMatches.slice(-2);

    const awayML = parseMoneylineValue(lastTwo[0]);
    const homeML = parseMoneylineValue(lastTwo[1]);

    if (awayML == null && homeML == null) continue;

    out.push({
      time: normalizeFlattenedTime(start.value),
      awaySpread: spreadInfo.awaySpread,
      homeSpread: spreadInfo.homeSpread,
      awaySpreadOdds: spreadInfo.awaySpreadOdds,
      homeSpreadOdds: spreadInfo.homeSpreadOdds,
      total: totalInfo.total,
      overOdds: totalInfo.overOdds,
      underOdds: totalInfo.underOdds,
      awayML,
      homeML,
      raw: chunk,
    });
  }

  return out;
}

function parseSpreadFromText(text, { awayAbbr, homeAbbr }) {
  const result = {
    awaySpread: null,
    homeSpread: null,
    awaySpreadOdds: null,
    homeSpreadOdds: null,
  };

  const match = /\b([A-Z]{2,3})\s+([+-]?\d+(?:\.5)?|PK)\s+([+-]\d{2,4})\b/i.exec(text);
  if (!match) return result;

  const side = match[1].toUpperCase();
  const line = parseLineNumber(match[2]);
  const odds = parseMoneylineValue(match[3]);
  if (line == null) return result;

  if (side === String(awayAbbr || '').toUpperCase()) {
    result.awaySpread = line;
    result.homeSpread = -line;
    result.awaySpreadOdds = odds;
  } else if (side === String(homeAbbr || '').toUpperCase()) {
    result.homeSpread = line;
    result.awaySpread = -line;
    result.homeSpreadOdds = odds;
  } else {
    // If abbreviations are unavailable, assume the listed side is the home/favorite side.
    result.homeSpread = line;
    result.awaySpread = -line;
    result.homeSpreadOdds = odds;
  }

  return result;
}

function parseTotalFromText(text) {
  const result = { total: null, overOdds: null, underOdds: null };
  const match = /\b([ou])\s*(\d+(?:\.5)?)\s+([+-]\d{2,4})\b/i.exec(text);
  if (!match) return result;

  result.total = parseLineNumber(match[2]);
  const odds = parseMoneylineValue(match[3]);
  if (match[1].toLowerCase() === 'o') result.overOdds = odds;
  if (match[1].toLowerCase() === 'u') result.underOdds = odds;
  return result;
}

function extractTeamsFromHtml(html) {
  const names = [];
  const add = (value) => {
    const name = normalizeDisplayTeamName(value);
    if (name && !names.some((existing) => normalizeTeamKey(existing) === normalizeTeamKey(name))) names.push(name);
  };

  const patterns = [
    /<a[^>]*href=["']\/nfl\/teams\/[^"']+["'][^>]*aria-label=["']([^"']+)["'][^>]*>/gi,
    /aria-label=["']([^"']+)["'][^>]*href=["']\/nfl\/teams\/[^"']+["']/gi,
    /<img[^>]*(?:alt|title)=["']([^"']+)["'][^>]*>/gi,
    /(?:teamName|shortName|fullName|displayName)["']?\s*[:=]\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) add(match[1]);
  }

  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function buildRequestedTeamKeys(teamName, teamAbbr) {
  return [...new Set([
    normalizeTeamKey(teamName),
    normalizeTeamKey(teamAbbr),
    ...teamAliasKeys(teamName),
    ...teamAliasKeys(teamAbbr),
  ].filter(Boolean))];
}

function teamAliasKeys(value) {
  const key = normalizeTeamKey(value);
  const map = {
    cardinals: ['ari', 'arizona'], falcons: ['atl', 'atlanta'], ravens: ['bal', 'baltimore'], bills: ['buf', 'buffalo'], panthers: ['car', 'carolina'],
    bears: ['chi', 'chicago'], bengals: ['cin', 'cincinnati'], browns: ['cle', 'cleveland'], cowboys: ['dal', 'dallas'], broncos: ['den', 'denver'],
    lions: ['det', 'detroit'], packers: ['gb', 'greenbay'], texans: ['hou', 'houston'], colts: ['ind', 'indianapolis'], jaguars: ['jax', 'jacksonville'],
    chiefs: ['kc', 'kansascity'], raiders: ['lv', 'lasvegas'], chargers: ['lac', 'losangeleschargers'], rams: ['lar', 'losangelesrams'], dolphins: ['mia', 'miami'],
    vikings: ['min', 'minnesota'], patriots: ['ne', 'newengland'], saints: ['no', 'neworleans'], giants: ['nyg', 'newyorkgiants'], jets: ['nyj', 'newyorkjets'],
    eagles: ['phi', 'philadelphia'], steelers: ['pit', 'pittsburgh'], fortyniners: ['sf', 'sanfrancisco', '49ers'], seahawks: ['sea', 'seattle'], buccaneers: ['tb', 'tampa', 'tampabay'],
    titans: ['ten', 'tennessee'], commanders: ['was', 'wsh', 'washington'],
  };
  const reverse = {};
  for (const [main, aliases] of Object.entries(map)) {
    reverse[main] = [main, ...aliases];
    for (const alias of aliases) reverse[alias] = [main, ...aliases];
  }
  return reverse[key] || (key ? [key] : []);
}

function keysMatch(actualValue, requestedKeys) {
  if (!requestedKeys?.length) return false;
  const actualKeys = new Set([normalizeTeamKey(actualValue), ...teamAliasKeys(actualValue)].filter(Boolean));
  return requestedKeys.some((key) => actualKeys.has(key));
}

function findParsedGame(games, awayKeys, homeKeys, gameId) {
  const cleanGameId = String(gameId || '').replace(/[^0-9]/g, '');
  return (
    games.find((game) => cleanGameId && String(game.gameId || '').includes(cleanGameId)) ||
    games.find((game) => keysMatch(game.awayTeam, awayKeys) && keysMatch(game.homeTeam, homeKeys)) ||
    games.find((game) => keysMatch(game.awayTeam, homeKeys) && keysMatch(game.homeTeam, awayKeys)) ||
    null
  );
}

function cleanParsedMovementRows(rows) {
  const sorted = (rows || [])
    .filter(Boolean)
    .filter((row) => !isSportsbookComparisonRow(row))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const cleaned = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const next = sorted[i + 1];

    // ScoresAndOdds can render a partial first movement row, then the complete
    // row one second later with the same spread/ML plus total. Keep the complete row.
    if (
      next &&
      row.total == null &&
      next.total != null &&
      row.awayML === next.awayML &&
      row.homeML === next.homeML &&
      row.awaySpread === next.awaySpread &&
      row.homeSpread === next.homeSpread &&
      Math.abs(new Date(next.time).getTime() - new Date(row.time).getTime()) <= 5000
    ) {
      continue;
    }

    const prev = cleaned[cleaned.length - 1];
    if (
      prev &&
      prev.awayML === row.awayML &&
      prev.homeML === row.homeML &&
      prev.awaySpread === row.awaySpread &&
      prev.homeSpread === row.homeSpread &&
      prev.total === row.total
    ) {
      continue;
    }

    cleaned.push(row);
  }

  return cleaned;
}

function isSportsbookComparisonRow(row) {
  const raw = String(row?.raw || '');

  // Current odds matrix rows include rotation number + team name, e.g.
  // "451 Patriots | +170 | +180 | ...". Historical movement rows look like
  // "SEA -3.5 -110 | o44.5 -110 | +164 | -198" and should be kept.
  if (/\b\d{3}\s+[A-Z][A-Za-z]+\b/.test(raw)) return true;

  // A sportsbook comparison moneyline row may accidentally create impossible
  // same-side positive moneylines for both teams from one team's price row.
  if (
    row?.awaySpread == null &&
    row?.homeSpread == null &&
    row?.total == null &&
    row?.awayML != null &&
    row?.homeML != null &&
    Math.sign(row.awayML) === Math.sign(row.homeML)
  ) {
    return true;
  }

  return false;
}

function formatMovementLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) {
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return String(value);
}

function normalizeFlattenedTime(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDisplayTeamName(value) {
  const cleaned = cleanText(value)
    .replace(/\b(?:logo|helmet|odds|line movements?|moneyline|spread|total|tickets?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const abbr = teamToAbbr(cleaned);
  const full = abbrToTeamName(abbr);
  if (full) return full;

  const key = normalizeTeamKey(cleaned);
  const aliases = teamAliasKeys(key);
  for (const alias of aliases) {
    const aliasFull = abbrToTeamName(teamToAbbr(alias));
    if (aliasFull) return aliasFull;
  }

  return cleaned && cleaned.length <= 40 ? cleaned : '';
}

function abbrToTeamName(abbr) {
  const map = {
    ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs', LV: 'Raiders', LAC: 'Chargers', LAR: 'Rams', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SF: '49ers', SEA: 'Seahawks', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders', WSH: 'Commanders',
  };
  return map[String(abbr || '').toUpperCase()] || null;
}

function teamToAbbr(team) {
  const clean = String(team || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {
    arizonacardinals: 'ARI', cardinals: 'ARI', ari: 'ARI',
    atlantafalcons: 'ATL', falcons: 'ATL', atl: 'ATL',
    baltimoreravens: 'BAL', ravens: 'BAL', bal: 'BAL',
    buffalobills: 'BUF', bills: 'BUF', buf: 'BUF',
    carolinapanthers: 'CAR', panthers: 'CAR', car: 'CAR',
    chicagobears: 'CHI', bears: 'CHI', chi: 'CHI',
    cincinnatibengals: 'CIN', bengals: 'CIN', cin: 'CIN',
    clevelandbrowns: 'CLE', browns: 'CLE', cle: 'CLE',
    dallascowboys: 'DAL', cowboys: 'DAL', dal: 'DAL',
    denverbroncos: 'DEN', broncos: 'DEN', den: 'DEN',
    detroitlions: 'DET', lions: 'DET', det: 'DET',
    greenbaypackers: 'GB', packers: 'GB', gb: 'GB',
    houstontexans: 'HOU', texans: 'HOU', hou: 'HOU',
    indianapoliscolts: 'IND', colts: 'IND', ind: 'IND',
    jacksonvillejaguars: 'JAX', jaguars: 'JAX', jax: 'JAX',
    kansascitychiefs: 'KC', chiefs: 'KC', kc: 'KC',
    lasvegasraiders: 'LV', raiders: 'LV', lv: 'LV',
    losangeleschargers: 'LAC', chargers: 'LAC', lac: 'LAC',
    losangelesrams: 'LAR', rams: 'LAR', lar: 'LAR',
    miamidolphins: 'MIA', dolphins: 'MIA', mia: 'MIA',
    minnesotavikings: 'MIN', vikings: 'MIN', min: 'MIN',
    newenglandpatriots: 'NE', patriots: 'NE', ne: 'NE',
    neworleanssaints: 'NO', saints: 'NO', no: 'NO',
    newyorkgiants: 'NYG', giants: 'NYG', nyg: 'NYG',
    newyorkjets: 'NYJ', jets: 'NYJ', nyj: 'NYJ',
    philadelphiaeagles: 'PHI', eagles: 'PHI', phi: 'PHI',
    pittsburghsteelers: 'PIT', steelers: 'PIT', pit: 'PIT',
    sanfrancisco49ers: 'SF', '49ers': 'SF', sanfranciscofortyniners: 'SF', fortyniners: 'SF', sf: 'SF',
    seattleseahawks: 'SEA', seahawks: 'SEA', sea: 'SEA',
    tampabaybuccaneers: 'TB', buccaneers: 'TB', tb: 'TB',
    tennesseetitans: 'TEN', titans: 'TEN', ten: 'TEN',
    washingtoncommanders: 'WSH', commanders: 'WSH', washington: 'WSH', was: 'WSH', wsh: 'WSH',
  };
  return map[clean] || String(team || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
}

function normalizeTeamKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\bfootball team\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/^washingtoncommanders$/, 'commanders')
    .replace(/^washington$/, 'commanders')
    .replace(/^wsh$/, 'commanders')
    .replace(/^was$/, 'commanders')
    .replace(/^ne$/, 'patriots')
    .replace(/^sea$/, 'seahawks')
    .replace(/^sf$/, 'fortyniners')
    .replace(/^lar$/, 'rams')
    .replace(/^lac$/, 'chargers')
    .replace(/^jax$/, 'jaguars');
}

function parseMoneylineValue(text) {
  if (text == null || text === '') return null;
  const raw = String(text).trim().toLowerCase();
  if (raw === 'even' || raw === 'ev') return 100;
  const match = raw.match(/[+-]?\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

function parseLineNumber(value) {
  if (value == null || value === '') return null;
  const raw = String(value)
    .replace(/−|–/g, '-')
    .replace(/^pk$/i, '0')
    .replace(/^[ou]\s*/i, '')
    .replace(/[^0-9.+-]/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value = '') {
  return htmlDecode(stripHtml(String(value || ''))).replace(/\s+/g, ' ').trim();
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function htmlDecode(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function squashWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}
