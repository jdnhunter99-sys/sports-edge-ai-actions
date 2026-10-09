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
