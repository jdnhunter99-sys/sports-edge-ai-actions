import { mapWithConcurrency, fetchWithTimeout } from '../../base44/shared/upstream.ts';

// ScoresAndOdds per-game detail pages: bounded fan-out (see shared/upstream.ts).
const LINE_MOVEMENT_CONCURRENCY = 6;

// base44/functions/fetchMLBLineMovements/entry.ts
// MLB ScoresAndOdds line movement function.
// Built to mirror the working NFL line movement parser, adjusted for /mlb.

export async function fetchMlbLineMovementRequest(req: Request) {
  try {

    const body = await req.json().catch(() => ({}));
    const { gameDate, gameId, mode = 'summary', awayTeam, homeTeam, awayTeamAbbr, homeTeamAbbr } = body || {};

    if (!gameDate) {
      return Response.json({ error: 'Missing gameDate' }, { status: 400 });
    }

    const dateStr = String(gameDate).slice(0, 10);

    if (mode === 'detail' && gameId) {
      const game = await fetchGameDetails(gameId, dateStr);
      return Response.json({ success: true, mode: 'detail', game });
    }

    const pageUrl = `https://www.scoresandodds.com/mlb?date=${encodeURIComponent(dateStr)}`;
    const pageRes = await fetch(pageUrl, {
      headers: getScoresAndOddsHeaders('https://www.scoresandodds.com/mlb'),
    });

    if (!pageRes.ok) {
      return Response.json({ error: `Failed to fetch main page: ${pageRes.status}` }, { status: 500 });
    }

    const html = await pageRes.text();
    const gameIds = extractGameIds(html);

    const debug = {
      status: pageRes.status,
      htmlLength: html.length,
      containsEventCard: html.includes('event-card'),
      containsMlbDot: html.includes('mlb.'),
      containsEventsDetails: html.includes('/mlb/events/'),
      gameIds,
    };

    if (!gameIds.length) {
      return Response.json({
        success: false,
        message: 'No game IDs found on ScoresAndOdds MLB page',
        debug,
        games: [],
      });
    }

    // Targeted mode: match a single game from the board HTML and fetch only its
    // detail page. This avoids scraping all ~10 detail pages (519KB, 9+ seconds)
    // when the caller already knows which game it wants.
    if ((awayTeam || awayTeamAbbr) && (homeTeam || homeTeamAbbr)) {
      const matchedId = matchGameFromBoard(html, gameIds, { awayTeam, homeTeam, awayTeamAbbr, homeTeamAbbr });
      if (matchedId) {
        try {
          const game = await fetchGameDetails(matchedId, dateStr);
          return Response.json({ success: true, mode: 'targeted', debug: { ...debug, matchedGameId: matchedId }, games: [game] });
        } catch (_e) {
          // Fall through to exhaustive fetch on failure
        }
      }
    }

    const games = await mapWithConcurrency(gameIds, LINE_MOVEMENT_CONCURRENCY, async (id) => {
        try {
          return await fetchGameDetails(id, dateStr);
        } catch (error) {
          return {
            gameId: id,
            error: error?.message || String(error),
            moneylineMovement: [],
            spreadMovement: [],
            totalMovement: [],
            movements: { moneyline: [], spread: [], total: [] },
          };
        }
    });

    return Response.json({ success: true, mode: 'summary', debug, games });
  } catch (error) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

function getScoresAndOddsHeaders(referer = 'https://www.scoresandodds.com/mlb') {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
  };
}

function extractGameIds(html) {
  const ids = new Set();
  const patterns = [
    /id=["']mlb\.(\d+)["']/gi,
    /id=["']mlb[-.](\d+)["']/gi,
    /data-event=["']mlb\/(\d+)["']/gi,
    /data-content=["'][^"']*mlb\/(\d+)[^"']*["']/gi,
    /\/mlb\/events\/(\d+)\/details/gi,
    /\/mlb\/events\/(\d+)\/line-movements/gi,
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

function normalizeTeamNameKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function teamsMatch(boardTeam, requestedTeam, requestedAbbr) {
  const boardKey = normalizeTeamNameKey(boardTeam);
  if (!boardKey) return false;
  const reqKey = normalizeTeamNameKey(requestedTeam);
  const reqAbbrKey = normalizeTeamNameKey(requestedAbbr);
  if (reqKey && (boardKey === reqKey || boardKey.includes(reqKey) || reqKey.includes(boardKey))) return true;
  if (reqAbbrKey && (boardKey === reqAbbrKey || boardKey.includes(reqAbbrKey) || reqAbbrKey.includes(boardKey))) return true;
  const boardAbbr = normalizeTeamAbbr(boardTeam);
  const reqAbbrNorm = normalizeTeamAbbr(requestedAbbr || requestedTeam);
  return Boolean(boardAbbr && reqAbbrNorm && boardAbbr === reqAbbrNorm);
}

function extractTeamsNearEventId(html, id) {
  const cleanId = String(id || '').replace(/[^0-9]/g, '');
  if (!cleanId) return { awayTeam: null, homeTeam: null };

  const positions = [];
  const needles = [`mlb.${cleanId}`, `mlb-${cleanId}`, `/mlb/events/${cleanId}/details`, `/mlb/events/${cleanId}/line-movements`, `"id":"${cleanId}"`];
  for (const needle of needles) {
    let index = html.indexOf(needle);
    while (index !== -1) {
      positions.push(index);
      index = html.indexOf(needle, index + needle.length);
    }
  }

  const names = [];
  const add = (value) => {
    const name = cleanText(value);
    if (name && !names.some((n) => normalizeTeamNameKey(n) === normalizeTeamNameKey(name))) names.push(name);
  };

  for (const pos of positions.slice(0, 4)) {
    // Team links appear AFTER the game ID inside the event card. Search a wide
    // forward window — the home team can be 4500+ chars past the card's id.
    const snippet = html.slice(pos, Math.min(html.length, pos + 6000));
    const matches = [...snippet.matchAll(/<a[^>]*href=["']\/mlb\/teams\/[^"']+["'][^>]*aria-label=["']([^"']+)["'][^>]*>/gi)];
    for (const m of matches) add(m[1]);
    if (names.length >= 2) break;
  }

  return { awayTeam: names[0] || null, homeTeam: names[1] || null };
}

function matchGameFromBoard(html, gameIds, { awayTeam, homeTeam, awayTeamAbbr, homeTeamAbbr }) {
  for (const id of gameIds) {
    const teams = extractTeamsNearEventId(html, id);
    if (!teams.awayTeam || !teams.homeTeam) continue;
    if (teamsMatch(teams.awayTeam, awayTeam, awayTeamAbbr) && teamsMatch(teams.homeTeam, homeTeam, homeTeamAbbr)) return id;
    if (teamsMatch(teams.awayTeam, homeTeam, homeTeamAbbr) && teamsMatch(teams.homeTeam, awayTeam, awayTeamAbbr)) return id;
  }
  return null;
}

async function fetchGameDetails(gameId, gameDate) {
  const cleanId = String(gameId || '').replace(/[^0-9]/g, '');
  const detailsUrl = `https://www.scoresandodds.com/mlb/events/${cleanId}/details`;

  const res = await fetchWithTimeout(detailsUrl, {
    headers: {
      ...getScoresAndOddsHeaders(`https://www.scoresandodds.com/mlb?date=${encodeURIComponent(gameDate)}`),
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const parsed = parseMLBLineMovementDetail(html, cleanId, gameDate);

  if (!parsed) {
    return {
      gameId: cleanId,
      gameDate,
      error: 'Line movements table not found',
      moneylineMovement: [],
      spreadMovement: [],
      totalMovement: [],
      movements: { moneyline: [], spread: [], total: [] },
      debug: {
        htmlLength: html.length,
        hasTimeSpreadHeader: /Time\s+Spread\s+Total/i.test(cleanText(html)),
        hasLineMovementsText: /Line\s+Movements/i.test(cleanText(html)),
      },
    };
  }

  return parsed;
}

function parseMLBLineMovementDetail(html, gameId, gameDate) {
  const text = cleanText(html);
  const teams = extractTeamsFromDetail(html, text);
  const awayTeam = normalizeTeamAbbr(teams.awayTeam || teams.awayAbbr || 'AWY');
  const homeTeam = normalizeTeamAbbr(teams.homeTeam || teams.homeAbbr || 'HME');

  let rows = parseLineMovementTableRows(html, { awayAbbr: awayTeam, homeAbbr: homeTeam });

  if (!rows.length) {
    const container = extractLineMovementsContainer(html, gameId);
    if (container) rows = parseLineMovementTableRows(container, { awayAbbr: awayTeam, homeAbbr: homeTeam });
  }

  rows = cleanParsedMovementRows(rows);

  if (!rows.length) return null;

  const moneylineMovement = rows
    .filter((row) => row.awayML != null || row.homeML != null)
    .map((row) => ({
      time: row.time,
      label: formatMovementLabel(row.time),
      awayML: row.awayML,
      homeML: row.homeML,
      away: row.awayML,
      home: row.homeML,
    }));

  const spreadMovement = rows
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

  const totalMovement = rows
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

  const openingAwayProb = americanOddsToImpliedProb(opening?.awayML);
  const currentAwayProb = americanOddsToImpliedProb(current?.awayML);
  const openingHomeProb = americanOddsToImpliedProb(opening?.homeML);
  const currentHomeProb = americanOddsToImpliedProb(current?.homeML);

  const awayPrices = moneylineMovement.map((x) => x.awayML).filter((x) => x != null);
  const homePrices = moneylineMovement.map((x) => x.homeML).filter((x) => x != null);

  return {
    success: true,
    source: 'scoresandodds-detail-html',
    gameId: String(gameId || ''),
    gameDate,
    matchup: `${awayTeam} @ ${homeTeam}`,
    awayTeam,
    homeTeam,
    awayTeamAbbr: awayTeam,
    homeTeamAbbr: homeTeam,

    openingAwayML: opening?.awayML ?? null,
    currentAwayML: current?.awayML ?? null,
    openingHomeML: opening?.homeML ?? null,
    currentHomeML: current?.homeML ?? null,

    openingAwaySpread: opening?.awaySpread ?? null,
    currentAwaySpread: current?.awaySpread ?? null,
    openingHomeSpread: opening?.homeSpread ?? null,
    currentHomeSpread: current?.homeSpread ?? null,
    openingAwaySpreadOdds: opening?.awaySpreadOdds ?? null,
    currentAwaySpreadOdds: current?.awaySpreadOdds ?? null,
    openingHomeSpreadOdds: opening?.homeSpreadOdds ?? null,
    currentHomeSpreadOdds: current?.homeSpreadOdds ?? null,

    openingTotal: opening?.total ?? null,
    currentTotal: current?.total ?? null,
    openingOverOdds: opening?.overOdds ?? null,
    currentOverOdds: current?.overOdds ?? null,
    openingUnderOdds: opening?.underOdds ?? null,
    currentUnderOdds: current?.underOdds ?? null,

    awayProbChange: Number.isFinite(openingAwayProb) && Number.isFinite(currentAwayProb) ? currentAwayProb - openingAwayProb : null,
    homeProbChange: Number.isFinite(openingHomeProb) && Number.isFinite(currentHomeProb) ? currentHomeProb - openingHomeProb : null,
    awayDirection: movementDirection(openingAwayProb, currentAwayProb),
    homeDirection: movementDirection(openingHomeProb, currentHomeProb),
    bestAwayPrice: awayPrices.length ? Math.max(...awayPrices) : null,
    worstAwayPrice: awayPrices.length ? Math.min(...awayPrices) : null,
    bestHomePrice: homePrices.length ? Math.max(...homePrices) : null,
    worstHomePrice: homePrices.length ? Math.min(...homePrices) : null,

    movementCount: rows.length,
    rows,
    movements: { moneyline: moneylineMovement, spread: spreadMovement, total: totalMovement },
    moneylineMovement,
    spreadMovement,
    totalMovement,
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

    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((m) => cleanText(m[1]))
      .filter(Boolean);
    const rowText = squashWhitespace(cells.join(' | '));

    const moneylineMatches = [
      ...rowHtml.matchAll(/<span[^>]*class=["'][^"']*data-moneyline[^"']*["'][^>]*>\s*([+-]?\d+|even|ev)\s*<\/span>/gi),
    ];

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

function parseSpreadFromText(text, { awayAbbr, homeAbbr }) {
  const result = { awaySpread: null, homeSpread: null, awaySpreadOdds: null, homeSpreadOdds: null };

  const teamPattern = String.raw`\b([A-Z]{2,3})\s+([+-]?\d+(?:\.5)?|PK)\s+([+-]\d{2,4})\b`;
  const matches = [...String(text || '').matchAll(new RegExp(teamPattern, 'gi'))];
  if (!matches.length) return result;

  // Prefer the match that names one of this game's teams. This avoids grabbing ML prices.
  const match = matches.find((m) => {
    const side = normalizeTeamAbbr(m[1]);
    return side === awayAbbr || side === homeAbbr;
  }) || matches[0];

  const side = normalizeTeamAbbr(match[1]);
  const line = parseLineNumber(match[2]);
  const odds = parseMoneylineValue(match[3]);
  if (line == null) return result;

  if (side === awayAbbr) {
    result.awaySpread = line;
    result.homeSpread = -line;
    result.awaySpreadOdds = odds;
  } else if (side === homeAbbr) {
    result.homeSpread = line;
    result.awaySpread = -line;
    result.homeSpreadOdds = odds;
  }

  return result;
}

function parseTotalFromText(text) {
  const result = { total: null, overOdds: null, underOdds: null };
  const match = /\b([ou])\s*(\d+(?:\.5)?)\s+([+-]\d{2,4})\b/i.exec(String(text || ''));
  if (!match) return result;

  result.total = parseLineNumber(match[2]);
  const odds = parseMoneylineValue(match[3]);
  if (match[1].toLowerCase() === 'o') result.overOdds = odds;
  if (match[1].toLowerCase() === 'u') result.underOdds = odds;
  return result;
}

function extractLineMovementsContainer(html, gameId) {
  const id = String(gameId || '').replace(/[^0-9]/g, '');
  const startNeedle = `line-movements--${id}`;
  const start = html.indexOf(startNeedle);
  if (start === -1) return '';

  // Do not try to balance divs. Grab a generous window around the movement area.
  // ScoresAndOdds renders the complete movement table shortly after this id.
  return html.slice(Math.max(0, start - 2000), Math.min(html.length, start + 70000));
}

function extractTeamsFromDetail(html, text) {
  const headerMatch = /Time\s+Spread\s+Total\s+([A-Z]{2,3})\s+ML\s+([A-Z]{2,3})\s+ML/i.exec(text || '');
  if (headerMatch) {
    return { awayTeam: normalizeTeamAbbr(headerMatch[1]), homeTeam: normalizeTeamAbbr(headerMatch[2]) };
  }

  const container = extractLineMovementsContainer(html, '');
  const thMatches = [...String(container || html).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cleanText(m[1]));
  const mlHeaders = thMatches.map((x) => x.replace(/\s+ML$/i, '').trim()).filter((x) => /^[A-Z]{2,3}$/.test(x));
  if (mlHeaders.length >= 2) {
    return { awayTeam: normalizeTeamAbbr(mlHeaders[0]), homeTeam: normalizeTeamAbbr(mlHeaders[1]) };
  }

  const names = [];
  const add = (value) => {
    const abbr = normalizeTeamAbbr(value);
    if (abbr && /^[A-Z]{2,3}$/.test(abbr) && !names.includes(abbr)) names.push(abbr);
  };

  const patterns = [
    /<a[^>]*href=["']\/mlb\/teams\/[^"']+["'][^>]*aria-label=["']([^"']+)["'][^>]*>/gi,
    /aria-label=["']([^"']+)["'][^>]*href=["']\/mlb\/teams\/[^"']+["']/gi,
    /<img[^>]*(?:alt|title)=["']([^"']+)["'][^>]*>/gi,
    /(?:teamName|shortName|abbreviation|fullName|displayName)["']?\s*[:=]\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) add(match[1]);
  }

  return { awayTeam: names[0] || 'AWY', homeTeam: names[1] || 'HME' };
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
      prev.total === row.total &&
      prev.awaySpreadOdds === row.awaySpreadOdds &&
      prev.homeSpreadOdds === row.homeSpreadOdds &&
      prev.overOdds === row.overOdds &&
      prev.underOdds === row.underOdds
    ) {
      continue;
    }

    cleaned.push(row);
  }

  return cleaned;
}

function isSportsbookComparisonRow(row) {
  const raw = String(row?.raw || '');
  if (/\b\d{3}\s+[A-Z][A-Za-z]+\b/.test(raw)) return true;

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

function normalizeTeamAbbr(team) {
  if (!team) return '';
  const clean = String(team).trim().toUpperCase().replace(/[^A-Z]/g, '');
  const map = {
    ARI: 'AZ', AZ: 'AZ',
    ATH: 'OAK', OAK: 'OAK', AS: 'OAK',
    CHW: 'CWS', CWS: 'CWS',
    KCR: 'KC', KC: 'KC',
    SFG: 'SF', SF: 'SF',
    SDP: 'SD', SD: 'SD',
    TBR: 'TB', TB: 'TB',
    WSN: 'WSH', WSH: 'WSH', WSHINGTON: 'WSH',
  };
  return map[clean] || clean.slice(0, 3);
}

function americanOddsToImpliedProb(odds) {
  if (!Number.isFinite(Number(odds))) return null;
  const n = Number(odds);
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

function movementDirection(openingProb, currentProb) {
  if (!Number.isFinite(openingProb) || !Number.isFinite(currentProb)) return 'no movement';
  if (currentProb > openingProb) return 'toward favorite';
  if (currentProb < openingProb) return 'toward underdog';
  return 'no movement';
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