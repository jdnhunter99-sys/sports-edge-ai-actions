const NHL_STATS_ROOT = 'https://api.nhle.com/stats/rest/en';
const NHL_WEB_ROOT = 'https://api-web.nhle.com/v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const LEAGUE_PBP_CACHE_TTL_MS = 60 * 60 * 1000;
const LEAGUE_PBP_CACHE = new Map<number, { expiresAt: number; value: any }>();
const LEAGUE_PBP_IN_FLIGHT = new Map<number, Promise<any>>();
const REPORTS = ['summary', 'powerplay', 'penaltykill', 'faceoffpercentages', 'realtime', 'percentages', 'summaryshooting', 'penalties'];
const TEAM_STATS_REPORTS = [
  { report: 'summary', sort: 'goalsForPerGame' },
  { report: 'powerplay', sort: 'ppGoalsPerGame' },
  { report: 'penaltykill', sort: 'ppGoalsAgainstPerGame' },
  { report: 'faceoffpercentages', sort: 'faceoffWinPct' },
  { report: 'realtime', sort: 'hits' },
  { report: 'percentages', sort: 'satPct' },
  { report: 'summaryshooting', sort: 'shots5v5' },
  { report: 'penalties', sort: 'penaltiesTakenPer60' },
];
const TEAM_STATS_LOWER_IS_BETTER = new Set([
  'goalsAgainst', 'goalsAgainstPerGame', 'shotsAgainstPerGame', 'ppGoalsAgainst',
  'ppGoalsAgainstPerGame', 'shGoalsAgainst', 'shGoalsAgainstPerGame', 'timesShorthanded',
  'timesShorthandedPerGame', 'losses', 'otLosses', 'faceoffsLost', 'giveaways',
  'giveawaysPer60', 'giveawaysPerGame', 'missedShots', 'satAgainst', 'satAgainstPerGame',
  'usatAgainst', 'usatAgainstPerGame', 'penaltyMinutesPerGame', 'penaltiesPerGame',
]);

function normalizeAbbr(value: unknown) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}

function seasonIdFor(value: unknown) {
  const start = Number(value);
  if (!Number.isInteger(start) || start < 2000 || start > 2100) throw new Error('A valid NHL season start year is required.');
  return Number(`${start}${start + 1}`);
}

async function getJson(url: URL | string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'SportsEdgeAI-NHL-Team-Stats-Publisher/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.json();
      const detail = (await response.text()).slice(0, 180);
      const error = new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, delay)));
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 750 * (2 ** attempt))));
    }
  }
  throw new Error(`NHL data request failed for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchTeamEdgeStats(teamId: number, seasonId: number) {
  const [detail, zoneTime] = await Promise.all([
    getJson(`${NHL_WEB_ROOT}/edge/team-detail/${teamId}/${seasonId}/2`),
    getJson(`${NHL_WEB_ROOT}/edge/team-zone-time-details/${teamId}/${seasonId}/2`),
  ]);
  const highDanger = Array.isArray((detail as any)?.sogSummary)
    ? (detail as any).sogSummary.find((row: any) => row?.locationCode === 'high')
    : null;
  const zones = Array.isArray((zoneTime as any)?.zoneTimeDetails)
    ? (zoneTime as any).zoneTimeDetails
    : [];
  return {
    highDangerShotsFor: Number.isFinite(Number(highDanger?.shots)) ? Number(highDanger.shots) : null,
    highDangerShotsForRank: Number.isFinite(Number(highDanger?.shotsRank)) ? Number(highDanger.shotsRank) : null,
    zoneTimeByStrength: Object.fromEntries(zones.map((row: any) => [String(row?.strengthCode || '').toLowerCase(), {
      offensiveZonePctg: Number.isFinite(Number(row?.offensiveZonePctg)) ? Number(row.offensiveZonePctg) : null,
      offensiveZoneRank: Number.isFinite(Number(row?.offensiveZoneRank)) ? Number(row.offensiveZoneRank) : null,
      defensiveZonePctg: Number.isFinite(Number(row?.defensiveZonePctg)) ? Number(row.defensiveZonePctg) : null,
      defensiveZoneRank: Number.isFinite(Number(row?.defensiveZoneRank)) ? Number(row.defensiveZoneRank) : null,
    }])),
  };
}

async function fetchReportPage(report: string, seasonId: number, teamIds: number[], start: number) {
  const url = new URL(`${NHL_STATS_ROOT}/team/${report}`);
  url.searchParams.set('isAggregate', 'false');
  url.searchParams.set('isGame', 'true');
  url.searchParams.set('sort', 'gameDate');
  url.searchParams.set('start', String(start));
  url.searchParams.set('limit', '100');
  url.searchParams.set('cayenneExp', `gameTypeId=2 and seasonId=${seasonId} and teamId in (${teamIds.join(',')})`);
  return getJson(url);
}

async function fetchReportGames(report: string, seasonId: number, teamIds: number[]) {
  const first = await fetchReportPage(report, seasonId, teamIds, 0);
  const rows = Array.isArray(first?.data) ? first.data : [];
  const total = Number(first?.total) || rows.length;
  if (total <= rows.length) return rows;
  const pageStarts = Array.from({ length: Math.ceil(total / 100) - 1 }, (_, index) => (index + 1) * 100);
  const pages: any[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < pageStarts.length) {
      const start = pageStarts[cursor++];
      pages.push(await fetchReportPage(report, seasonId, teamIds, start));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, pageStarts.length) }, worker));
  return [...rows, ...pages.flatMap((page) => Array.isArray(page?.data) ? page.data : [])];
}

function elapsedInPeriod(value: unknown) {
  const [minutes, seconds] = String(value || '0:00').split(':').map(Number);
  return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : null;
}

function scoreState(value: number) {
  return Math.max(-3, Math.min(3, value));
}

function distanceAndAngle(details: any) {
  const x = Number(details?.xCoord);
  const y = Number(details?.yCoord);
  if (!Number.isFinite(x) || !Number.isFinite(y) || String(details?.zoneCode || '').toUpperCase() !== 'O') return null;
  // NHL event coordinates are rink feet with the goal line at +/- 89.
  const dx = Math.max(0, 89 - Math.abs(x));
  const distance = Math.hypot(dx, y);
  const angle = Math.atan2(Math.abs(y), Math.max(1, dx)) * 180 / Math.PI;
  return { distance, angle };
}

function collectLeagueShotData(payload: any, gameId: number, abbrById: Map<number, string>) {
  const homeId = Number(payload?.homeTeam?.id);
  const awayId = Number(payload?.awayTeam?.id);
  const homeAbbr = abbrById.get(homeId);
  const awayAbbr = abbrById.get(awayId);
  if (!homeAbbr || !awayAbbr) return { samples: [], timeRows: [], eventSplits: {} };
  const teamsByAbbr = { [homeAbbr]: homeId, [awayAbbr]: awayId };
  const abbreviations = [homeAbbr, awayAbbr];
  const plays = Array.isArray(payload?.plays) ? [...payload.plays] : [];
  plays.sort((a: any, b: any) => (Number(a?.periodDescriptor?.number) - Number(b?.periodDescriptor?.number))
    || (Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0)));
  const samples: any[] = [];
  const timeRows: any[] = [];
  const scores: Record<number, number> = { [homeId]: 0, [awayId]: 0 };
  const lastUnblockedShotByTeam = new Map<number, { period: number; elapsed: number }>();
  const playsByPeriod = new Map<number, any[]>();
  for (const event of plays) {
    const period = Number(event?.periodDescriptor?.number) || 0;
    if (period && String(event?.periodDescriptor?.periodType || '').toUpperCase() !== 'SO') {
      playsByPeriod.set(period, [...(playsByPeriod.get(period) || []), event]);
    }
    const type = String(event?.typeDescKey || '').toLowerCase();
    if (!['shot-on-goal', 'goal', 'missed-shot', 'blocked-shot'].includes(type)) continue;
    const details = event?.details || {};
    const shootingTeamId = Number(details?.eventOwnerTeamId);
    const shootingAbbr = abbrById.get(shootingTeamId);
    if (!shootingAbbr || !period) continue;
    const elapsed = elapsedInPeriod(event?.timeInPeriod);
    const geometry = distanceAndAngle(details);
    const isUnblocked = type !== 'blocked-shot';
    const previousShot = lastUnblockedShotByTeam.get(shootingTeamId);
    const isRebound = Boolean(isUnblocked && previousShot && previousShot.period === period
      && elapsed != null && elapsed >= previousShot.elapsed && elapsed - previousShot.elapsed <= 3);
    const emptyNet = type === 'goal' && !details?.goalieInNetId;
    const oppositeId = shootingTeamId === homeId ? awayId : homeId;
    samples.push({
      gameId,
      period,
      elapsed,
      shootingAbbr,
      defendingAbbr: shootingTeamId === homeId ? awayAbbr : homeAbbr,
      scoreDiff: scoreState((scores[shootingTeamId] || 0) - (scores[oppositeId] || 0)),
      strength: eventStrengthForTeam(event, shootingTeamId, homeId, awayId),
      type,
      shotType: String(details?.shotType || 'other').toLowerCase(),
      isUnblocked,
      isOnGoal: type === 'shot-on-goal' || type === 'goal',
      isGoal: type === 'goal',
      emptyNet,
      isRebound,
      distance: geometry?.distance ?? null,
      angle: geometry?.angle ?? null,
    });
    if (isUnblocked && elapsed != null) lastUnblockedShotByTeam.set(shootingTeamId, { period, elapsed });
    if (type === 'goal') scores[shootingTeamId] = (scores[shootingTeamId] || 0) + 1;
  }

  // Count the amount of time each team spends in a tied or leading/trailing
  // score state at 5-on-5. These league-wide rates normalize score-adjusted
  // Corsi and Fenwick without borrowing a third-party stat feed.
  for (const [period, periodEvents] of playsByPeriod) {
    const ordered = periodEvents.sort((a, b) => Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0));
    const periodType = String(ordered[0]?.periodDescriptor?.periodType || '').toUpperCase();
    const periodLength = periodType === 'OT' ? 300 : 1200;
    let homeScore = 0;
    let awayScore = 0;
    // Restore the score entering this period from the preceding periods.
    for (const prior of plays) {
      const priorPeriod = Number(prior?.periodDescriptor?.number) || 0;
      if (priorPeriod >= period) break;
      if (String(prior?.typeDescKey || '').toLowerCase() === 'goal') {
        const scorer = Number(prior?.details?.eventOwnerTeamId);
        if (scorer === homeId) homeScore += 1;
        if (scorer === awayId) awayScore += 1;
      }
    }
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index];
      if (String(event?.typeDescKey || '').toLowerCase() === 'goal') {
        const scorer = Number(event?.details?.eventOwnerTeamId);
        if (scorer === homeId) homeScore += 1;
        if (scorer === awayId) awayScore += 1;
      }
      const start = elapsedInPeriod(event?.timeInPeriod);
      const next = index + 1 < ordered.length ? elapsedInPeriod(ordered[index + 1]?.timeInPeriod) : periodLength;
      if (start == null || next == null) continue;
      const seconds = Math.max(0, Math.min(periodLength, next) - Math.min(periodLength, start));
      if (!seconds) continue;
      // Attribute time after processing a goal at this event timestamp, and
      // keep manpower time for both 5v5 score adjustment and PP xG/60.
      const diff = homeScore - awayScore;
      const homeStrength = eventStrengthForTeam(event, homeId, homeId, awayId);
      const awayStrength = eventStrengthForTeam(event, awayId, homeId, awayId);
      if (homeStrength === '5v5' || homeStrength === 'pp') {
        timeRows.push({ teamAbbr: homeAbbr, scoreDiff: scoreState(diff), seconds, strength: homeStrength });
      }
      if (awayStrength === '5v5' || awayStrength === 'pp') {
        timeRows.push({ teamAbbr: awayAbbr, scoreDiff: scoreState(-diff), seconds, strength: awayStrength });
      }
    }
  }
  return { samples, timeRows, eventSplits: buildGameEventSplits(payload, teamsByAbbr, abbreviations) };
}

function shotFeatures(sample: any) {
  const distance = Number(sample?.distance);
  const angle = Number(sample?.angle);
  const shotType = String(sample?.shotType || 'other');
  const typeFeature = (types: string[]) => types.includes(shotType) ? 1 : 0;
  return [
    1,
    distance / 25,
    (distance / 25) ** 2,
    angle / 45,
    typeFeature(['snap']),
    typeFeature(['slap']),
    typeFeature(['backhand']),
    typeFeature(['tip', 'deflection']),
    typeFeature(['wrap-around', 'wrap']),
    sample?.isRebound ? 1 : 0,
    sample?.strength === 'pp' ? 1 : 0,
    sample?.strength === 'pk' ? 1 : 0,
  ];
}

function solveLinearSystem(matrix: number[][], vector: number[]) {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= size; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= size; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return rows.map((row) => row[size]);
}

function fitShotModel(samples: any[]) {
  const training = samples.filter((shot) => shot.isUnblocked && !shot.emptyNet && shot.distance != null && shot.angle != null);
  const featureCount = 12;
  let beta = [-2.7, -1, -0.25, -0.15, 0, 0, 0, 0.2, 0.15, 0, 0.45, 0.2];
  if (training.length >= 100) {
    const penalty = 0.35;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const hessian = Array.from({ length: featureCount }, () => Array(featureCount).fill(0));
      const gradient = Array(featureCount).fill(0);
      for (const shot of training) {
        const features = shotFeatures(shot);
        const z = features.reduce((total, feature, index) => total + feature * beta[index], 0);
        const probability = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const outcome = shot.isGoal ? 1 : 0;
        for (let row = 0; row < featureCount; row += 1) {
          gradient[row] += features[row] * (outcome - probability);
          for (let column = 0; column < featureCount; column += 1) {
            hessian[row][column] += probability * (1 - probability) * features[row] * features[column];
          }
        }
      }
      for (let index = 1; index < featureCount; index += 1) {
        hessian[index][index] += penalty;
        gradient[index] -= penalty * beta[index];
      }
      hessian[0][0] += 1e-4;
      const step = solveLinearSystem(hessian, gradient);
      if (!step) break;
      let maxStep = 0;
      beta = beta.map((value, index) => {
        const boundedStep = Math.max(-1.5, Math.min(1.5, step[index]));
        maxStep = Math.max(maxStep, Math.abs(boundedStep));
        return Math.max(-8, Math.min(8, value + boundedStep));
      });
      if (maxStep < 1e-5) break;
    }
  }
  return {
    beta,
    trainingShots: training.length,
    predict(shot: any) {
      if (shot.emptyNet && shot.isGoal) return 1;
      if (shot.distance == null || shot.angle == null) return null;
      const features = shotFeatures(shot);
      const z = features.reduce((total, feature, index) => total + feature * beta[index], 0);
      const probability = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      return Math.max(0.002, Math.min(0.9, probability));
    },
  };
}

function buildLeagueAdvancedPbp(seasonId: number, teams: any[]) {
  const allIdsByAbbr = Object.fromEntries(teams.map((team: any) => [normalizeAbbr(team?.triCode), Number(team?.id)]));
  const abbrById = new Map(Object.entries(allIdsByAbbr).map(([abbr, id]) => [Number(id), abbr]));
  return (async () => {
    const cached = LEAGUE_PBP_CACHE.get(seasonId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existingFlight = LEAGUE_PBP_IN_FLIGHT.get(seasonId);
    if (existingFlight) return existingFlight;
    const promise = (async () => {
      const ids = Object.values(allIdsByAbbr).filter(Number.isFinite);
      const gameRows = await fetchReportGames('summary', seasonId, ids);
      const gameIds = [...new Set(gameRows.map((row: any) => Number(row?.gameId)).filter(Number.isFinite))];
      // Power-play and penalty-kill game reports supply the few ranking inputs
      // that cannot be derived reliably from play-by-play alone.
      const rangeReportPromise = Promise.allSettled([
        fetchReportGames('powerplay', seasonId, ids),
        fetchReportGames('penaltykill', seasonId, ids),
      ]);
      const samples: any[] = [];
      const timeRows: any[] = [];
      const baseEventSplitsByGameId: Record<string, any> = {};
      let cursor = 0;
      const worker = async () => {
        while (cursor < gameIds.length) {
          const gameId = gameIds[cursor++];
          try {
            const payload = await getJson(`${NHL_WEB_ROOT}/gamecenter/${gameId}/play-by-play`);
            const collected = collectLeagueShotData(payload, gameId, abbrById);
            baseEventSplitsByGameId[String(gameId)] = collected.eventSplits;
            if (!collected.samples.length) continue;
            samples.push(...collected.samples);
            timeRows.push(...collected.timeRows);
          } catch (error) {
            console.warn(`NHL league play-by-play unavailable for game ${gameId}:`, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(12, gameIds.length) }, worker));
      const pbpCoverage = gameIds.length ? Object.keys(baseEventSplitsByGameId).length / gameIds.length : 0;
      if (!gameIds.length || pbpCoverage < 0.9) {
        throw new Error(`NHL league play-by-play returned only ${Object.keys(baseEventSplitsByGameId).length} of ${gameIds.length} games.`);
      }

      const leagueGamesByAbbr: Record<string, Record<string, any>> = Object.fromEntries(
        Object.keys(allIdsByAbbr).map((abbr) => [abbr, {}]),
      );
      for (const row of gameRows) {
        const abbr = abbrById.get(Number(row?.teamId));
        const gameId = String(row?.gameId ?? '');
        if (!abbr || !gameId || !leagueGamesByAbbr[abbr]) continue;
        leagueGamesByAbbr[abbr][gameId] = {
          gameId: Number(gameId),
          date: row?.gameDate || null,
          homeRoad: row?.homeRoad === 'H' ? 'H' : row?.homeRoad === 'R' || row?.homeRoad === 'A' ? 'A' : null,
          stats: { ...row },
        };
      }
      const rangeReports = await rangeReportPromise;
      rangeReports.forEach((result, reportIndex) => {
        if (result.status !== 'fulfilled') {
          console.warn(`NHL league range-rank report ${reportIndex === 0 ? 'powerplay' : 'penaltykill'} unavailable:`, result.reason);
          return;
        }
        for (const row of result.value) {
          const abbr = abbrById.get(Number(row?.teamId));
          const gameId = String(row?.gameId ?? '');
          const game = abbr && gameId ? leagueGamesByAbbr[abbr]?.[gameId] : null;
          if (game) Object.assign(game.stats, row);
        }
      });

      const model = fitShotModel(samples);
      const stateTime: Record<string, number> = {};
      const stateAttempts: Record<string, number> = {};
      for (const row of timeRows) {
        if (row.strength === '5v5') stateTime[row.scoreDiff] = (stateTime[row.scoreDiff] || 0) + row.seconds;
      }
      for (const shot of samples) {
        if (shot.strength === '5v5') stateAttempts[shot.scoreDiff] = (stateAttempts[shot.scoreDiff] || 0) + 1;
      }
      const tiedRate = (stateAttempts['0'] || 0) / Math.max(1, stateTime['0'] || 0);
      const scoreWeights: Record<string, number> = {};
      for (let diff = -3; diff <= 3; diff += 1) {
        const state = String(diff);
        const rate = (stateAttempts[state] || 0) / Math.max(1, stateTime[state] || 0);
        scoreWeights[state] = rate > 0 ? Math.max(0.5, Math.min(2, tiedRate / rate)) : 1;
      }

      const advancedEventSplitsByGameId: Record<string, any> = {};
      const getBucket = (gameId: number, abbr: string, period: number, strength: string) => {
        const key = String(gameId);
        advancedEventSplitsByGameId[key] ||= {};
        advancedEventSplitsByGameId[key][abbr] ||= {};
        const periodKey = String(period || 0);
        advancedEventSplitsByGameId[key][abbr][periodKey] ||= {};
        advancedEventSplitsByGameId[key][abbr][periodKey].all ||= {};
        advancedEventSplitsByGameId[key][abbr][periodKey][strength] ||= {};
        return advancedEventSplitsByGameId[key][abbr][periodKey];
      };
      const increment = (shot: any, abbr: string, strength: string, key: string, value: number) => {
        const apply = (period: number) => {
          const bucket = getBucket(shot.gameId, abbr, period, strength);
          bucket.all[key] = Number(bucket.all[key] || 0) + value;
          bucket[strength][key] = Number(bucket[strength][key] || 0) + value;
        };
        apply(shot.period);
        if (shot.period !== 0) apply(0);
      };
      const oppositeStrength = (strength: string) => strength === 'pp' ? 'pk' : strength === 'pk' ? 'pp' : strength;
      const totals: Record<string, any> = Object.fromEntries(Object.keys(allIdsByAbbr).map((abbr) => [abbr, {
        gamesPlayed: 0,
        goalsAgainst: 0, shotsFor: 0, shotsAgainst: 0,
        shotAttemptsFor: 0, shotAttemptsAgainst: 0,
        corsiFor5v5: 0, corsiAgainst5v5: 0, fenwickFor5v5: 0, fenwickAgainst5v5: 0,
        goalsFor5v5: 0, goalsAgainst5v5: 0, shotsFor5v5: 0, shotsAgainst5v5: 0,
        firstPeriodGoalsFor: 0, firstPeriodGoalsAgainst: 0,
        secondPeriodGoalsFor: 0, secondPeriodGoalsAgainst: 0,
        thirdPeriodGoalsFor: 0, thirdPeriodGoalsAgainst: 0,
        emptyNetGoalsFor: 0, emptyNetGoalsAgainst: 0,
        gamesScoredFirst: 0, gamesAllowedFirst: 0,
        faceoffWins: 0, faceoffs: 0,
        offensiveZoneFaceoffWins: 0, offensiveZoneFaceoffs: 0,
        defensiveZoneFaceoffWins: 0, defensiveZoneFaceoffs: 0,
        neutralZoneFaceoffWins: 0, neutralZoneFaceoffs: 0,
        positionAllowed: Object.fromEntries(['all', 'Centers', 'Left Wings', 'Right Wings', 'Defensemen'].map((position) => [position, {
          shots: 0, goals: 0, assists: 0, points: 0, attempts: 0, ppPoints: 0, ppShots: 0,
        }])),
        xGoalsFor: 0, xGoalsAgainst: 0, xGoalsFor5v5: 0, xGoalsAgainst5v5: 0,
        xGoalsForPP: 0, xGoalsForPerGame: 0, xGoalsAgainstPerGame: 0,
        scoringChancesFor: 0, scoringChancesAgainst: 0,
        highDangerChancesFor: 0, highDangerChancesAgainst: 0,
        highDangerShotsFor: 0, highDangerShotsAgainst: 0,
        scoreAdjustedCorsi: 0, scoreAdjustedFenwick: 0,
        timeSeconds5v5: 0, timeSecondsPP: 0,
        goalsFor: 0,
      }]));

      for (const [gameId, splitByTeam] of Object.entries(baseEventSplitsByGameId)) {
        for (const [abbr, periods] of Object.entries(splitByTeam as any)) {
          if (totals[abbr]) totals[abbr].gamesPlayed += 1;
          const all = (periods as any)?.['0']?.all || {};
          const powerPlay = (periods as any)?.['0']?.pp || {};
          if (totals[abbr]) {
            totals[abbr].goalsFor += Number(all.goalsFor || 0);
            totals[abbr].goalsAgainst += Number(all.goalsAgainst || 0);
            totals[abbr].shotsFor += Number(all.shotsFor || 0);
            totals[abbr].shotsAgainst += Number(all.shotsAgainst || 0);
            totals[abbr].shotAttemptsFor += Number(all.shotAttemptsFor || 0);
            totals[abbr].shotAttemptsAgainst += Number(all.shotAttemptsAgainst || 0);
            totals[abbr].ppGoals = Number(totals[abbr].ppGoals || 0) + Number(all.ppGoals || 0);
            totals[abbr].shGoals = Number(totals[abbr].shGoals || 0) + Number(all.shGoals || 0);
            const fiveOnFive = (periods as any)?.['0']?.['5v5'] || {};
            const firstPeriod = (periods as any)?.['1']?.all || {};
            const secondPeriod = (periods as any)?.['2']?.all || {};
            const thirdPeriod = (periods as any)?.['3']?.all || {};
            totals[abbr].goalsFor5v5 += Number(fiveOnFive.goalsFor || 0);
            totals[abbr].goalsAgainst5v5 += Number(fiveOnFive.goalsAgainst || 0);
            totals[abbr].shotsFor5v5 += Number(fiveOnFive.shotsFor || 0);
            totals[abbr].shotsAgainst5v5 += Number(fiveOnFive.shotsAgainst || 0);
            totals[abbr].powerPlayShotsFor = Number(totals[abbr].powerPlayShotsFor || 0) + Number(powerPlay.shotsFor || 0);
            for (const field of ['blockedShots', 'hits', 'takeaways', 'giveaways', 'penaltiesTaken', 'penaltiesDrawn', 'penaltyMinutes']) {
              totals[abbr][field] = Number(totals[abbr][field] || 0) + Number(all[field] || 0);
            }
            totals[abbr].firstPeriodGoalsFor += Number(firstPeriod.goalsFor || 0);
            totals[abbr].firstPeriodGoalsAgainst += Number(firstPeriod.goalsAgainst || 0);
            totals[abbr].secondPeriodGoalsFor += Number(secondPeriod.goalsFor || 0);
            totals[abbr].secondPeriodGoalsAgainst += Number(secondPeriod.goalsAgainst || 0);
            totals[abbr].thirdPeriodGoalsFor += Number(thirdPeriod.goalsFor || 0);
            totals[abbr].thirdPeriodGoalsAgainst += Number(thirdPeriod.goalsAgainst || 0);
            totals[abbr].emptyNetGoalsFor += Number(all.emptyNetGoals || 0);
            totals[abbr].emptyNetGoalsAgainst += Number(all.emptyNetGoalsAgainst || 0);
            for (const faceoff of ['faceoffs', 'faceoffWins', 'offensiveZoneFaceoffs', 'offensiveZoneFaceoffWins', 'defensiveZoneFaceoffs', 'defensiveZoneFaceoffWins', 'neutralZoneFaceoffs', 'neutralZoneFaceoffWins']) {
              totals[abbr][faceoff] += Number(all[faceoff] || 0);
            }
            const positionSplits = (periods as any)?.positionStats?.['0'] || {};
            for (const position of ['Centers', 'Left Wings', 'Right Wings', 'Defensemen']) {
              const overallAllowed = positionSplits?.all?.[position] || {};
              const powerPlayAllowed = positionSplits?.pk?.[position] || {};
              for (const stat of ['shots', 'goals', 'assists', 'points', 'attempts']) {
                totals[abbr].positionAllowed[position][stat] += Number(overallAllowed[stat] || 0);
                totals[abbr].positionAllowed.all[stat] += Number(overallAllowed[stat] || 0);
              }
              totals[abbr].positionAllowed[position].ppPoints += Number(powerPlayAllowed.ppPoints || 0);
              totals[abbr].positionAllowed[position].ppShots += Number(powerPlayAllowed.ppShots || 0);
              totals[abbr].positionAllowed.all.ppPoints += Number(powerPlayAllowed.ppPoints || 0);
              totals[abbr].positionAllowed.all.ppShots += Number(powerPlayAllowed.ppShots || 0);
            }
            if ((periods as any)?.firstGoalFor === true) totals[abbr].gamesScoredFirst += 1;
            if ((periods as any)?.firstGoalAgainst === true) totals[abbr].gamesAllowedFirst += 1;
          }
        }
      }
      for (const sample of samples) {
        const shooterStrength = sample.strength;
        const defenderStrength = oppositeStrength(shooterStrength);
        if (sample.isUnblocked) {
          const xg = model.predict(sample);
          if (xg != null) {
            increment(sample, sample.shootingAbbr, shooterStrength, 'xGoalsFor', xg);
            increment(sample, sample.defendingAbbr, defenderStrength, 'xGoalsAgainst', xg);
            totals[sample.shootingAbbr].xGoalsFor += xg;
            totals[sample.defendingAbbr].xGoalsAgainst += xg;
            if (shooterStrength === '5v5') totals[sample.shootingAbbr].xGoalsFor5v5 += xg;
            if (defenderStrength === '5v5') totals[sample.defendingAbbr].xGoalsAgainst5v5 += xg;
            if (shooterStrength === 'pp') totals[sample.shootingAbbr].xGoalsForPP += xg;
          }
          const scoringChance = sample.distance != null && sample.distance <= 40 && sample.angle <= 45;
          const highDanger = sample.distance != null && sample.distance <= 25 && sample.angle <= 30;
          if (scoringChance) {
            increment(sample, sample.shootingAbbr, shooterStrength, 'scoringChancesFor', 1);
            increment(sample, sample.defendingAbbr, defenderStrength, 'scoringChancesAgainst', 1);
            totals[sample.shootingAbbr].scoringChancesFor += 1;
            totals[sample.defendingAbbr].scoringChancesAgainst += 1;
          }
          if (highDanger) {
            increment(sample, sample.shootingAbbr, shooterStrength, 'highDangerChancesFor', 1);
            increment(sample, sample.defendingAbbr, defenderStrength, 'highDangerChancesAgainst', 1);
            totals[sample.shootingAbbr].highDangerChancesFor += 1;
            totals[sample.defendingAbbr].highDangerChancesAgainst += 1;
            if (sample.isOnGoal) {
              increment(sample, sample.shootingAbbr, shooterStrength, 'highDangerShotsFor', 1);
              increment(sample, sample.defendingAbbr, defenderStrength, 'highDangerShotsAgainst', 1);
              totals[sample.shootingAbbr].highDangerShotsFor += 1;
              totals[sample.defendingAbbr].highDangerShotsAgainst += 1;
            }
          }
        }
        if (shooterStrength === '5v5') {
          totals[sample.shootingAbbr].corsiFor5v5 += 1;
          totals[sample.defendingAbbr].corsiAgainst5v5 += 1;
          if (sample.isUnblocked) {
            totals[sample.shootingAbbr].fenwickFor5v5 += 1;
            totals[sample.defendingAbbr].fenwickAgainst5v5 += 1;
          }
          const forWeight = scoreWeights[String(sample.scoreDiff)] ?? 1;
          const againstWeight = scoreWeights[String(-sample.scoreDiff)] ?? 1;
          increment(sample, sample.shootingAbbr, '5v5', 'scoreAdjustedCorsiFor', forWeight);
          increment(sample, sample.defendingAbbr, '5v5', 'scoreAdjustedCorsiAgainst', againstWeight);
          totals[sample.shootingAbbr].scoreAdjustedCorsi += forWeight;
          if (sample.isUnblocked) {
            increment(sample, sample.shootingAbbr, '5v5', 'scoreAdjustedFenwickFor', forWeight);
            increment(sample, sample.defendingAbbr, '5v5', 'scoreAdjustedFenwickAgainst', againstWeight);
            totals[sample.shootingAbbr].scoreAdjustedFenwick += forWeight;
          }
        }
      }
      for (const row of timeRows) {
        // NHL rate denominators use total team time at the matching strength.
        if (row.strength === '5v5') totals[row.teamAbbr].timeSeconds5v5 += row.seconds;
        if (row.strength === 'pp') totals[row.teamAbbr].timeSecondsPP += row.seconds;
      }
      const advancedByAbbr: Record<string, any> = {};
      const metricValue = (stats: any, key: string) => {
        if (key === 'shootingPct') return stats.shotsFor ? stats.goalsFor / stats.shotsFor : null;
        if (key === 'teamSavePct') return stats.shotsAgainst ? 1 - stats.goalsAgainst / stats.shotsAgainst : null;
        if (key === 'pdo5v5') {
          return stats.shotsFor5v5 && stats.shotsAgainst5v5
            ? stats.goalsFor5v5 / stats.shotsFor5v5 + 1 - stats.goalsAgainst5v5 / stats.shotsAgainst5v5
            : null;
        }
        if (key === 'corsiPct') return stats.corsiFor5v5 + stats.corsiAgainst5v5 ? stats.corsiFor5v5 / (stats.corsiFor5v5 + stats.corsiAgainst5v5) : null;
        if (key === 'fenwickPct') return stats.fenwickFor5v5 + stats.fenwickAgainst5v5 ? stats.fenwickFor5v5 / (stats.fenwickFor5v5 + stats.fenwickAgainst5v5) : null;
        if (key === 'goalDiff5v5PerGame') return stats.gamesPlayed ? (stats.goalsFor5v5 - stats.goalsAgainst5v5) / stats.gamesPlayed : null;
        if (key === 'goalsFor5v5PerGame') return stats.gamesPlayed ? stats.goalsFor5v5 / stats.gamesPlayed : null;
        if (key === 'goalsAgainst5v5PerGame') return stats.gamesPlayed ? stats.goalsAgainst5v5 / stats.gamesPlayed : null;
        if (key === 'firstPeriodGoalsForPerGame') return stats.gamesPlayed ? stats.firstPeriodGoalsFor / stats.gamesPlayed : null;
        if (key === 'firstPeriodGoalsAgainstPerGame') return stats.gamesPlayed ? stats.firstPeriodGoalsAgainst / stats.gamesPlayed : null;
        if (key === 'secondPeriodGoalsForPerGame') return stats.gamesPlayed ? stats.secondPeriodGoalsFor / stats.gamesPlayed : null;
        if (key === 'secondPeriodGoalsAgainstPerGame') return stats.gamesPlayed ? stats.secondPeriodGoalsAgainst / stats.gamesPlayed : null;
        if (key === 'thirdPeriodGoalsForPerGame') return stats.gamesPlayed ? stats.thirdPeriodGoalsFor / stats.gamesPlayed : null;
        if (key === 'thirdPeriodGoalsAgainstPerGame') return stats.gamesPlayed ? stats.thirdPeriodGoalsAgainst / stats.gamesPlayed : null;
        if (key === 'emptyNetGoalsForPerGame') return stats.gamesPlayed ? stats.emptyNetGoalsFor / stats.gamesPlayed : null;
        if (key === 'emptyNetGoalsAgainstPerGame') return stats.gamesPlayed ? stats.emptyNetGoalsAgainst / stats.gamesPlayed : null;
        if (key === 'goalsForPer60') return stats.timeSeconds5v5 ? stats.goalsFor5v5 * 3600 / stats.timeSeconds5v5 : null;
        if (key === 'goalsAgainstPer60') return stats.timeSeconds5v5 ? stats.goalsAgainst5v5 * 3600 / stats.timeSeconds5v5 : null;
        if (key === 'firstGoalPct') return stats.gamesPlayed ? stats.gamesScoredFirst / stats.gamesPlayed : null;
        if (key === 'firstGoalAllowedPct') return stats.gamesPlayed ? stats.gamesAllowedFirst / stats.gamesPlayed : null;
        if (key === 'faceoffWinPct') return stats.faceoffs ? stats.faceoffWins / stats.faceoffs : null;
        if (key === 'offensiveZoneFaceoffPct') return stats.offensiveZoneFaceoffs ? stats.offensiveZoneFaceoffWins / stats.offensiveZoneFaceoffs : null;
        if (key === 'defensiveZoneFaceoffPct') return stats.defensiveZoneFaceoffs ? stats.defensiveZoneFaceoffWins / stats.defensiveZoneFaceoffs : null;
        if (key === 'neutralZoneFaceoffPct') return stats.neutralZoneFaceoffs ? stats.neutralZoneFaceoffWins / stats.neutralZoneFaceoffs : null;
        if (key === 'offensiveZoneFaceoffsPerGame') return stats.gamesPlayed ? stats.offensiveZoneFaceoffs / stats.gamesPlayed : null;
        if (key === 'defensiveZoneFaceoffsPerGame') return stats.gamesPlayed ? stats.defensiveZoneFaceoffs / stats.gamesPlayed : null;
        if (key === 'neutralZoneFaceoffsPerGame') return stats.gamesPlayed ? stats.neutralZoneFaceoffs / stats.gamesPlayed : null;
        if (key === 'offensiveZoneStartPct') {
          const total = stats.offensiveZoneFaceoffs + stats.defensiveZoneFaceoffs + stats.neutralZoneFaceoffs;
          return total ? stats.offensiveZoneFaceoffs / total : null;
        }
        if (key === 'defensiveZoneStartPct') {
          const total = stats.offensiveZoneFaceoffs + stats.defensiveZoneFaceoffs + stats.neutralZoneFaceoffs;
          return total ? stats.defensiveZoneFaceoffs / total : null;
        }
        if (key.startsWith('position_')) {
          const stat = key.slice(key.lastIndexOf('_') + 1);
          const position = key.slice('position_'.length, key.lastIndexOf('_'));
          const counter = stats.positionAllowed?.[position]?.[stat];
          return stats.gamesPlayed && Number.isFinite(Number(counter)) ? Number(counter) / stats.gamesPlayed : null;
        }
        if (key === 'xGoalsForPerGame') return stats.gamesPlayed ? stats.xGoalsFor / stats.gamesPlayed : null;
        if (key === 'xGoalsAgainstPerGame') return stats.gamesPlayed ? stats.xGoalsAgainst / stats.gamesPlayed : null;
        if (key === 'goalsForPerGame') return stats.gamesPlayed ? stats.goalsFor / stats.gamesPlayed : null;
        if (key === 'goalsAgainstPerGame') return stats.gamesPlayed ? stats.goalsAgainst / stats.gamesPlayed : null;
        if (key === 'shotsForPerGame') return stats.gamesPlayed ? stats.shotsFor / stats.gamesPlayed : null;
        if (key === 'shotsAgainstPerGame') return stats.gamesPlayed ? stats.shotsAgainst / stats.gamesPlayed : null;
        if (key === 'ppGoalsPerGame') return stats.gamesPlayed ? stats.ppGoals / stats.gamesPlayed : null;
        if (key === 'shGoalsForPerGame') return stats.gamesPlayed ? stats.shGoals / stats.gamesPlayed : null;
        if (key === 'shotAttemptsForPerGame') return stats.gamesPlayed ? stats.shotAttemptsFor / stats.gamesPlayed : null;
        if (key === 'shotAttemptsAgainstPerGame') return stats.gamesPlayed ? stats.shotAttemptsAgainst / stats.gamesPlayed : null;
        if (key === 'goalsAboveExpected') return stats.goalsFor - stats.xGoalsFor;
        if (key === 'xGoalsPct') return stats.xGoalsFor + stats.xGoalsAgainst ? stats.xGoalsFor / (stats.xGoalsFor + stats.xGoalsAgainst) : null;
        if (key === 'scoringChancePct') return stats.scoringChancesFor + stats.scoringChancesAgainst ? stats.scoringChancesFor / (stats.scoringChancesFor + stats.scoringChancesAgainst) : null;
        if (key === 'highDangerChancePct') return stats.highDangerChancesFor + stats.highDangerChancesAgainst ? stats.highDangerChancesFor / (stats.highDangerChancesFor + stats.highDangerChancesAgainst) : null;
        if (key === 'xGoalsFor5v5Pct') return stats.xGoalsFor5v5 + stats.xGoalsAgainst5v5 ? stats.xGoalsFor5v5 / (stats.xGoalsFor5v5 + stats.xGoalsAgainst5v5) : null;
        if (key === 'xGoalsForPer60') return stats.timeSeconds5v5 ? stats.xGoalsFor5v5 * 3600 / stats.timeSeconds5v5 : null;
        if (key === 'xGoalsAgainstPer60') return stats.timeSeconds5v5 ? stats.xGoalsAgainst5v5 * 3600 / stats.timeSeconds5v5 : null;
        if (key === 'ppXGoalsPer60') return stats.timeSecondsPP ? stats.xGoalsForPP * 3600 / stats.timeSecondsPP : null;
        if (key === 'scoringChancesForPerGame') return stats.gamesPlayed ? stats.scoringChancesFor / stats.gamesPlayed : null;
        if (key === 'scoringChancesAgainstPerGame') return stats.gamesPlayed ? stats.scoringChancesAgainst / stats.gamesPlayed : null;
        if (key === 'highDangerChancesForPerGame') return stats.gamesPlayed ? stats.highDangerChancesFor / stats.gamesPlayed : null;
        if (key === 'highDangerChancesAgainstPerGame') return stats.gamesPlayed ? stats.highDangerChancesAgainst / stats.gamesPlayed : null;
        if (key === 'highDangerShotsForPerGame') return stats.gamesPlayed ? stats.highDangerShotsFor / stats.gamesPlayed : null;
        if (key === 'highDangerShotsAgainstPerGame') return stats.gamesPlayed ? stats.highDangerShotsAgainst / stats.gamesPlayed : null;
        if (key === 'blockedShotsPerGame' || key === 'hitsPerGame' || key === 'takeawaysPerGame'
          || key === 'giveawaysPerGame' || key === 'penaltiesTakenPerGame' || key === 'penaltiesDrawnPerGame'
          || key === 'penaltyMinutesPerGame' || key === 'ppShotsPerGame') {
          const sourceKey = key === 'ppShotsPerGame' ? 'powerPlayShotsFor' : key.slice(0, -'PerGame'.length);
          return stats.gamesPlayed ? Number(stats[sourceKey] || 0) / stats.gamesPlayed : null;
        }
        return stats[key];
      };
      const metricKeys = [
        'shootingPct', 'teamSavePct', 'pdo5v5', 'goalDiff5v5PerGame', 'goalsFor5v5PerGame', 'goalsAgainst5v5PerGame',
        'firstPeriodGoalsForPerGame', 'firstPeriodGoalsAgainstPerGame', 'secondPeriodGoalsForPerGame', 'secondPeriodGoalsAgainstPerGame',
        'thirdPeriodGoalsForPerGame', 'thirdPeriodGoalsAgainstPerGame', 'emptyNetGoalsForPerGame', 'emptyNetGoalsAgainstPerGame',
        'goalsForPer60', 'goalsAgainstPer60',
        'firstGoalPct', 'firstGoalAllowedPct', 'faceoffWinPct', 'offensiveZoneFaceoffPct',
        'defensiveZoneFaceoffPct', 'neutralZoneFaceoffPct', 'offensiveZoneStartPct', 'defensiveZoneStartPct',
        'offensiveZoneFaceoffsPerGame', 'defensiveZoneFaceoffsPerGame', 'neutralZoneFaceoffsPerGame',
        'blockedShotsPerGame', 'hitsPerGame', 'takeawaysPerGame', 'giveawaysPerGame',
        'penaltiesTakenPerGame', 'penaltiesDrawnPerGame', 'penaltyMinutesPerGame', 'ppShotsPerGame',
        ...['all', 'Centers', 'Left Wings', 'Right Wings', 'Defensemen'].flatMap((position) =>
          ['shots', 'goals', 'assists', 'points', 'attempts', 'ppPoints', 'ppShots'].map((stat) => `position_${position}_${stat}`)),
        'goalsFor', 'goalsForPerGame', 'goalsAgainst', 'goalsAgainstPerGame', 'ppGoalsPerGame', 'shGoalsForPerGame',
        'shotsFor', 'shotsForPerGame', 'shotsAgainst', 'shotsAgainstPerGame',
        'shotAttemptsForPerGame', 'shotAttemptsAgainstPerGame',
        'corsiFor5v5', 'corsiAgainst5v5', 'fenwickFor5v5', 'fenwickAgainst5v5', 'corsiPct', 'fenwickPct',
        'xGoalsFor', 'xGoalsForPerGame', 'xGoalsAgainst', 'xGoalsAgainstPerGame', 'goalsAboveExpected',
        'scoringChancesForPerGame', 'scoringChancesAgainstPerGame', 'highDangerChancesForPerGame',
        'highDangerChancesAgainstPerGame', 'highDangerShotsForPerGame', 'highDangerShotsAgainstPerGame',
        'xGoalsPct', 'scoringChancePct', 'highDangerChancePct', 'scoreAdjustedCorsi', 'scoreAdjustedFenwick',
        'xGoalsFor5v5Pct', 'xGoalsForPer60', 'xGoalsAgainstPer60', 'ppXGoalsPer60',
        'powerPlayPct', 'ppOpportunitiesPerGame', 'penaltyKillPct', 'timesShorthandedPerGame', 'ppGoalsAgainstPerGame',
      ];
      const lowerIsBetter = new Set([
        'goalsAgainst', 'goalsAgainstPerGame', 'shotsAgainstPerGame', 'shotAttemptsAgainstPerGame',
        'corsiAgainst5v5', 'fenwickAgainst5v5',
        'goalsAgainst5v5PerGame', 'firstPeriodGoalsAgainstPerGame', 'emptyNetGoalsAgainstPerGame',
        'secondPeriodGoalsAgainstPerGame', 'thirdPeriodGoalsAgainstPerGame', 'goalsAgainstPer60',
        'firstGoalAllowedPct', 'defensiveZoneStartPct',
        ...metricKeys.filter((key) => key.startsWith('position_')),
        'xGoalsAgainst', 'xGoalsAgainstPerGame', 'scoringChancesAgainstPerGame',
        'highDangerChancesAgainstPerGame', 'highDangerShotsAgainstPerGame', 'xGoalsAgainstPer60',
        'timesShorthandedPerGame', 'ppGoalsAgainstPerGame',
      ]);

      // Precompute league ranks for every comparison filter. The encoded rank
      // strings keep the API response small: each character is a metric rank in
      // `leagueRangeRankMetricOrder` (base 36, with '-' for unavailable).
      const rangeRankTeamOrder = Object.keys(allIdsByAbbr).sort();
      const rangeRankMetricOrder = metricKeys;
      const rangeRankTimeframes = [
        { key: 'season', limit: null, homeRoad: null },
        { key: 'l5', limit: 5, homeRoad: null },
        { key: 'l10', limit: 10, homeRoad: null },
        { key: 'l15', limit: 15, homeRoad: null },
        { key: 'homeAway:away', limit: null, homeRoad: 'A' },
        { key: 'homeAway:home', limit: null, homeRoad: 'H' },
      ];
      const rangePeriods = [['full', '0'], ['1', '1'], ['2', '2'], ['3', '3']];
      const rangeStrengths = ['all', '5v5', 'pp', 'pk'];
      const leagueEventSplitsByGameId: Record<string, any> = {};
      for (const gameId of new Set([...Object.keys(baseEventSplitsByGameId), ...Object.keys(advancedEventSplitsByGameId)])) {
        leagueEventSplitsByGameId[gameId] = mergeEventSplitTrees(
          mergeEventSplitTrees({}, baseEventSplitsByGameId[gameId] || {}),
          advancedEventSplitsByGameId[gameId] || {},
        );
      }
      const sumEventField = (eventRows: any[], periodKey: string, strength: string, field: string) => eventRows.reduce((total, eventRow) => {
        const value = eventRow?.event?.[periodKey]?.[strength]?.[field];
        const parsed = Number(value);
        return total + (Number.isFinite(parsed) ? parsed : 0);
      }, 0);
      const rangeStatsFor = (abbr: string, selectedGames: any[], periodKey: string, strength: string) => {
        const eventRows = selectedGames.map((game) => ({
          game,
          event: leagueEventSplitsByGameId[String(game.gameId)]?.[abbr],
        })).filter((row) => row.event);
        if (!eventRows.length) return null;
        const gamesPlayed = eventRows.length;
        const sumEvent = (field: string, eventStrength = strength) => sumEventField(eventRows, periodKey, eventStrength, field);
        const all = (field: string) => sumEvent(field, 'all');
        const fiveOnFive = (field: string) => sumEvent(field, '5v5');
        const powerPlay = (field: string) => sumEvent(field, 'pp');
        const penaltyKill = (field: string) => sumEvent(field, 'pk');
        const stats: Record<string, any> = {
          gamesPlayed,
          goalsFor: sumEvent('goalsFor'), goalsAgainst: sumEvent('goalsAgainst'),
          shotsFor: sumEvent('shotsFor'), shotsAgainst: sumEvent('shotsAgainst'),
          shotAttemptsFor: sumEvent('shotAttemptsFor'), shotAttemptsAgainst: sumEvent('shotAttemptsAgainst'),
          corsiFor5v5: fiveOnFive('shotAttemptsFor'), corsiAgainst5v5: fiveOnFive('shotAttemptsAgainst'),
          fenwickFor5v5: fiveOnFive('unblockedAttemptsFor'), fenwickAgainst5v5: fiveOnFive('unblockedAttemptsAgainst'),
          goalsFor5v5: fiveOnFive('goalsFor'), goalsAgainst5v5: fiveOnFive('goalsAgainst'),
          shotsFor5v5: fiveOnFive('shotsFor'), shotsAgainst5v5: fiveOnFive('shotsAgainst'),
          firstPeriodGoalsFor: sumEvent('goalsFor', 'all'), firstPeriodGoalsAgainst: sumEvent('goalsAgainst', 'all'),
          emptyNetGoalsFor: all('emptyNetGoals'), emptyNetGoalsAgainst: all('emptyNetGoalsAgainst'),
          gamesScoredFirst: eventRows.filter((row) => row.event.firstGoalFor === true).length,
          gamesAllowedFirst: eventRows.filter((row) => row.event.firstGoalAgainst === true).length,
          faceoffWins: sumEvent('faceoffWins'), faceoffs: sumEvent('faceoffs'),
          offensiveZoneFaceoffWins: sumEvent('offensiveZoneFaceoffWins'), offensiveZoneFaceoffs: sumEvent('offensiveZoneFaceoffs'),
          defensiveZoneFaceoffWins: sumEvent('defensiveZoneFaceoffWins'), defensiveZoneFaceoffs: sumEvent('defensiveZoneFaceoffs'),
          neutralZoneFaceoffWins: sumEvent('neutralZoneFaceoffWins'), neutralZoneFaceoffs: sumEvent('neutralZoneFaceoffs'),
          xGoalsFor: sumEvent('xGoalsFor'), xGoalsAgainst: sumEvent('xGoalsAgainst'),
          xGoalsFor5v5: fiveOnFive('xGoalsFor'), xGoalsAgainst5v5: fiveOnFive('xGoalsAgainst'),
          xGoalsForPP: powerPlay('xGoalsFor'),
          scoringChancesFor: sumEvent('scoringChancesFor'), scoringChancesAgainst: sumEvent('scoringChancesAgainst'),
          highDangerChancesFor: sumEvent('highDangerChancesFor'), highDangerChancesAgainst: sumEvent('highDangerChancesAgainst'),
          highDangerShotsFor: sumEvent('highDangerShotsFor'), highDangerShotsAgainst: sumEvent('highDangerShotsAgainst'),
          scoreAdjustedCorsi: fiveOnFive('scoreAdjustedCorsiFor'), scoreAdjustedFenwick: fiveOnFive('scoreAdjustedFenwickFor'),
          timeSeconds5v5: fiveOnFive('timeSeconds'), timeSecondsPP: powerPlay('timeSeconds'),
          ppGoals: powerPlay('ppGoals'), shGoals: penaltyKill('shGoals'),
          powerPlayShotsFor: powerPlay('shotsFor'),
          blockedShots: sumEvent('blockedShots'), hits: sumEvent('hits'), takeaways: sumEvent('takeaways'),
          giveaways: sumEvent('giveaways'), penaltiesTaken: sumEvent('penaltiesTaken'),
          penaltiesDrawn: sumEvent('penaltiesDrawn'), penaltyMinutes: sumEvent('penaltyMinutes'),
          positionAllowed: Object.fromEntries(['all', 'Centers', 'Left Wings', 'Right Wings', 'Defensemen'].map((position) => [position, {
            shots: 0, goals: 0, assists: 0, points: 0, attempts: 0, ppPoints: 0, ppShots: 0,
          }])),
        };
        const selectedStats = selectedGames.map((game) => game.stats || {});
        const sumReport = (field: string) => {
          const values = selectedStats.map((row) => row?.[field] == null || row?.[field] === '' ? null : Number(row[field]))
            .filter((value): value is number => value != null && Number.isFinite(value));
          return values.length ? values.reduce((total, value) => total + value, 0) : null;
        };
        const averageReport = (field: string) => {
          const values = selectedStats.map((row) => row?.[field] == null || row?.[field] === '' ? null : Number(row[field]))
            .filter((value): value is number => value != null && Number.isFinite(value));
          return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
        };
        const ppOpportunities = sumReport('ppOpportunities');
        const powerPlayGoals = sumReport('powerPlayGoalsFor');
        const timesShorthanded = sumReport('timesShorthanded');
        const ppGoalsAgainst = sumReport('ppGoalsAgainst');
        stats.ppOpportunities = ppOpportunities;
        stats.ppOpportunitiesPerGame = ppOpportunities != null && gamesPlayed ? ppOpportunities / gamesPlayed : averageReport('ppOpportunities');
        stats.powerPlayPct = ppOpportunities && powerPlayGoals != null ? powerPlayGoals / ppOpportunities : averageReport('powerPlayPct');
        stats.timesShorthanded = timesShorthanded;
        stats.timesShorthandedPerGame = timesShorthanded != null && gamesPlayed ? timesShorthanded / gamesPlayed : averageReport('timesShorthanded');
        stats.penaltyKillPct = timesShorthanded && ppGoalsAgainst != null ? 1 - ppGoalsAgainst / timesShorthanded : averageReport('penaltyKillPct');
        stats.ppGoalsAgainstPerGame = averageReport('ppGoalsAgainst')
          ?? (gamesPlayed ? penaltyKill('goalsAgainst') / gamesPlayed : null);
        for (const position of ['Centers', 'Left Wings', 'Right Wings', 'Defensemen']) {
          for (const stat of ['shots', 'goals', 'assists', 'points', 'attempts', 'ppPoints', 'ppShots']) {
            const total = eventRows.reduce((sum, row) => {
              const value = row.event.positionStats?.[periodKey]?.[strength]?.[position]?.[stat];
              return sum + (Number.isFinite(Number(value)) ? Number(value) : 0);
            }, 0);
            stats.positionAllowed[position][stat] = total;
            stats.positionAllowed.all[stat] += total;
          }
        }
        return stats;
      };
      const leagueRangeRanks: Record<string, Record<string, string>> = {};
      for (const timeframe of rangeRankTimeframes) {
        for (const [period, periodKey] of rangePeriods) {
          for (const strength of rangeStrengths) {
            const selectionKey = `${timeframe.key}|${period}|${strength}`;
            const totalsByAbbr: Record<string, any> = {};
            for (const abbr of rangeRankTeamOrder) {
              let selectedGames = Object.values(leagueGamesByAbbr[abbr] || {})
                .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
              if (timeframe.homeRoad) selectedGames = selectedGames.filter((row: any) => row.homeRoad === timeframe.homeRoad);
              if (timeframe.limit) selectedGames = selectedGames.slice(0, timeframe.limit);
              totalsByAbbr[abbr] = rangeStatsFor(abbr, selectedGames, periodKey, strength);
            }
            const ranksByStat: Record<string, Record<string, number>> = Object.fromEntries(rangeRankTeamOrder.map((abbr) => [abbr, {}]));
            for (const key of metricKeys) {
              const ranked = rangeRankTeamOrder
                .map((abbr) => ({ abbr, value: totalsByAbbr[abbr] ? metricValue(totalsByAbbr[abbr], key) : null }))
                .filter((item) => item.value != null && item.value !== '' && Number.isFinite(Number(item.value)))
                .sort((a, b) => (lowerIsBetter.has(key) ? Number(a.value) - Number(b.value) : Number(b.value) - Number(a.value)) || a.abbr.localeCompare(b.abbr));
              let rank = 0;
              let lastValue: number | null = null;
              ranked.forEach((item, index) => {
                const value = Number(item.value);
                if (lastValue == null || Math.abs(value - lastValue) > 1e-8) rank = index + 1;
                ranksByStat[item.abbr][key] = rank;
                lastValue = value;
              });
            }
            leagueRangeRanks[selectionKey] = Object.fromEntries(rangeRankTeamOrder.map((abbr) => [abbr,
              rangeRankMetricOrder.map((key) => {
                const rank = ranksByStat[abbr][key];
                return rank ? rank.toString(36).toUpperCase() : '-';
              }).join(''),
            ]));
          }
        }
      }
      for (const [abbr, stats] of Object.entries(totals)) {
        advancedByAbbr[abbr] = { ...stats, rankByStat: {} };
      }
      for (const key of metricKeys) {
        const ranked = Object.entries(advancedByAbbr)
          .map(([abbr, stats]: [string, any]) => ({ abbr, value: metricValue(stats, key) }))
          .filter((item) => item.value != null && item.value !== '' && Number.isFinite(Number(item.value)))
          .sort((a, b) => (lowerIsBetter.has(key) ? Number(a.value) - Number(b.value) : Number(b.value) - Number(a.value)) || a.abbr.localeCompare(b.abbr));
        let rank = 0;
        let lastValue: number | null = null;
        ranked.forEach((item, index) => {
          const value = Number(item.value);
          if (lastValue == null || Math.abs(value - lastValue) > 1e-8) rank = index + 1;
          advancedByAbbr[item.abbr].rankByStat[key] = rank;
          lastValue = value;
        });
      }
      const value = {
        model: { method: 'NHL PBP logistic model', trainingShots: model.trainingShots },
        eventSplitsByGameId: advancedEventSplitsByGameId,
        baseEventSplitsByGameId,
        leagueAdvancedByAbbr: advancedByAbbr,
        leagueRangeRanks,
        leagueRangeRankMetricOrder: rangeRankMetricOrder,
        gamesFetched: Object.keys(baseEventSplitsByGameId).length,
      };
      LEAGUE_PBP_CACHE.set(seasonId, { expiresAt: Date.now() + LEAGUE_PBP_CACHE_TTL_MS, value });
      return value;
    })();
    LEAGUE_PBP_IN_FLIGHT.set(seasonId, promise);
    try {
      return await promise;
    } finally {
      LEAGUE_PBP_IN_FLIGHT.delete(seasonId);
    }
  })();
}

async function fetchHeadToHeadGames(awayAbbr: string, homeAbbr: string, seasonStart: number) {
  const seasons = [seasonStart, seasonStart - 1, seasonStart - 2];
  const scheduleTeamAbbrs = awayAbbr === 'UTA' ? ['UTA', 'ARI'] : [awayAbbr];
  const schedules = await Promise.allSettled(scheduleTeamAbbrs.flatMap((teamAbbr) => seasons.map((season) =>
    getJson(`${NHL_WEB_ROOT}/club-schedule-season/${encodeURIComponent(teamAbbr)}/${seasonIdFor(season)}`)
  )));
  const franchiseAbbr = (value: unknown) => {
    const abbr = normalizeAbbr(value);
    return abbr === 'ARI' ? 'UTA' : abbr;
  };
  const seenGameIds = new Set<number>();
  return schedules.flatMap((result) => {
    if (result.status !== 'fulfilled') return [];
    return Array.isArray((result.value as any)?.games) ? (result.value as any).games : [];
  }).filter((game: any) => {
    const gameType = Number(game?.gameType);
    const isTargetMatchup =
      (franchiseAbbr(game?.awayTeam?.abbrev) === awayAbbr && franchiseAbbr(game?.homeTeam?.abbrev) === homeAbbr)
      || (franchiseAbbr(game?.awayTeam?.abbrev) === homeAbbr && franchiseAbbr(game?.homeTeam?.abbrev) === awayAbbr);
    // The NHL schedule feed uses `OFF` for completed games (not `FINAL`).
    const isCompleted = ['OFF', 'FINAL', 'FINAL_OT', 'FINAL_SO'].includes(String(game?.gameState || '').toUpperCase())
      && game?.awayTeam?.score != null
      && game?.homeTeam?.score != null
      && Number.isFinite(Number(game.awayTeam.score))
      && Number.isFinite(Number(game.homeTeam.score));
    if (!isTargetMatchup || (gameType !== 2 && gameType !== 3) || !isCompleted) return false;
    const gameId = Number(game?.id);
    if (!Number.isFinite(gameId) || seenGameIds.has(gameId)) return false;
    seenGameIds.add(gameId);
    return true;
  }).sort((a: any, b: any) => String(b?.gameDate || '').localeCompare(String(a?.gameDate || '')))
    .slice(0, 10)
    .map((game: any) => ({
      gameId: Number(game.id),
      date: game.gameDate || null,
      gameType: Number(game.gameType),
      awayAbbr: franchiseAbbr(game?.awayTeam?.abbrev),
      awayTeam: [game?.awayTeam?.placeName?.default, game?.awayTeam?.commonName?.default].filter(Boolean).join(' ') || game?.awayTeam?.abbrev || '',
      awayScore: Number(game?.awayTeam?.score),
      homeAbbr: franchiseAbbr(game?.homeTeam?.abbrev),
      homeTeam: [game?.homeTeam?.placeName?.default, game?.homeTeam?.commonName?.default].filter(Boolean).join(' ') || game?.homeTeam?.abbrev || '',
      homeScore: Number(game?.homeTeam?.score),
      venue: game?.venue?.default || game?.venue?.name || '',
    }));
}

function mergeEventSplitTrees(target: any, source: any) {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = Number(target[key] || 0) + value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ||= {};
      mergeEventSplitTrees(target[key], value);
    } else if (target[key] == null) {
      target[key] = value;
    }
  }
  return target;
}

function eventTeam(event: any, homeId: number, awayId: number) {
  const owner = Number(event?.details?.eventOwnerTeamId);
  return owner === homeId || owner === awayId ? owner : null;
}

function eventStrengthForTeam(event: any, teamId: number, homeId: number, awayId: number) {
  const code = String(event?.situationCode || '').padStart(4, '0');
  // NHL situationCode is away goalie, away skaters, home skaters, home goalie.
  const awayGoalie = Number(code[0]);
  const awaySkaters = Number(code[1]);
  const homeSkaters = Number(code[2]);
  const homeGoalie = Number(code[3]);
  if (![awayGoalie, awaySkaters, homeSkaters, homeGoalie].every(Number.isFinite)) return 'other';
  // A 6-on-5 with the goalie pulled is not a power play. Ignore manpower
  // classifications while either net is empty so empty-net sequences do not
  // contaminate PP/PK goals, shots, or xG rates.
  if (!awayGoalie || !homeGoalie) return 'other';
  const own = teamId === homeId ? homeSkaters : teamId === awayId ? awaySkaters : 0;
  const opp = teamId === homeId ? awaySkaters : teamId === awayId ? homeSkaters : 0;
  if (own === 5 && opp === 5) return '5v5';
  if (own > opp) return 'pp';
  if (own < opp) return 'pk';
  return 'other';
}

function addCount(target: any, key: string, value = 1) {
  target[key] = Number(target[key] || 0) + value;
}

function buildGameEventSplits(payload: any, teamIdsByAbbr: Record<string, number>, abbreviations: string[]) {
  const homeId = Number(payload?.homeTeam?.id);
  const awayId = Number(payload?.awayTeam?.id);
  const abbrById = new Map(Object.entries(teamIdsByAbbr).map(([abbr, id]) => [Number(id), abbr]));
  const trackedIds = new Set(abbreviations.map((abbr) => teamIdsByAbbr[abbr]).filter(Number.isFinite));
  const rosterTeamByPlayer = new Map((Array.isArray(payload?.rosterSpots) ? payload.rosterSpots : [])
    .map((spot: any) => [Number(spot?.playerId), Number(spot?.teamId)]));
  const rosterPositionByPlayer = new Map((Array.isArray(payload?.rosterSpots) ? payload.rosterSpots : [])
    .map((spot: any) => [Number(spot?.playerId), String(spot?.positionCode || '').toUpperCase()]));
  const output: Record<string, any> = {};
  const getBucket = (abbr: string, period: number, strength: string) => {
    output[abbr] ||= {};
    const periodKey = String(period || 0);
    output[abbr][periodKey] ||= {};
    output[abbr][periodKey].all ||= {};
    output[abbr][periodKey][strength] ||= {};
    return output[abbr][periodKey];
  };
  const incrementFor = (abbr: string, period: number, strength: string, metric: string, value = 1) => {
    const byPeriod = getBucket(abbr, period, strength);
    addCount(byPeriod.all, metric, value);
    if (byPeriod[strength]) addCount(byPeriod[strength], metric, value);
    if (period !== 0) {
      const fullGame = getBucket(abbr, 0, strength);
      addCount(fullGame.all, metric, value);
      if (fullGame[strength]) addCount(fullGame[strength], metric, value);
    }
  };
  const positionName = (playerId: unknown) => {
    const position = rosterPositionByPlayer.get(Number(playerId));
    return position === 'C' ? 'Centers'
      : position === 'L' ? 'Left Wings'
        : position === 'R' ? 'Right Wings'
          : position === 'D' ? 'Defensemen' : null;
  };
  const incrementPosition = (abbr: string, period: number, strength: string, position: string, metric: string) => {
    const target = output[abbr] ||= {};
    target.positionStats ||= {};
    const periodKey = String(period || 0);
    const incrementBucket = (key: string, situation: string) => {
      target.positionStats[key] ||= {};
      target.positionStats[key].all ||= {};
      target.positionStats[key][situation] ||= {};
      target.positionStats[key].all[position] ||= {};
      target.positionStats[key][situation][position] ||= {};
      target.positionStats[key].all[position][metric] = (target.positionStats[key].all[position][metric] || 0) + 1;
      target.positionStats[key][situation][position][metric] = (target.positionStats[key][situation][position][metric] || 0) + 1;
    };
    incrementBucket(periodKey, strength);
    if (period !== 0) incrementBucket('0', strength);
  };
  const plays = Array.isArray(payload?.plays) ? [...payload.plays] : [];
  plays.sort((a: any, b: any) => (Number(a?.periodDescriptor?.number) - Number(b?.periodDescriptor?.number))
    || (Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0)));
  let firstGoalTeamId: number | null = null;
  for (const event of plays) {
    const type = String(event?.typeDescKey || '').toLowerCase();
    if (String(event?.periodDescriptor?.periodType || '').toUpperCase() === 'SO') continue;
    const details = event?.details || {};
    const period = Number(event?.periodDescriptor?.number) || 0;
    const ownerId = eventTeam(event, homeId, awayId);
    const ownerAbbr = ownerId ? abbrById.get(ownerId) : null;
    // eventOwnerTeamId is the team taking the shot, including blocked shots.
    // The blocking team is represented separately by blockingPlayerId.
    const shotTeamId = ownerId;

    if (type === 'goal') {
      const scoringId = Number(details?.eventOwnerTeamId || rosterTeamByPlayer.get(Number(details?.scoringPlayerId)));
      const scoringAbbr = abbrById.get(scoringId);
      const emptyNet = /empty.?net/i.test(String(details?.goalModifier || '')) || !details?.goalieInNetId;
      if (scoringId && !firstGoalTeamId) firstGoalTeamId = scoringId;
      for (const abbr of abbreviations) {
        const teamId = teamIdsByAbbr[abbr];
        const strength = eventStrengthForTeam(event, teamId, homeId, awayId);
        if (!trackedIds.has(teamId)) continue;
        incrementFor(abbr, period, strength, scoringId === teamId ? 'goalsFor' : 'goalsAgainst');
        if (scoringId === teamId && strength === 'pp') incrementFor(abbr, period, strength, 'ppGoals');
        if (scoringId === teamId && strength === 'pk') incrementFor(abbr, period, strength, 'shGoals');
        if (emptyNet && scoringId === teamId) incrementFor(abbr, period, strength, 'emptyNetGoals');
        if (emptyNet && scoringId !== teamId) incrementFor(abbr, period, strength, 'emptyNetGoalsAgainst');
        if (scoringId !== teamId) {
          const scoringPosition = positionName(details?.scoringPlayerId);
          if (scoringPosition) {
            incrementPosition(abbr, period, strength, scoringPosition, 'goals');
            incrementPosition(abbr, period, strength, scoringPosition, 'points');
            if (strength === 'pk') incrementPosition(abbr, period, strength, scoringPosition, 'ppPoints');
          }
          for (const assistId of [details?.assist1PlayerId, details?.assist2PlayerId]) {
            const assistPosition = positionName(assistId);
            if (assistPosition) {
              incrementPosition(abbr, period, strength, assistPosition, 'assists');
              incrementPosition(abbr, period, strength, assistPosition, 'points');
              if (strength === 'pk') incrementPosition(abbr, period, strength, assistPosition, 'ppPoints');
            }
          }
        }
      }
      if (scoringAbbr && period) {
        // Keep the first-goal marker attached to the game's event detail for simple downstream use.
        output[scoringAbbr] ||= {};
      }
    }

    if (['shot-on-goal', 'goal', 'missed-shot', 'blocked-shot'].includes(type)) {
      const attemptAbbr = abbrById.get(shotTeamId);
      const shooterId = Number(details?.shootingPlayerId);
      const shooterTeamId = Number(rosterTeamByPlayer.get(shooterId) || shotTeamId);
      const shooterPosition = positionName(shooterId);
      for (const abbr of abbreviations) {
        const teamId = teamIdsByAbbr[abbr];
        const strength = eventStrengthForTeam(event, teamId, homeId, awayId);
        if (!trackedIds.has(teamId)) continue;
        const isAttemptFor = teamId === shotTeamId;
        if (isAttemptFor) {
          incrementFor(abbr, period, strength, 'shotAttemptsFor');
          if (type !== 'blocked-shot') incrementFor(abbr, period, strength, 'unblockedAttemptsFor');
          if (type === 'shot-on-goal' || type === 'goal') incrementFor(abbr, period, strength, 'shotsFor');
        } else {
          incrementFor(abbr, period, strength, 'shotAttemptsAgainst');
          if (type !== 'blocked-shot') incrementFor(abbr, period, strength, 'unblockedAttemptsAgainst');
          if (type === 'shot-on-goal' || type === 'goal') incrementFor(abbr, period, strength, 'shotsAgainst');
          if (type === 'blocked-shot') incrementFor(abbr, period, strength, 'blockedShots');
          if (shooterTeamId === (teamId === homeId ? awayId : homeId) && shooterPosition) {
            incrementPosition(abbr, period, strength, shooterPosition, 'attempts');
            if (type === 'shot-on-goal' || type === 'goal') {
              incrementPosition(abbr, period, strength, shooterPosition, 'shots');
              if (strength === 'pk') incrementPosition(abbr, period, strength, shooterPosition, 'ppShots');
            }
          }
        }
      }
      if (!attemptAbbr && type !== 'blocked-shot') console.warn('NHL PBP shot event had no tracked team owner');
    }

    if (ownerAbbr && abbreviations.includes(ownerAbbr) && ['hit', 'takeaway', 'giveaway'].includes(type)) {
      const metric = type === 'hit' ? 'hits' : type === 'takeaway' ? 'takeaways' : 'giveaways';
      incrementFor(ownerAbbr, period, eventStrengthForTeam(event, teamIdsByAbbr[ownerAbbr], homeId, awayId), metric);
    }

    if (type === 'penalty' && ownerAbbr && abbreviations.includes(ownerAbbr)) {
      const strength = eventStrengthForTeam(event, teamIdsByAbbr[ownerAbbr], homeId, awayId);
      incrementFor(ownerAbbr, period, strength, 'penaltiesTaken');
      incrementFor(ownerAbbr, period, strength, 'penaltyMinutes', Number(details?.duration) || 0);
      const otherAbbr = ownerId === homeId ? abbrById.get(awayId) : abbrById.get(homeId);
      if (otherAbbr && abbreviations.includes(otherAbbr)) incrementFor(otherAbbr, period, eventStrengthForTeam(event, teamIdsByAbbr[otherAbbr], homeId, awayId), 'penaltiesDrawn');
    }

    if (type === 'faceoff') {
      const winnerTeamId = Number(rosterTeamByPlayer.get(Number(details?.winningPlayerId)) || ownerId);
      const loserTeamId = Number(rosterTeamByPlayer.get(Number(details?.losingPlayerId)));
      const zone = String(details?.zoneCode || '').toUpperCase();
      for (const abbr of abbreviations) {
        const teamId = teamIdsByAbbr[abbr];
        const strength = eventStrengthForTeam(event, teamId, homeId, awayId);
        if (winnerTeamId === teamId || loserTeamId === teamId) {
          incrementFor(abbr, period, strength, 'faceoffs');
          if (winnerTeamId === teamId) incrementFor(abbr, period, strength, 'faceoffWins');
          const teamZone = zone === 'N' ? 'N' : (ownerId === teamId ? zone : zone === 'O' ? 'D' : zone === 'D' ? 'O' : 'N');
          if (teamZone === 'O') {
            incrementFor(abbr, period, strength, 'offensiveZoneFaceoffs');
            if (winnerTeamId === teamId) incrementFor(abbr, period, strength, 'offensiveZoneFaceoffWins');
          } else if (teamZone === 'D') {
            incrementFor(abbr, period, strength, 'defensiveZoneFaceoffs');
            if (winnerTeamId === teamId) incrementFor(abbr, period, strength, 'defensiveZoneFaceoffWins');
          } else {
            incrementFor(abbr, period, strength, 'neutralZoneFaceoffs');
            if (winnerTeamId === teamId) incrementFor(abbr, period, strength, 'neutralZoneFaceoffWins');
          }
        }
      }
    }
  }

  // Attribute elapsed game time to the manpower state recorded by the prior event.
  // This gives GF/60 and GA/60 a real 5v5 denominator, including period filters.
  const byPeriod = new Map<number, any[]>();
  for (const event of plays) {
    const number = Number(event?.periodDescriptor?.number) || 0;
    if (!number || String(event?.periodDescriptor?.periodType || '').toUpperCase() === 'SO') continue;
    byPeriod.set(number, [...(byPeriod.get(number) || []), event]);
  }
  for (const [period, periodEvents] of byPeriod) {
    const ordered = periodEvents.sort((a, b) => Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0));
    const periodType = String(ordered[0]?.periodDescriptor?.periodType || '').toUpperCase();
    const periodLength = periodType === 'OT' ? 300 : 1200;
    const elapsed = (event: any) => {
      const [minutes, seconds] = String(event?.timeInPeriod || '0:00').split(':').map(Number);
      return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : null;
    };
    const lastEvent = ordered[ordered.length - 1];
    const terminalTime = String(lastEvent?.typeDescKey || '').toLowerCase() === 'game-end'
      ? elapsed(lastEvent) ?? periodLength
      : periodLength;
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      const start = elapsed(current);
      const next = index + 1 < ordered.length ? elapsed(ordered[index + 1]) : terminalTime;
      if (start == null || next == null) continue;
      const seconds = Math.max(0, Math.min(periodLength, next) - Math.min(periodLength, start));
      if (!seconds) continue;
      for (const abbr of abbreviations) {
        const teamId = teamIdsByAbbr[abbr];
        const strength = eventStrengthForTeam(current, teamId, homeId, awayId);
        incrementFor(abbr, period, strength, 'timeSeconds', seconds);
      }
    }
  }

  const finalEvent = [...plays].reverse().find((event: any) => String(event?.typeDescKey || '').toLowerCase() === 'game-end');
  const lastPeriodEvent = [...plays].reverse().find((event: any) => Number(event?.periodDescriptor?.number) > 0);
  const gameEndPeriodType = plays.some((event: any) => String(event?.periodDescriptor?.periodType || '').toUpperCase() === 'SO')
    ? 'SO'
    : finalEvent?.periodDescriptor?.periodType || lastPeriodEvent?.periodDescriptor?.periodType || null;
  for (const abbr of abbreviations) {
    output[abbr] ||= {};
    output[abbr].firstGoalFor = firstGoalTeamId == null ? null : firstGoalTeamId === teamIdsByAbbr[abbr];
    output[abbr].firstGoalAgainst = firstGoalTeamId == null ? null : firstGoalTeamId !== teamIdsByAbbr[abbr];
    output[abbr].gameEndPeriodType = gameEndPeriodType;
  }
  return output;
}

async function fetchComparison(seasonId: number, abbreviations: string[], awayAbbr: string, homeAbbr: string) {
  const headToHeadPromise = fetchHeadToHeadGames(awayAbbr, homeAbbr, Math.floor(seasonId / 10000))
    .catch((error) => {
      console.warn('NHL head-to-head schedule history unavailable:', error);
      return [];
    });
  const teamsPayload = await getJson(`${NHL_STATS_ROOT}/team?limit=100`);
  const teams = Array.isArray(teamsPayload?.data) ? teamsPayload.data : [];
  const teamIdsByAbbr: Record<string, number> = {};
  for (const abbr of abbreviations) {
    const match = teams.find((team: any) => normalizeAbbr(team?.triCode) === abbr);
    const id = Number(match?.id);
    if (!Number.isFinite(id)) throw new Error(`NHL team ID was not found for ${abbr}.`);
    teamIdsByAbbr[abbr] = id;
  }
  const abbrById = new Map(Object.entries(teamIdsByAbbr).map(([abbr, id]) => [Number(id), abbr]));
  const ids = Object.values(teamIdsByAbbr);
  const edgeResults = await Promise.allSettled(abbreviations.map(async (abbr) => [
    abbr,
    await fetchTeamEdgeStats(teamIdsByAbbr[abbr], seasonId),
  ] as const));
  const edgeStatsByAbbr: Record<string, any> = {};
  for (const result of edgeResults) {
    if (result.status === 'fulfilled') {
      edgeStatsByAbbr[result.value[0]] = result.value[1];
    } else {
      console.warn('NHL EDGE team detail unavailable:', result.reason);
    }
  }
  const reportResults = await Promise.allSettled(REPORTS.map((report) => fetchReportGames(report, seasonId, ids)));
  const gamesByTeamId: Record<string, Record<string, any>> = Object.fromEntries(ids.map((id) => [String(id), {}]));
  reportResults.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      console.warn(`NHL per-game team report ${REPORTS[index]} unavailable:`, result.reason);
      return;
    }
    for (const row of result.value) {
      const teamId = String(row?.teamId ?? '');
      const gameId = String(row?.gameId ?? '');
      if (!gamesByTeamId[teamId] || !gameId) continue;
      gamesByTeamId[teamId][gameId] ||= {
        gameId: Number(gameId),
        date: row?.gameDate || null,
        homeRoad: row?.homeRoad === 'H' ? 'H' : row?.homeRoad === 'R' || row?.homeRoad === 'A' ? 'A' : null,
        opponent: row?.opponentTeamAbbrev || null,
        stats: {},
      };
      Object.assign(gamesByTeamId[teamId][gameId].stats, row);
    }
  });
  const gameIds = [...new Set(Object.values(gamesByTeamId).flatMap((teamGames) => Object.keys(teamGames)))];
  const eventSplitsByGameId: Record<string, any> = {};
  let leagueAdvanced: any = null;
  try {
    leagueAdvanced = await buildLeagueAdvancedPbp(seasonId, teams);
  } catch (error) {
    console.warn('NHL league-wide PBP shot-quality build unavailable; falling back to matchup PBP:', error);
  }
  for (const gameId of gameIds) {
    const base = leagueAdvanced?.baseEventSplitsByGameId?.[gameId];
    const advanced = leagueAdvanced?.eventSplitsByGameId?.[gameId];
    if (base || advanced) eventSplitsByGameId[gameId] = mergeEventSplitTrees(mergeEventSplitTrees({}, base || {}), advanced || {});
  }
  const missingGameIds = gameIds.filter((gameId) => !eventSplitsByGameId[gameId]);
  let cursor = 0;
  const worker = async () => {
    while (cursor < missingGameIds.length) {
      const gameId = missingGameIds[cursor++];
      try {
        const pbp = await getJson(`${NHL_WEB_ROOT}/gamecenter/${gameId}/play-by-play`);
        const gameAbbreviations = [
          abbrById.get(Number(pbp?.homeTeam?.id)),
          abbrById.get(Number(pbp?.awayTeam?.id)),
        ].filter(Boolean);
        eventSplitsByGameId[gameId] = buildGameEventSplits(pbp, teamIdsByAbbr, gameAbbreviations);
      } catch (error) {
        console.warn(`NHL play-by-play unavailable for game ${gameId}:`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, missingGameIds.length) }, worker));

  const headToHeadGames = await headToHeadPromise;

  const teamGamesByAbbr: Record<string, any[]> = {};
  for (const abbr of abbreviations) {
    const teamId = String(teamIdsByAbbr[abbr]);
    teamGamesByAbbr[abbr] = Object.values(gamesByTeamId[teamId] || {})
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
  }
  return {
    success: true,
    seasonId,
    teamIdsByAbbr,
    teamGamesByAbbr,
    edgeStatsByAbbr,
    leagueAdvancedByAbbr: leagueAdvanced?.leagueAdvancedByAbbr || {},
    leagueRangeRanks: leagueAdvanced?.leagueRangeRanks || {},
    leagueRangeRankMetricOrder: leagueAdvanced?.leagueRangeRankMetricOrder || [],
    shotModel: leagueAdvanced?.model || null,
    headToHeadGames,
    eventSplitsByGameId,
    requestedGameCount: gameIds.length,
    eventGameCount: Object.keys(eventSplitsByGameId).length,
    unavailableReports: reportResults.flatMap((result, index) => result.status === 'rejected' ? [REPORTS[index]] : []),
    fetchedAt: new Date().toISOString(),
  };
}

function localized(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value.default || value.name || value.displayName || value.abbreviation || '');
}

function normalizeTeamName(value: unknown): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchAggregateTeamStats(seasonId: number, teams: any[]) {
  const abbrByTeamId = new Map(teams.map((team) => [Number(team?.id), normalizeAbbr(team?.triCode)]));
  const abbrByFranchiseId = new Map(teams
    .filter((team) => Number.isFinite(Number(team?.franchiseId)))
    .map((team) => [Number(team?.franchiseId), normalizeAbbr(team?.triCode)]));
  const rowsByAbbr: Record<string, any> = Object.fromEntries(teams.map((team) => {
    const abbr = normalizeAbbr(team?.triCode);
    return [abbr, { teamAbbr: abbr, teamName: team?.fullName || team?.name || abbr, seasonId, rankByStat: {} }];
  }));
  const reportResults = await Promise.allSettled(TEAM_STATS_REPORTS.map(async ({ report, sort }) => {
    const url = new URL(`${NHL_STATS_ROOT}/team/${report}`);
    url.searchParams.set('isAggregate', 'true');
    url.searchParams.set('isGame', 'false');
    url.searchParams.set('sort', sort);
    url.searchParams.set('start', '0');
    url.searchParams.set('limit', '100');
    url.searchParams.set('cayenneExp', `gameTypeId=2 and seasonId=${seasonId}`);
    const payload = await getJson(url);
    return { report, rows: Array.isArray(payload?.data) ? payload.data : [] };
  }));
  reportResults.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      console.warn(`NHL aggregate report ${TEAM_STATS_REPORTS[index].report} unavailable:`, result.reason);
      return;
    }
    for (const row of result.value.rows) {
      const teamId = Number(row?.teamId);
      const franchiseId = Number(row?.franchiseId);
      const abbr = abbrByTeamId.get(teamId)
        || abbrByFranchiseId.get(franchiseId)
        || normalizeAbbr(row?.teamAbbrev || row?.teamAbbr || row?.triCode);
      if (!abbr || !rowsByAbbr[abbr]) continue;
      Object.assign(rowsByAbbr[abbr], row);
    }
  });

  for (const stats of Object.values(rowsByAbbr) as any[]) {
    const games = Number(stats?.gamesPlayed);
    if (!Number.isFinite(games) || games <= 0) continue;
    const perGame = (source: string, target: string) => {
      const value = Number(stats?.[source]);
      if (Number.isFinite(value)) stats[target] = value / games;
    };
    perGame('satFor', 'satForPerGame');
    perGame('satAgainst', 'satAgainstPerGame');
    perGame('usatFor', 'usatForPerGame');
    perGame('usatAgainst', 'usatAgainstPerGame');
    perGame('emptyNetGoals', 'emptyNetGoalsPerGame');
    perGame('blockedShots', 'blockedShotsPerGame');
    perGame('hits', 'hitsPerGame');
    perGame('takeaways', 'takeawaysPerGame');
    perGame('giveaways', 'giveawaysPerGame');
    perGame('penaltyMinutes', 'penaltyMinutesPerGame');
    perGame('penalties', 'penaltiesPerGame');
    perGame('totalPenaltiesDrawn', 'penaltiesDrawnPerGame');
    perGame('totalFaceoffs', 'totalFaceoffsPerGame');
    perGame('offensiveZoneFaceoffs', 'offensiveZoneFaceoffsPerGame');
    perGame('defensiveZoneFaceoffs', 'defensiveZoneFaceoffsPerGame');
    perGame('neutralZoneFaceoffs', 'neutralZoneFaceoffsPerGame');
    const goalsFor = Number(stats?.goalsFor);
    const shotsFor = Number(stats?.shots);
    if (Number.isFinite(goalsFor) && Number.isFinite(shotsFor) && shotsFor > 0) stats.shootingPct = goalsFor / shotsFor;
    const shotsAgainst = Number(stats?.shotsAgainstPerGame) * games;
    const goalsAgainst = Number(stats?.goalsAgainst);
    if (Number.isFinite(shotsAgainst) && shotsAgainst > 0 && Number.isFinite(goalsAgainst)) stats.teamSavePct = Math.max(0, 1 - goalsAgainst / shotsAgainst);
    const goalsForPerGame = Number(stats?.goalsForPerGame);
    const goalsAgainstPerGame = Number(stats?.goalsAgainstPerGame);
    if (Number.isFinite(goalsForPerGame) && Number.isFinite(goalsAgainstPerGame)) stats.goalDifferentialPerGame = goalsForPerGame - goalsAgainstPerGame;
  }

  const entries = Object.entries(rowsByAbbr);
  const keys = new Set(entries.flatMap(([, stats]) => Object.keys(stats || {})));
  for (const key of keys) {
    const ranked = entries.map(([abbr, stats]) => ({ abbr, raw: stats?.[key], value: Number(stats?.[key]) }))
      .filter((row) => row.raw != null && row.raw !== '' && Number.isFinite(row.value))
      .sort((a, b) => (TEAM_STATS_LOWER_IS_BETTER.has(key) ? a.value - b.value : b.value - a.value) || a.abbr.localeCompare(b.abbr));
    let rank = 0;
    let previous: number | null = null;
    ranked.forEach((row, index) => {
      if (previous == null || Math.abs(row.value - previous) > 1e-9) rank = index + 1;
      rowsByAbbr[row.abbr].rankByStat[key] = rank;
      previous = row.value;
    });
  }
  return rowsByAbbr;
}

async function fetchCurrentStandings() {
  const payload = await getJson(`${NHL_WEB_ROOT}/standings/now`);
  const standings = Array.isArray(payload?.standings) ? payload.standings : [];
  if (standings.length !== 32) throw new Error(`NHL standings returned ${standings.length} teams; expected 32.`);
  return { standings, standingsDate: payload?.standingsDateTimeUtc || new Date().toISOString() };
}

function selectActiveTeams(allTeams: any[], standings: any[]) {
  const unresolved: string[] = [];
  const selected = standings.map((standing) => {
    const abbr = normalizeAbbr(localized(standing?.teamAbbrev));
    const currentName = localized(standing?.teamName);
    const currentNameKey = normalizeTeamName(currentName);
    const matches = allTeams.filter((team) =>
      normalizeAbbr(team?.triCode) === abbr
      && normalizeTeamName(team?.fullName || team?.name) === currentNameKey
    );
    if (!abbr || !currentNameKey || matches.length !== 1) {
      unresolved.push(`${abbr || 'unknown'} (${currentName || 'unnamed'}; matches=${matches.length})`);
      return null;
    }
    return matches[0];
  }).filter(Boolean);
  const uniqueIds = new Set(selected.map((team: any) => Number(team?.id)));
  const uniqueAbbrs = new Set(selected.map((team: any) => normalizeAbbr(team?.triCode)));
  if (selected.length !== 32 || uniqueIds.size !== 32 || uniqueAbbrs.size !== 32 || unresolved.length) {
    throw new Error(`Could not resolve exactly 32 active NHL teams from current standings (${selected.length} resolved; ${unresolved.join(', ') || 'duplicate team IDs or abbreviations'}).`);
  }
  return selected.sort((a: any, b: any) => normalizeAbbr(a?.triCode).localeCompare(normalizeAbbr(b?.triCode)));
}

async function fetchHeadToHeadIndex(teams: any[], seasonStart: number) {
  const seasons = [seasonStart, seasonStart - 1, seasonStart - 2];
  const abbreviations = [...new Set(teams.map((team) => normalizeAbbr(team?.triCode)).filter(Boolean))];
  const scheduleTeams = [...new Set(abbreviations.flatMap((abbr) => abbr === 'UTA' ? ['UTA', 'ARI'] : [abbr]))];
  const tasks = scheduleTeams.flatMap((abbr) => seasons.map((season) => ({ abbr, season })));
  const responses: any[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        const response = await getJson(`${NHL_WEB_ROOT}/club-schedule-season/${encodeURIComponent(task.abbr)}/${seasonIdFor(task.season)}`);
        responses.push(...(Array.isArray(response?.games) ? response.games : []));
      } catch (error) {
        console.warn(`NHL ${task.abbr} ${task.season} schedule unavailable:`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, worker));
  const franchiseAbbr = (value: unknown) => normalizeAbbr(value) === 'ARI' ? 'UTA' : normalizeAbbr(value);
  const byId = new Map<number, any>();
  for (const game of responses) {
    const gameId = Number(game?.id);
    const gameType = Number(game?.gameType);
    const state = String(game?.gameState || '').toUpperCase();
    const awayScore = Number(game?.awayTeam?.score);
    const homeScore = Number(game?.homeTeam?.score);
    if (!Number.isFinite(gameId) || (gameType !== 2 && gameType !== 3) || !['OFF', 'FINAL', 'FINAL_OT', 'FINAL_SO'].includes(state)
      || !Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
    byId.set(gameId, {
      gameId,
      date: game?.gameDate || null,
      gameType,
      awayAbbr: franchiseAbbr(game?.awayTeam?.abbrev),
      awayTeam: [game?.awayTeam?.placeName?.default, game?.awayTeam?.commonName?.default].filter(Boolean).join(' ') || game?.awayTeam?.abbrev || '',
      awayScore,
      homeAbbr: franchiseAbbr(game?.homeTeam?.abbrev),
      homeTeam: [game?.homeTeam?.placeName?.default, game?.homeTeam?.commonName?.default].filter(Boolean).join(' ') || game?.homeTeam?.abbrev || '',
      homeScore,
      venue: game?.venue?.default || game?.venue?.name || '',
    });
  }
  return [...byId.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function currentSeasonStart() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  return month >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function writeJson(path: string, value: unknown) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(value)}\n`);
}

async function main() {
  const seasonStart = Number(Deno.env.get('NHL_TEAM_STATS_SEASON')) || currentSeasonStart();
  const seasonId = seasonIdFor(seasonStart);
  const outputRoot = Deno.env.get('NHL_TEAM_STATS_OUTPUT_DIR') || Deno.cwd();
  const generatedAt = new Date().toISOString();
  console.log(`NHL game-detail publisher: season=${seasonId}, generated=${generatedAt}`);

  const [teamPayload, standingsResult] = await Promise.all([
    getJson(`${NHL_STATS_ROOT}/team?limit=100`),
    fetchCurrentStandings(),
  ]);
  const allTeams = (Array.isArray(teamPayload?.data) ? teamPayload.data : [])
    .filter((team: any) => normalizeAbbr(team?.triCode) && Number.isFinite(Number(team?.id)))
    .sort((a: any, b: any) => normalizeAbbr(a?.triCode).localeCompare(normalizeAbbr(b?.triCode)));
  const teams = selectActiveTeams(allTeams, standingsResult.standings);
  const abbreviations = teams.map((team: any) => normalizeAbbr(team?.triCode));
  console.log(`Loaded ${teams.length} NHL teams; fetching all reports, EDGE inputs, and play-by-play.`);

  const [comparison, teamStatsByAbbr, headToHeadGames] = await Promise.all([
    fetchComparison(seasonId, abbreviations, abbreviations[0], abbreviations[1]),
    fetchAggregateTeamStats(seasonId, teams),
    fetchHeadToHeadIndex(teams, seasonStart),
  ]);
  if (comparison.eventGameCount < comparison.requestedGameCount * 0.9) {
    throw new Error(`Refusing to publish incomplete NHL play-by-play coverage (${comparison.eventGameCount}/${comparison.requestedGameCount}).`);
  }
  if (!comparison.leagueRangeRankMetricOrder?.length || Object.keys(comparison.leagueRangeRanks || {}).length < 90) {
    throw new Error('Refusing to publish NHL data without league ranks for all timeframe, period, and strength selections.');
  }
  if (comparison.unavailableReports?.length) {
    throw new Error(`Refusing to publish NHL data with unavailable per-game reports: ${comparison.unavailableReports.join(', ')}.`);
  }
  const teamsWithoutSeasonStats = Object.entries(teamStatsByAbbr)
    .filter(([, stats]: [string, any]) => !(Number(stats?.gamesPlayed) > 0))
    .map(([abbr]) => abbr);
  if (Object.keys(teamStatsByAbbr).length !== 32 || teamsWithoutSeasonStats.length) {
    throw new Error(`Refusing to publish incomplete NHL team leaderboards (${teamsWithoutSeasonStats.length} teams missing season games).`);
  }

  const leagueDir = `${outputRoot}/nhl-team-stats/v1/${seasonStart}`;
  const teamStatsCount = Object.keys(teamStatsByAbbr).length;
  const leaguePayload = {
    sport: 'nhl', cacheVersion: 1, season: seasonStart, seasonId, generatedAt,
    teamCount: teams.length,
    standingsDate: standingsResult.standingsDate,
    standings: standingsResult.standings,
    teamStatsByAbbr,
    teams: teams.map((team: any) => ({
      id: String(team.id), abbr: normalizeAbbr(team.triCode),
      name: team.fullName || team.name || normalizeAbbr(team.triCode),
    })),
    reportCoverage: { reports: REPORTS, aggregateTeams: teamStatsCount },
    unavailableReports: comparison.unavailableReports,
    eventGameCount: comparison.eventGameCount,
    requestedGameCount: comparison.requestedGameCount,
  };
  await writeJson(`${leagueDir}/league.json`, leaguePayload);
  await writeJson(`${leagueDir}/head-to-head.json`, {
    sport: 'nhl', cacheVersion: 1, season: seasonStart, seasonId, generatedAt,
    seasons: [seasonStart, seasonStart - 1, seasonStart - 2],
    games: headToHeadGames,
  });

  for (const abbr of abbreviations) {
    const teamGames = comparison.teamGamesByAbbr?.[abbr] || [];
    const teamGameIds = new Set(teamGames.map((row: any) => String(row.gameId)));
    const eventSplitsByGameId = Object.fromEntries(Object.entries(comparison.eventSplitsByGameId || {})
      .filter(([gameId]) => teamGameIds.has(String(gameId))));
    const leagueRangeRanks = Object.fromEntries(Object.entries(comparison.leagueRangeRanks || {}).map(([selection, byTeam]: [string, any]) => [
      selection, byTeam?.[abbr] ? { [abbr]: byTeam[abbr] } : {},
    ]));
    const teamPayload = {
      sport: 'nhl', cacheVersion: 1, season: seasonStart, seasonId, teamCount: teams.length,
      teamAbbr: abbr, teamId: comparison.teamIdsByAbbr?.[abbr], generatedAt,
      teamGamesByAbbr: { [abbr]: teamGames },
      edgeStatsByAbbr: comparison.edgeStatsByAbbr?.[abbr] ? { [abbr]: comparison.edgeStatsByAbbr[abbr] } : {},
      leagueAdvancedByAbbr: comparison.leagueAdvancedByAbbr?.[abbr] ? { [abbr]: comparison.leagueAdvancedByAbbr[abbr] } : {},
      leagueRangeRanks,
      leagueRangeRankMetricOrder: comparison.leagueRangeRankMetricOrder,
      eventSplitsByGameId,
      shotModel: comparison.shotModel,
      requestedGameCount: teamGameIds.size,
      eventGameCount: Object.keys(eventSplitsByGameId).length,
      unavailableReports: comparison.unavailableReports,
    };
    await writeJson(`${leagueDir}/teams/${abbr}.json`, teamPayload);
  }
  await writeJson(`${outputRoot}/nhl-team-stats/v1/latest.json`, {
    sport: 'nhl', cacheVersion: 1, season: seasonStart, seasonId, generatedAt,
    path: `nhl-team-stats/v1/${seasonStart}/league.json`,
  });
  console.log(`Published ${teams.length} team files, standings, team leaderboards, H2H index, and ${comparison.eventGameCount}/${comparison.requestedGameCount} PBP games.`);
}

main().catch((error) => {
  console.error('NHL game-detail stats publisher failed:', error);
  Deno.exit(1);
});
