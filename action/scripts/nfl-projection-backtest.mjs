import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sourceRoot = process.env.SPORTS_EDGE_SOURCE_DIR || process.cwd();
const { projectNFLPlayerPerformance } = await import(pathToFileURL(resolve(sourceRoot, 'src/lib/nflProjectionModel.js')).href);
const { parquetReadObjects } = await import(pathToFileURL(resolve(sourceRoot, 'node_modules/hyparquet/src/node.js')).href);

const ODDS_URL = 'https://raw.githubusercontent.com/theedgepredictor/odds-data-pump/main/data/processed/football/nfl/player_props';
const STATS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_';
const SCHEDULE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const MARKETS = ['passing_yards', 'passing_attempts', 'rushing_yards', 'rushing_attempts', 'receiving_yards', 'receptions'];
const SOURCES = { passing_yards: 'passing_yards', passing_attempts: 'attempts', rushing_yards: 'rushing_yards', rushing_attempts: 'rushing_attempts', receiving_yards: 'receiving_yards', receptions: 'receptions' };
const WORKLOAD = { passing_yards: 'passing_attempts', rushing_yards: 'rushing_attempts', receiving_yards: 'receptions' };

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const finite = (value) => number(value) != null;
const normalizeName = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));
const mean = (values) => { const usable = values.filter(finite).map(Number); return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null; };

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'SportsEdgeAI-GitHub-Backtest/1.0' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function fetchRows(url, predicate = () => true) {
  return parseCSV(await fetchText(url)).filter(predicate);
}

async function fetchRowsOptional(url) {
  try {
    return await fetchRows(url);
  } catch (error) {
    if (String(error.message).startsWith('404 ')) return [];
    throw error;
  }
}

async function fetchOdds(season, week) {
  const response = await fetch(`${ODDS_URL}/${season}.parquet`);
  if (!response.ok) throw new Error(`Historical odds unavailable for ${season}: ${response.status}`);
  return parquetReadObjects({
    file: await response.arrayBuffer(),
    columns: ['player_id', 'join_name', 'bet_type', 'side', 'value', 'odds', 'season', 'week'],
    filter: { $and: [{ season: BigInt(season) }, { week: BigInt(week) }] },
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); if (row.some(Boolean)) rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

function normalizeMarket(value) {
  const raw = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  return ({ pass_attempts: 'passing_attempts', attempts: 'passing_attempts', rush_attempts: 'rushing_attempts', carries: 'rushing_attempts', rec_yards: 'receiving_yards', rec_yds: 'receiving_yards', rec: 'receptions' })[raw] || raw;
}

function scheduleInfo(rows, season, requestedWeek) {
  const games = rows.filter((row) => row.game_type === 'REG' && Number(row.season) === season && (!requestedWeek || finite(row.week)));
  const completedWeeks = games.filter((row) => finite(row.away_score) && finite(row.home_score)).map((row) => Number(row.week));
  const week = Number(requestedWeek) || Math.max(...completedWeeks);
  const target = games.filter((row) => Number(row.week) === week).map((row) => ({
    ...row, week, season, game_id: row.game_id || row.old_game_id, totalLine: number(row.total_line),
  }));
  return { week, games: target, byGameId: new Map(target.map((game) => [String(game.game_id), game])) };
}

function statValue(row, field) {
  return number(row[field]) ?? number(row[field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]);
}

function aggregate(rows) {
  const fields = ['attempts', 'carries', 'targets', 'receptions', 'passing_yards', 'rushing_yards', 'receiving_yards'];
  return Object.fromEntries(fields.map((field) => [field, mean(rows.map((row) => statValue(row, field)))]));
}

function modelPlayer(player, priorRows) {
  const ordered = [...priorRows].sort((a, b) => Number(a.week) - Number(b.week));
  const l5 = aggregate(ordered.slice(-5));
  const l10 = aggregate(ordered.slice(-10));
  const season = aggregate(ordered);
  const camel = (stats) => ({ attempts: stats.attempts, carries: stats.carries, targets: stats.targets, receptions: stats.receptions, passingYards: stats.passing_yards, rushingYards: stats.rushing_yards, receivingYards: stats.receiving_yards });
  return { name: player.player_display_name || player.player_name, position: player.position, depthRank: player.position === 'QB' ? 1 : null, _l5: camel(l5), _l10: camel(l10), seasonStats: camel(season) };
}

function propLine(rows, player, market, season, week) {
  const wantedId = String(player.player_id || '');
  const wantedName = normalizeName(player.player_display_name || player.player_name);
  const sourceMarket = SOURCES[market];
  const candidates = rows.filter((row) => {
    const idMatch = wantedId && String(row.player_id || '') === wantedId;
    const nameMatch = wantedName && normalizeName(row.join_name || row.player || row.player_name) === wantedName;
    return (idMatch || nameMatch) && String(row.bet_type || '').toLowerCase() === sourceMarket && Number(row.season) === season && Number(row.week) === week && finite(row.value);
  });
  if (!candidates.length) return null;
  const groups = new Map();
  for (const row of candidates) {
    const key = String(Number(row.value));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const group = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  const over = group.find((row) => String(row.side || '').toLowerCase().includes('over'));
  const under = group.find((row) => String(row.side || '').toLowerCase().includes('under'));
  return { line: Number(group[0].value), overOdds: number(over?.odds), underOdds: number(under?.odds) };
}

function actual(row, market) {
  const field = { passing_yards: 'passing_yards', passing_attempts: 'attempts', rushing_yards: 'rushing_yards', rushing_attempts: 'carries', receiving_yards: 'receiving_yards', receptions: 'receptions' }[market];
  return statValue(row, field);
}

function priorRows(allRows, playerId, season, week) {
  return allRows.filter((row) => String(row.player_id) === String(playerId) && (Number(row.season) < season || (Number(row.season) === season && Number(row.week) < week)));
}

function calculate(row, allRows, game, market, book, oddsRows, season, week) {
  const prior = priorRows(allRows, row.player_id, season, week);
  const player = modelPlayer(row, prior);
  const teamSpread = String(game.home_team) === String(row.recent_team) ? number(game.spread_line) : -number(game.spread_line);
  const context = { line: book.line, overOdds: book.overOdds, underOdds: book.underOdds, spread: teamSpread, total: game.totalLine, vegas: {} };
  const workloadMarket = WORKLOAD[market];
  if (workloadMarket) {
    const workload = propLine(oddsRows, row, workloadMarket, season, week);
    if (workload) context.vegas[{ passing_attempts: 'passingAttempts', rushing_attempts: 'rushingAttempts', receptions: 'receptions' }[workloadMarket]] = workload.line;
  }
  return projectNFLPlayerPerformance({ player, market, context });
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${normalizeName(record.player_name)}|${record.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map((rows) => {
    const comparable = rows.filter((row) => row.sportsbook_abs_error != null);
    return { player_name: rows[0].player_name, player_id: rows[0].player_id, market: rows[0].market, sample_size: rows.length, model_mae: round(mean(rows.map((row) => row.model_abs_error))), sportsbook_mae: comparable.length ? round(mean(comparable.map((row) => row.sportsbook_abs_error))) : null, model_beats_sportsbook_rate: comparable.length ? round(mean(comparable.map((row) => row.model_abs_error < row.sportsbook_abs_error)), 3) : null };
  });
}

async function main() {
  const requestedSeason = number(process.env.NFL_SEASON) || new Date().getUTCFullYear();
  const requestedWeek = number(process.env.NFL_WEEK);
  const scheduleRows = await fetchRows(SCHEDULE_URL);
  const target = scheduleInfo(scheduleRows, requestedSeason, requestedWeek);
  if (!Number.isFinite(target.week)) throw new Error(`No completed week found for ${requestedSeason}`);
  const currentStats = await fetchRows(`${STATS_URL}${requestedSeason}.csv`, (row) => Number(row.week) <= target.week);
  const previousStats = await fetchRowsOptional(`${STATS_URL}${requestedSeason - 1}.csv`);
  const oddsRows = await fetchOdds(requestedSeason, target.week);
  const allStats = [...previousStats, ...currentStats];
  const records = [];
  for (const row of currentStats.filter((candidate) => Number(candidate.week) === target.week)) {
    const game = target.byGameId.get(String(row.game_id));
    if (!game) continue;
    for (const market of MARKETS) {
      const book = propLine(oddsRows, row, market, requestedSeason, target.week);
      const actualValue = actual(row, market);
      if (!book || actualValue == null) continue;
      const projection = calculate(row, allStats, game, market, book, oddsRows, requestedSeason, target.week);
      records.push({ season: requestedSeason, week: target.week, game_id: String(row.game_id), game_date: game.gameday, player_id: String(row.player_id), player_name: row.player_display_name, position: row.position, market, actual: actualValue, projection: round(projection.projection), sportsbook_line: book.line, model_abs_error: round(Math.abs(projection.projection - actualValue)), sportsbook_abs_error: round(Math.abs(book.line - actualValue)), model_beats_sportsbook: Math.abs(projection.projection - actualValue) < Math.abs(book.line - actualValue) });
    }
  }
  const players = summarize(records);
  const byMarket = Object.fromEntries([...new Set(players.map((row) => row.market))].map((market) => { const rows = players.filter((row) => row.market === market); return [market, { sample_size: rows.reduce((sum, row) => sum + row.sample_size, 0), model_mae: round(mean(rows.flatMap((row) => Array(row.sample_size).fill(row.model_mae)))), sportsbook_mae: round(mean(rows.filter((row) => row.sportsbook_mae != null).flatMap((row) => Array(row.sample_size).fill(row.sportsbook_mae)))) }]; }));
  const output = { model_version: 'deterministic-nfl-projection-v1', source: 'theedgepredictor/odds-data-pump', season: requestedSeason, week: target.week, generated_at: new Date().toISOString(), sample_size: records.length, by_market: byMarket, players, records };
  const outputPath = process.env.NFL_BACKTEST_OUTPUT_PATH || 'public/data/nfl-projection-backtest.json';
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ season: requestedSeason, week: target.week, records: records.length, players: players.length, by_market: byMarket }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
