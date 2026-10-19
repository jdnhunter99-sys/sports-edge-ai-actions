import { asyncBufferFromUrl, parquetReadObjects } from 'npm:hyparquet@1.24.0';

// Shared NFL game-detail team-stats engine used by the GitHub publisher.
// Derived from the Base44 L5 refresh implementation, including its regular-season
// rolling-window boundary fix. The source calculations remain unchanged.
export const NFL_TEAM_STATS_TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH'];

export async function handleNFLTeamStatsRefresh(req: Request, base44: any) {
  try {
    const input = await req.json().catch(() => ({}));
    const requested = Array.isArray(input?.timeframes) ? input.timeframes : [];
    const timeframes = [...new Set(requested.map((value: unknown) => {
      const raw = String(value || '').trim();
      return /^l(5|10|15)$/i.test(raw) ? raw.toUpperCase() : raw;
    }))];
    if (!timeframes.length || timeframes.some((timeframe: string) =>
      !/^\d{4}$/.test(timeframe) && !['L5', 'L10', 'L15'].includes(timeframe)
    )) {
      return Response.json({ ok: false, error: 'Provide one or more four-digit seasons and/or L5, L10, L15 timeframes.' }, { status: 400 });
    }

    const currentYear = new Date().getFullYear();
    const frames: Array<any> = [];
    const errors: string[] = [];
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < NFL_TEAM_STATS_TEAMS.length; i += 2) {
      pairs.push([NFL_TEAM_STATS_TEAMS[i], NFL_TEAM_STATS_TEAMS[i + 1]]);
    }

    for (const timeframe of timeframes) {
      const statsSeason = resolveRefreshStatsSeason(currentYear, timeframe);
      const scrapedAt = new Date().toISOString();
      const results: Array<any> = [];
      const frameErrors: string[] = [];

      for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
        const [awayAbbr, homeAbbr] = pairs[pairIndex];
        try {
          // The first pair constructs league-wide context. Every remaining
          // matchup in this frame reuses the same in-process context.
          const summary = await buildNFLGameDetailSummary({
            base44,
            season: statsSeason,
            week: 999,
            timeframe,
            awayTeam: awayAbbr,
            homeTeam: homeAbbr,
            awayTeamName: awayAbbr,
            homeTeamName: homeAbbr,
            forceRefresh: pairIndex === 0,
            useInlineStatRankings: false,
          });

          const awayStats = Array.isArray(summary?.awayStats) ? summary.awayStats : [];
          const homeStats = Array.isArray(summary?.homeStats) ? summary.homeStats : [];
          if (!awayStats.length || !homeStats.length) {
            frameErrors.push(`${awayAbbr} @ ${homeAbbr} (${timeframe}): missing team summary stats`);
            continue;
          }

          await writeRefreshTeamStatsRecord(base44, {
            season: statsSeason,
            week: 999,
            timeframe,
            teamAbbr: awayAbbr,
            opponentAbbr: homeAbbr,
            stats: awayStats,
            qbSituationalStats: summary?.qbSituationalStats?.away || [],
            scrapedAt,
          });
          results.push({ team: awayAbbr, statsCount: awayStats.length, gamesUsed: summary?.meta?.awayScheduleGamesUsed ?? null, seasonRanges: summary?.meta?.seasonRanges || null });

          await writeRefreshTeamStatsRecord(base44, {
            season: statsSeason,
            week: 999,
            timeframe,
            teamAbbr: homeAbbr,
            opponentAbbr: awayAbbr,
            stats: homeStats,
            qbSituationalStats: summary?.qbSituationalStats?.home || [],
            scrapedAt,
          });
          results.push({ team: homeAbbr, statsCount: homeStats.length, gamesUsed: summary?.meta?.homeScheduleGamesUsed ?? null, seasonRanges: summary?.meta?.seasonRanges || null });
        } catch (error) {
          frameErrors.push(`${awayAbbr} @ ${homeAbbr} (${timeframe}): ${error?.message || String(error)}`);
        }
      }

      const frame = {
        timeframe,
        season: statsSeason,
        expected_team_count: NFL_TEAM_STATS_TEAMS.length,
        cached_team_count: results.length,
        results,
        errors: frameErrors,
        scraped_at: scrapedAt,
      };
      frames.push(frame);
      errors.push(...frameErrors.map((error) => `${timeframe}: ${error}`));

      // Do not retain the large serialized league context for five separate
      // timeframe frames in one GitHub runner process.
      NFL_LEAGUE_CONTEXT_MEMORY_CACHE.clear();
    }

    const ok = errors.length === 0 && frames.length === timeframes.length &&
      frames.every((frame) => frame.cached_team_count === frame.expected_team_count);
    return Response.json({
      ok,
      sport: 'nfl',
      frames,
      errors,
      timeframes,
      scraped_at: new Date().toISOString(),
      self_contained: true,
      downstream_function_calls: 0,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    return Response.json({
      ok: false,
      sport: 'nfl',
      error: error?.message || String(error),
      self_contained: true,
      downstream_function_calls: 0,
    }, { status: 500 });
  }
}

function refreshWeeklyCacheDate(season: any, week: any) {
  return `nfl_game_detail_team_weekly_${Number(season || 0)}_wk${Number(week || 0)}`;
}

function normalizeRefreshTeam(team: string) {
  const raw = String(team || '').trim().toUpperCase();
  const aliases: Record<string, string> = {
    ARZ:'ARI', ARI:'ARI', ATL:'ATL', BAL:'BAL', BLT:'BAL', BUF:'BUF', CAR:'CAR', CHI:'CHI', CIN:'CIN',
    CLE:'CLE', CLV:'CLE', DAL:'DAL', DEN:'DEN', DET:'DET', GB:'GB', GNB:'GB', HOU:'HOU', IND:'IND',
    JAX:'JAX', JAC:'JAX', KC:'KC', KAN:'KC', LAC:'LAC', SD:'LAC', LAR:'LAR', LA:'LAR', STL:'LAR',
    LV:'LV', OAK:'LV', MIA:'MIA', MIN:'MIN', NE:'NE', NWE:'NE', NO:'NO', NOR:'NO', NYG:'NYG',
    NYJ:'NYJ', PHI:'PHI', PIT:'PIT', SEA:'SEA', SF:'SF', SFO:'SF', TB:'TB', TAM:'TB', TEN:'TEN',
    WAS:'WSH', WSH:'WSH', WFT:'WSH', WDC:'WSH'
  };
  return aliases[raw] || raw;
}

function refreshTeamStatsCacheKey({ season, timeframe, teamAbbr }: any) {
  return `nflverse_team_${Number(season || 0)}_${String(timeframe || 'season')}_${normalizeRefreshTeam(teamAbbr)}`;
}

async function upsertRefreshCacheRecord(base44: any, cacheKey: string, record: any) {
  const existing = await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.filter({ cache_key: cacheKey });
  if (existing?.length) await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.update(existing[0].id, record);
  else await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.create(record);
}

function compactRefreshStats(stats: any[]) {
  return (stats || [])
    .filter((stat) => {
      const value = stat?.displayValue ?? stat?.value;
      return value != null && value !== '' && value !== '—';
    })
    .map((stat) => ({
      name: stat.name,
      value: stat.value,
      displayValue: stat.displayValue,
      rank: stat.rank,
      rankDisplay: stat.rankDisplay,
      leagueTeamsRanked: stat.leagueTeamsRanked,
    }));
}

async function writeRefreshTeamStatsRecord(base44: any, { season, week, timeframe, teamAbbr, opponentAbbr, stats, qbSituationalStats = [], scrapedAt }: any) {
  const cacheKey = refreshTeamStatsCacheKey({ season, timeframe, teamAbbr });
  const compacted = compactRefreshStats(stats);
  const baseRecord: any = {
    cache_date: refreshWeeklyCacheDate(season, week),
    scraped_at: scrapedAt,
    season: Number(season || 0),
    week: Number(week || 0),
    timeframe: String(timeframe || 'season'),
    game_id: '',
    team_abbr: normalizeRefreshTeam(teamAbbr),
    opponent_abbr: normalizeRefreshTeam(opponentAbbr),
    side: 'team',
    source: 'nflverse-team-detail-cache',
  };
  const basePayload: any = {
    teamAbbr: normalizeRefreshTeam(teamAbbr),
    opponentAbbr: normalizeRefreshTeam(opponentAbbr),
    timeframe: String(timeframe || 'season'),
    stats: compacted,
    statsCount: compacted.length,
    qbSituationalStats: Array.isArray(qbSituationalStats) ? qbSituationalStats : [],
  };

  const payloadJson = JSON.stringify(basePayload);
  if (payloadJson.length <= 16000) {
    await upsertRefreshCacheRecord(base44, cacheKey, { ...baseRecord, cache_key: cacheKey, payload: payloadJson });
    // Clear stale split parts from an older larger payload.
    try { await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.deleteMany({ cache_key: `${cacheKey}_p0` }); } catch (_) {}
    try { await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.deleteMany({ cache_key: `${cacheKey}_p1` }); } catch (_) {}
    return;
  }

  const mid = Math.ceil(compacted.length / 2);
  const halves = [compacted.slice(0, mid), compacted.slice(mid)];
  try { await base44.asServiceRole.entities.NFLGameDetailTeamStatsCache.deleteMany({ cache_key: cacheKey }); } catch (_) {}
  for (let i = 0; i < halves.length; i++) {
    const partPayload = { ...basePayload, stats: halves[i], statsCount: halves[i].length, part: i, parts: halves.length };
    const partKey = `${cacheKey}_p${i}`;
    await upsertRefreshCacheRecord(base44, partKey, { ...baseRecord, cache_key: partKey, payload: JSON.stringify(partPayload) });
  }
}

function resolveRefreshStatsSeason(currentYear: number, timeframe: string) {
  const clean = String(timeframe || 'season');
  if (/^\d{4}$/.test(clean)) return Number(clean);
  return new Date().getMonth() < 8 ? currentYear - 1 : currentYear;
}


// Shared NFL league context cache for one Base44 function isolate.
// The expensive part of nflGameDetail is league-wide nflverse PBP/team data, not the matchup itself.
// Cache it by season/week so preloading 16 games does not re-stream the full season 16 times.
const NFL_LEAGUE_CONTEXT_MEMORY_CACHE = new Map();


// ─── Cache TTL logic ────────────────────────────────────────────────────────
// Re-scrape every 15 min normally, every 5 min in the 3-hour window before first pitch
function getCacheTtlMs(games) {
  const now = Date.now();
  const PRE_PITCH_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours
  const NORMAL_TTL = 15 * 60 * 1000;
  const PRE_PITCH_TTL = 5 * 60 * 1000;

  for (const g of games) {
    if (!g.gameTimeIso) continue;
    const firstPitch = new Date(g.gameTimeIso).getTime();
    if (firstPitch > now && firstPitch - now <= PRE_PITCH_WINDOW_MS) {
      return PRE_PITCH_TTL;
    }
  }
  return NORMAL_TTL;
}

// ─── Main handler ───────────────────────────────────────────────────────────

// ─── NFL game-detail summary mode ───────────────────────────────────────────
async function handleNFLGameDetailMode(base44, body) {
  const season = Number(body.season || new Date().getFullYear());
  const week = Number(body.week || body.weekNumber || 1);
  const awayTeam = normalizeNFLTeam(body.awayTeam || body.awayTeamName || body.away_abbr);
  const homeTeam = normalizeNFLTeam(body.homeTeam || body.homeTeamName || body.home_abbr);
  const forceRefresh = Boolean(body.forceRefresh); const timeframe = String(body.timeframe || 'season');
  const cacheDate = getNFLGameDetailWeeklyCacheKey({ season, week });
  const cacheKey = getNFLGameDetailCacheKey({ season, week, timeframe, awayTeam, homeTeam });

  if (!awayTeam || !homeTeam) {
    return Response.json({ error: 'Missing awayTeam/homeTeam for nflGameDetail mode' }, { status: 400 });
  }

  const ttlMs = getNFLCacheTtlMs(season, week);

  if (!forceRefresh) {
    try {
      const cached = await readNFLGameDetailCache(base44, cacheKey);
      if (cached) {
        const age = Date.now() - new Date(cached.record.scraped_at).getTime();
        if (cached.parsed && age < ttlMs) {
          return Response.json({
            found: true,
            fromCache: true,
            scrapedAt: cached.record.scraped_at,
            source: 'nflverse',
            summary: cached.parsed,
            ...cached.parsed,
          });
        }
      }
    } catch (cacheReadErr) {
      // Cache miss/errors should not block the NFL data load.
      console.log('NFL cache read error:', cacheReadErr?.message || cacheReadErr);
    }
  }

  const summary = await buildNFLGameDetailSummary({
    base44,
    season,
    week,
    timeframe,
    awayTeam,
    homeTeam,
    awayTeamName: body.awayTeamName,
    homeTeamName: body.homeTeamName,
    forceRefresh,
  });

  const scrapedAt = new Date().toISOString();

  try {
    const existing = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: cacheDate });
    const payload = {
      cache_date: cacheDate,
      scraped_at: scrapedAt,
      games: [JSON.stringify(compactNFLSummaryForCache(summary))],
      raw_html_length: 0,
      parse_errors: summary?.meta?.note ? [summary.meta.note] : [],
      source: 'nflverse',
    };

    if (existing && existing.length > 0) {
      await base44.asServiceRole.entities.LineupCache.update(existing[0].id, payload);
    } else {
      await base44.asServiceRole.entities.LineupCache.create(payload);
    }

    await writeNFLGameDetailCache(base44, {
      cacheKey,
      cacheDate,
      summary,
      season,
      week,
      timeframe,
      awayTeam,
      homeTeam,
      gameId: body?.gameId || body?.game?.id || '',
    });
  } catch (cacheWriteErr) {
    summary.meta = {
      ...(summary.meta || {}),
      cacheWarning: cacheWriteErr?.message || String(cacheWriteErr),
    };
  }

  return Response.json({
    found: true,
    fromCache: false,
    scrapedAt,
    source: 'nflverse',
    summary,
    ...summary,
  });
}




async function handleNFLPropsOpponentMetricsMode(base44, body) {
  const season = Number(body?.season || new Date().getFullYear());
  const week = Number(body?.week || body?.weekNumber || 18);
  const timeframe = String(body?.timeframe || 'season');

  // The league context is calculated for all 32 clubs regardless of the two
  // matchup teams. These placeholders simply satisfy the existing summary
  // builder without creating 16 separate matchup requests.
  const summary = await buildNFLGameDetailSummary({
    base44,
    season,
    week,
    timeframe,
    awayTeam: 'ARI',
    homeTeam: 'ATL',
    forceRefresh: Boolean(body?.forceRefresh),
    useInlineStatRankings: false,
    includePropsOpponentMetrics: true,
  });

  return Response.json({
    ok: true,
    source: 'nflverse_props_opponent_metrics',
    season: Number(summary?.meta?.statsSeason || summary?.season || season),
    week: Number(summary?.meta?.statsThroughWeek || summary?.week || week),
    generatedAt: summary?.meta?.generatedAt || new Date().toISOString(),
    teams: summary?.propsOpponentMetricsByTeam || {},
    teamCount: Object.keys(summary?.propsOpponentMetricsByTeam || {}).length,
    trackingStatsSource: summary?.meta?.trackingStatsSource || null,
  });
}


// ─── NFL Next Gen Stats mode ────────────────────────────────────────────────
// Public Next Gen Stats statboard helper for table discovery.
// Good first target: passing, which should expose Avg Time To Throw / TTT-style fields.
const NEXT_GEN_BASE = 'https://nextgenstats.nfl.com/api/statboard';

const NEXT_GEN_ALLOWED_STAT_TYPES = new Set([
  'passing',
  'rushing',
  'receiving',
]);

function cleanNextGenStatType(statType) {
  const raw = String(statType || 'passing').trim().toLowerCase();
  const aliases = {
    pass: 'passing',
    passing: 'passing',
    rush: 'rushing',
    rushing: 'rushing',
    rec: 'receiving',
    receiving: 'receiving',
  };

  const cleaned = aliases[raw] || raw;
  if (!NEXT_GEN_ALLOWED_STAT_TYPES.has(cleaned)) {
    throw new Error(`Unsupported Next Gen statType "${statType}". Use passing, rushing, or receiving.`);
  }

  return cleaned;
}

function getNextGenRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.stats)) return data.stats;
  if (Array.isArray(data?.results)) return data.results;

  // NGS sometimes wraps arrays deeper in named keys.
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
          if (Array.isArray(nested)) return nested;
        }
      }
    }
  }

  return [];
}

function flattenNextGenRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;

  const flat = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue && typeof nestedValue === 'object') continue;
        flat[`${key}_${nestedKey}`] = nestedValue;
      }
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

function filterNextGenRows(rows, body) {
  let filtered = rows || [];

  const requestedTeams = (body.teams || body.teamFilter || [])
    .map((t) => normalizeNFLTeam(t))
    .filter(Boolean);

  if (requestedTeams.length) {
    const wanted = new Set(requestedTeams);
    filtered = filtered.filter((row) => {
      const candidates = [
        row.teamAbbr,
        row.team,
        row.teamCode,
        row.team_abbr,
        row.clubCode,
        row.club,
        row.latestTeam,
        row.player_current_team,
        row.teamName,
      ].map((v) => normalizeNFLTeam(v));
      return candidates.some((v) => wanted.has(v));
    });
  }

  return filtered;
}

async function fetchNextGenStats(statType, season, seasonType) {
  const cleanType = cleanNextGenStatType(statType);
  const y = Number(season || new Date().getFullYear());
  const st = String(seasonType || 'REG').trim().toUpperCase();
  const url = `${NEXT_GEN_BASE}/${cleanType}?season=${encodeURIComponent(y)}&seasonType=${encodeURIComponent(st)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'en-US,en;q=0.9',
      referer: `https://nextgenstats.nfl.com/stats/${cleanType}`,
      origin: 'https://nextgenstats.nfl.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    },
  });

  const text = await res.text();

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      url,
      errorPreview: text.slice(0, 800),
    };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      url,
      error: `Next Gen returned non-JSON response: ${err?.message || String(err)}`,
      responsePreview: text.slice(0, 800),
    };
  }

  return {
    ok: true,
    status: res.status,
    url,
    data: json,
  };
}

async function handleNextGenStatsMode(body) {
  const statType = cleanNextGenStatType(body.statType || body.type || body.page || 'passing');
  const season = Number(body.season || body.year || new Date().getFullYear());
  const seasonType = String(body.seasonType || 'REG').trim().toUpperCase();
  const maxRows = Math.max(1, Math.min(Number(body.maxRows || 50), 500));
  const includeRaw = Boolean(body.includeRaw);

  const fetched = await fetchNextGenStats(statType, season, seasonType);
  if (!fetched.ok) {
    return Response.json(
      {
        ok: false,
        source: 'next-gen-stats',
        statType,
        season,
        seasonType,
        ...fetched,
      },
      { status: fetched.status || 502 }
    );
  }

  const rawRows = getNextGenRows(fetched.data);
  const rows = rawRows.map(flattenNextGenRow);
  const filteredRows = filterNextGenRows(rows, body);
  const sample = filteredRows[0] || rows[0] || null;

  return Response.json({
    ok: true,
    source: 'next-gen-stats',
    statType,
    season,
    seasonType,
    url: fetched.url,
    rowCount: rows.length,
    filteredRowCount: filteredRows.length,
    columns: sample ? Object.keys(sample) : [],
    rows: filteredRows.slice(0, maxRows),
    sample,
    raw: includeRaw ? fetched.data : undefined,
  });
}



function compactNFLStatsForCache(stats) {
  // Keep cache small enough for Base44 LineupCache.games.
  // Missing rows naturally display as "—" in the UI, so there is no need to cache placeholders.
  return (stats || [])
    .filter((s) => {
      const v = s?.displayValue ?? s?.value;
      return v != null && v !== '' && v !== '—';
    })
    .map((s) => ({
      name: s.name,
      value: s.value,
      displayValue: s.displayValue,
      rank: s.rank,
      rankDisplay: s.rankDisplay,
      leagueTeamsRanked: s.leagueTeamsRanked,
    }));
}

function compactNFLSummaryForCache(summary) {
  if (!summary) return summary;
  const h2h = summary.h2h
    ? {
        homeRecord: summary.h2h.homeRecord,
        awayRecord: summary.h2h.awayRecord,
        atsRecord: summary.h2h.atsRecord,
        ouRecord: summary.h2h.ouRecord,
        awayLast10: summary.h2h.awayLast10,
        homeLast10: summary.h2h.homeLast10,
        awayH2HRecord: summary.h2h.awayH2HRecord,
        homeH2HRecord: summary.h2h.homeH2HRecord,
        awayAvgMargin: summary.h2h.awayAvgMargin,
        homeAvgMargin: summary.h2h.homeAvgMargin,
        awayAvgCombinedPoints: summary.h2h.awayAvgCombinedPoints,
        homeAvgCombinedPoints: summary.h2h.homeAvgCombinedPoints,
        favoriteATS: summary.h2h.favoriteATS,
        favoriteATSRecord: summary.h2h.favoriteATSRecord,
        underdogATS: summary.h2h.underdogATS,
        underdogATSRecord: summary.h2h.underdogATSRecord,
        overRecord: summary.h2h.overRecord,
        overPct: summary.h2h.overPct,
        underRecord: summary.h2h.underRecord,
        underPct: summary.h2h.underPct,
      }
    : summary.h2h;

  return {
    source: summary.source,
    season: summary.season,
    week: summary.week,
    awayTeam: summary.awayTeam,
    homeTeam: summary.homeTeam,
    awayStats: compactNFLStatsForCache(summary.awayStats),
    homeStats: compactNFLStatsForCache(summary.homeStats),
    h2h,
    matchupAnalyzer: summary.matchupAnalyzer,
    // Coach/QB vs-opponent data is intentionally omitted from cache until that source is wired.
    vsOpponent: emptyVsOpponent(),
    meta: summary.meta,
  };
}

function getNFLGameDetailCacheKey({ season, week, timeframe, awayTeam, homeTeam }) {
  return `nflverse_${Number(season || 0)}_wk${Number(week || 0)}_${String(timeframe || 'season')}_${normalizeNFLTeam(awayTeam)}_${normalizeNFLTeam(homeTeam)}`;
}

function getNFLGameDetailWeeklyCacheKey({ season, week }) {
  return `nfl_game_detail_weekly_${Number(season || 0)}_wk${Number(week || 0)}`;
}

async function readNFLGameDetailCache(base44, cacheKey) {
  try {
    const rows = await base44.asServiceRole.entities.NFLGameDetailCache.filter({ cache_key: cacheKey });
    if (!rows || !rows.length) return null;
    const record = rows[0];
    const parsed = typeof record?.payload === 'string' ? JSON.parse(record.payload) : record?.payload;
    if (!parsed) return null;
    return { record, parsed };
  } catch (_err) {
    return null;
  }
}

async function writeNFLGameDetailCache(base44, { cacheKey, cacheDate, summary, season, week, timeframe, awayTeam, homeTeam, gameId }) {
  if (!cacheKey || !cacheDate || !summary) return;

  const payload = {
    cache_key: cacheKey,
    cache_date: cacheDate,
    scraped_at: new Date().toISOString(),
    season: Number(season || summary?.season || 0),
    week: Number(week || summary?.week || 0),
    timeframe: String(timeframe || 'season'),
    game_id: String(gameId || ''),
    away_team: normalizeNFLTeam(awayTeam || summary?.awayTeam || ''),
    home_team: normalizeNFLTeam(homeTeam || summary?.homeTeam || ''),
    payload: JSON.stringify(compactNFLSummaryForCache(summary)),
    source: 'nflverse',
  };

  const existing = await base44.asServiceRole.entities.NFLGameDetailCache.filter({ cache_key: cacheKey });
  if (existing && existing.length > 0) {
    await base44.asServiceRole.entities.NFLGameDetailCache.update(existing[0].id, payload);
  } else {
    await base44.asServiceRole.entities.NFLGameDetailCache.create(payload);
  }
}

function getNFLCacheTtlMs(season, week) {
  // 6 hours while the current season/week is being developed or refreshed.
  // Older completed season/week summaries can sit much longer.
  const currentYear = new Date().getFullYear();
  if (Number(season) < currentYear) return 7 * 24 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

function normalizeNFLTeam(team) {
  const raw = String(team || '').trim().toUpperCase();
  const aliases = {
    ARZ: 'ARI', ARI: 'ARI', ATL: 'ATL', BAL: 'BAL', BLT: 'BAL', BUF: 'BUF', CAR: 'CAR', CHI: 'CHI', CIN: 'CIN',
    CLE: 'CLE', CLV: 'CLE', DAL: 'DAL', DEN: 'DEN', DET: 'DET', GB: 'GB', GNB: 'GB', HOU: 'HOU', IND: 'IND',
    JAX: 'JAX', JAC: 'JAX', KC: 'KC', KAN: 'KC', LAC: 'LAC', SD: 'LAC', LAR: 'LAR', LA: 'LAR', STL: 'LAR',
    LV: 'LV', OAK: 'LV', MIA: 'MIA', MIN: 'MIN', NE: 'NE', NWE: 'NE', NO: 'NO', NOR: 'NO', NYG: 'NYG',
    NYJ: 'NYJ', PHI: 'PHI', PIT: 'PIT', SEA: 'SEA', SF: 'SF', SFO: 'SF', TB: 'TB', TAM: 'TB', TEN: 'TEN',
    WAS: 'WAS', WSH: 'WAS', WFT: 'WAS', WDC: 'WAS'
  };
  return aliases[raw] || raw;
}


// ─── Build response ─────────────────────────────────────────────────────────
function buildResponse(games, homeTeamName, awayTeamName, scrapedAt, fromCache, gameTimeIso, gamePk, gameNumber) {
  if (homeTeamName && awayTeamName) {
    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const hN = normalize(homeTeamName);
    const aN = normalize(awayTeamName);
    const candidates = games.filter(g =>
      fuzzyTeamMatch(normalize(g.homeTeam), hN) &&
      fuzzyTeamMatch(normalize(g.awayTeam), aN)
    );

    // FantasyPros renders each half of a doubleheader as a separate gamebox.
    // Keep both candidates and order them chronologically so MLB gameNumber 1/2
    // can select the correct card even when FantasyPros and MLB start times differ.
    const orderedCandidates = [...candidates].sort((a, b) => {
      const aTime = a?.gameTimeIso ? new Date(a.gameTimeIso).getTime() : NaN;
      const bTime = b?.gameTimeIso ? new Date(b.gameTimeIso).getTime() : NaN;
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
      if (Number.isFinite(aTime)) return -1;
      if (Number.isFinite(bTime)) return 1;
      return 0;
    });

    let match = orderedCandidates[0] || null;
    let matchedBy = match ? 'team_pair' : null;

    // Use a directly attached gamePk if FantasyPros ever exposes one.
    if (gamePk) {
      const exact = orderedCandidates.find((candidate) => String(candidate.gamePk || '') === String(gamePk));
      if (exact) {
        match = exact;
        matchedBy = 'game_pk';
      }
    }

    // Start time is the strongest identifier currently available on the lineup page.
    // Do not require the old 45-minute cutoff: postponed/rescheduled doubleheaders
    // can have slightly different listed times between MLB and FantasyPros.
    if (matchedBy !== 'game_pk' && orderedCandidates.length > 1 && gameTimeIso) {
      const target = new Date(gameTimeIso).getTime();
      if (Number.isFinite(target)) {
        let best = null;
        let bestDelta = Infinity;
        for (const candidate of orderedCandidates) {
          const candidateTime = candidate.gameTimeIso ? new Date(candidate.gameTimeIso).getTime() : NaN;
          if (!Number.isFinite(candidateTime)) continue;
          const delta = Math.abs(candidateTime - target);
          if (delta < bestDelta) {
            best = candidate;
            bestDelta = delta;
          }
        }
        if (best) {
          match = best;
          matchedBy = 'start_time';
        }
      }
    }

    // gameNumber is a deterministic fallback and also handles callers that lack
    // a reliable ISO start time. MLB uses 1 for the opener and 2 for the nightcap.
    if (matchedBy !== 'game_pk' && matchedBy !== 'start_time' && orderedCandidates.length > 1) {
      const requestedGameNumber = Number(gameNumber);
      if (Number.isInteger(requestedGameNumber) && requestedGameNumber >= 1) {
        const byGameNumber = orderedCandidates[requestedGameNumber - 1];
        if (byGameNumber) {
          match = byGameNumber;
          matchedBy = 'game_number';
        }
      }
    }

    if (match) {
      const candidateIndex = orderedCandidates.indexOf(match);
      return Response.json({
        found: true,
        fromCache,
        scrapedAt,
        source: 'fantasypros',
        matchedBy,
        matchedGameNumber: candidateIndex >= 0 ? candidateIndex + 1 : null,
        candidateCount: orderedCandidates.length,
        ...match,
      });
    }
    return Response.json({ found: false, homeLineup: [], awayLineup: [], fromCache, scrapedAt, source: 'fantasypros' });
  }
  return Response.json({ scrapedAt, fromCache, source: 'fantasypros', games });
}

async function handleProbablePitchersMode(base44, body) {
  const today = new Date().toISOString().slice(0, 10);
  const { homeTeamName, awayTeamName, homeAbbr, awayAbbr, gameTimeIso, gamePk, gameNumber, forceRefresh } = body;

  if (!forceRefresh) {
    try {
      const cached = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: `probable_pitchers_${today}` });
      if (cached && cached.length > 0) {
        const record = cached[0];
        const ttl = getCacheTtlMs(record.games || []);
        const age = Date.now() - new Date(record.scraped_at).getTime();
        if (age < ttl) {
          return await buildProbablePitcherResponse(record.games || [], homeTeamName, awayTeamName, homeAbbr, awayAbbr, gameTimeIso, gamePk, gameNumber, record.scraped_at, true);
        }
      }
    } catch {}
  }

  const res = await fetch('https://www.fantasypros.com/mlb/probable-pitchers.php', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.fantasypros.com/',
    }
  });

  if (!res.ok) {
    return Response.json({ error: `FantasyPros probable pitchers fetch failed: ${res.status}` }, { status: 502 });
  }

  const html = await res.text();
  const games = parseProbablePitchersHtml(html);
  const scrapedAt = new Date().toISOString();

  try {
    const existing = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: `probable_pitchers_${today}` });
    const payload = {
      cache_date: `probable_pitchers_${today}`,
      scraped_at: scrapedAt,
      games,
      raw_html_length: html.length,
      parse_errors: [],
      source: 'fantasypros_probable_pitchers',
    };
    if (existing && existing.length > 0) await base44.asServiceRole.entities.LineupCache.update(existing[0].id, payload);
    else await base44.asServiceRole.entities.LineupCache.create(payload);
  } catch {}

  return await buildProbablePitcherResponse(games, homeTeamName, awayTeamName, homeAbbr, awayAbbr, gameTimeIso, gamePk, gameNumber, scrapedAt, false);
}

function parseProbablePitchersHtml(html) {
  const rows = [];
  const teamNameMap = new Map([
    ['arizonadiamondbacks', 'Arizona Diamondbacks'],
    ['atlantabraves', 'Atlanta Braves'],
    ['baltimoreorioles', 'Baltimore Orioles'],
    ['bostonredsox', 'Boston Red Sox'],
    ['chicagocubs', 'Chicago Cubs'],
    ['chicagowhitesox', 'Chicago White Sox'],
    ['cincinnatireds', 'Cincinnati Reds'],
    ['clevelandguardians', 'Cleveland Guardians'],
    ['coloradorockies', 'Colorado Rockies'],
    ['detroittigers', 'Detroit Tigers'],
    ['houstonastros', 'Houston Astros'],
    ['kansascityroyals', 'Kansas City Royals'],
    ['losangelesangels', 'Los Angeles Angels'],
    ['losangelesdodgers', 'Los Angeles Dodgers'],
    ['miamimarlins', 'Miami Marlins'],
    ['milwaukeebrewers', 'Milwaukee Brewers'],
    ['minnesotatwins', 'Minnesota Twins'],
    ['newyorkmets', 'New York Mets'],
    ['newyorkyankees', 'New York Yankees'],
    ['oaklandathletics', 'Oakland Athletics'],
    ['philadelphiaphillies', 'Philadelphia Phillies'],
    ['pittsburghpirates', 'Pittsburgh Pirates'],
    ['sandiegopadres', 'San Diego Padres'],
    ['sanfranciscogiants', 'San Francisco Giants'],
    ['seattlemariners', 'Seattle Mariners'],
    ['stlouiscardinals', 'St. Louis Cardinals'],
    ['tampabayrays', 'Tampa Bay Rays'],
    ['texasrangers', 'Texas Rangers'],
    ['torontobluejays', 'Toronto Blue Jays'],
    ['washingtonnationals', 'Washington Nationals'],
  ]);

  const abbrMap = {
    ARI: 'Arizona Diamondbacks', ATL: 'Atlanta Braves', BAL: 'Baltimore Orioles', BOS: 'Boston Red Sox', CHC: 'Chicago Cubs',
    CWS: 'Chicago White Sox', CIN: 'Cincinnati Reds', CLE: 'Cleveland Guardians', COL: 'Colorado Rockies', DET: 'Detroit Tigers',
    HOU: 'Houston Astros', KC: 'Kansas City Royals', LAA: 'Los Angeles Angels', LAD: 'Los Angeles Dodgers', MIA: 'Miami Marlins',
    MIL: 'Milwaukee Brewers', MIN: 'Minnesota Twins', NYM: 'New York Mets', NYY: 'New York Yankees', OAK: 'Oakland Athletics',
    ATH: 'Oakland Athletics', PHI: 'Philadelphia Phillies', PIT: 'Pittsburgh Pirates', SD: 'San Diego Padres', SF: 'San Francisco Giants',
    SEA: 'Seattle Mariners', STL: 'St. Louis Cardinals', TB: 'Tampa Bay Rays', TEX: 'Texas Rangers', TOR: 'Toronto Blue Jays', WSH: 'Washington Nationals'
  };

  const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const normalize = (s) => clean(s).toLowerCase().replace(/[^a-z]/g, '');
  const findTeamName = (raw) => teamNameMap.get(normalize(raw)) || null;

  const tableMatches = [...html.matchAll(/<tr>\s*<td class="sticky">[\s\S]*?<\/tr>/gi)];

  for (const trMatch of tableMatches) {
    const trHtml = trMatch[0];
    const teamMatch = trHtml.match(/<td class="sticky"><strong><a[^>]*>([\s\S]*?)<\/a><\/strong><\/td>/i);
    const teamName = findTeamName(teamMatch ? teamMatch[1] : '');
    if (!teamName) continue;

    const cellMatches = [...trHtml.matchAll(/<div[^>]*class="player-cell"[^>]*data-loc="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="player-cell"|<\/td>|<\/tr>)/gi)];
    for (const cellMatch of cellMatches) {
      const loc = cellMatch[1];
      const cellHtml = cellMatch[2];
      const opponentMatch = cellHtml.match(/<strong>\s*([^<]+?)\s*<\/strong>/i);
      const pitcherMatch = cellHtml.match(/<a class="player-name"[^>]*>([^<]+)<\/a>/i);
      const isTbd = />\s*TBD\s*<\/td>/i.test(cellHtml) || /<br\s*\/?>\s*TBD/i.test(cellHtml);
      if (!opponentMatch) continue;

      const opponentRaw = clean(opponentMatch[1]).replace(/^@/, '');
      const opponent = abbrMap[opponentRaw.toUpperCase()] || findTeamName(opponentRaw) || opponentRaw;
      const pitcher = pitcherMatch ? clean(pitcherMatch[1]) : (isTbd ? 'TBD' : '');
      if (!pitcher && !isTbd) continue;

      const existing = rows.filter((r) => r.team === teamName && r.opponent === opponent);
      rows.push({
        team: teamName,
        opponent,
        pitcher: pitcher === 'TBD' ? null : pitcher,
        loc,
        gameIndex: existing.length + 1,
      });
    }
  }

  return rows;
}

async function buildProbablePitcherResponse(rows, homeTeamName, awayTeamName, homeAbbr, awayAbbr, gameTimeIso, gamePk, gameNumber, scrapedAt, fromCache) {
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const hN = normalize(homeTeamName);
  const aN = normalize(awayTeamName);
  const candidates = rows.filter((row) =>
    (normalize(row.team) === hN && normalize(row.opponent) === aN) ||
    (normalize(row.team) === aN && normalize(row.opponent) === hN)
  );

  const pick = (teamName, opponentName, expectedLoc) => {
    const matches = rows.filter((row) => {
      const teamMatches = normalize(row.team) === normalize(teamName);
      const opponentMatches = normalize(row.opponent) === normalize(opponentName);
      const locMatches = expectedLoc ? String(row.loc || '').toLowerCase() === expectedLoc : true;
      return teamMatches && opponentMatches && locMatches;
    });

    if (!matches.length) return null;

    // Doubleheaders must never fall back from Game 2 to Game 1. If the
    // requested occurrence does not exist in the FantasyPros rows, return
    // null so the caller keeps the starter as TBD.
    if (Number(gameNumber) > 0) {
      const exactIndex = Number(gameNumber) - 1;
      if (matches[exactIndex]) return matches[exactIndex];
      return null;
    }

    return matches[0] || null;
  };

  const away = pick(awayTeamName, homeTeamName, 'visitor') || pick(awayTeamName, homeTeamName, null);
  const home = pick(homeTeamName, awayTeamName, 'home') || pick(homeTeamName, awayTeamName, null);
  const awayFullName = away ? await resolveProjectedPitcherFullName(away.pitcher, awayAbbr, away.team) : null;
  const homeFullName = home ? await resolveProjectedPitcherFullName(home.pitcher, homeAbbr, home.team) : null;

  return Response.json({
    found: Boolean(away || home),
    fromCache,
    scrapedAt,
    source: 'fantasypros_probable_pitchers',
    awayPitcher: away ? { name: awayFullName || away.pitcher || null, fullName: awayFullName || away.pitcher || null, gameIndex: away.gameIndex, status: away.pitcher ? 'projected' : 'tbd' } : { name: null, fullName: null, status: 'tbd' },
    homePitcher: home ? { name: homeFullName || home.pitcher || null, fullName: homeFullName || home.pitcher || null, gameIndex: home.gameIndex, status: home.pitcher ? 'projected' : 'tbd' } : { name: null, fullName: null, status: 'tbd' },
    candidates,
  });
}

function fuzzyTeamMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Match on last 6 chars (usually city+name combo works)
  const len = Math.min(a.length, b.length, 6);
  return a.slice(-len) === b.slice(-len) || a.includes(b.slice(-5)) || b.includes(a.slice(-5));
}

// ─── Parse a single gamebox block ───────────────────────────────────────────
function parseGamebox(box) {
  // Away team
  const visitorInfoEnd = box.indexOf('<div class="at-sign');
  const visitorBlock = visitorInfoEnd > 0 ? box.slice(0, visitorInfoEnd) : box.slice(0, box.length / 2);
  const awayTeam = extractText(visitorBlock, /<div class="visitor-info[\s\S]*?<h4[^>]*><a[^>]*>([^<]+)<\/a>/i);
  const awayStatus = extractText(visitorBlock, /class="pull-right"[^>]*>([^<]+)<\/span>/i);
  const awayPitcher = parsePitcher(visitorBlock);

  // Home team
  const homeInfoIdx = box.indexOf('<div class="home-info');
  const homeBlock = homeInfoIdx >= 0 ? box.slice(homeInfoIdx) : '';
  const homeTeam = extractText(homeBlock, /<h4[^>]*><a[^>]*>([^<]+)<\/a>/i);
  const homeStatus = extractText(homeBlock, /class="pull-right"[^>]*>([^<]+)<\/span>/i);
  const homePitcher = parsePitcher(homeBlock);

  // Game time
  const isoTimeMatch = box.match(/data-isotime="([^"]+)"/i);
  const gameTimeIso = isoTimeMatch ? isoTimeMatch[1] : '';
  const gameTime = gameTimeIso
    ? new Date(gameTimeIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' })
    : '';

  // Venue
  const venueMatch = box.match(/class="venue-name"[^>]*(?:title="([^"]+)"[^>]*>|>([^<]*))/i);
  const venue = venueMatch ? (venueMatch[1] || venueMatch[2] || '').trim() : '';

  // Weather
  const weather = parseWeather(box);

  // Lineups — two team-table tables per gamebox
  const tables = extractTables(box);
  const awayLineup = tables[0] ? parseLineupTable(tables[0]) : [];
  const homeLineup = tables[1] ? parseLineupTable(tables[1]) : [];

  return {
    awayTeam,
    homeTeam,
    awayStatus: awayStatus || 'Projected Lineup',
    homeStatus: homeStatus || 'Projected Lineup',
    awayPitcher,
    homePitcher,
    gameTime,
    gameTimeIso,
    venue,
    weather,
    awayLineup,
    homeLineup,
  };
}

// ─── Extract starting pitcher info ──────────────────────────────────────────
function parsePitcher(block) {
  const nameMatch = block.match(/fp-player-name="([^"]+)"/i);
  const name = nameMatch ? nameMatch[1].trim() : '';

  const idMatch = block.match(/\bfp-id-(\d+)\b/i);
  const fantasyProsId = idMatch ? idMatch[1] : '';

  // Extract throws and details from <small> tag after fp-player-link
  const smallMatch = block.match(/fp-player-link[^>]*>[^<]*<\/a><br[^>]*><small>([^<]*)<\/small>/i);
  const details = smallMatch ? smallMatch[1].trim() : '';

  // Parse throws: look for RHP or LHP in details
  const throwsMatch = details.match(/\b(RHP|LHP)\b/i);
  const throws_ = throwsMatch ? throwsMatch[1].toUpperCase() : '';

  return { name, fantasyProsId, throws: throws_, details };
}

const MLB_TEAM_ID_BY_ABBR = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, KCR: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133, PHI: 143,
  PIT: 134, SD: 135, SDP: 135, SEA: 136, SF: 137, SFG: 137, STL: 138, TB: 139,
  TBR: 139, TEX: 140, TOR: 141, WSH: 120, WSN: 120, AZ: 109
};

function normalizePlayerName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitProjectedPitcherName(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length < 2) return { initial: null, lastName: null };
  const first = parts[0];
  const lastName = parts.slice(1).join(' ');
  const initialMatch = first.match(/^([a-z])/i);
  return {
    initial: initialMatch ? initialMatch[1].toLowerCase() : null,
    lastName,
  };
}

async function resolveProjectedPitcherFullName(projectedName, teamAbbr, teamName) {
  const cleaned = String(projectedName || '').trim();
  if (!cleaned || /^tbd$/i.test(cleaned)) return null;

  const searchResults = [];
  const pushPeople = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.people)) searchResults.push(...data.people);
    } catch {}
  };

  await pushPeople(`https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(cleaned)}&sportIds=1`);

  const teamId = MLB_TEAM_ID_BY_ABBR[String(teamAbbr || '').trim().toUpperCase()] || null;
  if (teamId) {
    try {
      const rosterRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&season=${new Date().getFullYear()}`);
      if (rosterRes.ok) {
        const rosterData = await rosterRes.json();
        const rosterPeople = Array.isArray(rosterData?.roster)
          ? rosterData.roster.map((entry) => ({
              id: entry?.person?.id,
              fullName: entry?.person?.fullName,
              active: true,
              primaryPosition: { abbreviation: entry?.position?.abbreviation || entry?.position?.code || 'P' },
            }))
          : [];
        searchResults.push(...rosterPeople);
      }
    } catch {}
  }

  const uniquePeople = searchResults.filter((person, index, arr) => {
    const key = `${person?.id || ''}:${person?.fullName || ''}`;
    return index === arr.findIndex((item) => `${item?.id || ''}:${item?.fullName || ''}` === key);
  });
  if (!uniquePeople.length) return cleaned;

  const pitchers = uniquePeople.filter((p) => {
    const position = String(p.primaryPosition?.abbreviation || p.primaryPosition?.code || '').toUpperCase();
    return position === 'P' || position === '1';
  });
  const pool = pitchers.length ? pitchers : uniquePeople;

  const wanted = normalizePlayerName(cleaned);
  const exact = pool.find((p) => normalizePlayerName(p.fullName) === wanted);
  if (exact?.fullName) return exact.fullName;

  const { initial, lastName } = splitProjectedPitcherName(cleaned);
  if (initial && lastName) {
    const lastWanted = normalizePlayerName(lastName);
    const initialMatch = pool.find((p) => {
      const fullParts = String(p.fullName || '').split(/\s+/).filter(Boolean);
      if (fullParts.length < 2) return false;
      const pInitial = fullParts[0]?.[0]?.toLowerCase() || '';
      const pLast = normalizePlayerName(fullParts.slice(1).join(' '));
      return pInitial === initial && pLast === lastWanted;
    });
    if (initialMatch?.fullName) return initialMatch.fullName;
  }

  const lastOnlyMatches = pool.filter((p) => {
    const fullParts = String(p.fullName || '').split(/\s+/).filter(Boolean);
    if (fullParts.length < 2) return false;
    return normalizePlayerName(fullParts.slice(1).join(' ')) === normalizePlayerName(lastName || cleaned);
  });
  if (lastOnlyMatches.length === 1 && lastOnlyMatches[0]?.fullName) return lastOnlyMatches[0].fullName;

  const active = pool.find((p) => p.active && p.fullName);
  if (active?.fullName) return active.fullName;

  return pool[0]?.fullName || cleaned;
}

// ─── Extract all team-table HTML blocks from a gamebox ───────────────────────
function extractTables(box) {
  const tables = [];
  const marker = '<table class="table table-full team-table">';
  let searchFrom = 0;
  while (true) {
    const start = box.indexOf(marker, searchFrom);
    if (start === -1) break;
    const end = box.indexOf('</table>', start);
    if (end === -1) break;
    tables.push(box.slice(start, end + 8));
    searchFrom = end + 8;
  }
  return tables;
}

// ─── Parse one team-table into a lineup array ────────────────────────────────
function parseLineupTable(tableHtml) {
  // FantasyPros uses unclosed <tbody> — extract from <tbody> to </table>
  let rowsHtml = tableHtml;
  const tbodyIdx = tableHtml.indexOf('<tbody');
  if (tbodyIdx >= 0) {
    rowsHtml = tableHtml.slice(tbodyIdx);
  }
  // Strip any explicit closing tbody if it exists
  rowsHtml = rowsHtml.replace(/<\/tbody>/gi, '');

  const players = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(rowsHtml)) !== null) {
    const rowHtml = rowMatch[1];

    const nameMatch = rowHtml.match(/fp-player-name="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const fpIdMatch = rowHtml.match(/\bfp-id-(\d+)\b/i);
    const fantasyProsId = fpIdMatch ? fpIdMatch[1] : '';

    const urlMatch = rowHtml.match(/href="(\/mlb\/players\/[^"]+)"/i);
    const playerUrl = urlMatch ? `https://www.fantasypros.com${urlMatch[1]}` : '';

    // Position is in <small> inside the player-cell td
    const posMatch = rowHtml.match(/<small>\s*\(([^)]+)\)\s*<\/small>/i);
    const position = posMatch ? posMatch[1].trim() : '';

    // Get all <td> values (stripped)
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]).trim());

    // Specific stat cells by class
    const avgMatch = rowHtml.match(/class="[^"]*\bavg\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const splitsMatch = rowHtml.match(/class="[^"]*\bsplits\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const wobaMatch = rowHtml.match(/class="[^"]*\bwoba\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);

    players.push({
      battingOrder: tds[0] || String(players.length + 1),
      name,
      fantasyProsId,
      playerUrl,
      position,
      bats: tds[2] || '',
      avg: avgMatch ? stripTags(avgMatch[1]).trim() : '',
      splitAvg: splitsMatch ? stripTags(splitsMatch[1]).trim() : '',
      woba: wobaMatch ? stripTags(wobaMatch[1]).trim() : '',
    });
  }

  return players;
}

// ─── Parse weather from .game-details block ──────────────────────────────────
function parseWeather(box) {
  const detailsMatch = box.match(/class="[^"]*game-details[^"]*"[^>]*>([\s\S]*?)(?=<div class="team-list)/i);
  if (!detailsMatch) return { tempF: '', precipChance: '', windMph: '', windDirectionDegrees: '' };

  const weatherText = detailsMatch[1];

  // Temperature: number near "°F"
  const tempMatch = weatherText.match(/(\d+)\s*°\s*F/i) || weatherText.match(/(\d+)&deg;F/i);
  const tempF = tempMatch ? tempMatch[1] : '';

  // Precipitation: .pop or text pattern
  const popMatch = weatherText.match(/class="[^"]*pop[^"]*"[^>]*>([^<]+)</i) ||
                   weatherText.match(/(\d+)\s*%\s*(?:chance|precip)/i);
  const precipChance = popMatch ? popMatch[1].trim() : '';

  // Wind speed: number before "mph"
  const windMatch = weatherText.match(/(\d+)\s*mph/i);
  const windMph = windMatch ? windMatch[1] : '';

  // Wind direction from SVG rotate transform
  const rotateMatch = weatherText.match(/rotate\(([^)]+)\)/i);
  const windDirectionDegrees = rotateMatch ? rotateMatch[1].trim() : '';

  return { tempF, precipChance, windMph, windDirectionDegrees };
}

// ─── Utility: split HTML by <div class="exactClass"> ────────────────────────
function splitByClass(html, className) {
  const marker = `<div class="${className}"`;
  const indices = [];
  let idx = 0;
  while (true) {
    const found = html.indexOf(marker, idx);
    if (found === -1) break;
    indices.push(found);
    idx = found + 1;
  }
  if (indices.length === 0) return [];
  return indices.map((start, i) => {
    const end = i + 1 < indices.length ? indices[i + 1] : html.length;
    return html.slice(start, end);
  });
}

// ─── Utility: extract text via regex match ───────────────────────────────────
function extractText(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim() : '';
}

// ─── Utility: strip HTML tags + decode entities ──────────────────────────────
function stripTags(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// Inline nflverse helper. Base44 was not bundling local lib/nflverse.ts imports.
// This version avoids full-season play-by-play downloads in serverless mode.
// It uses nflverse team weekly stats + schedules, which is much lighter and
// prevents Base44 worker OOM/timeouts that show up as "user-exception".
// ─────────────────────────────────────────────────────────────────────────────


// ─── ESPN NFL trench win rates ──────────────────────────────────────────────
// ESPN embeds the team PBWR/RBWR/PRWR/RSWR table directly in this free article.
// We fetch and parse it once per NFL game-detail request, then place the values
// into the existing stat rows that already exist in the Offense/Defense tabs.
const ESPN_WIN_RATE_URLS = {
  2025: 'https://www.espn.com/nfl/story/_/id/46138675/2025-nfl-win-rates-top-teams-players-rankings-pass-run-block',
  2024: 'https://www.espn.com/nfl/story/_/id/41040723/2024-nfl-win-rates-top-teams-players-rankings',
};

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function makeEmptyEspnWinRate(team) {
  return {
    team: normalizeTeam(team),
    passBlockWinRate: null,
    runBlockWinRate: null,
    passRushWinRate: null,
    runStopWinRate: null,
    source: 'espn_win_rates',
  };
}

function setEspnWinRateMetric(map, team, key, value) {
  const abbr = normalizeTeam(team);
  const n = Number(String(value ?? '').replace('%', '').trim());
  if (!abbr || !Number.isFinite(n)) return;
  const current = map.get(abbr) || makeEmptyEspnWinRate(abbr);
  current[key] = n;
  map.set(abbr, current);
}

function parseEspnTeamWinRatesTable(html) {
  const map = new Map();
  const tableMatch = String(html || '').match(/<h2[^>]*>\s*NFL team win rate rankings\s*<\/h2>[\s\S]*?<table[\s\S]*?<tbody>([\s\S]*?)<\/tbody>[\s\S]*?<\/table>/i);
  if (!tableMatch) return map;

  const tbody = tableMatch[1];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRegex.exec(tbody)) !== null) {
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cell;
    while ((cell = cellRegex.exec(row[1])) !== null) cells.push(cell[1]);
    if (cells.length < 5) continue;

    const hrefTeam = String(cells[0]).match(/\/nfl\/team\/_\/name\/([a-z]{2,3})\//i)?.[1];
    const team = normalizeTeam(hrefTeam || stripHtml(cells[0]));
    if (!team) continue;

    setEspnWinRateMetric(map, team, 'passRushWinRate', stripHtml(cells[1]).match(/\d+(?:\.\d+)?/)?.[0]);
    setEspnWinRateMetric(map, team, 'runStopWinRate', stripHtml(cells[2]).match(/\d+(?:\.\d+)?/)?.[0]);
    setEspnWinRateMetric(map, team, 'passBlockWinRate', stripHtml(cells[3]).match(/\d+(?:\.\d+)?/)?.[0]);
    setEspnWinRateMetric(map, team, 'runBlockWinRate', stripHtml(cells[4]).match(/\d+(?:\.\d+)?/)?.[0]);
  }

  return map;
}

async function loadEspnWinRates(season) {
  const years = Object.keys(ESPN_WIN_RATE_URLS).map(Number);
  const fallbackYear = Math.max(...years);
  const url = ESPN_WIN_RATE_URLS[Number(season)] || ESPN_WIN_RATE_URLS[fallbackYear];
  const html = await fetchText(url);
  const map = parseEspnTeamWinRatesTable(html);
  return {
    source: 'espn_win_rates',
    url,
    parsedTeams: map.size,
    metrics: map,
  };
}

function applyEspnWinRatesToStats(stats, rates) {
  if (!rates || !Array.isArray(stats)) return stats;
  setStatValue(stats, 'passBlockWinRate', rates.passBlockWinRate, 1, '%');
  setStatValue(stats, 'runBlockWinRate', rates.runBlockWinRate, 1, '%');
  setStatValue(stats, 'passRushWinRate', rates.passRushWinRate, 1, '%');
  setStatValue(stats, 'runStopRate', rates.runStopWinRate, 1, '%');
  return stats;
}


// ─── StatRankings authenticated team metrics ───────────────────────────────
// Uses the same STATRANKINGS_COOKIE secret as your standalone StatRankings function.
// These definitions target stats already present in the NFL Offense, Defense,
// and Special Teams comparison components. Failed pages are skipped safely.
const STATRANKINGS_BASE = 'https://statrankings.com/nfl';

const STATRANKINGS_DEFINITIONS = [
  { id: 'epaPerPlay', path: '/advanced/teams/epa/epa-per-play', targets: [{ name: 'epaPerPlay', decimals: 3 }, { name: 'offensiveEpaPerPlay', decimals: 3 }] },
  { id: 'passEpaPerPlay', path: '/advanced/teams/epa/epa-per-play-passing', targets: [{ name: 'passEpaPerPlay', decimals: 3 }, { name: 'passingEpaPerPlay', decimals: 3 }] },
  { id: 'rushEpaPerPlay', path: '/advanced/teams/epa/epa-per-play-rushing', targets: [{ name: 'rushEpaPerPlay', decimals: 3 }, { name: 'rushingEpaPerPlay', decimals: 3 }] },
  { id: 'successRate', path: '/advanced/teams/epa/success-rate', targets: [{ name: 'successRate', decimals: 1, suffix: '%' }, { name: 'offensiveSuccessRate', decimals: 1, suffix: '%' }] },
  { id: 'passSuccessRate', path: '/advanced/teams/epa/success-rate-passing', targets: [{ name: 'passSuccessRate', decimals: 1, suffix: '%' }, { name: 'passingSuccessRate', decimals: 1, suffix: '%' }] },
  { id: 'rushSuccessRate', path: '/advanced/teams/epa/success-rate-rushing', targets: [{ name: 'rushSuccessRate', decimals: 1, suffix: '%' }, { name: 'rushingSuccessRate', decimals: 1, suffix: '%' }] },
  { id: 'explosivePassRate', path: '/advanced/teams/passing/explosive-play-rate', targets: [{ name: 'explosivePassRate', decimals: 1, suffix: '%' }, { name: 'explosivePassPct', decimals: 1, suffix: '%' }] },
  { id: 'dropPct', path: '/advanced/teams/passing/drop-percentage', targets: [{ name: 'dropPct', decimals: 1, suffix: '%' }] },
  { id: 'passesDropped', path: '/advanced/teams/passing/passes-dropped', targets: [{ name: 'passesDropped', decimals: 0 }] },
  { id: 'passYardsAfterCatch', path: '/advanced/teams/passing/pass-yards-after-catch', targets: [{ name: 'passYardsAfterCatch', decimals: 0 }] },
  { id: 'yardsBeforeContact', path: '/advanced/teams/rushing/yards-before-contact', targets: [{ name: 'yardsBeforeContact', decimals: 2 }, { name: 'rushYardsBeforeContact', decimals: 2 }] },
  { id: 'yardsAfterContact', path: '/advanced/teams/rushing/yards-after-contact', targets: [{ name: 'yardsAfterContact', decimals: 0 }] },
  { id: 'avoidedTackleRate', path: '/advanced/teams/rushing/avoided-tackle-rate', targets: [{ name: 'avoidedTackleRate', decimals: 1, suffix: '%' }] },
  { id: 'avoidedTackles', path: '/advanced/teams/rushing/avoided-tackles', targets: [{ name: 'avoidedTackles', decimals: 0 }] },
  { id: 'powerSuccessRate', path: '/advanced/teams/trench-play/power-success-rate', targets: [{ name: 'powerSuccessRate', decimals: 1, suffix: '%' }] },
  { id: 'stuffRate', path: '/advanced/teams/trench-play/stuff-rate', targets: [{ name: 'stuffRate', decimals: 1, suffix: '%' }] },
  { id: 'offensiveArby', path: '/advanced/teams/trench-play/offensive-arby', targets: [{ name: 'offensiveARBY', decimals: 2 }] },
  { id: 'defensiveArby', path: '/advanced/teams/trench-play/defensive-arby', targets: [{ name: 'defensiveARBY', decimals: 2 }] },
  { id: 'havocRate', path: '/advanced/teams/trench-play/havoc-rate', targets: [{ name: 'havocRate', decimals: 1, suffix: '%' }] },
  { id: 'blitzRate', path: '/advanced/teams/defense/blitz-rate', targets: [{ name: 'blitzRate', decimals: 1, suffix: '%' }, { name: 'blitzPct', decimals: 1, suffix: '%' }] },
  { id: 'pressureRate', path: '/advanced/teams/defense/pressure-rate', targets: [{ name: 'pressureRate', decimals: 1, suffix: '%' }, { name: 'defensivePressureRate', decimals: 1, suffix: '%' }] },
  { id: 'qbHitPct', path: '/advanced/teams/defense/quarterback-hit-percentage', targets: [{ name: 'qbHitPct', decimals: 1, suffix: '%' }, { name: 'quarterbackHitPercentage', decimals: 1, suffix: '%' }] },
  { id: 'qbSackPct', path: '/advanced/teams/defense/quarterback-sack-percentage', targets: [{ name: 'sackRate', decimals: 1, suffix: '%' }, { name: 'sacksRate', decimals: 1, suffix: '%' }] },
  { id: 'missedTacklePct', path: '/advanced/teams/defense/missed-tackle-percentage', targets: [{ name: 'missedTacklePct', decimals: 1, suffix: '%' }, { name: 'missedTackleRate', decimals: 1, suffix: '%' }] },
  { id: 'missedTackles', path: '/advanced/teams/defense/missed-tackles', targets: [{ name: 'missedTackles', decimals: 0 }] },
  { id: 'brokenTackles', path: '/advanced/teams/defense/broken-tackles', targets: [{ name: 'brokenTackles', decimals: 0 }] },
  { id: 'oppExplosivePlayRate', path: '/advanced/teams/defense/opponent-explosive-play-rate', targets: [{ name: 'oppExplosivePlayRate', decimals: 1, suffix: '%' }] },
  { id: 'manCoverageRate', path: '/advanced/teams/coverage/man-coverage-rate', targets: [{ name: 'manCoverageRate', decimals: 1, suffix: '%' }, { name: 'manCoveragePct', decimals: 1, suffix: '%' }] },
  { id: 'zoneCoverageRate', path: '/advanced/teams/coverage/zone-coverage-rate', targets: [{ name: 'zoneCoverageRate', decimals: 1, suffix: '%' }, { name: 'zoneCoveragePct', decimals: 1, suffix: '%' }] },
  { id: 'adotAllowed', path: '/advanced/teams/coverage/average-depth-of-target-allowed', targets: [{ name: 'averageDepthOfTargetAllowed', decimals: 2 }, { name: 'airYardsAllowed', decimals: 2 }] },
  { id: 'yacAllowed', path: '/advanced/teams/coverage/yards-after-catch-allowed', targets: [{ name: 'yardsAfterCatchAllowed', decimals: 0 }] },
  { id: 'coverageYardsAllowed', path: '/advanced/teams/coverage/yards-allowed', targets: [{ name: 'coverageYardsAllowed', decimals: 0 }] },
  { id: 'fieldGoalPct', path: '/teams/special-teams-offense/field-goal-conversion-percentage', targets: [{ name: 'fieldGoalPct', decimals: 1, suffix: '%' }, { name: 'fgPct', decimals: 1, suffix: '%' }, { name: 'fieldGoalPercentage', decimals: 1, suffix: '%' }] },
  { id: 'extraPointPct', path: '/teams/scoring-offense/extra-point-conversion-percentage', targets: [{ name: 'extraPointPct', decimals: 1, suffix: '%' }, { name: 'xpPct', decimals: 1, suffix: '%' }, { name: 'extraPointPercentage', decimals: 1, suffix: '%' }] },
  { id: 'fieldGoalsMade', path: '/teams/special-teams-offense/field-goals-made-per-game', targets: [{ name: 'fieldGoalsMadePerGame', decimals: 1 }] },
  { id: 'kickingPointsPerGame', path: '/teams/special-teams-offense/kicking-points-per-game', targets: [{ name: 'kickingPointsPerGame', decimals: 1 }] },
  { id: 'netPuntAverage', path: '/teams/special-teams-offense/net-yards-per-punt-attempt', targets: [{ name: 'netAvgPuntYards', decimals: 2 }, { name: 'netPuntAverage', decimals: 2 }] },
  { id: 'grossPuntAverage', path: '/teams/special-teams-offense/yards-per-successful-punt', targets: [{ name: 'grossAvgPuntYards', decimals: 2 }, { name: 'grossPuntAverage', decimals: 2 }, { name: 'puntAverage', decimals: 2 }] },
  { id: 'puntYardsPerGame', path: '/teams/special-teams-offense/punt-yards-per-game', targets: [{ name: 'puntYards', decimals: 1 }] },
  { id: 'puntsPerGame', path: '/teams/special-teams-offense/punt-attempts-per-game', targets: [{ name: 'punts', decimals: 1 }] },
  { id: 'puntTouchbackPct', path: '/teams/special-teams-offense/kickoff-touchback-percentage', targets: [{ name: 'kickoffTouchbackPct', decimals: 1, suffix: '%' }] },
  { id: 'oppNetPuntAverage', path: '/teams/special-teams-defense/opponent-net-yards-per-punt-attempt', targets: [{ name: 'opponentNetPuntAverage', decimals: 2 }] },
  { id: 'oppKickoffTouchbackPct', path: '/teams/special-teams-defense/opponent-kickoff-touchback-percentage', targets: [{ name: 'opponentKickoffTouchbackPct', decimals: 1, suffix: '%' }] },
  { id: 'fgBlockedPerGame', path: '/teams/special-teams-defense/field-goals-blocked-per-game', targets: [{ name: 'fieldGoalsBlockedPerGame', decimals: 1 }] },
  { id: 'puntsBlockedPerGame', path: '/teams/special-teams-defense/punts-blocked-per-game', targets: [{ name: 'puntsBlockedPerGame', decimals: 1 }] },
];

function statRankingsUrl(path, season) {
  const cleanPath = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${STATRANKINGS_BASE}${cleanPath}?season=${encodeURIComponent(String(season || ''))}`;
}

function statRankingsCookie() {
  return Deno.env.get('STATRANKINGS_COOKIE') || '';
}

async function fetchStatRankingsHtmlDirect(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      referer: 'https://statrankings.com/nfl',
      origin: 'https://statrankings.com',
      cookie: statRankingsCookie(),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`StatRankings fetch failed ${res.status}`);
  return text;
}

function parseStatRankingsValue(value) {
  if (value == null || value === '' || value === '-') return null;
  const n = Number(String(value).replace('%', '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseStatRankingsColumnsFromHtml(html) {
  const headerMatch = String(html || '').match(/<thead[\s\S]*?<tr[\s\S]*?<\/tr>[\s\S]*?<\/thead>/i);
  if (!headerMatch) return ['rank', 'team', '2025', 'Last 1', 'Last 3', 'Last 5', 'Last 10', 'Home', 'Away', '2024'];
  const cells = [...headerMatch[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => stripHtml(m[1]).replace(/[↓↕]/g, '').trim())
    .filter(Boolean);
  return cells.length ? cells : ['rank', 'team', '2025', 'Last 1', 'Last 3', 'Last 5', 'Last 10', 'Home', 'Away', '2024'];
}

function parseStatRankingsRowsFromHtml(html, def, season) {
  const columns = parseStatRankingsColumnsFromHtml(html);
  const rows = [];
  const teamMap = new Map();
  const bodyMatch = String(html || '').match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const source = bodyMatch ? bodyMatch[1] : String(html || '');
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const rowHtml = match[1];
    const teamMatch = rowHtml.match(/data-tooltip="([^"]+)"/i);
    if (!teamMatch?.[1]) continue;
    const team = decodeHtmlEntities(teamMatch[1]).trim();
    const teamAbbr = TEAM_ABBR_BY_NAME[team] || normalizeTeam(team);
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripHtml(m[1]).trim()).filter((v) => v !== '');
    const rank = parseStatRankingsValue(cells[0]);
    const valueCells = cells.slice(2);
    if (!valueCells.length) continue;
    const value = parseStatRankingsValue(valueCells[0]);
    const displayValue = valueCells[0] || '—';
    const columnData = {};
    const colNames = columns.slice(2);
    colNames.forEach((col, i) => {
      const display = valueCells[i];
      if (display == null || display === '') return;
      columnData[col] = { value: parseStatRankingsValue(display), displayValue: display };
    });
    const row = { rank, team, teamAbbr, value, displayValue, columns: columnData, source: 'statrankings', id: def.id, url: statRankingsUrl(def.path, season) };
    rows.push(row);
    if (teamAbbr) teamMap.set(teamAbbr, row);
  }
  return { rows, teamMap, columns };
}

async function readStatRankingsCache(base44, cacheDate, ttlMs) {
  try {
    const rows = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: cacheDate });
    if (!rows?.length) return null;
    const record = rows[0];
    const scrapedAt = record.scraped_at ? new Date(record.scraped_at).getTime() : 0;
    if (!scrapedAt || Date.now() - scrapedAt > ttlMs) return null;
    const raw = Array.isArray(record.games) ? record.games[0] : null;
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

async function writeStatRankingsCache(base44, cacheDate, payload, scrapedAt) {
  try {
    const existing = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: cacheDate });
    const record = {
      cache_date: cacheDate,
      scraped_at: scrapedAt,
      games: [JSON.stringify(payload)],
      raw_html_length: payload.htmlLength || 0,
      parse_errors: payload.warnings || [],
      source: 'statrankings',
    };
    if (existing?.length) await base44.asServiceRole.entities.LineupCache.update(existing[0].id, record);
    else await base44.asServiceRole.entities.LineupCache.create(record);
  } catch (_) {}
}

async function loadSingleStatRankingsDefinition(base44, def, season, forceRefresh = false) {
  const cacheDate = `statrankings_direct_${String(season)}_${def.id}`;
  const ttlMs = 12 * 60 * 60 * 1000;
  if (!forceRefresh) {
    const cached = await readStatRankingsCache(base44, cacheDate, ttlMs);
    if (cached) return cached;
  }
  const url = statRankingsUrl(def.path, season);
  const html = await fetchStatRankingsHtmlDirect(url);
  const parsed = parseStatRankingsRowsFromHtml(html, def, season);
  const scrapedAt = new Date().toISOString();
  const payload = {
    id: def.id,
    path: def.path,
    url,
    columns: parsed.columns,
    rowCount: parsed.rows.length,
    teamMap: Object.fromEntries(parsed.teamMap.entries()),
    htmlLength: html.length,
    scrapedAt,
  };
  await writeStatRankingsCache(base44, cacheDate, payload, scrapedAt);
  return payload;
}

function statRankingsBundleCacheKey(season) {
  return `statrankings_direct_bundle_v14_pressure_qbhit_${String(season)}`;
}

function compactStatRankingsPayloadForBundle(payload) {
  if (!payload?.teamMap) return null;
  return {
    id: payload.id,
    path: payload.path,
    url: payload.url,
    rowCount: payload.rowCount || Object.keys(payload.teamMap || {}).length,
    teamMap: payload.teamMap,
  };
}

function mapFromStatRankingsBundleObject(raw) {
  const bundle = new Map();
  const items = raw?.items || raw?.bundle || {};
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item?.id && item?.teamMap) bundle.set(item.id, item);
    }
  } else if (items && typeof items === 'object') {
    for (const [id, item] of Object.entries(items)) {
      if (item?.teamMap) bundle.set(id, { id, ...item });
    }
  }
  return bundle;
}

async function readStatRankingsBundleCache(base44, season, ttlMs) {
  try {
    const rows = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: statRankingsBundleCacheKey(season) });
    if (!rows?.length) return null;
    const record = rows[0];
    const scrapedAt = record.scraped_at ? new Date(record.scraped_at).getTime() : 0;
    if (!scrapedAt || Date.now() - scrapedAt > ttlMs) return null;
    const raw = Array.isArray(record.games) ? record.games[0] : null;
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

async function writeStatRankingsBundleCache(base44, season, bundle, warnings) {
  try {
    const items = {};
    for (const [id, payload] of bundle.entries()) {
      const compact = compactStatRankingsPayloadForBundle(payload);
      if (compact) items[id] = compact;
    }

    const scrapedAt = new Date().toISOString();
    const payload = {
      source: 'statrankings',
      season: String(season),
      scrapedAt,
      itemCount: Object.keys(items).length,
      items,
    };

    const cacheDate = statRankingsBundleCacheKey(season);
    const existing = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: cacheDate });
    const record = {
      cache_date: cacheDate,
      scraped_at: scrapedAt,
      games: [JSON.stringify(payload)],
      raw_html_length: 0,
      parse_errors: warnings || [],
      source: 'statrankings_bundle',
    };

    if (existing?.length) await base44.asServiceRole.entities.LineupCache.update(existing[0].id, record);
    else await base44.asServiceRole.entities.LineupCache.create(record);
  } catch (_) {}
}

async function loadStatRankingsBundle(base44, season, warnings, forceRefresh = false) {
  const ttlMs = 12 * 60 * 60 * 1000;

  // Important speed fix: use one bundle cache instead of reading/scraping every stat page
  // on every NFL game-detail request.
  if (!forceRefresh) {
    const cachedBundle = await readStatRankingsBundleCache(base44, season, ttlMs);
    const cachedMap = mapFromStatRankingsBundleObject(cachedBundle);
    if (cachedMap.size) return cachedMap;
  }

  const bundle = new Map();
  const defs = STATRANKINGS_DEFINITIONS;
  const concurrency = 10;
  let index = 0;

  async function worker() {
    while (index < defs.length) {
      const def = defs[index++];
      try {
        const payload = await loadSingleStatRankingsDefinition(base44, def, season, forceRefresh);
        if (payload?.teamMap && Object.keys(payload.teamMap).length) {
          bundle.set(def.id, payload);
        } else {
          warnings?.push?.(`StatRankings ${def.id} parsed 0 teams`);
        }
      } catch (err) {
        warnings?.push?.(`StatRankings ${def.id} failed: ${err?.message || String(err)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, defs.length) }, () => worker()));

  if (bundle.size) await writeStatRankingsBundleCache(base44, season, bundle, warnings);
  return bundle;
}

function statRankingsRow(bundle, id, team) {
  const abbr = normalizeTeam(team);
  return bundle?.get?.(id)?.teamMap?.[abbr] || null;
}

function applyStatRankingsTarget(stats, row, target) {
  if (!row || !target?.name) return;
  const raw = row.columns?.['2025']?.value ?? row.value;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  setStatValue(stats, target.name, value, target.decimals ?? 1, target.suffix || '');
}

function applyStatRankingsToStats(stats, bundle, team) {
  if (!bundle || !Array.isArray(stats)) return stats;
  for (const def of STATRANKINGS_DEFINITIONS) {
    const row = statRankingsRow(bundle, def.id, team);
    if (!row) continue;
    for (const target of def.targets || []) applyStatRankingsTarget(stats, row, target);
  }
  return stats;
}

const TEAM_ABBR_BY_NAME = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET', 'Green Bay Packers': 'GB', 'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN', 'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG', 'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SCHEDULES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP_URL = (season) => `${NFLVERSE_BASE}/pbp/play_by_play_${season}.csv.gz`;
const FTN_CHARTING_URL = (season) => `${NFLVERSE_BASE}/ftn_charting/ftn_charting_${season}.csv`;
const NGS_PASSING_URL = `${NFLVERSE_BASE}/nextgen_stats/ngs_passing.csv`;
const PARTICIPATION_URL = (season) => `${NFLVERSE_BASE}/pbp_participation/pbp_participation_${season}.csv`;
const PFR_ADV_RUSH_WEEK_URL = (season) => `${NFLVERSE_BASE}/pfr_advstats/advstats_week_rush_${season}.csv`;

const TEAM_ALIASES = {
  ARI: 'ARI', ARZ: 'ARI', ATL: 'ATL', BAL: 'BAL', BLT: 'BAL', BUF: 'BUF', CAR: 'CAR', CHI: 'CHI', CIN: 'CIN', CLE: 'CLE', CLV: 'CLE',
  DAL: 'DAL', DEN: 'DEN', DET: 'DET', GB: 'GB', GNB: 'GB', HOU: 'HOU', IND: 'IND', JAX: 'JAX', JAC: 'JAX', KC: 'KC', KAN: 'KC',
  LAC: 'LAC', SD: 'LAC', LAR: 'LAR', LA: 'LAR', STL: 'LAR', LV: 'LV', OAK: 'LV', RAI: 'LV', MIA: 'MIA', MIN: 'MIN', NE: 'NE',
  NWE: 'NE', NO: 'NO', NOR: 'NO', NYG: 'NYG', NYJ: 'NYJ', PHI: 'PHI', PIT: 'PIT', SEA: 'SEA', SF: 'SF', SFO: 'SF', TB: 'TB',
  TAM: 'TB', TEN: 'TEN', WAS: 'WAS', WSH: 'WAS', WFT: 'WAS'
};

// Canonical 32-team set used when building league ranks.
// H2H ranks must compare the matchup teams against the full league, not only
// the two teams in the current game.
const NFL_CANONICAL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
];

function normalizeTeam(team) {
  const raw = String(team || '').trim().toUpperCase();
  return TEAM_ALIASES[raw] || raw;
}

function num(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const cleaned = String(value).replace('%', '').trim();
  if (cleaned === '' || cleaned === 'NA' || cleaned === 'NaN') return fallback;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function safeDiv(a, b) {
  return b ? a / b : null;
}

function rangeIncludes(ranges, season, week) {
  const y = Number(season);
  const w = Number(week);
  if (!Number.isFinite(y) || !Number.isFinite(w)) return false;
  return (ranges || []).some((r) =>
    Number(r?.season) === y &&
    w >= Number(r?.minWeek ?? 0) &&
    w <= Number(r?.maxWeek ?? 999)
  );
}

function pct(a, b) {
  const v = safeDiv(a, b);
  return v == null ? null : v * 100;
}

function round(value, decimals = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function display(value, decimals = 1, suffix = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}${suffix}`;
}

function displayInt(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}`;
}

function stat(name, value, displayValue = null) {
  return { name, value, displayValue: displayValue ?? String(value ?? '—') };
}

function statNumber(name, value, decimals = 1, suffix = '') {
  return stat(name, value == null ? null : round(value, decimals), display(value, decimals, suffix));
}

function statInteger(name, value) {
  return stat(name, value == null ? null : Math.round(value), displayInt(value));
}

function statRecord(name, value) {
  return stat(name, value || '—', value || '—');
}

function firstValue(row, names, fallback = '') {
  for (const name of names) {
    if (row && row[name] != null && row[name] !== '') return row[name];
  }
  return fallback;
}

function firstNumber(row, names, fallback = 0) {
  return num(firstValue(row, names, ''), fallback);
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SportsEdgeAI/1.0',
        Accept: 'text/csv,text/plain,*/*'
      }
    });
    if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
    return await res.text();
  } catch (err) {
    throw new Error(`nflverse fetch failed: ${err?.message || String(err)}`);
  }
}


async function fetchGzipText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SportsEdgeAI/1.0',
        Accept: 'application/gzip,application/octet-stream,text/csv,*/*'
      }
    });
    if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);

    const buffer = await res.arrayBuffer();
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buffer]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    } catch (gzipErr) {
      // Some hosts may transparently decompress. If that happens, fall back to text.
      const asText = new TextDecoder().decode(buffer);
      if (asText && asText.includes('game_id')) return asText;
      throw gzipErr;
    }
  } catch (err) {
    throw new Error(`nflverse gzip fetch failed: ${err?.message || String(err)}`);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((values) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] ?? '';
    });
    return obj;
  });
}

async function loadSchedules() {
  return parseCsv(await fetchText(SCHEDULES_URL));
}

async function loadTeamStats(season) {
  const urls = [
    `${NFLVERSE_BASE}/stats_team/stats_team_week_${season}.csv`,
    `${NFLVERSE_BASE}/stats_team/stats_team_${season}.csv`
  ];

  const errors = [];
  for (const url of urls) {
    try {
      return parseCsv(await fetchText(url));
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }

  throw new Error(`Unable to load nflverse team stats. Tried: ${errors.join(' | ')}`);
}


async function loadFtnCharting(seasons, ranges) {
  const byPlay = new Map();
  let rowsLoaded = 0;

  for (const season of seasons || []) {
    if (Number(season) < 2022) continue;
    const rows = parseCsv(await fetchText(FTN_CHARTING_URL(season)));
    for (const row of rows) {
      const rowSeason = num(row.season, NaN);
      const rowWeek = num(row.week, NaN);
      if (!rangeIncludes(ranges, rowSeason, rowWeek)) continue;

      const gameId = String(row.nflverse_game_id || '').trim();
      const playId = String(row.nflverse_play_id || '').trim();
      const nBlitzers = num(row.n_blitzers, NaN);
      if (!gameId || !playId || !Number.isFinite(nBlitzers)) continue;

      byPlay.set(`${gameId}|${playId}`, { nBlitzers });
      rowsLoaded += 1;
    }
  }

  return { byPlay, rowsLoaded };
}


async function loadParticipationTeamTimeToThrow(seasons, ranges) {
  const agg = new Map();
  let rowsUsed = 0;
  const warnings = [];

  for (const season of seasons || []) {
    try {
      const rows = parseCsv(await fetchText(PARTICIPATION_URL(season)));
      for (const row of rows) {
        const rowSeason = num(firstValue(row, ['season'], season), Number(season));
        const gameId = String(firstValue(row, ['nflverse_game_id', 'game_id'], '') || '');
        let rowWeek = num(firstValue(row, ['week'], ''), NaN);
        if (!Number.isFinite(rowWeek) && gameId) {
          const m = gameId.match(/^\d{4}_(\d{2})_/);
          if (m) rowWeek = Number(m[1]);
        }
        if (Number.isFinite(rowWeek) && !rangeIncludes(ranges, rowSeason, rowWeek)) continue;

        const team = normalizeTeam(firstValue(row, ['possession_team', 'posteam', 'team'], ''));
        const ttt = firstNumber(row, ['time_to_throw'], NaN);
        if (!team || !Number.isFinite(ttt) || ttt <= 0) continue;

        const current = agg.get(team) || { sum: 0, count: 0 };
        current.sum += ttt;
        current.count += 1;
        agg.set(team, current);
        rowsUsed += 1;
      }
    } catch (err) {
      warnings.push(`Participation TTT ${season} unavailable: ${err?.message || String(err)}`);
    }
  }

  const byTeam = new Map();
  for (const [team, v] of agg.entries()) {
    if (v.count > 0) byTeam.set(team, v.sum / v.count);
  }
  return { byTeam, rowsUsed, warnings };
}

function fuzzyNumeric(row, preferred, predicate = null) {
  for (const key of preferred || []) {
    const value = firstNumber(row, [key], NaN);
    if (Number.isFinite(value)) return value;
  }
  for (const [key, raw] of Object.entries(row || {})) {
    const norm = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (predicate && !predicate(norm)) continue;
    const value = num(raw, NaN);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

async function loadPfrTeamYardsBeforeContact(seasons, ranges) {
  const agg = new Map();
  let rowsUsed = 0;
  const warnings = [];

  for (const season of seasons || []) {
    try {
      const rows = parseCsv(await fetchText(PFR_ADV_RUSH_WEEK_URL(season)));
      for (const row of rows) {
        const rowSeason = num(firstValue(row, ['season'], season), Number(season));
        const rowWeek = num(firstValue(row, ['week'], ''), NaN);
        if (Number.isFinite(rowWeek) && !rangeIncludes(ranges, rowSeason, rowWeek)) continue;

        const team = normalizeTeam(firstValue(row, ['team', 'team_abbr', 'teamAbbr'], ''));
        if (!team) continue;

        const attempts = fuzzyNumeric(row,
          ['rush_attempts', 'rushing_attempts', 'rush_att', 'att', 'carries'],
          (k) => (k === 'att' || k.includes('rushattempt') || k.includes('rushingattempt') || k === 'carries')
        );
        const ybcTotal = fuzzyNumeric(row,
          ['yards_before_contact', 'rush_yards_before_contact', 'rushing_yards_before_contact', 'ybc'],
          (k) => (k === 'ybc' || (k.includes('yardsbeforecontact') && !k.includes('per') && !k.includes('att')))
        );
        const ybcPerAtt = fuzzyNumeric(row,
          ['yards_before_contact_per_attempt', 'yards_before_contact_per_att', 'rush_yards_before_contact_per_att', 'rushing_yards_before_contact_per_attempt', 'ybc_per_att', 'ybc_att'],
          (k) => ((k.includes('ybc') || k.includes('yardsbeforecontact')) && (k.includes('peratt') || k.endsWith('att')))
        );

        let total = ybcTotal;
        if (!Number.isFinite(total) && Number.isFinite(ybcPerAtt) && Number.isFinite(attempts) && attempts > 0) {
          total = ybcPerAtt * attempts;
        }
        if (!Number.isFinite(total)) continue;

        const current = agg.get(team) || { totalYbc: 0, attempts: 0 };
        current.totalYbc += total;
        if (Number.isFinite(attempts) && attempts > 0) current.attempts += attempts;
        agg.set(team, current);
        rowsUsed += 1;
      }
    } catch (err) {
      warnings.push(`PFR advanced rushing YBC ${season} unavailable: ${err?.message || String(err)}`);
    }
  }

  return { byTeam: agg, rowsUsed, warnings };
}

function mergeYardsBeforeContactIntoPbpMetrics(metrics, ybcByTeam) {
  if (!metrics) return metrics;
  for (const [team, value] of ybcByTeam || []) {
    const m = metrics.get(team);
    if (!m || !Number.isFinite(value?.totalYbc)) continue;
    m.yardsBeforeContactSum = value.totalYbc;
    m.yardsBeforeContactRuns = Number.isFinite(value.attempts) ? value.attempts : 0;
  }
  return metrics;
}

async function loadNgsTeamTimeToThrow(seasons, ranges) {
  const seasonSet = new Set((seasons || []).map((s) => Number(s)));
  const agg = new Map();
  let rowsUsed = 0;
  const warnings = [];

  const addRow = (row, defaultSeason = null) => {
    const flat = flattenNextGenRow(row) || row || {};
    const season = num(firstValue(flat, ['season', 'season_year', 'seasonYear'], defaultSeason ?? ''), NaN);
    if (!seasonSet.has(season)) return;

    const seasonType = String(firstValue(flat, ['season_type', 'seasonType'], 'REG')).toUpperCase();
    if (seasonType && seasonType !== 'REG') return;

    const rawWeek = firstValue(flat, ['week', 'week_number', 'weekNumber'], '');
    const week = rawWeek === '' ? null : num(rawWeek, NaN);
    if (week != null && Number.isFinite(week) && week > 0 && !rangeIncludes(ranges, season, week)) return;

    const team = normalizeTeam(firstValue(flat, [
      'team_abbr', 'teamAbbr', 'team', 'teamCode', 'club_code', 'clubCode',
      'player_current_team', 'latestTeam'
    ], ''));

    const attempts = firstNumber(flat, [
      'attempts', 'pass_attempts', 'passAttempts', 'att', 'passing_attempts'
    ], NaN);
    const ttt = firstNumber(flat, [
      'avg_time_to_throw', 'avgTimeToThrow', 'average_time_to_throw',
      'averageTimeToThrow', 'time_to_throw', 'timeToThrow'
    ], NaN);

    if (!team || !Number.isFinite(ttt) || ttt <= 0) return;

    const weight = Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
    const current = agg.get(team) || { weighted: 0, attempts: 0 };
    current.weighted += ttt * weight;
    current.attempts += weight;
    agg.set(team, current);
    rowsUsed += 1;
  };

  // FIRST: use the small public NGS statboard response. This avoids loading another
  // full play-level participation CSV into memory while PBP is already being processed.
  for (const season of seasonSet) {
    try {
      const response = await fetchNextGenStats('passing', season, 'REG');
      if (!response?.ok) {
        warnings.push(`NGS statboard ${season} failed: HTTP ${response?.status || 'unknown'} ${response?.error || response?.errorPreview || ''}`.trim());
        continue;
      }
      const rows = getNextGenRows(response.data).map(flattenNextGenRow);
      for (const row of rows) addRow(row, season);
    } catch (err) {
      warnings.push(`NGS statboard ${season} failed: ${err?.message || String(err)}`);
    }
  }

  // Do NOT fall back to play-level participation here. That dataset is very large
  // and caused Base44 workers to terminate with a generic user-exception when loaded
  // after the full-season PBP/FTN pass. If the compact NGS statboard is unavailable,
  // leave Time to Throw null and report a warning instead of risking the whole function.
  if (rowsUsed === 0) {
    warnings.push('Time to Throw unavailable: compact NFL Next Gen statboard returned no usable rows; participation fallback intentionally disabled for worker safety.');
  }

  const byTeam = new Map();
  for (const [team, value] of agg.entries()) {
    if (value.attempts > 0) byTeam.set(team, value.weighted / value.attempts);
  }

  return { byTeam, rowsUsed, warnings };
}

function mergeTrackingIntoPbpMetrics(metrics, ngsTimeToThrowByTeam) {
  if (!metrics) return metrics;
  for (const [team, m] of metrics.entries()) {
    const tracking = ngsTimeToThrowByTeam?.get(team);
    const ttt = tracking?.timeToThrow ?? tracking;
    if (Number.isFinite(ttt)) {
      // Preserve the existing applyPbpMetricsToStats contract.
      m.timeToThrowSum = ttt;
      m.timeToThrowCount = 1;
    }
    const man = tracking?.manCoverageRate;
    const zone = tracking?.zoneCoverageRate;
    if (Number.isFinite(man)) m.manCoverageRate = man;
    if (Number.isFinite(zone)) m.zoneCoverageRate = zone;
  }
  return metrics;
}



function teamFromRow(row) {
  return normalizeTeam(firstValue(row, [
    'team', 'recent_team', 'team_abbr', 'posteam', 'club_code', 'club', 'tm'
  ]));
}

function weekFromRow(row) {
  return num(firstValue(row, ['week', 'game_week'], ''), null);
}

function makeBlankTeamSummary(team) {
  return {
    team,
    games: 0,
    rows: [],
    sums: {},
    means: {}
  };
}

function addToSummary(summary, row) {
  summary.rows.push(row);
  const gameId = firstValue(row, ['game_id', 'old_game_id', 'gsis_id'], '');
  if (!summary.gameIds) summary.gameIds = new Set();
  if (gameId) summary.gameIds.add(gameId);

  for (const [key, value] of Object.entries(row)) {
    const n = num(value, NaN);
    if (!Number.isFinite(n)) continue;
    summary.sums[key] = (summary.sums[key] || 0) + n;
    if (!summary.counts) summary.counts = {};
    summary.counts[key] = (summary.counts[key] || 0) + 1;
  }

  summary.games = Math.max(summary.gameIds?.size || 0, summary.rows.length || 0, 1);
}

function finalizeSummary(summary) {
  summary.means = {};
  for (const [key, value] of Object.entries(summary.sums || {})) {
    const c = summary.counts?.[key] || 0;
    if (c) summary.means[key] = value / c;
  }
  if (!summary.games) summary.games = 1;
  return summary;
}

function sum(summary, names) {
  for (const name of names) {
    if (summary.sums && summary.sums[name] != null) return summary.sums[name];
  }
  return 0;
}

function mean(summary, names) {
  for (const name of names) {
    if (summary.means && summary.means[name] != null) return summary.means[name];
  }
  return null;
}

function perGame(summary, names) {
  return safeDiv(sum(summary, names), Math.max(summary.games || 1, 1));
}

function aggregateTeamRows(rows, teams, ranges) {
  const map = new Map();
  for (const row of rows) {
    const team = teamFromRow(row);
    if (!team || (teams && !teams.has(team))) continue;
    const rowWeek = weekFromRow(row);
    const rowSeason = num(firstValue(row, ['season'], ''), NaN);
    if (Number.isFinite(rowSeason) && Number.isFinite(rowWeek)) {
      const inRange = ranges.some((r) => Number(r.season) === rowSeason && rowWeek >= r.minWeek && rowWeek <= r.maxWeek);
      if (!inRange) continue;
    }
    if (!map.has(team)) map.set(team, makeBlankTeamSummary(team));
    addToSummary(map.get(team), row);
  }
  for (const value of map.values()) finalizeSummary(value);
  return map;
}


function rowMetricTotals(row) {
  const passAttempts = firstNumber(row, ['attempts', 'passing_attempts', 'pass_attempts'], 0);
  const completions = firstNumber(row, ['completions', 'passing_completions'], 0);
  const passYards = firstNumber(row, ['passing_yards', 'pass_yards'], 0);
  const passTds = firstNumber(row, ['passing_tds', 'passing_touchdowns', 'pass_touchdowns'], 0);
  const interceptions = firstNumber(row, ['interceptions', 'interceptions_thrown'], 0);
  const sacksAllowed = firstNumber(row, ['sacks_suffered', 'sacks_allowed', 'sacks_taken'], 0);
  const rushAttempts = firstNumber(row, ['carries', 'rushing_attempts', 'rush_attempts'], 0);
  const rushYards = firstNumber(row, ['rushing_yards', 'rush_yards'], 0);
  const turnovers = interceptions + firstNumber(row, ['fumbles_lost', 'lost_fumbles'], 0);
  const airYards = firstNumber(row, ['passing_air_yards', 'air_yards'], 0);

  return {
    passAttempts,
    completions,
    passYards,
    passTds,
    interceptions,
    sacksAllowed,
    rushAttempts,
    rushYards,
    turnovers,
    airYards,
    yards: passYards + rushYards,
    plays: passAttempts + sacksAllowed + rushAttempts
  };
}

function buildTeamWeekRowMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const team = teamFromRow(row);
    const week = weekFromRow(row);
    const season = num(firstValue(row, ['season'], ''), NaN);
    if (!team || week == null || !Number.isFinite(week)) continue;
    const key = Number.isFinite(season) ? `${team}_${season}_${week}` : `${team}_${week}`;
    map.set(key, row);
  }
  return map;
}

function makeScheduleAgg(team) {
  return {
    team,
    games: 0,
    pointsFor: 0,
    pointsAllowed: 0,
    yardsAllowed: 0,
    playsFaced: 0,
    passYardsAllowed: 0,
    completionsAllowed: 0,
    attemptsFaced: 0,
    passTdsAllowed: 0,
    interceptionsForced: 0,
    sacks: 0,
    airYardsAllowed: 0,
    rushYardsAllowed: 0,
    rushAttemptsFaced: 0,
    turnoversForced: 0
  };
}

function addScheduleGameAgg(target, pointsFor, pointsAllowed, opponentRow) {
  target.games += 1;
  target.pointsFor += pointsFor;
  target.pointsAllowed += pointsAllowed;

  if (!opponentRow) return;
  const opp = rowMetricTotals(opponentRow);
  target.yardsAllowed += opp.yards;
  target.playsFaced += opp.plays;
  target.passYardsAllowed += opp.passYards;
  target.completionsAllowed += opp.completions;
  target.attemptsFaced += opp.passAttempts;
  target.passTdsAllowed += opp.passTds;
  target.interceptionsForced += opp.interceptions;
  target.sacks += opp.sacksAllowed;
  target.airYardsAllowed += opp.airYards;
  target.rushYardsAllowed += opp.rushYards;
  target.rushAttemptsFaced += opp.rushAttempts;
  target.turnoversForced += opp.turnovers;
}

function buildScheduleAggs(schedules, teamRows, ranges, teams) {
  const rowMap = buildTeamWeekRowMap(teamRows);
  const map = new Map();
  for (const team of teams) { map.set(team, makeScheduleAgg(team)); }
  for (const g of schedules || []) {
    const gSeason = num(g.season, 0);
    const gWeek = num(g.week, 0);
    if (!gWeek) continue;
    const inRange = ranges.some((r) => Number(r.season) === gSeason && gWeek >= r.minWeek && gWeek <= r.maxWeek);
    if (!inRange) continue;
    const away = normalizeTeam(g.away_team);
    const home = normalizeTeam(g.home_team);
    const awayScore = num(g.away_score, NaN);
    const homeScore = num(g.home_score, NaN);
    if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
    if (teams.has(away)) {
      const target = map.get(away) || makeScheduleAgg(away);
      addScheduleGameAgg(target, awayScore, homeScore, rowMap.get(`${home}_${gSeason}_${gWeek}`) || rowMap.get(`${home}_${gWeek}`));
      map.set(away, target);
    }
    if (teams.has(home)) {
      const target = map.get(home) || makeScheduleAgg(home);
      addScheduleGameAgg(target, homeScore, awayScore, rowMap.get(`${away}_${gSeason}_${gWeek}`) || rowMap.get(`${away}_${gWeek}`));
      map.set(home, target);
    }
  }
  return map;
}


function makePbpAgg(team) {
  return {
    team, gamesSet: new Set(), qbPassers: new Map(),
    plays: 0, epa: 0, successes: 0, yards: 0, firstDowns: 0, turnovers: 0,
    interceptionsThrown: 0, fumblesLost: 0, offensivePoints: 0, firstHalfPoints: 0,
    secondHalfPoints: 0, fourthQuarterPoints: 0, twoMinuteEpa: 0, twoMinutePlays: 0,
    possessionSeconds: 0, noHuddlePlays: 0, hurryUpPlays: 0, completions: 0, passYards: 0,
    passTds: 0, sacksTaken: 0, passDropbacks: 0, pressuresAllowed: 0, qbHitsAllowed: 0,
    hurriesAllowed: 0, blitzesFaced: 0, chartedBlitzDropbacksFaced: 0, timeToThrowSum: 0, timeToThrowCount: 0,
    passPlays: 0, passEpa: 0, passSuccesses: 0, explosivePasses: 0, rushPlays: 0,
    rushEpa: 0, rushSuccesses: 0, explosiveRuns: 0, stuffedRuns: 0, powerRushes: 0,
    powerRushSuccesses: 0, shortYardageRushes: 0, shortYardageRushSuccesses: 0,
    yardsBeforeContactSum: 0, yardsBeforeContactRuns: 0, adjustedLineYardsSum: 0, adjustedLineYardsRuns: 0,
    redZoneDrives: new Set(), redZoneTdDrives: new Set(), redZoneScoreDrives: new Set(),
    goalToGoDrives: new Set(), goalToGoTdDrives: new Set(), goalToGoPlays: 0, goalToGoSuccesses: 0,
    thirdDowns: 0, thirdDownConversions: 0, thirdDownEpa: 0, fourthDowns: 0, fourthDownConversions: 0,
    drives: new Map(),
    defGamesSet: new Set(), defPlays: 0, defEpaAllowed: 0, defSuccessesAllowed: 0,
    defYardsAllowed: 0, defFirstDownsAllowed: 0, defTurnoversForced: 0, defInterceptionsForced: 0,
    defFumblesForced: 0, defFirstHalfPointsAllowed: 0, defSecondHalfPointsAllowed: 0,
    defFourthQuarterPointsAllowed: 0, defTwoMinuteEpaAllowed: 0, defTwoMinutePlays: 0,
    defDrives: new Map(), defOpeningDriveCount: 0, defOpeningDriveScoreCount: 0,
    defOpeningDriveTdCount: 0, defAvgDriveStartYardline100: null,
    defPassPlays: 0, defCompletionsAllowed: 0, defPassYardsAllowed: 0, defPassTdsAllowed: 0,
    defInterceptionsForcedAsPassDefense: 0, defPassEpaAllowed: 0, defPassSuccessesAllowed: 0,
    defExplosivePassesAllowed: 0, defPassDropbacks: 0, defBlitzes: 0, defChartedBlitzDropbacks: 0, defPressures: 0,
    defQbHits: 0, defHurries: 0, defRushPlays: 0, defRushEpaAllowed: 0, defRushSuccessesAllowed: 0,
    defExplosiveRunsAllowed: 0, defRushYardsBeforeContactAllowedSum: 0, defRushYardsBeforeContactAllowedRuns: 0,
    defAdjustedLineYardsAllowedSum: 0, defAdjustedLineYardsAllowedRuns: 0, defTacklesForLoss: 0,
    defStuffedRuns: 0, defShortYardagePlays: 0, defShortYardageStops: 0, defShortYardageConversionsAllowed: 0,
    defRedZoneDrives: new Set(), defRedZoneTdDrivesAllowed: new Set(), defRedZoneScoreDrivesAllowed: new Set(),
    defGoalToGoDrivesAllowed: new Set(), defGoalToGoTdDrivesAllowed: new Set(),
    defThirdDowns: 0, defThirdDownConversionsAllowed: 0, defFourthDowns: 0, defFourthDownConversionsAllowed: 0,
    fgMade: 0, fgAtt: 0, fgMade40: 0, fgAtt40: 0, fgMade50: 0, fgAtt50: 0, longestFg: null,
    xpMade: 0, xpAtt: 0, punts: 0, puntYards: 0, puntInside20: 0, puntTouchbacks: 0,
    puntReturns: 0, puntReturnYards: 0, puntReturnTds: 0, kickReturns: 0, kickReturnYards: 0,
    kickReturnTds: 0, puntReturnYardsAllowed: 0, kickReturnYardsAllowed: 0, specialTeamsEpa: 0, specialTeamsPlays: 0,
  };
}

function shouldUsePbpPlay(row) {
  const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
  if (!playType || ['no_play', 'qb_kneel', 'qb_spike', 'timeout'].includes(playType)) return false;
  const epa = num(firstValue(row, ['epa'], ''), NaN);
  return Number.isFinite(epa);
}

function isOffensivePbpPlay(row) {
  const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
  if (!playType) return false;
  if (['no_play', 'qb_kneel', 'qb_spike', 'timeout', 'field_goal', 'extra_point', 'kickoff', 'punt'].includes(playType)) return false;
  return firstValue(row, ['posteam'], '') && firstValue(row, ['defteam'], '');
}

function isSpecialTeamsPbpPlay(row) {
  const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
  return ['punt', 'kickoff', 'field_goal', 'extra_point'].includes(playType) ||
    truthyNumber(row, ['punt_attempt']) ||
    truthyNumber(row, ['kickoff_attempt']) ||
    truthyNumber(row, ['field_goal_attempt']) ||
    truthyNumber(row, ['extra_point_attempt']);
}

function isPassPlay(row) {
  const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
  return playType === 'pass' || truthyNumber(row, ['pass_attempt', 'qb_dropback']);
}

function isRushPlay(row) {
  const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
  return playType === 'run' || playType === 'rush' || truthyNumber(row, ['rush_attempt']);
}

function isTouchdown(row) {
  return truthyNumber(row, ['touchdown']) || truthyNumber(row, ['pass_touchdown', 'rush_touchdown', 'return_touchdown']);
}

function isFirstDown(row) {
  return truthyNumber(row, ['first_down', 'first_down_pass', 'first_down_rush', 'first_down_penalty']);
}

function isTurnover(row) {
  return truthyNumber(row, ['turnover']) ||
    truthyNumber(row, ['interception']) ||
    truthyNumber(row, ['fumble_lost']) ||
    truthyNumber(row, ['fumble_lost_1']) ||
    truthyNumber(row, ['fumble_lost_2']);
}

function scoringPointsForRow(row) {
  let points = 0;
  if (isTouchdown(row)) points += 6;
  if (String(firstValue(row, ['field_goal_result'], '')).toLowerCase() === 'made') points += 3;
  if (String(firstValue(row, ['extra_point_result'], '')).toLowerCase() === 'good') points += 1;
  if (String(firstValue(row, ['two_point_conv_result'], '')).toLowerCase() === 'success') points += 2;
  if (truthyNumber(row, ['safety'])) points += 2;
  return points;
}

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function rowFromHeaders(headers, values, wantedIndexes = null) {
  const row = {};
  const indexes = wantedIndexes || headers.map((_, i) => i);
  for (const idx of indexes) {
    row[headers[idx]] = values[idx] ?? '';
  }
  return row;
}

function wantedPbpColumnIndexes(headers) {
  const needed = new Set([
    'season','week','posteam','defteam','play_type','epa','success','yards_gained','down','ydstogo','yards_to_go','yardline_100',
    'pass_attempt','qb_dropback','rush_attempt','touchdown','pass_touchdown','rush_touchdown','return_touchdown',
    'complete_pass','incomplete_pass','sack','no_huddle','shotgun','play_clock',
    'was_pressure','pressure','qb_hit','qb_hit_1_player_id','qb_hit_2_player_id','qb_hurry','hurry','time_to_throw','was_blitz','blitz','number_of_pass_rushers','pass_rushers',
    'yards_after_contact','rushing_yards_after_contact','yards_before_contact','rushing_yards_before_contact',
    'first_down','first_down_pass','first_down_rush','first_down_penalty','third_down_converted','fourth_down_converted',
    'game_id','old_game_id','play_id','passer_player_id','passer_player_name','passing_yards','drive','fixed_drive','qtr','quarter','game_seconds_remaining','half_seconds_remaining',
    'quarter_seconds_remaining','score_differential','field_goal_attempt','field_goal_result','kick_distance',
    'extra_point_attempt','extra_point_result','two_point_conv_result','punt_attempt','punt_inside_twenty',
    'touchback','kickoff_attempt','return_yards','return_touchdown','safety','goal_to_go','interception','fumble_lost',
    'fumble_lost_1','fumble_lost_2','fumble_forced','fumble_forced_1','fumble_forced_2','turnover','td_team','return_team','penalty','penalty_yards'
  ]);
  const out = [];
  headers.forEach((h, idx) => {
    if (needed.has(h)) out.push(idx);
  });
  return out;
}


function truthyNumber(row, names) {
  return names.some((name) => { const v = firstValue(row, [name], ''); const n = num(v, NaN); return Number.isFinite(n) ? n === 1 : String(v).toUpperCase() === 'TRUE'; });
}

function firstFiniteNumber(row, names) {
  for (const name of names) {
    const value = firstValue(row, [name], '');
    if (value === '' || value == null) continue;
    const n = num(value, NaN);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function adjustedLineYardsForCarry(yards) {
  if (!Number.isFinite(yards)) return null;
  if (yards < 0) return yards * 1.2;
  if (yards <= 4) return yards;
  if (yards <= 10) return 4 + ((yards - 4) * 0.5);
  return 7;
}

function ensureDrive(m, gameId, team, row) {
  const drive = firstValue(row, ['fixed_drive', 'drive'], '');
  if (!gameId || !team || !drive) return null;
  const key = `${gameId}_${team}_${drive}`;
  const existing = m.drives.get(key) || {
    gameId,
    team,
    driveNumber: num(drive, 999),
    plays: 0,
    firstDown: false,
    touchdown: false,
    score: false,
    points: 0,
    startYardline100: null,
    maxGameSeconds: null,
    minGameSeconds: null,
  };
  const y100 = firstNumber(row, ['yardline_100'], NaN);
  if (Number.isFinite(y100) && existing.startYardline100 == null) existing.startYardline100 = y100;
  const gsr = firstNumber(row, ['game_seconds_remaining'], NaN);
  if (Number.isFinite(gsr)) {
    existing.maxGameSeconds = existing.maxGameSeconds == null ? gsr : Math.max(existing.maxGameSeconds, gsr);
    existing.minGameSeconds = existing.minGameSeconds == null ? gsr : Math.min(existing.minGameSeconds, gsr);
  }
  m.drives.set(key, existing);
  return existing;
}


function ensureDefDrive(m, gameId, defenseTeam, row) {
  const drive = firstValue(row, ['fixed_drive', 'drive'], '');
  const offenseTeam = normalizeTeam(firstValue(row, ['posteam'], ''));
  if (!gameId || !defenseTeam || !offenseTeam || !drive) return null;
  const key = `${gameId}_${defenseTeam}_vs_${offenseTeam}_${drive}`;
  const existing = m.defDrives.get(key) || {
    gameId,
    defenseTeam,
    offenseTeam,
    driveNumber: num(drive, 999),
    touchdown: false,
    score: false,
    points: 0,
    startYardline100: null,
  };
  const y100 = firstNumber(row, ['yardline_100'], NaN);
  if (Number.isFinite(y100) && existing.startYardline100 == null) existing.startYardline100 = y100;
  m.defDrives.set(key, existing);
  return existing;
}

function addPbpRowToMetrics(row, metrics, ranges, ftnChartingByPlay = null) {
  const rowSeason = num(firstValue(row, ['season'], ''), null);
  const rowWeek = num(firstValue(row, ['week'], ''), null);
  if (rowSeason == null || rowWeek == null || !Number.isFinite(rowWeek)) return false;
  const inRange = ranges.some((r) => Number(r.season) === rowSeason && rowWeek >= r.minWeek && rowWeek <= r.maxWeek);
  if (!inRange) return false;

  const posteam = normalizeTeam(firstValue(row, ['posteam'], ''));
  const defteam = normalizeTeam(firstValue(row, ['defteam'], ''));
  if (!metrics.has(posteam) && !metrics.has(defteam)) return false;

  const gameId = firstValue(row, ['game_id', 'old_game_id'], '');
  const qtr = firstNumber(row, ['qtr', 'quarter'], 0);
  const halfSeconds = firstNumber(row, ['half_seconds_remaining'], NaN);
  const gameSeconds = firstNumber(row, ['game_seconds_remaining'], NaN);
  const epa = num(firstValue(row, ['epa'], ''), 0);
  const success = truthyNumber(row, ['success']);
  const yards = firstNumber(row, ['yards_gained'], 0);
  const down = firstNumber(row, ['down'], 0);
  const yardline100 = firstNumber(row, ['yardline_100'], NaN);
  const pass = isPassPlay(row);
  const rush = isRushPlay(row);
  const td = isTouchdown(row);
  const firstDown = isFirstDown(row);
  const turnover = isTurnover(row);
  const interception = truthyNumber(row, ['interception']);
  const fumbleLost = truthyNumber(row, ['fumble_lost', 'fumble_lost_1', 'fumble_lost_2']);
  const fumbleForced = truthyNumber(row, ['fumble_forced', 'fumble_forced_1', 'fumble_forced_2']);
  const completePass = truthyNumber(row, ['complete_pass']);
  const passTd = truthyNumber(row, ['pass_touchdown']);
  const sack = truthyNumber(row, ['sack']);
  const noHuddle = truthyNumber(row, ['no_huddle']);
  const playClock = firstNumber(row, ['play_clock'], NaN);
  const ydsToGo = firstFiniteNumber(row, ['ydstogo', 'yards_to_go']);
  const qbDropback = truthyNumber(row, ['qb_dropback']) || pass;
  const qbHit = truthyNumber(row, ['qb_hit']) || Boolean(firstValue(row, ['qb_hit_1_player_id', 'qb_hit_2_player_id'], ''));
  // nflfastR documents qb_hit as a binary play indicator and also exposes the
  // individual QB-hit player IDs. The ID fallback protects against rows where the
  // aggregate indicator is blank while a credited hit player is present.
  const pressureFlag = truthyNumber(row, ['was_pressure', 'pressure']) || qbHit || sack;
  const hurryFlag = truthyNumber(row, ['qb_hurry', 'hurry']) || (pressureFlag && !qbHit && !sack);
  // Blitz is sourced from nflverse FTN charting, not assumed to exist in normal nflfastR PBP.
  const nflversePlayId = String(firstValue(row, ['play_id'], '') || '').trim();
  const charting = gameId && nflversePlayId ? ftnChartingByPlay?.get(`${gameId}|${nflversePlayId}`) : null;
  const hasChartedBlitz = charting != null && Number.isFinite(charting.nBlitzers);
  const blitzFlag = hasChartedBlitz ? charting.nBlitzers > 0 : false;
  const yardsAfterContact = firstFiniteNumber(row, ['yards_after_contact', 'rushing_yards_after_contact']);
  const explicitYardsBeforeContact = firstFiniteNumber(row, ['yards_before_contact', 'rushing_yards_before_contact']);
  const yardsBeforeContact = Number.isFinite(explicitYardsBeforeContact)
    ? explicitYardsBeforeContact
    : Number.isFinite(yardsAfterContact)
      ? yards - yardsAfterContact
      : NaN;
  const scorePts = scoringPointsForRow(row);
  const offensivePlay = shouldUsePbpPlay(row) && isOffensivePbpPlay(row);
  const specialTeamsPlay = shouldUsePbpPlay(row) && isSpecialTeamsPbpPlay(row);

  if (posteam && metrics.has(posteam)) {
    const offense = metrics.get(posteam);
    if (gameId) offense.gamesSet.add(gameId);

    const driveObj = ensureDrive(offense, gameId, posteam, row);
    if (driveObj && scorePts) {
      driveObj.points += scorePts;
      driveObj.score = true;
    }
    if (driveObj && td) driveObj.touchdown = true;
    if (driveObj && firstDown) driveObj.firstDown = true;

    if (scorePts) {
      offense.offensivePoints += scorePts;
      if (qtr === 1 || qtr === 2) offense.firstHalfPoints += scorePts;
      if (qtr === 3 || qtr === 4 || qtr === 5) offense.secondHalfPoints += scorePts;
      if (qtr === 4) offense.fourthQuarterPoints += scorePts;
    }

    if (specialTeamsPlay) {
      offense.specialTeamsEpa += epa;
      offense.specialTeamsPlays += 1;
    }

    if (truthyNumber(row, ['field_goal_attempt'])) {
      const dist = firstNumber(row, ['kick_distance'], 0);
      offense.fgAtt += 1;
      if (dist >= 40) offense.fgAtt40 += 1;
      if (dist >= 50) offense.fgAtt50 += 1;
      if (String(firstValue(row, ['field_goal_result'], '')).toLowerCase() === 'made') {
        offense.fgMade += 1;
        offense.longestFg = offense.longestFg == null ? dist : Math.max(offense.longestFg, dist);
        if (dist >= 40) offense.fgMade40 += 1;
        if (dist >= 50) offense.fgMade50 += 1;
      }
    }

    if (truthyNumber(row, ['extra_point_attempt'])) {
      offense.xpAtt += 1;
      if (String(firstValue(row, ['extra_point_result'], '')).toLowerCase() === 'good') offense.xpMade += 1;
    }

    if (truthyNumber(row, ['punt_attempt'])) {
      offense.punts += 1;
      offense.puntYards += firstNumber(row, ['kick_distance'], 0);
      offense.puntReturnYardsAllowed += Math.max(0, firstNumber(row, ['return_yards'], 0));
      if (truthyNumber(row, ['punt_inside_twenty'])) offense.puntInside20 += 1;
      if (truthyNumber(row, ['touchback'])) offense.puntTouchbacks += 1;
    }

    if (offensivePlay) {
      offense.plays += 1;
      offense.epa += epa;
      offense.yards += yards;
      if (driveObj) driveObj.plays += 1;
      if (success) offense.successes += 1;
      if (firstDown) offense.firstDowns += 1;
      if (turnover) offense.turnovers += 1;
      if (interception) offense.interceptionsThrown += 1;
      if (fumbleLost) offense.fumblesLost += 1;
      if (Number.isFinite(halfSeconds) && halfSeconds <= 120) {
        offense.twoMinuteEpa += epa;
        offense.twoMinutePlays += 1;
      }
      if (noHuddle) offense.noHuddlePlays += 1;
      if (noHuddle || (Number.isFinite(playClock) && playClock <= 10) || (Number.isFinite(halfSeconds) && halfSeconds <= 120)) {
        offense.hurryUpPlays += 1;
      }

      if (pass) {
        offense.passPlays += 1;
        offense.passEpa += epa;
        if (completePass) offense.completions += 1;
        offense.passYards += yards;
        if (passTd) offense.passTds += 1;
        if (sack) offense.sacksTaken += 1;
        if (success) offense.passSuccesses += 1;
        if (yards >= 20) offense.explosivePasses += 1;
      }
      if (qbDropback) {
        offense.passDropbacks += 1;
        if (pressureFlag) offense.pressuresAllowed += 1;
        if (qbHit) offense.qbHitsAllowed += 1;
        if (hurryFlag) offense.hurriesAllowed += 1;
        if (hasChartedBlitz) {
          offense.chartedBlitzDropbacksFaced += 1;
          if (blitzFlag) offense.blitzesFaced += 1;
        }

        const passerId = String(firstValue(row, ['passer_player_id'], '') || '').trim();
        const passerName = String(firstValue(row, ['passer_player_name'], '') || '').trim();
        if (passerId || passerName) {
          const passerKey = passerId || `name:${passerName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          let passer = offense.qbPassers.get(passerKey);
          if (!passer) {
            passer = {
              playerId: passerId || null,
              player: passerName || passerId,
              situations: {
                all: makeQbSituationAgg(),
                blitz: makeQbSituationAgg(),
                pressure: makeQbSituationAgg(),
                cleanPocket: makeQbSituationAgg(),
              },
            };
            offense.qbPassers.set(passerKey, passer);
          }

          const playType = String(firstValue(row, ['play_type'], '') || '').toLowerCase();
          const passAttempt = truthyNumber(row, ['pass_attempt']) || (!sack && playType === 'pass');
          const passingYardsValue = firstFiniteNumber(row, ['passing_yards']);
          const passingYards = passAttempt
            ? (Number.isFinite(passingYardsValue) ? passingYardsValue : yards)
            : 0;
          const qbPlay = { epa, success, passAttempt, completePass, passingYards };
          addQbSituationPlay(passer.situations.all, qbPlay);
          if (hasChartedBlitz && blitzFlag) addQbSituationPlay(passer.situations.blitz, qbPlay);
          addQbSituationPlay(passer.situations[pressureFlag ? 'pressure' : 'cleanPocket'], qbPlay);
        }
      }
      if (rush) {
        offense.rushPlays += 1;
        offense.rushEpa += epa;
        if (success) offense.rushSuccesses += 1;
        if (yards >= 10) offense.explosiveRuns += 1;
        if (yards <= 0) offense.stuffedRuns += 1;
        if (Number.isFinite(yardsBeforeContact)) {
          offense.yardsBeforeContactSum += yardsBeforeContact;
          offense.yardsBeforeContactRuns += 1;
        }

        const adjustedLineYards = adjustedLineYardsForCarry(yards);
        if (adjustedLineYards != null) {
          offense.adjustedLineYardsSum += adjustedLineYards;
          offense.adjustedLineYardsRuns += 1;
        }

        const isShortYardageRush = Number.isFinite(ydsToGo) && ydsToGo <= 2 && (down === 3 || down === 4 || String(firstValue(row, ['goal_to_go'], '')) === '1');
        if (isShortYardageRush) {
          offense.shortYardageRushes += 1;
          if (success || firstDown || td || truthyNumber(row, ['third_down_converted', 'fourth_down_converted'])) {
            offense.shortYardageRushSuccesses += 1;
          }
        }

        const isPowerRush = Number.isFinite(ydsToGo) && ydsToGo <= 2 && (down === 3 || down === 4);
        if (isPowerRush) {
          offense.powerRushes += 1;
          if (success || firstDown || td || truthyNumber(row, ['third_down_converted', 'fourth_down_converted'])) {
            offense.powerRushSuccesses += 1;
          }
        }
      }
      if (Number.isFinite(yardline100) && yardline100 <= 20 && driveObj) {
        const key = `${gameId}_${posteam}_${firstValue(row, ['fixed_drive', 'drive'], '')}`;
        offense.redZoneDrives.add(key);
        if (td) offense.redZoneTdDrives.add(key);
        if (td || scorePts > 0) offense.redZoneScoreDrives.add(key);
      }
      if (truthyNumber(row, ['goal_to_go']) && driveObj) {
        const key = `${gameId}_${posteam}_${firstValue(row, ['fixed_drive', 'drive'], '')}`;
        offense.goalToGoDrives.add(key);
        offense.goalToGoPlays += 1;
        if (success) offense.goalToGoSuccesses += 1;
        if (td) offense.goalToGoTdDrives.add(key);
      }
      if (down === 3) {
        offense.thirdDowns += 1;
        offense.thirdDownEpa += epa;
        if (firstDown || td || truthyNumber(row, ['third_down_converted'])) offense.thirdDownConversions += 1;
      }
      if (down === 4) {
        offense.fourthDowns += 1;
        if (firstDown || td || truthyNumber(row, ['fourth_down_converted'])) offense.fourthDownConversions += 1;
      }
    }
  }

  if (defteam && metrics.has(defteam)) {
    const defense = metrics.get(defteam);
    if (gameId) defense.defGamesSet.add(gameId);

    const defDriveObj = ensureDefDrive(defense, gameId, defteam, row);
    if (defDriveObj && scorePts && posteam !== defteam) {
      defDriveObj.points += scorePts;
      defDriveObj.score = true;
    }
    if (defDriveObj && td && posteam !== defteam) defDriveObj.touchdown = true;

    if (scorePts && posteam !== defteam) {
      defense.defFirstHalfPointsAllowed += (qtr === 1 || qtr === 2) ? scorePts : 0;
      defense.defSecondHalfPointsAllowed += (qtr === 3 || qtr === 4 || qtr === 5) ? scorePts : 0;
      defense.defFourthQuarterPointsAllowed += qtr === 4 ? scorePts : 0;
    }

    if (specialTeamsPlay && posteam !== defteam) {
      defense.specialTeamsEpa -= epa;
      defense.specialTeamsPlays += 1;
    }

    if (truthyNumber(row, ['punt_attempt'])) {
      const retYards = firstNumber(row, ['return_yards'], 0);
      if (retYards > 0) {
        defense.puntReturns += 1;
        defense.puntReturnYards += retYards;
        if (truthyNumber(row, ['return_touchdown'])) defense.puntReturnTds += 1;
      }
    }

    if (truthyNumber(row, ['kickoff_attempt'])) {
      const retYards = firstNumber(row, ['return_yards'], 0);
      if (retYards > 0) {
        defense.kickReturns += 1;
        defense.kickReturnYards += retYards;
        if (truthyNumber(row, ['return_touchdown'])) defense.kickReturnTds += 1;
      }
    }

    if (offensivePlay) {
      defense.defPlays += 1;
      defense.defEpaAllowed += epa;
      defense.defYardsAllowed += yards;
      if (success) defense.defSuccessesAllowed += 1;
      if (firstDown) defense.defFirstDownsAllowed += 1;
      if (turnover) defense.defTurnoversForced += 1;
      if (interception) defense.defInterceptionsForced += 1;
      if (fumbleForced) defense.defFumblesForced += 1;
      if (Number.isFinite(halfSeconds) && halfSeconds <= 120) {
        defense.defTwoMinuteEpaAllowed += epa;
        defense.defTwoMinutePlays += 1;
      }
      if (pass) {
        defense.defPassPlays += 1;
        defense.defPassEpaAllowed += epa;
        defense.defPassYardsAllowed += yards;
        if (completePass) defense.defCompletionsAllowed += 1;
        if (passTd) defense.defPassTdsAllowed += 1;
        if (interception) defense.defInterceptionsForcedAsPassDefense += 1;
        if (success) defense.defPassSuccessesAllowed += 1;
        if (yards >= 20) defense.defExplosivePassesAllowed += 1;
      }
      if (qbDropback) {
        defense.defPassDropbacks += 1;
        if (hasChartedBlitz) {
          defense.defChartedBlitzDropbacks += 1;
          if (blitzFlag) defense.defBlitzes += 1;
        }
        if (pressureFlag) defense.defPressures += 1;
        if (qbHit) defense.defQbHits += 1;
        if (hurryFlag) defense.defHurries += 1;
      }
      if (rush) {
        defense.defRushPlays += 1;
        defense.defRushEpaAllowed += epa;
        if (success) defense.defRushSuccessesAllowed += 1;
        if (yards >= 10) defense.defExplosiveRunsAllowed += 1;
        if (yards < 0) defense.defTacklesForLoss += 1;
        if (yards <= 0) defense.defStuffedRuns += 1;
        if (Number.isFinite(yardsBeforeContact)) {
          defense.defRushYardsBeforeContactAllowedSum += yardsBeforeContact;
          defense.defRushYardsBeforeContactAllowedRuns += 1;
        }
        const adjustedLineYardsAllowed = adjustedLineYardsForCarry(yards);
        if (adjustedLineYardsAllowed != null) {
          defense.defAdjustedLineYardsAllowedSum += adjustedLineYardsAllowed;
          defense.defAdjustedLineYardsAllowedRuns += 1;
        }
      }

      const isShortYardageDefensePlay = Number.isFinite(ydsToGo) && ydsToGo <= 2 && (down === 3 || down === 4);
      if (isShortYardageDefensePlay) {
        const converted = firstDown || td || truthyNumber(row, ['third_down_converted', 'fourth_down_converted']);
        defense.defShortYardagePlays += 1;
        if (converted) defense.defShortYardageConversionsAllowed += 1;
        else defense.defShortYardageStops += 1;
      }
      if (Number.isFinite(yardline100) && yardline100 <= 20) {
        const key = `${gameId}_${posteam}_${firstValue(row, ['fixed_drive', 'drive'], '')}`;
        defense.defRedZoneDrives.add(key);
        if (td) defense.defRedZoneTdDrivesAllowed.add(key);
        if (td || scorePts > 0) defense.defRedZoneScoreDrivesAllowed.add(key);
      }
      if (truthyNumber(row, ['goal_to_go'])) {
        const key = `${gameId}_${posteam}_${firstValue(row, ['fixed_drive', 'drive'], '')}`;
        defense.defGoalToGoDrivesAllowed.add(key);
        if (td) defense.defGoalToGoTdDrivesAllowed.add(key);
      }
      if (down === 3) {
        defense.defThirdDowns += 1;
        if (firstDown || td || truthyNumber(row, ['third_down_converted'])) defense.defThirdDownConversionsAllowed += 1;
      }
      if (down === 4) {
        defense.defFourthDowns += 1;
        if (firstDown || td || truthyNumber(row, ['fourth_down_converted'])) defense.defFourthDownConversionsAllowed += 1;
      }
    }
  }

  return true;
}

function finalizePbpMetrics(metrics) {
  for (const m of metrics.values()) {
    m.qbSituational = [...(m.qbPassers?.values?.() || [])]
      .map((passer) => ({
        playerId: passer.playerId,
        player: passer.player,
        dropbacks: passer.situations?.all?.dropbacks || 0,
        situations: Object.fromEntries(Object.entries(passer.situations || {}).map(([key, bucket]) => [key, finalizeQbSituationAgg(bucket)])),
      }))
      .filter((passer) => passer.dropbacks > 0)
      .sort((a, b) => b.dropbacks - a.dropbacks)
      .slice(0, 4);
    delete m.qbPassers;

    const driveValues = [...m.drives.values()];
    m.driveCount = driveValues.length;
    m.tdDrives = driveValues.filter((d) => d.touchdown).length;
    m.scoreDrives = driveValues.filter((d) => d.score || d.points > 0).length;
    m.successfulDrives = driveValues.filter((d) => d.touchdown || d.firstDown || d.points > 0).length;
    m.drivePoints = driveValues.reduce((acc, d) => acc + (d.points || 0), 0);
    m.possessionSeconds = driveValues.reduce((acc, d) => {
      if (d.maxGameSeconds != null && d.minGameSeconds != null) return acc + Math.max(0, d.maxGameSeconds - d.minGameSeconds);
      return acc;
    }, 0);
    const startYards = driveValues.map((d) => d.startYardline100).filter((v) => Number.isFinite(v));
    m.avgDriveStartYardline100 = average(startYards);
    const durations = driveValues
      .map((d) => d.maxGameSeconds != null && d.minGameSeconds != null && d.plays > 1 ? (d.maxGameSeconds - d.minGameSeconds) / d.plays : null)
      .filter((v) => Number.isFinite(v) && v >= 0 && v <= 120);
    m.secondsPerPlay = average(durations);

    const drivesByGame = new Map();
    for (const d of driveValues) {
      if (!drivesByGame.has(d.gameId)) drivesByGame.set(d.gameId, []);
      drivesByGame.get(d.gameId).push(d);
    }
    let openingCount = 0;
    let openingScores = 0;
    let openingTds = 0;
    for (const list of drivesByGame.values()) {
      list.sort((a, b) => a.driveNumber - b.driveNumber);
      const first = list[0];
      if (!first) continue;
      openingCount += 1;
      if (first.score || first.points > 0) openingScores += 1;
      if (first.touchdown) openingTds += 1;
    }
    m.openingDriveCount = openingCount;
    m.openingDriveScoreCount = openingScores;
    m.openingDriveTdCount = openingTds;

    const defDriveValues = [...(m.defDrives?.values?.() || [])];
    const defStartYards = defDriveValues.map((d) => d.startYardline100).filter((v) => Number.isFinite(v));
    m.defAvgDriveStartYardline100 = average(defStartYards);
    const defDrivesByGame = new Map();
    for (const d of defDriveValues) {
      if (!defDrivesByGame.has(d.gameId)) defDrivesByGame.set(d.gameId, []);
      defDrivesByGame.get(d.gameId).push(d);
    }
    let defOpeningCount = 0;
    let defOpeningScores = 0;
    let defOpeningTds = 0;
    for (const list of defDrivesByGame.values()) {
      list.sort((a, b) => a.driveNumber - b.driveNumber);
      const first = list[0];
      if (!first) continue;
      defOpeningCount += 1;
      if (first.score || first.points > 0) defOpeningScores += 1;
      if (first.touchdown) defOpeningTds += 1;
    }
    m.defOpeningDriveCount = defOpeningCount;
    m.defOpeningDriveScoreCount = defOpeningScores;
    m.defOpeningDriveTdCount = defOpeningTds;

    m.games = m.gamesSet.size || m.defGamesSet.size || 1;
    m.defGames = m.defGamesSet.size || m.games;

    delete m.drives;
    delete m.defDrives;
    delete m.gamesSet;
    delete m.defGamesSet;
  }
  return metrics;
}

function makeQbSituationAgg() {
  return { dropbacks: 0, epa: 0, successes: 0, attempts: 0, completions: 0, passingYards: 0 };
}

function addQbSituationPlay(bucket, { epa, success, passAttempt, completePass, passingYards }) {
  bucket.dropbacks += 1;
  bucket.epa += Number.isFinite(epa) ? epa : 0;
  if (success) bucket.successes += 1;
  if (!passAttempt) return;
  bucket.attempts += 1;
  if (completePass) bucket.completions += 1;
  bucket.passingYards += Number.isFinite(passingYards) ? passingYards : 0;
}

function finalizeQbSituationAgg(bucket) {
  const dropbacks = Number(bucket?.dropbacks || 0);
  const attempts = Number(bucket?.attempts || 0);
  return {
    dropbacks,
    epaPerDropback: dropbacks ? bucket.epa / dropbacks : null,
    successPct: dropbacks ? (bucket.successes / dropbacks) * 100 : null,
    compPct: attempts ? (bucket.completions / attempts) * 100 : null,
    yardsPerAttempt: attempts ? bucket.passingYards / attempts : null,
    attempts,
  };
}

async function streamPbpTeamMetrics(seasons, teams, ranges, ftnChartingByPlay = null) {
  const metrics = new Map();
  for (const team of teams) metrics.set(team, makePbpAgg(team));
  let rowsScanned = 0;
  let rowsUsed = 0;

  for (const season of seasons) {
    const url = PBP_URL(season);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SportsEdgeAI/1.0', Accept: 'application/gzip,application/octet-stream,text/csv,*/*' }
    });
    if (!res.ok) throw new Error(`PBP fetch failed ${res.status}: ${url}`);
    if (!res.body) throw new Error('PBP response body stream unavailable');

    let stream = res.body;
    try { stream = stream.pipeThrough(new DecompressionStream('gzip')); } catch (err) {}

    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let headers = null;
    let wantedIndexes = null;
    let leftover = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = leftover + value;
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (!headers) {
          headers = parseCsvLine(line).map((h) => h.trim());
          wantedIndexes = wantedPbpColumnIndexes(headers);
          continue;
        }
        rowsScanned += 1;
        const values = parseCsvLine(line);
        const row = rowFromHeaders(headers, values, wantedIndexes);
        if (addPbpRowToMetrics(row, metrics, ranges, ftnChartingByPlay)) rowsUsed += 1;
      }
    }
    if (leftover) {
      if (!headers) {
        headers = parseCsvLine(leftover).map((h) => h.trim());
        wantedIndexes = wantedPbpColumnIndexes(headers);
      } else {
        rowsScanned += 1;
        const values = parseCsvLine(leftover);
        const row = rowFromHeaders(headers, values, wantedIndexes);
        if (addPbpRowToMetrics(row, metrics, ranges, ftnChartingByPlay)) rowsUsed += 1;
      }
    }
  }

  return { metrics: finalizePbpMetrics(metrics), rowsScanned, rowsUsed };
}

function setStatValue(stats, name, value, decimals = 1, suffix = '') {
  const found = (stats || []).find((s) => String(s.name).toLowerCase() === String(name).toLowerCase());
  if (!found) return;
  found.value = value == null || !Number.isFinite(value) ? null : round(value, decimals);
  found.displayValue = display(value, decimals, suffix);
}

function setStatRecordValue(stats, name, value) {
  const found = (stats || []).find((s) => String(s.name).toLowerCase() === String(name).toLowerCase());
  if (!found) return;
  found.value = value || '—';
  found.displayValue = value || '—';
}


function statValueNumber(stats, name) {
  const found = (stats || []).find((s) => String(s.name).toLowerCase() === String(name).toLowerCase());
  if (!found) return null;
  const n = Number(String(found.value ?? found.displayValue ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

function nflPasserRating(completions, attempts, yards, touchdowns, interceptions) {
  if (!attempts || attempts <= 0) return null;
  const cap = (v) => Math.max(0, Math.min(2.375, v));
  const a = cap(((completions / attempts) - 0.3) * 5);
  const b = cap(((yards / attempts) - 3) * 0.25);
  const c = cap((touchdowns / attempts) * 20);
  const d = cap(2.375 - ((interceptions / attempts) * 25));
  return ((a + b + c + d) / 6) * 100;
}

function formatPossession(secondsPerGame) {
  if (secondsPerGame == null || !Number.isFinite(secondsPerGame)) return '—';
  const total = Math.max(0, Math.round(secondsPerGame));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function applyPbpMetricsToStats(stats, pbp) {
  if (!pbp || !pbp.plays) return stats;
  const games = Math.max(pbp.games || 1, 1);
  const defGames = Math.max(pbp.defGames || games, 1);

  setStatValue(stats, 'epaPerPlay', safeDiv(pbp.epa, pbp.plays), 3);
  setStatValue(stats, 'successRate', pct(pbp.successes, pbp.plays), 1, '%');
  setStatValue(stats, 'driveSuccessRate', pct(pbp.successfulDrives, pbp.driveCount), 1, '%');
  setStatValue(stats, 'pointsPerDrive', safeDiv(pbp.drivePoints, pbp.driveCount), 2);
  setStatValue(stats, 'tdsPerDrive', safeDiv(pbp.tdDrives, pbp.driveCount), 2);
  setStatValue(stats, 'firstDownsPerGame', safeDiv(pbp.firstDowns, games), 1);
  setStatValue(stats, 'firstDownRate', pct(pbp.firstDowns, pbp.plays), 1, '%');
  setStatValue(stats, 'turnoverRate', pct(pbp.turnovers, pbp.plays), 1, '%');
  setStatRecordValue(stats, 'timeOfPossession', formatPossession(safeDiv(pbp.possessionSeconds, games)));
  setStatValue(stats, 'expectedPointsGenerated', safeDiv(pbp.epa, games), 2);
  setStatValue(stats, 'noHuddleRate', pct(pbp.noHuddlePlays, pbp.plays), 1, '%');
  setStatValue(stats, 'hurryUpRate', pct(pbp.hurryUpPlays, pbp.plays), 1, '%');
  setStatValue(stats, 'secondsPerPlay', pbp.secondsPerPlay, 1);
  setStatValue(stats, 'neutralPace', pbp.secondsPerPlay, 1);
  setStatValue(stats, 'openingDriveTdPct', pct(pbp.openingDriveTdCount, pbp.openingDriveCount), 1, '%');
  setStatValue(stats, 'openingDriveScorePct', pct(pbp.openingDriveScoreCount, pbp.openingDriveCount), 1, '%');
  setStatValue(stats, 'firstHalfPoints', safeDiv(pbp.firstHalfPoints, games), 1);
  setStatValue(stats, 'secondHalfPoints', safeDiv(pbp.secondHalfPoints, games), 1);
  setStatValue(stats, 'fourthQuarterPoints', safeDiv(pbp.fourthQuarterPoints, games), 1);
  setStatValue(stats, 'twoMinuteOffenseEpa', safeDiv(pbp.twoMinuteEpa, pbp.twoMinutePlays), 3);

  setStatValue(stats, 'passEpaPerPlay', safeDiv(pbp.passEpa, pbp.passPlays), 3);
  setStatValue(stats, 'passSuccessRate', pct(pbp.passSuccesses, pbp.passPlays), 1, '%');
  setStatValue(stats, 'explosivePassRate', pct(pbp.explosivePasses, pbp.passPlays), 1, '%');
  setStatValue(stats, 'interceptionRate', pct(pbp.interceptionsThrown, pbp.passPlays), 1, '%');
  const passAttempts = Math.max(pbp.passPlays || 0, 0);
  const passerRating = nflPasserRating(pbp.completions, passAttempts, pbp.passYards, pbp.passTds, pbp.interceptionsThrown);
  setStatValue(stats, 'qbRating', passerRating, 1);
  setStatValue(stats, 'passerRating', passerRating, 1);
  setStatValue(stats, 'pressureRateAllowed', pct(pbp.pressuresAllowed, pbp.passDropbacks), 1, '%');
  if (pbp.chartedBlitzDropbacksFaced > 0) setStatValue(stats, 'blitzRateFaced', pct(pbp.blitzesFaced, pbp.chartedBlitzDropbacksFaced), 1, '%');
  setStatValue(stats, 'pressurePctAllowed', pct(pbp.pressuresAllowed, pbp.passDropbacks), 1, '%');
  setStatValue(stats, 'hurryPct', pct(pbp.hurriesAllowed, pbp.passDropbacks), 1, '%');
  setStatValue(stats, 'qbHitsAllowed', safeDiv(pbp.qbHitsAllowed, games), 1);
  setStatValue(stats, 'qbHitPct', safeDiv(pbp.defQbHits, games), 1);
  setStatValue(stats, 'quarterbackHitPercentage', safeDiv(pbp.defQbHits, games), 1);
  setStatValue(stats, 'qbHitsPerGame', safeDiv(pbp.defQbHits, games), 1);
  setStatValue(stats, 'qbHits', safeDiv(pbp.defQbHits, games), 1);
  if (pbp.timeToThrowSum > 0) setStatValue(stats, 'timeToThrow', safeDiv(pbp.timeToThrowSum, pbp.timeToThrowCount), 2);

  setStatValue(stats, 'pressureRate', pct(pbp.defPressures, pbp.defPassDropbacks), 1, '%');
  setStatValue(stats, 'hurryRate', pct(pbp.defHurries, pbp.defPassDropbacks), 1, '%');
  setStatValue(stats, 'manCoverageRate', pbp.manCoverageRate, 1, '%');
  setStatValue(stats, 'manCoveragePct', pbp.manCoverageRate, 1, '%');
  setStatValue(stats, 'zoneCoverageRate', pbp.zoneCoverageRate, 1, '%');
  setStatValue(stats, 'zoneCoveragePct', pbp.zoneCoverageRate, 1, '%');
  if (pbp.defChartedBlitzDropbacks > 0) setStatValue(stats, 'blitzRate', pct(pbp.defBlitzes, pbp.defChartedBlitzDropbacks), 1, '%');
  if (pbp.defChartedBlitzDropbacks > 0) setStatValue(stats, 'blitzPct', pct(pbp.defBlitzes, pbp.defChartedBlitzDropbacks), 1, '%');
  setStatValue(stats, 'rushEpaPerPlay', safeDiv(pbp.rushEpa, pbp.rushPlays), 3);
  setStatValue(stats, 'rushSuccessRate', pct(pbp.rushSuccesses, pbp.rushPlays), 1, '%');
  setStatValue(stats, 'explosiveRunRate', pct(pbp.explosiveRuns, pbp.rushPlays), 1, '%');
  setStatValue(stats, 'stuffRate', pct(pbp.stuffedRuns, pbp.rushPlays), 1, '%');
  setStatValue(stats, 'stuffRateAllowed', pct(pbp.stuffedRuns, pbp.rushPlays), 1, '%');
  setStatValue(stats, 'powerSuccessRate', pct(pbp.powerRushSuccesses, pbp.powerRushes), 1, '%');
  if (pbp.yardsBeforeContactRuns > 0) setStatValue(stats, 'yardsBeforeContact', safeDiv(pbp.yardsBeforeContactSum, pbp.yardsBeforeContactRuns), 2);
  setStatValue(stats, 'adjustedLineYards', safeDiv(pbp.adjustedLineYardsSum, pbp.adjustedLineYardsRuns), 2);
  setStatValue(stats, 'shortYardageSuccess', pct(pbp.shortYardageRushSuccesses, pbp.shortYardageRushes), 1, '%');
  setStatValue(stats, 'redZoneTripsPerGame', safeDiv(pbp.redZoneDrives.size, games), 1);
  setStatValue(stats, 'redZoneTdPct', pct(pbp.redZoneTdDrives.size, pbp.redZoneDrives.size), 1, '%');
  setStatValue(stats, 'redZoneScorePct', pct(pbp.redZoneScoreDrives.size, pbp.redZoneDrives.size), 1, '%');
  setStatValue(stats, 'goalToGoTdPct', pct(pbp.goalToGoTdDrives.size, pbp.goalToGoDrives.size), 1, '%');
  setStatValue(stats, 'goalToGoSuccessRate', pct(pbp.goalToGoSuccesses, pbp.goalToGoPlays), 1, '%');
  setStatValue(stats, 'thirdDownConversionPct', pct(pbp.thirdDownConversions, pbp.thirdDowns), 1, '%');
  setStatValue(stats, 'thirdDownEpa', safeDiv(pbp.thirdDownEpa, pbp.thirdDowns), 3);
  setStatValue(stats, 'fourthDownConversionPct', pct(pbp.fourthDownConversions, pbp.fourthDowns), 1, '%');
  setStatValue(stats, 'fourthDownAttemptsPerGame', safeDiv(pbp.fourthDowns, games), 1);

  setStatValue(stats, 'defensiveEpaPerPlay', safeDiv(pbp.defEpaAllowed, pbp.defPlays), 3);
  setStatValue(stats, 'defensiveSuccessRate', pct(pbp.defSuccessesAllowed, pbp.defPlays), 1, '%');
  setStatValue(stats, 'pointsAllowedPerDrive', safeDiv(pbp.drivePoints, pbp.driveCount), 2);
  setStatValue(stats, 'turnoversForced', safeDiv(pbp.defTurnoversForced, defGames), 1);
  setStatValue(stats, 'forcedFumbles', safeDiv(pbp.defFumblesForced, defGames), 2);
  setStatValue(stats, 'takeawayRate', pct(pbp.defTurnoversForced, pbp.defPlays), 1, '%');
  setStatValue(stats, 'interceptions', safeDiv(pbp.defInterceptionsForced, defGames), 1);
  setStatValue(stats, 'passingYardsAllowedPerGame', safeDiv(pbp.defPassYardsAllowed, defGames), 1); setStatValue(stats, 'passingAttemptsAllowedPerGame', safeDiv(pbp.defPassPlays, defGames), 1); setStatValue(stats, 'completionsAllowedPerGame', safeDiv(pbp.defCompletionsAllowed, defGames), 1); setStatValue(stats, 'yardsPerCompletionAllowed', safeDiv(pbp.defPassYardsAllowed, pbp.defCompletionsAllowed), 2); setStatValue(stats, 'completionPctAllowed', pct(pbp.defCompletionsAllowed, pbp.defPassPlays), 1, '%'); setStatValue(stats, 'yardsPerAttemptAllowed', safeDiv(pbp.defPassYardsAllowed, pbp.defPassPlays), 2); setStatValue(stats, 'passingTouchdownsAllowed', safeDiv(pbp.defPassTdsAllowed, defGames), 1); setStatValue(stats, 'passEpaAllowed', safeDiv(pbp.defPassEpaAllowed, pbp.defPassPlays), 3); setStatValue(stats, 'passEpaAllowedPerPlay', safeDiv(pbp.defPassEpaAllowed, pbp.defPassPlays), 3); setStatValue(stats, 'passingEpaAllowed', safeDiv(pbp.defPassEpaAllowed, pbp.defPassPlays), 3);
  setStatValue(stats, 'passSuccessRateAllowed', pct(pbp.defPassSuccessesAllowed, pbp.defPassPlays), 1, '%');
  setStatValue(stats, 'explosivePassRateAllowed', pct(pbp.defExplosivePassesAllowed, pbp.defPassPlays), 1, '%');
  const passerRatingAllowed = nflPasserRating(
    pbp.defCompletionsAllowed,
    pbp.defPassPlays,
    pbp.defPassYardsAllowed,
    pbp.defPassTdsAllowed,
    pbp.defInterceptionsForcedAsPassDefense
  );
  setStatValue(stats, 'qbRatingAllowed', passerRatingAllowed, 1);
  setStatValue(stats, 'passerRatingAllowed', passerRatingAllowed, 1);
  setStatValue(stats, 'rushEpaAllowed', safeDiv(pbp.defRushEpaAllowed, pbp.defRushPlays), 3);
  setStatValue(stats, 'rushEpaAllowedPerPlay', safeDiv(pbp.defRushEpaAllowed, pbp.defRushPlays), 3);
  setStatValue(stats, 'rushingEpaAllowed', safeDiv(pbp.defRushEpaAllowed, pbp.defRushPlays), 3);
  setStatValue(stats, 'rushSuccessRateAllowed', pct(pbp.defRushSuccessesAllowed, pbp.defRushPlays), 1, '%');
  setStatValue(stats, 'explosiveRunRateAllowed', pct(pbp.defExplosiveRunsAllowed, pbp.defRushPlays), 1, '%');
  if (pbp.defRushYardsBeforeContactAllowedSum > 0) setStatValue(stats, 'yardsBeforeContactAllowed', safeDiv(pbp.defRushYardsBeforeContactAllowedSum, defGames), 1);
  if (pbp.defRushYardsBeforeContactAllowedSum > 0) setStatValue(stats, 'rushYardsBeforeContactAllowed', safeDiv(pbp.defRushYardsBeforeContactAllowedSum, defGames), 1);
  setStatValue(stats, 'adjustedLineYardsAllowed', safeDiv(pbp.defAdjustedLineYardsAllowedSum, pbp.defAdjustedLineYardsAllowedRuns), 2);
  setStatValue(stats, 'alyAllowed', safeDiv(pbp.defAdjustedLineYardsAllowedSum, pbp.defAdjustedLineYardsAllowedRuns), 2);
  setStatValue(stats, 'stuffRate', pct(pbp.defStuffedRuns, pbp.defRushPlays), 1, '%'); setStatValue(stats, 'defStuffRate', pct(pbp.defStuffedRuns, pbp.defRushPlays), 1, '%');
  setStatValue(stats, 'shortYardageStopPct', pct(pbp.defShortYardageStops, pbp.defShortYardagePlays), 1, '%'); setStatValue(stats, 'shortYardageDefense', pct(pbp.defShortYardageStops, pbp.defShortYardagePlays), 1, '%');
  setStatValue(stats, 'shortYardageSuccessAllowed', pct(pbp.defShortYardageConversionsAllowed, pbp.defShortYardagePlays), 1, '%'); setStatValue(stats, 'tackleForLossPct', pct(pbp.defTacklesForLoss, pbp.defRushPlays), 1, '%'); setStatValue(stats, 'tflPct', pct(pbp.defTacklesForLoss, pbp.defRushPlays), 1, '%');
  setStatValue(stats, 'tacklesForLoss', safeDiv(pbp.defTacklesForLoss, defGames), 1); setStatValue(stats, 'redZoneTdPctAllowed', pct(pbp.defRedZoneTdDrivesAllowed.size, pbp.defRedZoneDrives.size), 1, '%');
  setStatValue(stats, 'redZoneScorePctAllowed', pct(pbp.defRedZoneScoreDrivesAllowed.size, pbp.defRedZoneDrives.size), 1, '%'); setStatValue(stats, 'goalToGoTdPctAllowed', pct(pbp.defGoalToGoTdDrivesAllowed.size, pbp.defGoalToGoDrivesAllowed.size), 1, '%');
  setStatValue(stats, 'thirdDownPctAllowed', pct(pbp.defThirdDownConversionsAllowed, pbp.defThirdDowns), 1, '%'); setStatValue(stats, 'fourthDownPctAllowed', pct(pbp.defFourthDownConversionsAllowed, pbp.defFourthDowns), 1, '%');
  setStatValue(stats, 'firstHalfPointsAllowed', safeDiv(pbp.defFirstHalfPointsAllowed, defGames), 1); setStatValue(stats, 'secondHalfPointsAllowed', safeDiv(pbp.defSecondHalfPointsAllowed, defGames), 1);
  setStatValue(stats, 'fourthQuarterPointsAllowed', safeDiv(pbp.defFourthQuarterPointsAllowed, defGames), 1); setStatValue(stats, 'twoMinuteDefenseEpa', safeDiv(pbp.defTwoMinuteEpaAllowed, pbp.defTwoMinutePlays), 3);
  setStatValue(stats, 'openingDriveScorePctAllowed', pct(pbp.defOpeningDriveScoreCount, pbp.defOpeningDriveCount), 1, '%');
  setStatValue(stats, 'fieldGoalPct', pct(pbp.fgMade, pbp.fgAtt), 1, '%'); setStatValue(stats, 'extraPointPct', pct(pbp.xpMade, pbp.xpAtt), 1, '%');
  setStatRecordValue(stats, 'fieldGoalsMade40Plus', pbp.fgAtt40 ? `${pbp.fgMade40}/${pbp.fgAtt40}` : '—'); setStatRecordValue(stats, 'fieldGoalsMade50Plus', pbp.fgAtt50 ? `${pbp.fgMade50}/${pbp.fgAtt50}` : '—');
  setStatValue(stats, 'fieldGoalPct40Plus', pct(pbp.fgMade40, pbp.fgAtt40), 1, '%'); setStatValue(stats, 'fieldGoalPct50Plus', pct(pbp.fgMade50, pbp.fgAtt50), 1, '%');
  setStatValue(stats, 'longFieldGoalMade', pbp.longestFg, 0);
  setStatRecordValue(stats, 'fieldGoalsMadeFieldGoalsAttempted', pbp.fgAtt ? `${pbp.fgMade}/${pbp.fgAtt}` : '—'); setStatRecordValue(stats, 'extraPointsMadeExtraPointsAttempted', pbp.xpAtt ? `${pbp.xpMade}/${pbp.xpAtt}` : '—');
  setStatValue(stats, 'grossAvgPuntYards', safeDiv(pbp.puntYards, pbp.punts), 1); setStatValue(stats, 'netAvgPuntYards', safeDiv(pbp.puntYards - pbp.puntReturnYardsAllowed - (pbp.puntTouchbacks * 20), pbp.punts), 1);
  setStatValue(stats, 'inside20Pct', pct(pbp.puntInside20, pbp.punts), 1, '%'); setStatValue(stats, 'puntTouchbackPct', pct(pbp.puntTouchbacks, pbp.punts), 1, '%');
  setStatValue(stats, 'puntReturnYardsAllowed', pbp.puntReturnYardsAllowed, 0); setStatValue(stats, 'punts', pbp.punts, 0); setStatValue(stats, 'puntYards', pbp.puntYards, 0);
  setStatValue(stats, 'kickReturnAverage', safeDiv(pbp.kickReturnYards, pbp.kickReturns), 1); setStatValue(stats, 'kickReturnTouchdowns', pbp.kickReturnTds, 0);
  setStatValue(stats, 'kickReturns', pbp.kickReturns, 0); setStatValue(stats, 'kickReturnYards', pbp.kickReturnYards, 0);
  setStatValue(stats, 'puntReturnAverage', safeDiv(pbp.puntReturnYards, pbp.puntReturns), 1); setStatValue(stats, 'puntReturnTouchdowns', pbp.puntReturnTds, 0);
  setStatValue(stats, 'puntReturns', pbp.puntReturns, 0); setStatValue(stats, 'puntReturnYards', pbp.puntReturnYards, 0);
  const ownFp = pbp.avgDriveStartYardline100 == null ? null : 100 - pbp.avgDriveStartYardline100;
  const oppFp = pbp.defAvgDriveStartYardline100 == null ? null : 100 - pbp.defAvgDriveStartYardline100;
  setStatValue(stats, 'avgStartingFieldPosition', ownFp, 1); setStatValue(stats, 'avgDriveStartYardLine', ownFp, 1);
  setStatValue(stats, 'oppAvgStartingFieldPosition', oppFp, 1); setStatValue(stats, 'oppAvgDriveStartYardLine', oppFp, 1);
  setStatValue(stats, 'netFieldPosition', ownFp != null && oppFp != null ? ownFp - oppFp : null, 1); setStatValue(stats, 'hiddenYards', ownFp != null && oppFp != null ? (ownFp - oppFp) * safeDiv(pbp.driveCount, games) : null, 1);
  setStatValue(stats, 'specialTeamsEPA', safeDiv(pbp.specialTeamsEpa, pbp.specialTeamsPlays), 3); setStatValue(stats, 'specialTeamsEpaPerPlay', safeDiv(pbp.specialTeamsEpa, pbp.specialTeamsPlays), 3);

  return stats;
}

function teamStats(summary, scheduleAgg = null) {
  const scheduleGames = scheduleAgg?.games || 0;
  const games = Math.max(scheduleGames || summary.games || 1, 1);
  const passAttempts = sum(summary, ['attempts', 'passing_attempts', 'pass_attempts']);
  const completions = sum(summary, ['completions', 'passing_completions']);
  const passYards = sum(summary, ['passing_yards', 'pass_yards']);
  const passTD = sum(summary, ['passing_tds', 'passing_touchdowns', 'pass_touchdowns']);
  const interceptions = sum(summary, ['interceptions', 'interceptions_thrown']);
  const sacksAllowed = sum(summary, ['sacks_suffered', 'sacks_allowed', 'sacks_taken']);
  const rushAttempts = sum(summary, ['carries', 'rushing_attempts', 'rush_attempts']);
  const rushYards = sum(summary, ['rushing_yards', 'rush_yards']);
  const rushTD = sum(summary, ['rushing_tds', 'rushing_touchdowns', 'rush_touchdowns']);
  const totalYards = passYards + rushYards;
  const plays = passAttempts + sacksAllowed + rushAttempts;
  const turnovers = interceptions + sum(summary, ['fumbles_lost', 'lost_fumbles']);
  const fgMade = sum(summary, ['fg_made', 'field_goals_made']);
  const fgAtt = sum(summary, ['fg_att', 'field_goals_attempted']);
  const xpMade = sum(summary, ['pat_made', 'xp_made', 'extra_points_made']);
  const xpAtt = sum(summary, ['pat_att', 'xp_att', 'extra_points_attempted']);
  const punts = sum(summary, ['punts']);
  const puntYards = sum(summary, ['punt_yards']);
  const puntReturns = sum(summary, ['punt_returns']);
  const puntReturnYards = sum(summary, ['punt_return_yards']);
  const kickReturns = sum(summary, ['kickoff_returns', 'kick_returns']);
  const kickReturnYards = sum(summary, ['kickoff_return_yards', 'kick_return_yards']);

  const stats = [];

  // Overall offense
  stats.push(statNumber('pointsPerGame', scheduleAgg ? safeDiv(scheduleAgg.pointsFor, games) : perGame(summary, ['points', 'total_points', 'team_points', 'total_tds']), 1));
  stats.push(statNumber('yardsPerGame', totalYards ? totalYards / games : perGame(summary, ['total_yards', 'yards']), 1));
  stats.push(statNumber('playsPerGame', plays ? plays / games : perGame(summary, ['plays']), 1));
  stats.push(statNumber('yardsPerPlay', safeDiv(totalYards || sum(summary, ['total_yards']), plays || sum(summary, ['plays'])), 2));
  stats.push(statNumber('epaPerPlay', mean(summary, ['epa_per_play', 'offensive_epa_per_play']), 3));
  stats.push(statNumber('successRate', mean(summary, ['success_rate', 'offensive_success_rate']), 1, '%'));
  stats.push(statRecord('offensiveDVOA', '—')); stats.push(statRecord('driveSuccessRate', '—')); stats.push(statRecord('pointsPerDrive', '—')); stats.push(statRecord('tdsPerDrive', '—'));
  stats.push(statNumber('firstDownsPerGame', perGame(summary, ['first_downs']), 1));
  stats.push(statNumber('firstDownRate', mean(summary, ['first_down_rate']), 1, '%'));
  stats.push(statRecord('timeOfPossession', '—'));
  stats.push(statNumber('turnoverRate', pct(turnovers, plays), 1, '%'));
  stats.push(statNumber('penaltiesPerGame', perGame(summary, ['penalties']), 1));
  stats.push(statNumber('penaltyYardsPerGame', perGame(summary, ['penalty_yards']), 1));

  // Passing offense
  stats.push(statNumber('passingYardsPerGame', passYards / games, 1));
  stats.push(statNumber('passingAttemptsPerGame', passAttempts / games, 1));
  stats.push(statNumber('completionsPerGame', completions / games, 1));
  stats.push(statNumber('completionPct', pct(completions, passAttempts), 1, '%'));
  stats.push(statNumber('yardsPerAttempt', safeDiv(passYards, passAttempts), 2));
  stats.push(statNumber('netYardsPerAttempt', safeDiv(passYards, passAttempts + sacksAllowed), 2));
  stats.push(statNumber('passingTouchdownsPerGame', passTD / games, 1));
  stats.push(statNumber('interceptionRate', pct(interceptions, passAttempts), 1, '%'));
  stats.push(statNumber('sackRateAllowed', pct(sacksAllowed, passAttempts + sacksAllowed), 1, '%'));
  stats.push(statNumber('passEpaPerPlay', mean(summary, ['pass_epa_per_play', 'passing_epa_per_play']), 3));
  stats.push(statNumber('passSuccessRate', mean(summary, ['pass_success_rate', 'passing_success_rate']), 1, '%'));
  stats.push(statNumber('explosivePassRate', mean(summary, ['explosive_pass_rate', 'explosive_pass_pct']), 1, '%'));
  stats.push(statNumber('airYardsPerAttempt', safeDiv(sum(summary, ['passing_air_yards', 'air_yards']), passAttempts), 1));
  stats.push(statNumber('averageDepthOfTarget', safeDiv(sum(summary, ['passing_air_yards', 'air_yards']), passAttempts), 1));
  stats.push(statRecord('pressureRateAllowed', '—'));
  stats.push(statRecord('blitzRateFaced', '—'));
  stats.push(statNumber('qbRating', nflPasserRating(completions, passAttempts, passYards, passTD, interceptions), 1));
  stats.push(statNumber('passerRating', nflPasserRating(completions, passAttempts, passYards, passTD, interceptions), 1));
  stats.push(statRecord('expectedPointsGenerated', '—'));

  // Protection
  stats.push(statNumber('sacksAllowedPerGame', sacksAllowed / games, 1));
  stats.push(statRecord('pressurePct', '—')); stats.push(statRecord('hurryPct', '—')); stats.push(statRecord('qbHitsAllowed', '—')); stats.push(statRecord('passBlockWinRate', '—')); stats.push(statRecord('timeToThrow', '—'));

  // Rushing offense
  stats.push(statNumber('rushingYardsPerGame', rushYards / games, 1));
  stats.push(statNumber('rushingAttemptsPerGame', rushAttempts / games, 1)); stats.push(statInteger('totalRushAttempts', rushAttempts));
  stats.push(statNumber('yardsPerCarry', safeDiv(rushYards, rushAttempts), 2));
  stats.push(statNumber('rushingTouchdownsPerGame', rushTD / games, 1));
  stats.push(statNumber('rushEpaPerPlay', mean(summary, ['rush_epa_per_play', 'rushing_epa_per_play']), 3));
  stats.push(statNumber('rushSuccessRate', mean(summary, ['rush_success_rate', 'rushing_success_rate']), 1, '%'));
  stats.push(statNumber('explosiveRunRate', mean(summary, ['explosive_run_rate', 'explosive_rush_rate']), 1, '%'));
  stats.push(statRecord('stuffRate', '—')); stats.push(statRecord('stuffRateAllowed', '—')); stats.push(statRecord('powerSuccessRate', '—')); stats.push(statRecord('openFieldYards', '—')); stats.push(statRecord('secondLevelYards', '—'));

  // OL
  stats.push(statRecord('yardsBeforeContact', '—')); stats.push(statRecord('adjustedLineYards', '—')); stats.push(statRecord('runBlockWinRate', '—')); stats.push(statRecord('shortYardageSuccess', '—')); stats.push(statRecord('stuffRateAllowed', '—'));

  // Situational offense
  stats.push(statRecord('redZoneTripsPerGame', '—')); stats.push(statNumber('redZoneTdPct', mean(summary, ['red_zone_td_pct', 'redzone_td_pct']), 1, '%'));
  stats.push(statRecord('redZoneScorePct', '—')); stats.push(statRecord('goalToGoTdPct', '—')); stats.push(statRecord('goalToGoSuccessRate', '—'));
  stats.push(statNumber('thirdDownConversionPct', mean(summary, ['third_down_pct', 'third_down_conversion_pct']), 1, '%'));
  stats.push(statRecord('thirdDownEpa', '—'));
  stats.push(statNumber('fourthDownConversionPct', mean(summary, ['fourth_down_pct', 'fourth_down_conversion_pct']), 1, '%'));
  stats.push(statRecord('fourthDownAttemptsPerGame', '—'));
  stats.push(statRecord('secondsPerPlay', '—')); stats.push(statRecord('neutralPace', '—')); stats.push(statRecord('noHuddleRate', '—')); stats.push(statRecord('hurryUpRate', '—')); stats.push(statRecord('openingDriveTdPct', '—')); stats.push(statRecord('openingDriveScorePct', '—')); stats.push(statRecord('firstHalfPoints', '—')); stats.push(statRecord('secondHalfPoints', '—')); stats.push(statRecord('fourthQuarterPoints', '—')); stats.push(statRecord('twoMinuteOffenseEpa', '—'));

  // Defense — populated where weekly opponent/team schedule data allows it.
  stats.push(statNumber('pointsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.pointsAllowed, games) : null, 1));
  stats.push(statNumber('yardsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.yardsAllowed, games) : null, 1));
  stats.push(statNumber('playsFacedPerGame', scheduleAgg ? safeDiv(scheduleAgg.playsFaced, games) : null, 1));
  stats.push(statNumber('yardsPerPlayAllowed', scheduleAgg ? safeDiv(scheduleAgg.yardsAllowed, scheduleAgg.playsFaced) : null, 2));
  stats.push(statRecord('defensiveEpaPerPlay', '—')); stats.push(statRecord('defensiveSuccessRate', '—')); stats.push(statRecord('defensiveDVOA', '—')); stats.push(statRecord('pointsAllowedPerDrive', '—'));
  stats.push(statNumber('turnoversForced', scheduleAgg ? safeDiv(scheduleAgg.turnoversForced, games) : null, 1));
  stats.push(statNumber('takeawayRate', scheduleAgg ? pct(scheduleAgg.turnoversForced, scheduleAgg.playsFaced) : null, 1, '%'));

  stats.push(statNumber('passingYardsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.passYardsAllowed, games) : null, 1));
  stats.push(statNumber('completionPctAllowed', scheduleAgg ? pct(scheduleAgg.completionsAllowed, scheduleAgg.attemptsFaced) : null, 1, '%'));
  stats.push(statNumber('yardsPerAttemptAllowed', scheduleAgg ? safeDiv(scheduleAgg.passYardsAllowed, scheduleAgg.attemptsFaced) : null, 2));
  stats.push(statNumber('passingTouchdownsAllowed', scheduleAgg ? safeDiv(scheduleAgg.passTdsAllowed, games) : null, 1));
  stats.push(statNumber('interceptions', scheduleAgg ? safeDiv(scheduleAgg.interceptionsForced, games) : null, 1));
  stats.push(statRecord('passEpaAllowed', '—')); stats.push(statRecord('passEpaAllowedPerPlay', '—')); stats.push(statRecord('passingEpaAllowed', '—')); stats.push(statRecord('passSuccessRateAllowed', '—')); stats.push(statRecord('explosivePassRateAllowed', '—'));
  stats.push(statNumber('airYardsAllowed', scheduleAgg ? safeDiv(scheduleAgg.airYardsAllowed, scheduleAgg.attemptsFaced) : null, 1));
  stats.push(statNumber('qbRatingAllowed', scheduleAgg ? nflPasserRating(scheduleAgg.completionsAllowed, scheduleAgg.attemptsFaced, scheduleAgg.passYardsAllowed, scheduleAgg.passTdsAllowed, scheduleAgg.interceptionsForced) : null, 1));
  stats.push(statNumber('passerRatingAllowed', scheduleAgg ? nflPasserRating(scheduleAgg.completionsAllowed, scheduleAgg.attemptsFaced, scheduleAgg.passYardsAllowed, scheduleAgg.passTdsAllowed, scheduleAgg.interceptionsForced) : null, 1));

  stats.push(statNumber('sackRate', scheduleAgg ? pct(scheduleAgg.sacks, scheduleAgg.attemptsFaced + scheduleAgg.sacks) : null, 1, '%'));
  stats.push(statNumber('sacksPerGame', scheduleAgg ? safeDiv(scheduleAgg.sacks, games) : null, 1));
  stats.push(statRecord('pressureRate', '—')); stats.push(statRecord('qbHitsPerGame', '—')); stats.push(statRecord('hurryRate', '—')); stats.push(statRecord('blitzRate', '—')); stats.push(statRecord('blitzPct', '—')); stats.push(statRecord('passRushWinRate', '—'));
  stats.push(statNumber('passingAttemptsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.attemptsFaced, games) : null, 1));
  stats.push(statNumber('completionsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.completionsAllowed, games) : null, 1));
  stats.push(statRecord('manCoverageRate', '—')); stats.push(statRecord('zoneCoverageRate', '—'));
  stats.push(statNumber('yardsPerCompletionAllowed', scheduleAgg ? safeDiv(scheduleAgg.passYardsAllowed, scheduleAgg.completionsAllowed) : null, 2));

  stats.push(statNumber('rushingYardsAllowedPerGame', scheduleAgg ? safeDiv(scheduleAgg.rushYardsAllowed, games) : null, 1));
  stats.push(statNumber('rushAttemptsFaced', scheduleAgg ? safeDiv(scheduleAgg.rushAttemptsFaced, games) : null, 1));
  stats.push(statNumber('yardsPerCarryAllowed', scheduleAgg ? safeDiv(scheduleAgg.rushYardsAllowed, scheduleAgg.rushAttemptsFaced) : null, 2));
  stats.push(statRecord('rushEpaAllowed', '—')); stats.push(statRecord('rushEpaAllowedPerPlay', '—')); stats.push(statRecord('rushingEpaAllowed', '—')); stats.push(statRecord('rushSuccessRateAllowed', '—')); stats.push(statRecord('explosiveRunRateAllowed', '—')); stats.push(statRecord('missedTacklePct', '—')); stats.push(statRecord('yardsBeforeContactAllowed', '—')); stats.push(statRecord('adjustedLineYardsAllowed', '—')); stats.push(statRecord('runStopRate', '—')); stats.push(statRecord('defStuffRate', '—')); stats.push(statRecord('shortYardageStopPct', '—')); stats.push(statRecord('shortYardageDefense', '—')); stats.push(statRecord('shortYardageSuccessAllowed', '—')); stats.push(statRecord('tackleForLossPct', '—')); stats.push(statRecord('tacklesForLoss', '—')); stats.push(statRecord('forcedFumbles', '—'));

  stats.push(statRecord('redZoneTdPctAllowed', '—')); stats.push(statRecord('redZoneScorePctAllowed', '—')); stats.push(statRecord('goalToGoTdPctAllowed', '—')); stats.push(statRecord('thirdDownPctAllowed', '—')); stats.push(statRecord('fourthDownPctAllowed', '—')); stats.push(statRecord('openingDriveScorePctAllowed', '—')); stats.push(statRecord('firstHalfPointsAllowed', '—')); stats.push(statRecord('secondHalfPointsAllowed', '—')); stats.push(statRecord('fourthQuarterPointsAllowed', '—')); stats.push(statRecord('twoMinuteDefenseEpa', '—'));

  // Special teams
  stats.push(statNumber('fieldGoalPct', pct(fgMade, fgAtt), 1, '%'));
  stats.push(statNumber('extraPointPct', pct(xpMade, xpAtt), 1, '%'));
  stats.push(statRecord('fieldGoalsMade40Plus', '—')); stats.push(statRecord('fieldGoalsMade50Plus', '—')); stats.push(statRecord('fieldGoalPct40Plus', '—')); stats.push(statRecord('fieldGoalPct50Plus', '—')); stats.push(statRecord('longFieldGoalMade', '—'));
  stats.push(statRecord('fieldGoalsMadeFieldGoalsAttempted', fgAtt ? `${fgMade}/${fgAtt}` : '—'));
  stats.push(statRecord('extraPointsMadeExtraPointsAttempted', xpAtt ? `${xpMade}/${xpAtt}` : '—'));
  stats.push(statNumber('grossAvgPuntYards', safeDiv(puntYards, punts), 1));
  stats.push(statRecord('netAvgPuntYards', '—')); stats.push(statRecord('inside20Pct', '—')); stats.push(statRecord('puntTouchbackPct', '—')); stats.push(statRecord('puntReturnYardsAllowed', '—'));
  stats.push(statInteger('punts', punts));
  stats.push(statInteger('puntYards', puntYards));
  stats.push(statNumber('kickReturnAverage', safeDiv(kickReturnYards, kickReturns), 1));
  stats.push(statRecord('kickReturnTouchdowns', '—')); stats.push(statInteger('kickReturns', kickReturns)); stats.push(statInteger('kickReturnYards', kickReturnYards));
  stats.push(statNumber('puntReturnAverage', safeDiv(puntReturnYards, puntReturns), 1));
  stats.push(statRecord('puntReturnTouchdowns', '—')); stats.push(statInteger('puntReturns', puntReturns)); stats.push(statInteger('puntReturnYards', puntReturnYards));
  stats.push(statRecord('avgStartingFieldPosition', '—')); stats.push(statRecord('oppAvgStartingFieldPosition', '—')); stats.push(statRecord('avgDriveStartYardLine', '—')); stats.push(statRecord('oppAvgDriveStartYardLine', '—')); stats.push(statRecord('hiddenYards', '—')); stats.push(statRecord('specialTeamsDVOA', '—')); stats.push(statRecord('specialTeamsEPA', '—')); stats.push(statRecord('specialTeamsEpaPerPlay', '—')); stats.push(statRecord('netFieldPosition', '—')); stats.push(statRecord('kickCoverageGrade', '—')); stats.push(statRecord('puntCoverageGrade', '—'));

  return stats;
}



const NFL_STAT_HIGHER_IS_BETTER = {
  interceptionRate: false, sackRateAllowed: false, pressureRateAllowed: false, pressurePctAllowed: false,
  hurriesAllowed: false, hurryPct: false, turnoverRate: false, penaltiesPerGame: false,
  penaltyYardsPerGame: false, stuffRate: false,
  pointsAllowedPerGame: false, yardsAllowedPerGame: false,
  yardsPerPlayAllowed: false, defensiveEpaPerPlay: false, epaAllowedPerPlay: false,
  defensiveSuccessRate: false, successRateAllowed: false, pointsAllowedPerDrive: false,
  passingYardsAllowedPerGame: false, completionPctAllowed: false, yardsPerAttemptAllowed: false,
  passingTouchdownsAllowed: false, passEpaAllowed: false, passEpaAllowedPerPlay: false,
  passingEpaAllowed: false, passSuccessRateAllowed: false, passingSuccessRateAllowed: false,
  explosivePassRateAllowed: false, explosivePassPctAllowed: false, airYardsAllowed: false,
  qbRatingAllowed: false, passerRatingAllowed: false, cpoeAllowed: false,
  rushingYardsAllowedPerGame: false, yardsPerCarryAllowed: false,
  rushEpaAllowed: false, rushEpaAllowedPerPlay: false, rushingEpaAllowed: false,
  rushSuccessRateAllowed: false, rushingSuccessRateAllowed: false, explosiveRunRateAllowed: false,
  explosiveRushRateAllowed: false, missedTacklePct: false, yardsBeforeContactAllowed: false,
  adjustedLineYardsAllowed: false, shortYardageSuccessAllowed: false,
  redZoneTdPctAllowed: false, redZoneTouchdownPctAllowed: false, redZoneScorePctAllowed: false,
  goalToGoTdPctAllowed: false, thirdDownPctAllowed: false, thirdDownConversionPctAllowed: false,
  fourthDownPctAllowed: false, openingDriveScorePctAllowed: false,
  firstHalfPointsAllowed: false, secondHalfPointsAllowed: false, fourthQuarterPointsAllowed: false,
  twoMinuteDefenseEpa: false, puntReturnYardsAllowed: false,
  oppAvgStartingFieldPosition: false, oppAvgDriveStartYardLine: false,
  passingAttemptsAllowedPerGame: false, completionsAllowedPerGame: false, yardsPerCompletionAllowed: false,
};

function statRawNumberForRank(stat) {
  if (!stat) return null;
  const raw = stat.value ?? stat.displayValue;
  if (raw == null || raw === '' || raw === '—') return null;
  const n = Number(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildLeagueTeamSet(teamRows, schedules, ranges) {
  const teams = new Set();
  for (const row of teamRows || []) { const team = teamFromRow(row); if (team) teams.add(team); }
  for (const g of schedules || []) {
    const gSeason = num(g.season, 0);
    const gWeek = num(g.week, 0);
    if (!gWeek) continue;
    const inRange = ranges.some((r) => Number(r.season) === gSeason && gWeek >= r.minWeek && gWeek <= r.maxWeek);
    if (!inRange) continue;
    const away = normalizeTeam(g.away_team);
    const home = normalizeTeam(g.home_team);
    if (away) teams.add(away);
    if (home) teams.add(home);
  }
  return teams;
}

function addLeagueRanksToStats(targetStats, leagueStatsByTeam) {
  if (!Array.isArray(targetStats) || !leagueStatsByTeam?.size) return targetStats;

  const statsByName = new Map();
  for (const [team, stats] of leagueStatsByTeam.entries()) {
    for (const stat of stats || []) {
      const name = stat?.name;
      if (!name) continue;
      const value = statRawNumberForRank(stat);
      if (value == null) continue;
      if (!statsByName.has(name)) statsByName.set(name, []);
      statsByName.get(name).push({ team, value });
    }
  }

  const rankMaps = new Map();
  for (const [name, rows] of statsByName.entries()) {
    if (!rows.length) continue;
    const higherIsBetter = NFL_STAT_HIGHER_IS_BETTER[name] !== false;
    rows.sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);

    const rankMap = new Map();
    let currentRank = 1;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].value !== rows[i - 1].value) currentRank = i + 1;
      rankMap.set(rows[i].team, { rank: currentRank, leagueTeamsRanked: rows.length });
    }
    rankMaps.set(name, rankMap);
  }

  return targetStats.map((stat) => {
    const name = stat?.name;
    const team = normalizeTeam(stat?.team || '');
    if (!name || !team) return stat;
    const ranked = rankMaps.get(name)?.get(team);
    if (!ranked) return stat;
    return {
      ...stat,
      rank: ranked.rank,
      rankDisplay: `#${ranked.rank}`,
      leagueTeamsRanked: ranked.leagueTeamsRanked,
    };
  });
}

const NFL_PROPS_OPPONENT_METRIC_CONFIG = {
  'Opp Pass Defense': { statNames: ['passingYardsAllowedPerGame'], suffix: ' YPG' },
  'Opp Run Defense': { statNames: ['rushingYardsAllowedPerGame'], suffix: ' YPG' },
  'Opp Pressure Rate': { statNames: ['pressureRate'], suffix: '%' },
  'Opp Sack Rate': { statNames: ['sackRate'], suffix: '%' },
  'Opp Man Coverage %': { statNames: ['manCoverageRate', 'manCoveragePct'], suffix: '%' },
  'Opp Zone Coverage %': { statNames: ['zoneCoverageRate', 'zoneCoveragePct'], suffix: '%' },
  'Opp Explosive Pass Rate': { statNames: ['explosivePassRateAllowed'], suffix: '%' },
  'Opp Explosive Run Rate': { statNames: ['explosiveRunRateAllowed', 'explosiveRushRateAllowed'], suffix: '%' },
  'Opp Stuff Rate': { statNames: ['defStuffRate', 'stuffRate'], suffix: '%' },
  'Opp INTs Forced': { statNames: ['interceptions', 'turnoversForced'], suffix: '/G' },
};

function propsClientTeamAbbr(team) {
  const normalized = normalizeTeam(team);
  return normalized === 'WAS' ? 'WSH' : normalized;
}

function buildNFLPropsOpponentMetricsByTeam(leagueStatsByTeam, source = 'nflverse') {
  const out = {};
  if (!leagueStatsByTeam?.size) return out;

  for (const [team, baseStats] of leagueStatsByTeam.entries()) {
    const rankedStats = addLeagueRanksToStats(baseStats, leagueStatsByTeam);
    const metrics = {};

    for (const [label, config] of Object.entries(NFL_PROPS_OPPONENT_METRIC_CONFIG)) {
      const wanted = config.statNames.map((name) => String(name).toLowerCase());
      const row = (rankedStats || []).find((stat) => wanted.includes(String(stat?.name || '').toLowerCase()));
      if (!row) continue;

      const value = statRawNumberForRank(row);
      if (!Number.isFinite(value)) continue;
      const rank = Number(row?.rank);
      const displayValue = row?.displayValue && row.displayValue !== '—'
        ? row.displayValue
        : `${value}${config.suffix || ''}`;

      metrics[label] = {
        value,
        displayValue,
        rank: Number.isFinite(rank) ? rank : null,
        source,
        statName: row?.name || null,
      };
    }

    const key = propsClientTeamAbbr(team);
    if (key && Object.keys(metrics).length) out[key] = metrics;
  }

  return out;
}

function buildRankedTeamStats(stats, team) {
  return (stats || []).map((stat) => ({ ...stat, team }));
}

function statDisplayFromList(stats, names) {
  const wanted = names.map((name) => String(name).toLowerCase());
  const found = (stats || []).find((stat) => wanted.includes(String(stat?.name || '').toLowerCase()));
  return found?.displayValue ?? found?.value ?? '—';
}

function statNumberFromList(stats, names) {
  const wanted = names.map((name) => String(name).toLowerCase());
  const found = (stats || []).find((stat) => wanted.includes(String(stat?.name || '').toLowerCase()));
  if (!found) return null;
  const raw = found.value ?? found.displayValue;
  const n = Number(String(raw).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

function matchupEdge(offenseValue, defenseValue, inverse = false) {
  const off = Number(String(offenseValue ?? '').replace('%', '').trim());
  const def = Number(String(defenseValue ?? '').replace('%', '').trim());
  if (!Number.isFinite(off) || !Number.isFinite(def)) return 'neutral';
  if (off === def) return 'neutral';

  // For offense-vs-defense rows, higher offense is usually better and lower defense allowed is better.
  // Example: offense yards/play 5.8 vs defense yards/play allowed 5.0 favors defense.
  if (inverse) return off < def ? 'offense' : 'defense';
  return off > def ? 'offense' : 'defense';
}

function buildMatchupRow(label, offenseStats, defenseStats, offenseNames, defenseNames, inverse = false) {
  const offense = statDisplayFromList(offenseStats, offenseNames);
  const defense = statDisplayFromList(defenseStats, defenseNames);
  return {
    label,
    offense,
    defense,
    edge: matchupEdge(
      statNumberFromList(offenseStats, offenseNames),
      statNumberFromList(defenseStats, defenseNames),
      inverse
    ),
  };
}

function buildOneMatchup(offenseTeam, defenseTeam, offenseStats, defenseStats) {
  return {
    offenseTeam,
    defenseTeam,
    passing: [
      buildMatchupRow('Pass EPA/Play', offenseStats, defenseStats, ['passEpaPerPlay'], ['passEpaAllowed']),
      buildMatchupRow('Pass Success Rate', offenseStats, defenseStats, ['passSuccessRate'], ['passSuccessRateAllowed']),
      buildMatchupRow('Explosive Pass Rate', offenseStats, defenseStats, ['explosivePassRate'], ['explosivePassRateAllowed']),
      buildMatchupRow('Yards/Attempt', offenseStats, defenseStats, ['yardsPerAttempt'], ['yardsPerAttemptAllowed']),
      buildMatchupRow('Completion %', offenseStats, defenseStats, ['completionPct'], ['completionPctAllowed']),
      buildMatchupRow('Pass Yards/Game', offenseStats, defenseStats, ['passingYardsPerGame'], ['passingYardsAllowedPerGame']),
      buildMatchupRow('Sack Rate', offenseStats, defenseStats, ['sackRateAllowed'], ['sackRate'], true),
      buildMatchupRow('Air Yards/Attempt', offenseStats, defenseStats, ['airYardsPerAttempt'], ['airYardsAllowed']),
    ],
    rushing: [
      buildMatchupRow('Rush EPA/Play', offenseStats, defenseStats, ['rushEpaPerPlay'], ['rushEpaAllowed']),
      buildMatchupRow('Rush Success Rate', offenseStats, defenseStats, ['rushSuccessRate'], ['rushSuccessRateAllowed']),
      buildMatchupRow('Explosive Run Rate', offenseStats, defenseStats, ['explosiveRunRate'], ['explosiveRunRateAllowed']),
      buildMatchupRow('Yards/Carry', offenseStats, defenseStats, ['yardsPerCarry'], ['yardsPerCarryAllowed']),
      buildMatchupRow('Rush Yards/Game', offenseStats, defenseStats, ['rushingYardsPerGame'], ['rushingYardsAllowedPerGame']),
      buildMatchupRow('Rush Attempts/Game', offenseStats, defenseStats, ['rushingAttemptsPerGame'], ['rushAttemptsFaced']),
      buildMatchupRow('Stuff Rate Allowed', offenseStats, defenseStats, ['stuffRateAllowed'], ['defStuffRate', 'stuffRate'], true),
      buildMatchupRow('Short Yardage Conversion', offenseStats, defenseStats, ['shortYardageSuccess', 'powerSuccessRate'], ['shortYardageStopPct', 'shortYardageDefense']),
    ],
    overall: [
      buildMatchupRow('EPA/Play', offenseStats, defenseStats, ['epaPerPlay'], ['defensiveEpaPerPlay']),
      buildMatchupRow('Success Rate', offenseStats, defenseStats, ['successRate'], ['defensiveSuccessRate']),
      buildMatchupRow('Red Zone TD %', offenseStats, defenseStats, ['redZoneTdPct'], ['redZoneTdPctAllowed']),
      buildMatchupRow('3rd Down %', offenseStats, defenseStats, ['thirdDownConversionPct'], ['thirdDownPctAllowed']),
      buildMatchupRow('4th Down %', offenseStats, defenseStats, ['fourthDownConversionPct'], ['fourthDownPctAllowed']),
      buildMatchupRow('Points/Game', offenseStats, defenseStats, ['pointsPerGame'], ['pointsAllowedPerGame']),
      buildMatchupRow('Yards/Game', offenseStats, defenseStats, ['yardsPerGame'], ['yardsAllowedPerGame']),
      buildMatchupRow('Plays/Game', offenseStats, defenseStats, ['playsPerGame'], ['playsFacedPerGame']),
      buildMatchupRow('Yards/Play', offenseStats, defenseStats, ['yardsPerPlay'], ['yardsPerPlayAllowed']),
      buildMatchupRow('Turnover Rate', offenseStats, defenseStats, ['turnoverRate'], ['takeawayRate'], true),
    ],
  };
}

function buildMatchupAnalyzer(awayTeam, homeTeam, awayStats, homeStats) {
  return {
    defaultView: 'awayOffenseVsHomeDefense',
    awayOffenseVsHomeDefense: buildOneMatchup(awayTeam, homeTeam, awayStats, homeStats),
    homeOffenseVsAwayDefense: buildOneMatchup(homeTeam, awayTeam, homeStats, awayStats),
  };
}

function recordString(wins, losses, ties = 0) {
  if (ties) return `${wins}-${losses}-${ties}`;
  return `${wins}-${losses}`;
}

function formatSigned(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value).toFixed(decimals);
  return value > 0 ? `+${rounded}` : rounded;
}

function getScheduleTotalLine(g) {
  return num(firstValue(g, ['total_line', 'total', 'over_under', 'ou', 'closing_total'], ''), NaN);
}

function getScheduleSpreadLine(g) {
  return num(firstValue(g, ['spread_line', 'spread', 'closing_spread'], ''), NaN);
}

function getGameDateLabel(g) {
  const raw = firstValue(g, ['gameday', 'game_date', 'date'], '');
  if (!raw) return `${g.season || ''} Wk ${g.week || ''}`.trim();
  const d = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function pctRecord(wins, losses, pushes = 0) {
  const total = wins + losses + pushes;
  if (!total) return '—';
  return `${recordString(wins, losses, pushes)} (${display(pct(wins, total), 1, '%')})`;
}

function buildH2H(schedules, awayTeam, homeTeam, season, week) {
  const away = normalizeTeam(awayTeam);
  const home = normalizeTeam(homeTeam);
  const past = schedules
    .filter((g) => {
      const gSeason = num(g.season, 0);
      const gWeek = num(g.week, 0);
      const gAway = normalizeTeam(g.away_team);
      const gHome = normalizeTeam(g.home_team);
      const sameTeams = [gAway, gHome].includes(away) && [gAway, gHome].includes(home);
      const before = gSeason < season || (gSeason === season && gWeek < week);
      const awayScore = num(g.away_score, NaN);
      const homeScore = num(g.home_score, NaN);
      return sameTeams && before && Number.isFinite(awayScore) && Number.isFinite(homeScore);
    })
    .sort((a, b) => {
      const aDate = String(firstValue(a, ['gameday', 'game_date', 'date'], ''));
      const bDate = String(firstValue(b, ['gameday', 'game_date', 'date'], ''));
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return String(b.game_id || '').localeCompare(String(a.game_id || ''));
    })
    .slice(0, 10);

  let homeWins = 0;
  let awayWins = 0;
  let ties = 0;
  let overs = 0;
  let unders = 0;
  let totalPushes = 0;
  let atsAway = 0;
  let atsHome = 0;
  let atsPushes = 0;
  let favoriteCovers = 0;
  let favoriteFails = 0;
  let favoritePushes = 0;
  let underdogCovers = 0;
  let underdogFails = 0;
  let underdogPushes = 0;
  const margins = [];
  const combined = [];
  const awayResults = [];
  const homeResults = [];
  const recentGames = [];

  for (const g of past) {
    const gAway = normalizeTeam(g.away_team);
    const gHome = normalizeTeam(g.home_team);
    const awayScore = num(g.away_score, NaN);
    const homeScore = num(g.home_score, NaN);
    if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;

    const requestedAwayWasActualAway = gAway === away;
    const reqAwayScore = requestedAwayWasActualAway ? awayScore : homeScore;
    const reqHomeScore = requestedAwayWasActualAway ? homeScore : awayScore;
    const reqAwayVenue = requestedAwayWasActualAway ? 'away' : 'home';
    const reqHomeVenue = requestedAwayWasActualAway ? 'home' : 'away';
    const reqAwayMargin = reqAwayScore - reqHomeScore;

    if (reqAwayScore > reqHomeScore) {
      awayWins += 1;
      awayResults.push('W');
      homeResults.push('L');
    } else if (reqHomeScore > reqAwayScore) {
      homeWins += 1;
      awayResults.push('L');
      homeResults.push('W');
    } else {
      ties += 1;
      awayResults.push('T');
      homeResults.push('T');
    }

    margins.push(reqAwayMargin);
    combined.push(reqAwayScore + reqHomeScore);

    const totalLine = getScheduleTotalLine(g);
    if (Number.isFinite(totalLine)) {
      const actualTotal = awayScore + homeScore;
      if (actualTotal > totalLine) overs += 1;
      else if (actualTotal < totalLine) unders += 1;
      else totalPushes += 1;
    }

    // nflverse schedule spread_line convention used here:
    //   positive = HOME team was favored by that many points
    //   negative = AWAY team was favored by that many points
    // Example: SEA at NE with spreadLine -4.5 means SEA -4.5, not NE -4.5.
    const spreadLine = getScheduleSpreadLine(g);
    let reqAwayAtsResult = '—';
    let reqHomeAtsResult = '—';
    let favoriteAtsResult = '—';
    let spreadFavoriteTeam = null;
    let spreadFavoriteLine = null;
    if (Number.isFinite(spreadLine)) {
      const homeFavored = spreadLine > 0;
      const awayFavored = spreadLine < 0;
      spreadFavoriteTeam = homeFavored ? gHome : awayFavored ? gAway : null;
      spreadFavoriteLine = spreadLine === 0 ? 0 : -Math.abs(spreadLine);

      const homeAtsMargin = homeScore - spreadLine - awayScore;
      const actualHomeCovered = homeAtsMargin > 0;
      const actualAwayCovered = homeAtsMargin < 0;
      const spreadPush = homeAtsMargin === 0;
      const requestedAwayCovered = requestedAwayWasActualAway ? actualAwayCovered : actualHomeCovered;
      const requestedHomeCovered = requestedAwayWasActualAway ? actualHomeCovered : actualAwayCovered;

      if (spreadPush) {
        atsPushes += 1;
        reqAwayAtsResult = 'P';
        reqHomeAtsResult = 'P';
      } else if (requestedAwayCovered) {
        atsAway += 1;
        reqAwayAtsResult = 'W';
        reqHomeAtsResult = 'L';
      } else if (requestedHomeCovered) {
        atsHome += 1;
        reqAwayAtsResult = 'L';
        reqHomeAtsResult = 'W';
      }

      if (spreadPush) {
        favoritePushes += 1;
        underdogPushes += 1;
        favoriteAtsResult = 'P';
      } else if ((homeFavored && actualHomeCovered) || (awayFavored && actualAwayCovered)) {
        favoriteCovers += 1;
        underdogFails += 1;
        favoriteAtsResult = 'W';
      } else if (homeFavored || awayFavored) {
        favoriteFails += 1;
        underdogCovers += 1;
        favoriteAtsResult = 'L';
      }
    }

    recentGames.push({
      season: g.season,
      week: g.week,
      date: getGameDateLabel(g),
      away_team: g.away_team,
      home_team: g.home_team,
      away_score: awayScore,
      home_score: homeScore,
      requestedAwayScore: reqAwayScore,
      requestedHomeScore: reqHomeScore,
      requestedAwayVenue: reqAwayVenue,
      requestedHomeVenue: reqHomeVenue,
      requestedAwayResult: awayResults[awayResults.length - 1],
      requestedHomeResult: homeResults[homeResults.length - 1],
      requestedAwayAtsResult: reqAwayAtsResult,
      requestedHomeAtsResult: reqHomeAtsResult,
      favoriteAtsResult,
      totalLine: Number.isFinite(totalLine) ? totalLine : null,
      spreadLine: Number.isFinite(spreadLine) ? spreadLine : null,
      spreadFavoriteTeam,
      spreadFavoriteLine,
      actualTotal: awayScore + homeScore,
    });
  }

  const meetings = past.length;
  const totalGamesWithLine = overs + unders + totalPushes;
  const atsGamesWithLine = atsAway + atsHome + atsPushes;
  const favoriteAtsGames = favoriteCovers + favoriteFails + favoritePushes;
  const underdogAtsGames = underdogCovers + underdogFails + underdogPushes;
  const avgMargin = average(margins);
  const avgCombined = average(combined);
  const last = recentGames[0];

  return {
    meetingsCount: meetings,
    homeRecord: meetings ? recordString(homeWins, awayWins, ties) : '—',
    awayRecord: meetings ? recordString(awayWins, homeWins, ties) : '—',
    atsRecord: atsGamesWithLine ? recordString(atsAway, atsHome, atsPushes) : '—',
    ouRecord: totalGamesWithLine ? recordString(overs, unders, totalPushes) : '—',
    awayLast10: meetings ? recordString(awayWins, homeWins, ties) : '—',
    homeLast10: meetings ? recordString(homeWins, awayWins, ties) : '—',
    awayH2HRecord: meetings ? recordString(awayWins, homeWins, ties) : '—',
    homeH2HRecord: meetings ? recordString(homeWins, awayWins, ties) : '—',
    awayATSRecord: atsGamesWithLine ? recordString(atsAway, atsHome, atsPushes) : '—',
    homeATSRecord: atsGamesWithLine ? recordString(atsHome, atsAway, atsPushes) : '—',
    awayRecentResults: awayResults.join(' ') || '—',
    homeRecentResults: homeResults.join(' ') || '—',
    awayAvgMargin: margins.length ? formatSigned(avgMargin, 1) : '—',
    homeAvgMargin: margins.length ? formatSigned(-avgMargin, 1) : '—',
    awayAvgCombinedPoints: combined.length ? display(avgCombined, 1) : '—',
    homeAvgCombinedPoints: combined.length ? display(avgCombined, 1) : '—',
    favoriteATS: favoriteAtsGames ? pctRecord(favoriteCovers, favoriteFails, favoritePushes) : '—',
    favoriteATSRecord: favoriteAtsGames ? recordString(favoriteCovers, favoriteFails, favoritePushes) : '—',
    favoriteATSPct: favoriteAtsGames ? display(pct(favoriteCovers, favoriteAtsGames), 1, '%') : '—',
    underdogATS: underdogAtsGames ? pctRecord(underdogCovers, underdogFails, underdogPushes) : '—',
    underdogATSRecord: underdogAtsGames ? recordString(underdogCovers, underdogFails, underdogPushes) : '—',
    underdogATSPct: underdogAtsGames ? display(pct(underdogCovers, underdogAtsGames), 1, '%') : '—',
    overRecord: totalGamesWithLine ? recordString(overs, unders, totalPushes) : '—',
    overPct: totalGamesWithLine ? display(pct(overs, totalGamesWithLine), 1, '%') : '—',
    underRecord: totalGamesWithLine ? recordString(unders, overs, totalPushes) : '—',
    underPct: totalGamesWithLine ? display(pct(unders, totalGamesWithLine), 1, '%') : '—',
    lastMeeting: last ? `${last.date}: ${last.away_team} ${last.away_score}, ${last.home_team} ${last.home_score}` : '—',
    lastMeetingAway: last ? `${last.requestedAwayResult} ${last.requestedAwayScore}-${last.requestedHomeScore}` : '—',
    lastMeetingHome: last ? `${last.requestedHomeResult} ${last.requestedHomeScore}-${last.requestedAwayScore}` : '—',
    recentGames,
  };
}

function average(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function emptyVsOpponent() {
  const empty = {
    awayRecord: '—', homeRecord: '—', awayATS: '—', homeATS: '—', awayOU: '—', homeOU: '—',
    awayPointsFor: '—', homePointsFor: '—', awayPointsAgainst: '—', homePointsAgainst: '—',
    awayAvgMargin: '—', homeAvgMargin: '—', awayLastMeeting: '—', homeLastMeeting: '—',
    awayRecentResults: '—', homeRecentResults: '—', awayQbTdInt: '—', homeQbTdInt: '—',
    awayQbPassYards: '—', homeQbPassYards: '—', awayQbRating: '—', homeQbRating: '—',
    awayQbSackRate: '—', homeQbSackRate: '—'
  };

  return {
    headCoach: { ...empty },
    offensiveCoordinator: { ...empty },
    defensiveCoordinator: { ...empty },
    qb: { ...empty }
  };
}


function nflLeagueContextCacheKey(season, week, timeframe = 'season') {
  return `nflverse_league_context_v8_${Number(season)}_wk${Number(week || 999)}_tf${timeframe}`;
}

function mapToEntries(value) {
  if (!value || typeof value.entries !== 'function') return [];
  return Array.from(value.entries());
}

function entriesToMap(value) {
  return new Map(Array.isArray(value) ? value : []);
}

function normalizeNFLLeagueContext(raw) {
  if (!raw) return null;
  const espnWinRates = raw.espnWinRates
    ? {
        ...raw.espnWinRates,
        metrics: entriesToMap(raw.espnWinRates.metricsEntries || raw.espnWinRates.metrics),
      }
    : null;

  return {
    schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
    teamRows: Array.isArray(raw.teamRows) ? raw.teamRows : [],
    pbpRowsScanned: Number(raw.pbpRowsScanned || 0),
    pbpRowsUsed: Number(raw.pbpRowsUsed || 0),
    ftnChartingRowsLoaded: Number(raw.ftnChartingRowsLoaded || 0),
    ngsPassingRowsUsed: Number(raw.ngsPassingRowsUsed || 0),
    pfrYbcRowsUsed: Number(raw.pfrYbcRowsUsed || 0),
    pbpMetricMap: entriesToMap(raw.pbpMetricEntries || raw.pbpMetricMap),
    espnWinRates,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    scrapedAt: raw.scrapedAt || null,
  };
}

function serializeNFLLeagueContext(context) {
  return {
    schedules: context.schedules || [],
    teamRows: context.teamRows || [],
    pbpRowsScanned: context.pbpRowsScanned || 0,
    pbpRowsUsed: context.pbpRowsUsed || 0,
    ftnChartingRowsLoaded: context.ftnChartingRowsLoaded || 0,
    ngsPassingRowsUsed: context.ngsPassingRowsUsed || 0,
    pfrYbcRowsUsed: context.pfrYbcRowsUsed || 0,
    pbpMetricEntries: mapToEntries(context.pbpMetricMap),
    espnWinRates: context.espnWinRates
      ? {
          source: context.espnWinRates.source,
          url: context.espnWinRates.url,
          parsedTeams: context.espnWinRates.parsedTeams,
          metricsEntries: mapToEntries(context.espnWinRates.metrics),
        }
      : null,
    warnings: context.warnings || [],
    scrapedAt: context.scrapedAt || new Date().toISOString(),
  };
}

async function readNFLLeagueContextCache(base44, season, week, ttlMs, timeframe = 'season') {
  const key = nflLeagueContextCacheKey(season, week, timeframe);
  const memory = NFL_LEAGUE_CONTEXT_MEMORY_CACHE.get(key);
  if (memory && Date.now() - memory.savedAt < ttlMs) {
    return normalizeNFLLeagueContext(memory.payload);
  }

  if (!base44) return null;

  try {
    const rows = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: key });
    const record = rows && rows[0];
    if (!record?.scraped_at) return null;

    const age = Date.now() - new Date(record.scraped_at).getTime();
    if (!Number.isFinite(age) || age >= ttlMs) return null;

    const raw = Array.isArray(record.games) ? record.games[0] : null;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const normalized = normalizeNFLLeagueContext(payload);
    if (normalized) {
      NFL_LEAGUE_CONTEXT_MEMORY_CACHE.set(key, { savedAt: Date.now(), payload });
      return normalized;
    }
  } catch (err) {
    console.log('NFL league context cache read failed:', err?.message || err);
  }

  return null;
}

async function writeNFLLeagueContextCache(base44, season, week, context, timeframe = 'season') {
  const key = nflLeagueContextCacheKey(season, week, timeframe);
  const scrapedAt = new Date().toISOString();
  const payload = serializeNFLLeagueContext({ ...context, scrapedAt });
  NFL_LEAGUE_CONTEXT_MEMORY_CACHE.set(key, { savedAt: Date.now(), payload });

  if (!base44) return;

  try {
    const record = {
      cache_date: key,
      scraped_at: scrapedAt,
      games: [JSON.stringify(payload)],
      raw_html_length: 0,
      parse_errors: context.warnings || [],
      source: 'nflverse_league_context',
    };
    const existing = await base44.asServiceRole.entities.LineupCache.filter({ cache_date: key });
    if (existing && existing.length > 0) await base44.asServiceRole.entities.LineupCache.update(existing[0].id, record);
    else await base44.asServiceRole.entities.LineupCache.create(record);
  } catch (err) {
    console.log('NFL league context cache write failed:', err?.message || err);
  }
}

function computeSeasonRanges(schedules, statsSeason, timeframe) {
  if (timeframe !== 'L5' && timeframe !== 'L10' && timeframe !== 'L15') return [{ season: statsSeason, minWeek: 0, maxWeek: 999 }];
  const n = timeframe === 'L5' ? 5 : timeframe === 'L10' ? 10 : 15;
  // NFLverse schedule weeks 19-22 are playoffs. The old max-week calculation
  // counted the Super Bowl as week 22 and selected e.g. 2025 W21-W22 for an
  // early-season L5 (2026 W1-W3). Almost every team has NO such games, making
  // their L5 snapshot identical to the current-season snapshot.
  // Select completed REGULAR-SEASON weeks when crossing the season boundary.
  const lastCompletedRegularWeek = (season) => {
    let maxWeek = 0;
    for (const game of schedules || []) {
      if (num(game.season, 0) !== season) continue;
      if (String(game.game_type || '').trim().toUpperCase() !== 'REG') continue;
      const week = num(game.week, 0);
      if (week < 1 || week > 18) continue;
      if (!Number.isFinite(num(game.away_score, NaN)) || !Number.isFinite(num(game.home_score, NaN))) continue;
      maxWeek = Math.max(maxWeek, week);
    }
    return maxWeek;
  };
  const maxWeek = lastCompletedRegularWeek(statsSeason);
  if (maxWeek >= n) return [{ season: statsSeason, minWeek: maxWeek - n + 1, maxWeek }];
  const ranges = maxWeek > 0 ? [{ season: statsSeason, minWeek: 1, maxWeek }] : [];
  const prevMax = lastCompletedRegularWeek(statsSeason - 1);
  if (prevMax > 0) {
    ranges.push({ season: statsSeason - 1, minWeek: Math.max(1, prevMax - (n - maxWeek) + 1), maxWeek: prevMax });
  }
  return ranges.length ? ranges : [{ season: statsSeason, minWeek: 0, maxWeek: 999 }];
}

async function buildNFLGameDetailSummary(params) {
  const base44 = params.base44;
  const season = Number(params.season || new Date().getFullYear());
  const week = Number(params.week || 1); const timeframe = String(params.timeframe || 'season');
  const awayTeam = normalizeTeam(params.awayTeam || params.awayTeamName || params.away_abbr);
  const homeTeam = normalizeTeam(params.homeTeam || params.homeTeamName || params.home_abbr);

  if (!awayTeam || !homeTeam) {
    throw new Error('Missing awayTeam/homeTeam for nflGameDetail mode');
  }

  let schedules = [];
  let teamRows = [];
  let pbpRowsScanned = 0;
  let pbpRowsUsed = 0;
  let ftnChartingRowsLoaded = 0;
  let ngsPassingRowsUsed = 0;
  let pfrYbcRowsUsed = 0;
  let trackingStatsSource = null;
  let trackingStatsDebug = null;
  let pbpMetricMap = new Map();
  let espnWinRates = null;
  let statRankingsBundle = null; let seasonRanges = [];
  const warnings = [];

// Use the selected dropdown season directly.
// The frontend decides whether "Current Season" should fallback to last available season.
const statsSeason = season;
const statsThroughWeek = week && week < 999 ? week : 999;

// Stream PBP for all 32 teams. The previous code only initialized the current
// away/home teams, so PBP-derived H2H metrics (EPA, success rate, explosive
// rate, red-zone, third-down, pressure, stuff rate, etc.) had values for the
// matchup teams but no league-wide rank pool. That is why many rows rendered
// without ranks while box-score/StatRankings rows did rank.
const teams = new Set(NFL_CANONICAL_TEAMS);
teams.add(awayTeam);
teams.add(homeTeam);

  const leagueContextTtlMs = getNFLCacheTtlMs(statsSeason, statsThroughWeek);
  const cachedLeagueContext = params.forceRefresh
    ? null
    : await readNFLLeagueContextCache(base44, statsSeason, statsThroughWeek, leagueContextTtlMs, timeframe);

  if (cachedLeagueContext) {
    schedules = cachedLeagueContext.schedules || [];
    teamRows = cachedLeagueContext.teamRows || [];
    pbpMetricMap = cachedLeagueContext.pbpMetricMap || new Map();
    pbpRowsScanned = cachedLeagueContext.pbpRowsScanned || 0;
    pbpRowsUsed = cachedLeagueContext.pbpRowsUsed || 0;
    ftnChartingRowsLoaded = cachedLeagueContext.ftnChartingRowsLoaded || 0;
    ngsPassingRowsUsed = cachedLeagueContext.ngsPassingRowsUsed || 0;
    pfrYbcRowsUsed = cachedLeagueContext.pfrYbcRowsUsed || 0;
    espnWinRates = cachedLeagueContext.espnWinRates || null;
    warnings.push(`NFL league context cache hit for ${statsSeason} week ${statsThroughWeek}`);
    for (const warning of cachedLeagueContext.warnings || []) warnings.push(warning);
  } else {
    try { schedules = await loadSchedules(); } catch (err) { warnings.push(`Schedule load failed: ${err?.message || String(err)}`); }
    seasonRanges = computeSeasonRanges(schedules, statsSeason, timeframe);
    const seasonsToLoad = [...new Set(seasonRanges.map((r) => r.season))];
    // Load FTN first because the streamed PBP pass joins charting by nflverse game/play ID.
    let ftnChartingByPlay = new Map();
    try {
      const ftn = await loadFtnCharting(seasonsToLoad, seasonRanges);
      ftnChartingByPlay = ftn.byPlay || new Map();
      ftnChartingRowsLoaded = ftn.rowsLoaded || 0;
    } catch (err) {
      warnings.push(`FTN charting load failed: ${err?.message || String(err)}`);
    }

    // Keep the memory-heavy season datasets out of the same Promise.all.
    // PBP is already the largest allocation in this function. Loading participation/PFR
    // simultaneously can make the Base44 worker die with a generic user-exception.
    const [teamRowsResult, pbpResult, espnWinRatesResult] = await Promise.all([
      Promise.all(seasonsToLoad.map((s) => loadTeamStats(s).catch(() => [])))
        .then((allRows) => ({ ok: true, rows: allRows.flat() }))
        .catch((err) => ({ ok: false, error: err })),
      streamPbpTeamMetrics(seasonsToLoad, teams, seasonRanges, ftnChartingByPlay)
        .then((result) => ({ ok: true, result }))
        .catch((err) => ({ ok: false, error: err })),
      loadEspnWinRates(statsSeason)
        .then((result) => ({ ok: true, result }))
        .catch((err) => ({ ok: false, error: err })),
    ]);

    if (teamRowsResult.ok) {
      teamRows = teamRowsResult.rows || [];
    } else {
      warnings.push(`Team stats load failed for ${statsSeason}: ${teamRowsResult.error?.message || String(teamRowsResult.error)}`);
    }

    if (pbpResult.ok) {
      pbpMetricMap = pbpResult.result?.metrics || new Map();
      pbpRowsScanned = pbpResult.result?.rowsScanned || 0;
      pbpRowsUsed = pbpResult.result?.rowsUsed || 0;
    } else {
      warnings.push(`PBP stream failed for ${statsSeason}: ${pbpResult.error?.message || String(pbpResult.error)}`);
    }

    // The FTN join map can contain ~47k rows. It is no longer needed once the PBP
    // stream has completed, so release it before loading any additional dataset.
    try { ftnChartingByPlay.clear(); } catch (_) {}

    // Load tracking sequentially after PBP finishes to keep peak worker memory low.
    try {
      const trackingData = await buildNFLTrackingStatsInline({
        season: statsSeason,
        week: statsThroughWeek,
        timeframe,
        forceRefresh: Boolean(params.forceRefresh),
      });
      const trackingTeams = trackingData?.teams || {};
      trackingStatsSource = trackingData?.source || null;
      ngsPassingRowsUsed = trackingData?.debug?.timeToThrowRowsUsed || 0;
      trackingStatsDebug = trackingData?.debug || null;
      const trackingMap = new Map();
      for (const [team, row] of Object.entries(trackingTeams)) {
        trackingMap.set(team, row);
      }
      mergeTrackingIntoPbpMetrics(pbpMetricMap, trackingMap);
      for (const warning of trackingData?.debug?.warnings || []) warnings.push(warning);
    } catch (err) {
      warnings.push(`NFL tracking load failed for ${statsSeason}: ${err?.message || String(err)}`);
    }

    try {
      const ybc = await loadPfrTeamYardsBeforeContact(seasonsToLoad, seasonRanges);
      pfrYbcRowsUsed = ybc?.rowsUsed || 0;
      mergeYardsBeforeContactIntoPbpMetrics(pbpMetricMap, ybc?.byTeam || new Map());
      for (const warning of ybc?.warnings || []) warnings.push(warning);
    } catch (err) {
      warnings.push(`PFR advanced rushing YBC load failed for ${statsSeason}: ${err?.message || String(err)}`);
    }

    if (espnWinRatesResult.ok) {
      espnWinRates = espnWinRatesResult.result || null;
      if (!espnWinRates?.parsedTeams) warnings.push(`ESPN win rates parsed 0 teams for ${statsSeason}`);
    } else {
      warnings.push(`ESPN win rates load failed for ${statsSeason}: ${espnWinRatesResult.error?.message || String(espnWinRatesResult.error)}`);
    }

    await writeNFLLeagueContextCache(base44, statsSeason, statsThroughWeek, {
      schedules,
      teamRows,
      pbpMetricMap,
      pbpRowsScanned,
      pbpRowsUsed,
      ftnChartingRowsLoaded,
      ngsPassingRowsUsed,
      pfrYbcRowsUsed,
      espnWinRates,
      warnings,
    }, timeframe);
  }
  if (!seasonRanges.length) seasonRanges = computeSeasonRanges(schedules, statsSeason, timeframe);

  // StatRankings is intentionally loaded by the frontend through the separate
  // StatRankings_function now. Keeping it separate prevents nflverse/game-detail
  // loading from waiting on dozens of authenticated StatRankings pages.
  if (params.useInlineStatRankings === true) {
    try {
      if (base44) {
        statRankingsBundle = await loadStatRankingsBundle(base44, statsSeason, warnings, Boolean(params.statRankingsForceRefresh));
      } else {
        warnings.push(`StatRankings bundle skipped for ${statsSeason}: missing Base44 client`);
      }
    } catch (err) {
      warnings.push(`StatRankings bundle load failed for ${statsSeason}: ${err?.message || String(err)}`);
    }
  }

  const leagueTeams = buildLeagueTeamSet(teamRows, schedules, seasonRanges);
  leagueTeams.add(awayTeam);
  leagueTeams.add(homeTeam);

  const aggMap = aggregateTeamRows(teamRows, leagueTeams, seasonRanges);
  const scheduleAggs = buildScheduleAggs(schedules, teamRows, seasonRanges, leagueTeams);
  const awayAgg = aggMap.get(awayTeam) || finalizeSummary(makeBlankTeamSummary(awayTeam));
  const homeAgg = aggMap.get(homeTeam) || finalizeSummary(makeBlankTeamSummary(homeTeam));
  const awayScheduleAgg = scheduleAggs.get(awayTeam) || makeScheduleAgg(awayTeam);
  const homeScheduleAgg = scheduleAggs.get(homeTeam) || makeScheduleAgg(homeTeam);

  const leagueStatsByTeam = new Map();
  for (const team of leagueTeams) {
    const teamAgg = aggMap.get(team) || finalizeSummary(makeBlankTeamSummary(team));
    const teamScheduleAgg = scheduleAggs.get(team) || makeScheduleAgg(team);
    const teamPbp = pbpMetricMap.get(team) || null;

    // Rank against the same enriched stat shape that the H2H table displays.
    // Without applying PBP here, the rank map was built from the pre-PBP
    // placeholders ("—"), so PBP metrics could not receive ranks.
    leagueStatsByTeam.set(team, buildRankedTeamStats(
      applyEspnWinRatesToStats(
        applyStatRankingsToStats(
          applyPbpMetricsToStats(teamStats(teamAgg, teamScheduleAgg), teamPbp),
          statRankingsBundle,
          team
        ),
        espnWinRates?.metrics?.get(team) || null
      ),
      team
    ));
  }

  const awayPbp = pbpMetricMap.get(awayTeam) || null;
  const homePbp = pbpMetricMap.get(homeTeam) || null;
  const awayStats = addLeagueRanksToStats(
    buildRankedTeamStats(
      applyEspnWinRatesToStats(
        applyStatRankingsToStats(
          applyPbpMetricsToStats(teamStats(awayAgg, awayScheduleAgg), awayPbp),
          statRankingsBundle,
          awayTeam
        ),
        espnWinRates?.metrics?.get(awayTeam) || null
      ),
      awayTeam
    ),
    leagueStatsByTeam
  );
  const homeStats = addLeagueRanksToStats(
    buildRankedTeamStats(
      applyEspnWinRatesToStats(
        applyStatRankingsToStats(
          applyPbpMetricsToStats(teamStats(homeAgg, homeScheduleAgg), homePbp),
          statRankingsBundle,
          homeTeam
        ),
        espnWinRates?.metrics?.get(homeTeam) || null
      ),
      homeTeam
    ),
    leagueStatsByTeam
  );
  const h2h = schedules.length ? buildH2H(schedules, awayTeam, homeTeam, season, week) : {};
  const matchupAnalyzer = buildMatchupAnalyzer(awayTeam, homeTeam, awayStats, homeStats);
  const propsOpponentMetricsByTeam = params.includePropsOpponentMetrics === true
    ? buildNFLPropsOpponentMetricsByTeam(leagueStatsByTeam, trackingStatsSource || 'nflverse')
    : null;

  return {
    source: 'nflverse',
    season,
    week,
    awayTeam,
    homeTeam,
    awayStats,
    homeStats,
    qbSituationalStats: {
      away: awayPbp?.qbSituational || [],
      home: homePbp?.qbSituational || [],
    },
    h2h,
    matchupAnalyzer,
    vsOpponent: emptyVsOpponent(),
    ...(propsOpponentMetricsByTeam ? { propsOpponentMetricsByTeam } : {}),
    meta: {
      generatedAt: new Date().toISOString(),
      requestedSeason: season,
      resolvedSeason: statsSeason,
      statsSeason,
      statsThroughWeek,
      seasonRanges,
      nflverseMode: pbpRowsUsed ? 'team_stats_plus_league_streamed_pbp_ranked' : 'team_stats_weekly_pregame_baseline',
      awayRowsUsed: awayAgg.rows?.length || 0,
      homeRowsUsed: homeAgg.rows?.length || 0,
      awayScheduleGamesUsed: awayScheduleAgg.games || 0,
      homeScheduleGamesUsed: homeScheduleAgg.games || 0,
      pbpRowsScanned,
      pbpRowsUsed,
      ftnChartingRowsLoaded,
      ngsPassingRowsUsed,
      pfrYbcRowsUsed,
      trackingStatsSource,
      trackingTimeToThrowRowsUsed: trackingStatsDebug?.timeToThrowRowsUsed || 0,
      trackingCoverageRowsUsed: trackingStatsDebug?.coverageRowsUsed || 0,
      trackingWarnings: trackingStatsDebug?.warnings || [],
      espnWinRateTeamsParsed: espnWinRates?.parsedTeams || 0,
      espnWinRateUrl: espnWinRates?.url || null,
      awayPbpPlaysUsed: awayPbp?.plays || 0,
      homePbpPlaysUsed: homePbp?.plays || 0,
      warnings,
      note: 'nflverse-derived stats plus FTN charting blitz rates, compact NFL Next Gen Stats time-to-throw when available, nflverse PFR advanced rushing YBC, real PBP forced fumbles, and ESPN trench win rates when available.'
    }
  };
}


// ─── Inlined fetchNFLTrackingStats + fetchNFLCoverageSchemes ───────────────
const INLINE_TRACKING_MEMORY_CACHE = new Map();
const INLINE_COVERAGE_MEMORY_CACHE = new Map();
const INLINE_NGS_PASSING_PARQUET = 'https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_passing.parquet';
const INLINE_SHARP_COVERAGE_URL = 'https://www.sharpfootballanalysis.com/stats-nfl/nfl-coverage-schemes/';

const INLINE_TRACKING_TEAM_ALIASES: Record<string,string> = {
  ARI:'ARI',ARZ:'ARI',ATL:'ATL',BAL:'BAL',BLT:'BAL',BUF:'BUF',CAR:'CAR',CHI:'CHI',CIN:'CIN',CLE:'CLE',CLV:'CLE',
  DAL:'DAL',DEN:'DEN',DET:'DET',GB:'GB',GNB:'GB',HOU:'HOU',IND:'IND',JAX:'JAX',JAC:'JAX',KC:'KC',KAN:'KC',
  LAC:'LAC',SD:'LAC',LAR:'LAR',LA:'LAR',STL:'LAR',LV:'LV',OAK:'LV',RAI:'LV',MIA:'MIA',MIN:'MIN',NE:'NE',
  NWE:'NE',NO:'NO',NOR:'NO',NYG:'NYG',NYJ:'NYJ',PHI:'PHI',PIT:'PIT',SEA:'SEA',SF:'SF',SFO:'SF',TB:'TB',
  TAM:'TB',TEN:'TEN',WAS:'WAS',WSH:'WAS',WFT:'WAS'
};
const INLINE_COVERAGE_TEAM_ABBR_BY_NAME: Record<string,string> = {
  'Arizona Cardinals':'ARI',Cardinals:'ARI','Atlanta Falcons':'ATL',Falcons:'ATL','Baltimore Ravens':'BAL',Ravens:'BAL',
  'Buffalo Bills':'BUF',Bills:'BUF','Carolina Panthers':'CAR',Panthers:'CAR','Chicago Bears':'CHI',Bears:'CHI',
  'Cincinnati Bengals':'CIN',Bengals:'CIN','Cleveland Browns':'CLE',Browns:'CLE','Dallas Cowboys':'DAL',Cowboys:'DAL',
  'Denver Broncos':'DEN',Broncos:'DEN','Detroit Lions':'DET',Lions:'DET','Green Bay Packers':'GB',Packers:'GB',
  'Houston Texans':'HOU',Texans:'HOU','Indianapolis Colts':'IND',Colts:'IND','Jacksonville Jaguars':'JAX',Jaguars:'JAX',
  'Kansas City Chiefs':'KC',Chiefs:'KC','Las Vegas Raiders':'LV',Raiders:'LV','Los Angeles Chargers':'LAC',Chargers:'LAC',
  'Los Angeles Rams':'LAR',Rams:'LAR','Miami Dolphins':'MIA',Dolphins:'MIA','Minnesota Vikings':'MIN',Vikings:'MIN',
  'New England Patriots':'NE',Patriots:'NE','New Orleans Saints':'NO',Saints:'NO','New York Giants':'NYG',Giants:'NYG',
  'New York Jets':'NYJ',Jets:'NYJ','Philadelphia Eagles':'PHI',Eagles:'PHI','Pittsburgh Steelers':'PIT',Steelers:'PIT',
  'San Francisco 49ers':'SF','49ers':'SF','Seattle Seahawks':'SEA',Seahawks:'SEA','Tampa Bay Buccaneers':'TB',Buccaneers:'TB',
  'Tennessee Titans':'TEN',Titans:'TEN','Washington Commanders':'WAS',Commanders:'WAS'
};

function inlineTrackingNormalizeTeam(team:any){const raw=String(team||'').trim().toUpperCase();return INLINE_TRACKING_TEAM_ALIASES[raw]||raw;}
function inlineTrackingNum(value:any,fallback=0){if(value==null||value==='')return fallback;const n=Number(String(value).replace('%','').trim());return Number.isFinite(n)?n:fallback;}
function inlineDecodeEntities(value:any){return String(value||'').replace(/&nbsp;/gi,' ').replace(/&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;/gi,"'").replace(/&quot;/gi,'"');}
function inlineStripTags(value:any){return inlineDecodeEntities(String(value||'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
function inlineCoverageNumber(value:any){const n=Number(String(value||'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}

async function buildInlineCoverageSchemes(season:number, forceRefresh:boolean){
  const cacheKey=`inline_coverage_${season||'latest'}`;
  const cached=INLINE_COVERAGE_MEMORY_CACHE.get(cacheKey);
  if(!forceRefresh&&cached&&Date.now()-cached.savedAt<12*60*60*1000)return cached.data;
  const res=await fetch(INLINE_SHARP_COVERAGE_URL,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36',Accept:'text/html,application/xhtml+xml','Accept-Language':'en-US,en;q=0.9'}});
  if(!res.ok)throw new Error(`Sharp coverage fetch failed ${res.status}`);
  const html=await res.text();
  const rows:any[]=[]; const teamMap:any={}; const seen=new Set<string>();
  const pushRow=(cells:string[])=>{
    if(cells.length<3||/^team$/i.test(cells[0]))return;
    const teamName=String(cells[0]||'').trim().replace(/\s+/g,' '); const teamAbbr=INLINE_COVERAGE_TEAM_ABBR_BY_NAME[teamName];
    const manCoverageRate=inlineCoverageNumber(cells[1]); const zoneCoverageRate=inlineCoverageNumber(cells[2]);
    const middleClosedRate=cells.length>3?inlineCoverageNumber(cells[3]):null; const middleOpenRate=cells.length>4?inlineCoverageNumber(cells[4]):null;
    if(!teamAbbr||!Number.isFinite(manCoverageRate)||!Number.isFinite(zoneCoverageRate)||seen.has(teamAbbr))return;
    seen.add(teamAbbr); const row={team:teamName,teamAbbr,manCoverageRate,zoneCoverageRate,middleClosedRate,middleOpenRate,value:manCoverageRate,displayValue:`${Number(manCoverageRate).toFixed(1)}%`};
    rows.push(row); teamMap[teamAbbr]=row;
  };
  for(const match of [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]){
    const cells=[...String(match[1]||'').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>inlineStripTags(c[1])).filter(Boolean); pushRow(cells);
  }
  if(rows.length<32){
    const plain=inlineStripTags(html);
    for(const teamName of Object.keys(INLINE_COVERAGE_TEAM_ABBR_BY_NAME)){
      if(teamName.includes(' '))continue; const escaped=teamName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const m=plain.match(new RegExp(`(?:^|\\s)${escaped}\\s+([0-9]+(?:\\.[0-9]+)?)\\s+([0-9]+(?:\\.[0-9]+)?)(?:\\s+([0-9]+(?:\\.[0-9]+)?))?(?:\\s+([0-9]+(?:\\.[0-9]+)?))?`,'i'));
      if(m)pushRow([teamName,m[1],m[2],m[3]||'',m[4]||'']);
    }
  }
  const text=inlineStripTags(html); const sm=text.match(/(?:Explore|NFL)\s+(20\d{2})\s+NFL\s+coverage/i)||text.match(/(20\d{2})\s+NFL\s+coverage/i); const pageSeason=sm?Number(sm[1]):null;
  const warnings:string[]=[]; if(!rows.length)warnings.push('Coverage table parsed 0 teams'); if(season&&pageSeason&&season!==pageSeason)warnings.push(`Sharp coverage page currently represents ${pageSeason}, not requested season ${season}`);
  const data={teamMap,rows,warnings,pageSeason,seasonMatchesRequest:!season||!pageSeason||season===pageSeason}; INLINE_COVERAGE_MEMORY_CACHE.set(cacheKey,{savedAt:Date.now(),data}); return data;
}

async function buildInlineTimeToThrowMap(season:number,week:number,timeframe:string){
  const warnings:string[]=[];
  try{
    const file=await asyncBufferFromUrl({url:INLINE_NGS_PASSING_PARQUET,requestInit:{headers:{'User-Agent':'SportsEdgeAI/1.0',Accept:'application/octet-stream,*/*'}}});
    const rows=await parquetReadObjects({file,columns:['season','season_type','week','team_abbr','attempts','pass_attempts','avg_time_to_throw']});
    const seasonRows=rows.filter((r:any)=>Number(r?.season)===Number(season)&&String(r?.season_type||'REG').toUpperCase()==='REG');
    let usableRows:any[]=[];
    if(String(timeframe||'season').toLowerCase()==='season'&&Number(week)>=18){const summaries=seasonRows.filter((r:any)=>Number(r?.week)===0);usableRows=summaries.length?summaries:seasonRows.filter((r:any)=>Number(r?.week)>0&&Number(r?.week)<=Number(week));}
    else if(Number(week)>0)usableRows=seasonRows.filter((r:any)=>Number(r?.week)>0&&Number(r?.week)<=Number(week));
    else {const summaries=seasonRows.filter((r:any)=>Number(r?.week)===0);usableRows=summaries.length?summaries:seasonRows.filter((r:any)=>Number(r?.week)>0);}
    const agg=new Map<string,any>(); let rowsUsed=0;
    for(const r of usableRows){const team=inlineTrackingNormalizeTeam(r?.team_abbr||'');const ttt=inlineTrackingNum(r?.avg_time_to_throw,NaN);const attempts=inlineTrackingNum(r?.attempts??r?.pass_attempts,NaN);if(!team||!Number.isFinite(ttt)||ttt<=0)continue;const weight=Number.isFinite(attempts)&&attempts>0?attempts:1;const cur=agg.get(team)||{weighted:0,attempts:0};cur.weighted+=ttt*weight;cur.attempts+=weight;agg.set(team,cur);rowsUsed++;}
    const map=new Map<string,number>(); for(const [team,v] of agg.entries())if(v.attempts>0)map.set(team,v.weighted/v.attempts); if(!rowsUsed)warnings.push(`Time to Throw unavailable: NGS parquet contained no usable ${season} passing rows`); return {map,rowsUsed,warnings};
  }catch(err){return {map:new Map(),rowsUsed:0,warnings:[`NGS parquet Time to Throw failed: ${err?.message||String(err)}`]};}
}

async function buildNFLTrackingStatsInline({season,week,timeframe,forceRefresh}:any){
  const cacheKey=`inline_tracking_${Number(season)}_wk${Number(week||0)}_${String(timeframe||'season')}`;
  const cached=INLINE_TRACKING_MEMORY_CACHE.get(cacheKey);
  if(!forceRefresh&&cached&&Date.now()-cached.savedAt<60*60*1000)return {...cached.data,fromCache:true};
  const [ttt,coverage]=await Promise.all([buildInlineTimeToThrowMap(Number(season),Number(week||0),String(timeframe||'season')),buildInlineCoverageSchemes(Number(season),Boolean(forceRefresh)).catch(err=>({teamMap:{},warnings:[`Coverage schemes failed: ${err?.message||String(err)}`],pageSeason:null,seasonMatchesRequest:null}))]);
  const coverageMap=new Map<string,any>(); for(const [team,row] of Object.entries(coverage.teamMap||{})){const normalizedTeam=inlineTrackingNormalizeTeam(team); const man=inlineTrackingNum((row as any)?.manCoverageRate,NaN); const zone=inlineTrackingNum((row as any)?.zoneCoverageRate,NaN); if(normalizedTeam&&Number.isFinite(man)&&Number.isFinite(zone))coverageMap.set(normalizedTeam,{manCoverageRate:man,zoneCoverageRate:zone});}
  const teams:any={}; for(const team of new Set([...ttt.map.keys(),...coverageMap.keys()])){const c=coverageMap.get(team);teams[team]={timeToThrow:ttt.map.get(team)??null,manCoverageRate:c?.manCoverageRate??null,zoneCoverageRate:c?.zoneCoverageRate??null};}
  const data={success:true,source:'nflverse-ngs-parquet+sharpfootballanalysis',season:Number(season),week:Number(week||0),timeframe:String(timeframe||'season'),teams,debug:{timeToThrowRowsUsed:ttt.rowsUsed,coverageRowsUsed:coverageMap.size,coveragePageSeason:coverage.pageSeason??null,coverageSeasonMatchesRequest:coverage.seasonMatchesRequest??null,warnings:[...(ttt.warnings||[]),...(coverage.warnings||[])]}};
  INLINE_TRACKING_MEMORY_CACHE.set(cacheKey,{savedAt:Date.now(),data}); return data;
}
