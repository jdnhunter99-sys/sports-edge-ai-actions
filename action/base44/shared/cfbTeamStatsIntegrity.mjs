/**
 * Pure integrity/ranking helpers shared by the CFB cache builder and tests.
 * Keep these checks independent from Base44 and Deno so fixtures can exercise
 * the exact production rules in Node.
 */

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

function firstFinite(object, keys) {
  for (const key of keys) if (finite(object?.[key])) return Number(object[key]);
  return null;
}

function compare(actual, expected, tolerance, label, errors) {
  if (actual == null || expected == null || !Number.isFinite(actual) || !Number.isFinite(expected)) return;
  if (Math.abs(actual - expected) > tolerance) {
    errors.push(`${label}: found ${actual}, expected ${expected.toFixed(3)} (±${tolerance})`);
  }
}

/**
 * Verify core offense fields from one selected set of games. Values here are
 * the rounded display fields, so tolerances account for their displayed
 * precision; raw aggregates remain the ranking inputs.
 */
export function validateCFBTeamOffense(stats, { team = 'team', timeframe = 'season', gameIds = null } = {}) {
  const errors = [];
  const offense = stats?.offense || {};
  const games = Number(stats?.games);
  if (!Number.isInteger(games) || games < 1) errors.push(`game count is invalid (${stats?.games ?? 'missing'})`);

  if (Array.isArray(gameIds)) {
    const ids = gameIds.map(String);
    const unique = new Set(ids);
    if (unique.size !== ids.length) errors.push(`duplicate game IDs (${ids.length} rows, ${unique.size} unique)`);
    if (Number.isInteger(games) && games !== unique.size) errors.push(`game count ${games} does not match ${unique.size} unique game IDs`);
  }

  const totalYards = firstFinite(offense, ['yardsPerGame', 'totalYardsPerGame']);
  const passYards = firstFinite(offense, ['passingYardsPerGame', 'passingYards']);
  const rushYards = firstFinite(offense, ['rushingYardsPerGame', 'rushingYards']);
  if (totalYards != null && passYards != null && rushYards != null) {
    compare(totalYards, passYards + rushYards, 0.2, 'passing yards/game + rushing yards/game = total yards/game', errors);
  }

  const passAttempts = firstFinite(offense, ['passingAttemptsPerGame', 'passAttemptsPerGame']);
  const rushAttempts = firstFinite(offense, ['rushingAttemptsPerGame', 'rushAttemptsPerGame']);
  const plays = firstFinite(offense, ['playsPerGame', 'offensivePlays', 'totalPlays']);
  if (plays != null && passAttempts != null && rushAttempts != null) {
    compare(plays, passAttempts + rushAttempts, 0.2, 'pass attempts/game + rush attempts/game = plays/game', errors);
  }

  const completions = firstFinite(offense, ['completionsPerGame', 'completions']);
  const completionPct = firstFinite(offense, ['completionPct', 'completionPercentage']);
  if (completions != null && passAttempts > 0 && completionPct != null) {
    compare(completionPct, completions / passAttempts * 100, 0.5, 'completion percentage', errors);
  }

  const yardsPerAttempt = firstFinite(offense, ['yardsPerAttempt', 'yardsPerPass', 'passYardsPerAttempt']);
  if (passYards != null && passAttempts > 0 && yardsPerAttempt != null) {
    compare(yardsPerAttempt, passYards / passAttempts, 0.03, 'passing yards/attempt', errors);
  }

  const sacksAllowed = firstFinite(offense, ['sacksAllowedPerGame']);
  const sackRateAllowed = firstFinite(offense, ['sackRateAllowed']);
  const netYardsPerAttempt = firstFinite(offense, ['netYardsPerAttempt']);
  if (sacksAllowed != null && passAttempts > 0 && sackRateAllowed != null) {
    compare(sackRateAllowed, sacksAllowed / (passAttempts + sacksAllowed) * 100, 0.5, 'sack rate allowed', errors);
  }
  if (sacksAllowed != null && passYards != null && passAttempts > 0 && netYardsPerAttempt != null) {
    compare(netYardsPerAttempt, passYards / (passAttempts + sacksAllowed), 0.12, 'net passing yards/attempt', errors);
  }

  const hurriesAllowed = firstFinite(offense, ['qbHurriesAllowedPerGame']);
  const pressureRateAllowed = firstFinite(offense, ['pressureRateAllowed', 'pressurePctAllowed']);
  const pressureAvoidancePct = firstFinite(offense, ['pressureAvoidancePct']);
  if (sacksAllowed != null && hurriesAllowed != null && passAttempts > 0 && pressureRateAllowed != null) {
    compare(pressureRateAllowed, (sacksAllowed + hurriesAllowed) / (passAttempts + sacksAllowed) * 100, 0.5, 'pressure rate allowed', errors);
  }
  if (pressureRateAllowed != null && pressureAvoidancePct != null) {
    compare(pressureAvoidancePct, 100 - pressureRateAllowed, 0.2, 'pressure avoidance percentage', errors);
  }

  const yardsPerCarry = firstFinite(offense, ['yardsPerCarry', 'yardsPerRush', 'rushYardsPerAttempt']);
  if (rushYards != null && rushAttempts > 0 && yardsPerCarry != null) {
    compare(yardsPerCarry, rushYards / rushAttempts, 0.03, 'rushing yards/carry', errors);
  }

  const yardsPerPlay = firstFinite(offense, ['yardsPerPlay']);
  if (totalYards != null && plays > 0 && yardsPerPlay != null) {
    compare(yardsPerPlay, totalYards / plays, 0.03, 'yards/play', errors);
  }

  const firstDowns = firstFinite(offense, ['firstDownsPerGame', 'firstDowns']);
  const firstDownRate = firstFinite(offense, ['firstDownRate']);
  if (firstDowns != null && plays > 0 && firstDownRate != null) {
    compare(firstDownRate, firstDowns / plays * 100, 0.5, 'first-down rate', errors);
  }

  return {
    ok: errors.length === 0,
    team,
    timeframe,
    games: Number.isInteger(games) ? games : null,
    checks: ['game-coverage', 'yards-splits', 'play-volume', 'completion-rate', 'passing-efficiency', 'net-yards-per-attempt', 'sack-rate', 'pressure-rate', 'rushing-efficiency', 'yards-per-play', 'first-down-rate'],
    errors,
  };
}

/** Verify defense fields against one matching, completed-game sample. */
export function validateCFBTeamDefense(stats, {
  team = 'team', timeframe = 'season', gameIds = null, totals = {},
} = {}) {
  const errors = [];
  const defense = stats?.defense || {};
  const offense = stats?.offense || {};
  const games = Number(stats?.games);
  if (!Number.isInteger(games) || games < 1) errors.push(`game count is invalid (${stats?.games ?? 'missing'})`);

  if (Array.isArray(gameIds)) {
    const ids = gameIds.map(String);
    const unique = new Set(ids);
    if (unique.size !== ids.length) errors.push(`duplicate game IDs (${ids.length} rows, ${unique.size} unique)`);
    if (Number.isInteger(games) && games !== unique.size) errors.push(`game count ${games} does not match ${unique.size} unique game IDs`);
  }

  const requiredTotals = [
    'pointsAllowed', 'totalYardsAllowed', 'passingYardsAllowed', 'rushingYardsAllowed',
    'passingAttemptsFaced', 'completionsAllowed', 'rushingAttemptsFaced',
  ];
  for (const key of requiredTotals) {
    if (!finite(totals[key])) errors.push(`required defensive source total ${key} is missing`);
  }

  const passYards = firstFinite(totals, ['passingYardsAllowed']);
  const rushYards = firstFinite(totals, ['rushingYardsAllowed']);
  const totalYards = firstFinite(totals, ['totalYardsAllowed']);
  const pointsAllowed = firstFinite(totals, ['pointsAllowed']);
  if (pointsAllowed != null) compare(firstFinite(defense, ['pointsAllowedPerGame']), pointsAllowed / games, 0.11, 'points allowed/game', errors);
  if (passYards != null && rushYards != null && totalYards != null) {
    compare(totalYards, passYards + rushYards, 0.01, 'passing yards allowed + rushing yards allowed = total yards allowed', errors);
    compare(firstFinite(defense, ['yardsAllowedPerGame']), totalYards / games, 0.11, 'yards allowed/game', errors);
    compare(firstFinite(defense, ['passingYardsAllowed', 'passingYardsAllowedPerGame']), passYards / games, 0.11, 'passing yards allowed/game', errors);
    compare(firstFinite(defense, ['rushingYardsAllowed', 'rushingYardsAllowedPerGame']), rushYards / games, 0.11, 'rushing yards allowed/game', errors);
  }

  const passAttempts = firstFinite(totals, ['passingAttemptsFaced']);
  const completions = firstFinite(totals, ['completionsAllowed']);
  const rushAttempts = firstFinite(totals, ['rushingAttemptsFaced']);
  const plays = passAttempts != null && rushAttempts != null ? passAttempts + rushAttempts : null;
  if (plays != null) {
    compare(firstFinite(defense, ['playsFacedPerGame']), plays / games, 0.11, 'plays faced/game', errors);
    if (totalYards != null) compare(firstFinite(defense, ['yardsPerPlayAllowed']), totalYards / plays, 0.011, 'yards/play allowed', errors);
  }
  if (completions != null && passAttempts > 0) {
    compare(firstFinite(defense, ['completionPctAllowed', 'completionPercentageAllowed']), completions / passAttempts * 100, 0.11, 'completion percentage allowed', errors);
    if (passYards != null) compare(firstFinite(defense, ['yardsPerAttemptAllowed', 'yardsPerPassAllowed', 'passYardsPerAttemptAllowed']), passYards / passAttempts, 0.011, 'passing yards/attempt allowed', errors);
  }
  if (rushYards != null && rushAttempts > 0) {
    compare(firstFinite(defense, ['yardsPerCarryAllowed', 'yardsPerRushAllowed', 'rushYardsPerAttemptAllowed']), rushYards / rushAttempts, 0.011, 'yards/carry allowed', errors);
  }

  const sacksMade = firstFinite(totals, ['sacksMade']);
  const interceptions = firstFinite(totals, ['interceptionsForced']);
  if (sacksMade != null && passAttempts != null) {
    compare(firstFinite(defense, ['sacksPerGame']), sacksMade / games, 0.11, 'defensive sacks/game', errors);
    compare(firstFinite(defense, ['sackRate']), sacksMade / (passAttempts + sacksMade) * 100, 0.11, 'defensive sack rate', errors);
  }
  const sacksAllowed = firstFinite(totals, ['sacksAllowed']);
  const teamPassAttempts = firstFinite(totals, ['teamPassingAttempts']);
  if (sacksAllowed != null && teamPassAttempts != null) {
    compare(firstFinite(offense, ['sacksAllowedPerGame']), sacksAllowed / games, 0.11, 'sacks allowed/game', errors);
    compare(firstFinite(offense, ['sackRateAllowed']), sacksAllowed / (teamPassAttempts + sacksAllowed) * 100, 0.11, 'sack rate allowed', errors);
  }
  const qbHurriesMade = firstFinite(totals, ['qbHurriesMade']);
  if (sacksMade != null && qbHurriesMade != null && passAttempts != null) {
    compare(firstFinite(defense, ['pressureRate', 'defensivePressureRate']), (sacksMade + qbHurriesMade) / (passAttempts + sacksMade) * 100, 0.11, 'defensive pressure rate', errors);
  }
  const qbHurriesAllowed = firstFinite(totals, ['qbHurriesAllowed']);
  if (sacksAllowed != null && qbHurriesAllowed != null && teamPassAttempts != null) {
    compare(firstFinite(offense, ['pressureRateAllowed', 'pressurePctAllowed']), (sacksAllowed + qbHurriesAllowed) / (teamPassAttempts + sacksAllowed) * 100, 0.11, 'pressure rate allowed', errors);
  }
  const tacklesForLoss = firstFinite(totals, ['tacklesForLoss']);
  if (tacklesForLoss != null) {
    compare(firstFinite(defense, ['tacklesForLoss', 'tfl']), tacklesForLoss / games, 0.11, 'tackles for loss/game', errors);
    if (plays != null && plays > 0) compare(firstFinite(defense, ['tackleForLossPct', 'tflPct']), tacklesForLoss / plays * 100, 0.11, 'tackle for loss percentage', errors);
  }
  const forcedFumbles = firstFinite(totals, ['forcedFumbles']);
  if (forcedFumbles != null) {
    compare(firstFinite(defense, ['fumblesForced', 'forcedFumblesPerGame', 'forcedFumbles']), forcedFumbles / games, 0.11, 'forced fumbles/game', errors);
  }
  const penalties = firstFinite(totals, ['penalties']);
  const penaltyYards = firstFinite(totals, ['penaltyYards']);
  if (penalties != null) compare(firstFinite(defense, ['penaltiesPerGame']), penalties / games, 0.11, 'penalties/game', errors);
  if (penaltyYards != null) compare(firstFinite(defense, ['penaltyYardsPerGame']), penaltyYards / games, 0.11, 'penalty yards/game', errors);
  if (interceptions != null) {
    compare(firstFinite(defense, ['interceptions', 'forcedInterceptionsPerGame']), interceptions / games, 0.11, 'interceptions forced/game', errors);
  }

  const thirdMade = firstFinite(totals, ['thirdDownConversionsAllowed']);
  const thirdAttempts = firstFinite(totals, ['thirdDownAttemptsFaced']);
  if (thirdMade != null && thirdAttempts > 0) {
    compare(firstFinite(defense, ['thirdDownPctAllowed', 'thirdDownConversionPctAllowed']), thirdMade / thirdAttempts * 100, 0.11, 'third-down percentage allowed', errors);
  }
  const fourthMade = firstFinite(totals, ['fourthDownConversionsAllowed']);
  const fourthAttempts = firstFinite(totals, ['fourthDownAttemptsFaced']);
  if (fourthMade != null && fourthAttempts > 0) {
    compare(firstFinite(defense, ['fourthDownPctAllowed', 'fourthDownConversionPctAllowed']), fourthMade / fourthAttempts * 100, 0.11, 'fourth-down percentage allowed', errors);
  }

  const fumblesLost = firstFinite(totals, ['fumblesLostByOpponents']);
  const turnovers = firstFinite(totals, ['turnoversForced']);
  const passesDeflected = firstFinite(totals, ['passesDeflected']);
  if (passesDeflected != null) {
    compare(firstFinite(defense, ['passesDeflectedPerGame']), passesDeflected / games, 0.11, 'passes deflected/game', errors);
  }
  if (interceptions != null && fumblesLost != null && turnovers != null) {
    compare(turnovers, interceptions + fumblesLost, 0.01, 'turnovers forced = interceptions + opponent fumbles lost', errors);
    compare(firstFinite(defense, ['turnoversForced']), turnovers / games, 0.11, 'turnovers forced/game', errors);
  }

  const rzTrips = firstFinite(totals, ['redZoneTripsAllowed']);
  const rzScores = firstFinite(totals, ['redZoneScoresAllowed']);
  const rzTouchdowns = firstFinite(totals, ['redZoneTouchdownsAllowed']);
  if (rzTrips > 0 && rzScores != null) {
    compare(firstFinite(defense, ['redZoneScorePctAllowed', 'redZoneEfficiencyAllowed']), rzScores / rzTrips * 100, 0.11, 'red-zone scoring percentage allowed', errors);
  }
  if (rzTrips > 0 && rzTouchdowns != null) {
    compare(firstFinite(defense, ['redZoneTdPctAllowed', 'redZoneTouchdownPctAllowed']), rzTouchdowns / rzTrips * 100, 0.11, 'red-zone touchdown percentage allowed', errors);
  }

  return {
    ok: errors.length === 0,
    team,
    timeframe,
    games: Number.isInteger(games) ? games : null,
    checks: [
      'game-coverage', 'yards-splits', 'plays-faced', 'completion-rate-allowed',
      'passing-efficiency-allowed', 'rushing-efficiency-allowed', 'defensive-sack-rate',
      'down-conversion-rates', 'turnover-reconciliation', 'red-zone-score-and-touchdown-rates',
    ],
    unavailable: [
      sacksMade == null ? 'defensive sacks and sack rate' : null,
      qbHurriesMade == null ? 'defensive pressure rate and QB hurries/game' : null,
      tacklesForLoss == null ? 'tackles for loss/game and TFL rate' : null,
      forcedFumbles == null ? 'forced fumbles/game' : null,
      passesDeflected == null ? 'passes deflected/game' : null,
      interceptions == null ? 'interceptions forced/game' : null,
      turnovers == null ? 'turnovers forced' : null,
      thirdMade == null || thirdAttempts == null ? 'third-down conversion rate allowed' : null,
      fourthMade == null || fourthAttempts == null ? 'fourth-down conversion rate allowed' : null,
      rzTrips == null ? 'drive-based red-zone, goal-to-go, and opening-drive rates' : null,
    ].filter(Boolean),
    errors,
  };
}

/** Compare the source schedule and game-box-score game-ID sets. */
export function validateCFBGameCoverage(expectedGameIds, actualGameIds) {
  const expected = (expectedGameIds || []).map(String);
  const actual = (actualGameIds || []).map(String);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  return {
    ok: expectedSet.size === expected.length && actualSet.size === actual.length &&
      expectedSet.size === actualSet.size && [...expectedSet].every((id) => actualSet.has(id)),
    expected: expectedSet.size,
    actual: actualSet.size,
    missing: [...expectedSet].filter((id) => !actualSet.has(id)),
    unexpected: [...actualSet].filter((id) => !expectedSet.has(id)),
    duplicates: [...new Set(duplicates)],
  };
}

/** Rank nonmissing values using the unrounded aggregate and competition ties. */
export function rankCFBRows(rows, { higherIsBetter = true } = {}) {
  const validRows = (rows || []).filter((row) => finite(row?.value)).map((row) => ({
    ...row,
    value: Number(row.value),
  }));
  validRows.sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
  const rankMap = {};
  let rank = 1;
  validRows.forEach((row, index) => {
    if (index > 0 && Math.abs(row.value - validRows[index - 1].value) > 1e-9) rank = index + 1;
    rankMap[row.team] = rank;
  });
  return rankMap;
}
