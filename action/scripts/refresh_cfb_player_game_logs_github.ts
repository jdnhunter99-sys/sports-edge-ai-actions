import { canonicalCfbTeam } from '../base44/shared/cfbOddsTeams.ts';

const outputRoot = Deno.env.get('CFB_PLAYER_LOGS_OUTPUT_DIR')?.trim();
if (!outputRoot) throw new Error('CFB_PLAYER_LOGS_OUTPUT_DIR is required');

const cacheRoot = `${outputRoot.replace(/\/$/, '')}/cfb-player-game-logs/v1`;
const playerBoxUrl = (season: number) => `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box/player_box_${season}.csv`;
const schedulesUrl = (season: number) => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${season}.csv`;
const groups: Record<string, Set<string>> = {
  qb: new Set(['passing', 'rushing']),
  rb: new Set(['rushing', 'receiving']),
  wr_te: new Set(['receiving', 'rushing']),
};
const currentSeason = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
})();
const seasons = [currentSeason - 1, currentSeason];

type Row = Record<string, string>;
type Game = Record<string, any>;

function value(row: Row, ...keys: string[]) {
  for (const key of keys) {
    const found = row[key];
    if (found != null && String(found).trim() !== '') return String(found).trim();
  }
  return '';
}

function number(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTeam(value: unknown) {
  const canonical = canonicalCfbTeam(value);
  return canonical?.abbr || String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePlayerName(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameTeam(a: unknown, b: unknown) {
  const left = normalizeTeam(a);
  const right = normalizeTeam(b);
  return Boolean(left && right && left === right);
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((value) => value !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function splitSlashPair(value: unknown): [number, number] {
  const match = String(value ?? '').match(/^(\d+)\s*\/\s*(\d+)$/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

async function fetchCsv(url: string): Promise<Row[]> {
  const response = await fetch(url, { headers: { 'User-Agent': 'SportsEdgeAI-CFB-Player-Log-Publisher/1.0', Accept: 'text/csv,*/*' } });
  if (!response.ok) throw new Error(`CSV fetch failed (${response.status}): ${url}`);
  const rows = parseCsv(await response.text()) as Row[];
  if (!rows.length) throw new Error(`CSV was empty: ${url}`);
  return rows;
}

async function buildSeason(season: number, group: keyof typeof groups) {
  const [boxRows, scheduleRows] = await Promise.all([
    fetchCsv(playerBoxUrl(season)),
    fetchCsv(schedulesUrl(season)),
  ]);
  const scheduleByGame = new Map<string, Row>();
  for (const schedule of scheduleRows) {
    const gameId = value(schedule, 'game_id');
    if (gameId && !scheduleByGame.has(gameId)) scheduleByGame.set(gameId, schedule);
  }

  const gamesByPlayerGame = new Map<string, Game>();
  const playerGameByIdentity = new Map<string, string>();
  const playerGameByGameName = new Map<string, string>();
  for (const row of boxRows) {
    const category = value(row, 'category').toLowerCase();
    if (!groups[group].has(category)) continue;
    const gameId = value(row, 'game_id');
    const playerName = value(row, 'athlete_name', 'player_name', 'name');
    if (!gameId || !playerName) continue;

    const playerId = value(row, 'athlete_id', 'player_id', 'id');
    const idKey = playerId || playerName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${idKey}|${gameId}`;
    const identityKey = `${gameId}|${value(row, 'team_id')}|${normalizePlayerName(playerName)}`;
    playerGameByIdentity.set(identityKey, key);
    const gameNameKey = `${gameId}|${normalizePlayerName(playerName)}`;
    if (!playerGameByGameName.has(gameNameKey)) playerGameByGameName.set(gameNameKey, key);
    else if (playerGameByGameName.get(gameNameKey) !== key) playerGameByGameName.set(gameNameKey, '');
    const schedule = scheduleByGame.get(gameId);
    if (!gamesByPlayerGame.has(key)) {
      const rowTeam = value(row, 'team', 'team_name', 'school');
      const teamId = value(row, 'team_id');
      const homeTeam = value(schedule || {}, 'home_team');
      const awayTeam = value(schedule || {}, 'away_team');
      const homeId = value(schedule || {}, 'home_id', 'home_team_id', 'homeId');
      const awayId = value(schedule || {}, 'away_id', 'away_team_id', 'awayId');
      const isHome = Boolean(schedule && ((teamId && teamId === homeId) || sameTeam(rowTeam, homeTeam)));
      const isAway = Boolean(schedule && ((teamId && teamId === awayId) || sameTeam(rowTeam, awayTeam)));
      const hasResolvedSide = isHome !== isAway;
      const team = hasResolvedSide ? (isHome ? homeTeam : awayTeam) : rowTeam;
      const opponent = hasResolvedSide ? (isHome ? awayTeam : homeTeam) : '';
      const teamIdResolved = hasResolvedSide ? (isHome ? homeId : awayId) : teamId;
      const opponentIdResolved = hasResolvedSide ? (isHome ? awayId : homeId) : '';
      const teamScore = hasResolvedSide ? number(value(schedule || {}, isHome ? 'home_points' : 'away_points', isHome ? 'home_score' : 'away_score')) : null;
      const opponentScore = hasResolvedSide ? number(value(schedule || {}, isHome ? 'away_points' : 'home_points', isHome ? 'away_score' : 'home_score')) : null;
      gamesByPlayerGame.set(key, {
        gameId,
        playerName,
        playerId,
        season,
        date: value(schedule || {}, 'start_date', 'game_date').slice(0, 10),
        week: number(value(schedule || {}, 'week')),
        seasonType: number(value(schedule || {}, 'season_type', 'seasonType')),
        team,
        opponent,
        teamId: teamIdResolved,
        opponentId: opponentIdResolved,
        isHome: hasResolvedSide ? isHome : null,
        teamScore,
        opponentScore,
        score: teamScore != null && opponentScore != null ? `${teamScore}-${opponentScore}` : '',
        result: teamScore == null || opponentScore == null ? '' : teamScore > opponentScore ? 'W' : teamScore < opponentScore ? 'L' : 'T',
        passing: null,
        rushing: null,
        receiving: null,
      });
    }

    const game = gamesByPlayerGame.get(key)!;
    if (category === 'passing') {
      const [comp, att] = splitSlashPair(value(row, 'completions_passing_attempts', 'completions/passingAttempts'));
      game.passing = {
        comp, att,
        yards: Number(value(row, 'passing_yards', 'passingYards')) || 0,
        tds: Number(value(row, 'passing_touchdowns', 'passingTouchdowns')) || 0,
        ints: Number(value(row, 'interceptionsThrown', 'passing_interceptions', 'passingInterceptions', 'interceptions', 'ints')) || 0,
      };
    } else if (category === 'rushing') {
      game.rushing = {
        att: Number(value(row, 'rushing_attempts', 'rushingAttempts')) || 0,
        yards: Number(value(row, 'rushing_yards', 'rushingYards')) || 0,
        tds: Number(value(row, 'rushing_touchdowns', 'rushingTouchdowns')) || 0,
      };
    } else if (category === 'receiving') {
      game.receiving = {
        rec: Number(value(row, 'receptions')) || 0,
        yards: Number(value(row, 'receiving_yards', 'receivingYards')) || 0,
        tds: Number(value(row, 'receiving_touchdowns', 'receivingTouchdowns')) || 0,
        targets: number(value(row, 'targets', 'receiving_targets', 'receivingTargets')),
      };
    }
  }

  // ESPN's box-score release does not consistently include targets. Join the
  // per-game receiver target totals from SportsDataverse's advanced receiving
  // release by game, ESPN team id, and normalized player name.
  const targetPath = `${outputRoot.replace(/\/$/, '')}/cfb-player-targets/${season}.json`;
  const targetPayload = JSON.parse(await Deno.readTextFile(targetPath)) as {
    available: boolean;
    targets: Array<{ gameId: string; teamId: string; playerName: string; targets: number }>;
  };
  const targetRows = Array.isArray(targetPayload.targets) ? targetPayload.targets : [];
  let matchedTargetRows = 0;
  for (const targetRow of targetRows) {
    const identityKey = `${targetRow.gameId}|${targetRow.teamId}|${normalizePlayerName(targetRow.playerName)}`;
    const gameNameKey = `${targetRow.gameId}|${normalizePlayerName(targetRow.playerName)}`;
    const playerGameKey = playerGameByIdentity.get(identityKey) || playerGameByGameName.get(gameNameKey);
    if (!playerGameKey) continue;
    matchedTargetRows++;
    const game = gamesByPlayerGame.get(playerGameKey)!;
    if (!game.receiving) game.receiving = { rec: 0, yards: 0, tds: 0, targets: targetRow.targets };
    else if (game.receiving.targets == null) game.receiving.targets = targetRow.targets;
  }
  if (targetPayload.available && group !== 'qb') {
    for (const game of gamesByPlayerGame.values()) {
      if (!game.receiving) game.receiving = { rec: 0, yards: 0, tds: 0, targets: 0 };
      else if (game.receiving.targets == null) game.receiving.targets = 0;
    }
  }
  if (targetRows.length) {
    console.info(`Joined ${matchedTargetRows}/${targetRows.length} ${season} ${group} receiver target totals.`);
  }

  const games = [...gamesByPlayerGame.values()]
    .filter((game) => game.passing || game.rushing || game.receiving)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const joinedOpponentCount = games.filter((game) => game.opponent).length;
  if (games.length && joinedOpponentCount < Math.ceil(games.length * 0.9)) {
    throw new Error(`Only ${joinedOpponentCount}/${games.length} ${season} ${group} logs joined to a schedule opponent; refusing to publish incomplete logs.`);
  }
  const scheduledTeams = [...new Set(scheduleRows
    .flatMap((schedule) => [value(schedule, 'home_team'), value(schedule, 'away_team')])
    .map(normalizeTeam)
    .filter(Boolean))];
  return { games, sourceRows: boxRows.length, scheduleGames: scheduleByGame.size, scheduledTeams };
}

for (const season of seasons) {
  const seasonGamesByGroup: Record<string, Game[]> = {};
  const scheduledTeamsByGroup: Record<string, string[]> = {};
  for (const group of Object.keys(groups)) {
    const directory = `${cacheRoot}/${season}`;
    await Deno.mkdir(directory, { recursive: true });
    const path = `${directory}/${group}.json`;
    try {
      const { games, sourceRows, scheduleGames, scheduledTeams } = await buildSeason(season, group);
      seasonGamesByGroup[group] = games;
      scheduledTeamsByGroup[group] = scheduledTeams;
      const updatedAt = new Date().toISOString();
      const payload = {
        sport: 'cfb',
        schemaVersion: 1,
        cacheVersion: 1,
        season,
        positionGroup: group,
        updatedAt,
        source: 'sportsdataverse-espn-player-box-plus-advanced-receiving-plus-cfbfastR-schedule',
        sourceRows,
        scheduleGames,
        gameCount: games.length,
        joinedOpponentCount: games.filter((game) => game.opponent).length,
        games,
      };
      await Deno.writeTextFile(path, `${JSON.stringify(payload)}\n`);
      console.info(`Built ${season} ${group}: ${games.length} player-game logs, ${payload.joinedOpponentCount} joined to an opponent.`);
    } catch (error) {
      // Early in a season, the source may not publish that season's player-box
      // CSV yet. Preserve an older snapshot if available; otherwise publish an
      // explicit empty current-season file so the prior season remains usable.
      const message = error instanceof Error ? error.message : String(error);
      const playerBoxUrl = message.includes('/player_box_');
      const sourceNotPublished = playerBoxUrl && (message.startsWith('CSV fetch failed (404)') || message.startsWith('CSV was empty:'));
      if (season !== currentSeason || !sourceNotPublished) throw error;
      const existing = await Deno.stat(path).then(() => true).catch(() => false);
      if (existing) {
        console.warn(`Keeping the previous ${season} ${group} cache: ${message}`);
        const previous = JSON.parse(await Deno.readTextFile(path));
        seasonGamesByGroup[group] = Array.isArray(previous?.games) ? previous.games : [];
        scheduledTeamsByGroup[group] = [...new Set(seasonGamesByGroup[group].flatMap((game) => [game.team, game.opponent]).filter(Boolean).map(normalizeTeam))];
      } else {
        await Deno.writeTextFile(path, `${JSON.stringify({
          sport: 'cfb', schemaVersion: 1, cacheVersion: 1, season,
          positionGroup: group, updatedAt: new Date().toISOString(),
          source: 'sportsdataverse-espn-player-box-plus-advanced-receiving-plus-cfbfastR-schedule',
          sourceRows: 0, scheduleGames: 0, gameCount: 0, joinedOpponentCount: 0, games: [],
        })}\n`);
        seasonGamesByGroup[group] = [];
        scheduledTeamsByGroup[group] = [];
        console.warn(`Published an empty ${season} ${group} cache because source data is not available yet.`);
      }
    }
  }

  // Detail pages request matchup history for one opponent. Publish small
  // opponent shards so Base44 does not download and scan the full position
  // season file on every cold request.
  for (const [group, games] of Object.entries(seasonGamesByGroup)) {
    const gamesByOpponent = new Map<string, { opponent: string; games: Game[] }>();
    for (const opponent of scheduledTeamsByGroup[group] || []) {
      const key = opponent.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key) gamesByOpponent.set(key, { opponent, games: [] });
    }
    for (const game of games) {
      if (!game.opponent) continue;
      const opponent = normalizeTeam(game.opponent);
      const key = opponent.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key) continue;
      if (!gamesByOpponent.has(key)) gamesByOpponent.set(key, { opponent, games: [] });
      gamesByOpponent.get(key)!.games.push(game);
    }

    const opponentDirectory = `${cacheRoot}/${season}/opponents/${group}`;
    await Deno.mkdir(opponentDirectory, { recursive: true });
    for (const [key, value] of gamesByOpponent) {
      const payload = {
        sport: 'cfb',
        schemaVersion: 1,
        cacheVersion: 1,
        season,
        positionGroup: group,
        opponent: value.opponent,
        updatedAt: new Date().toISOString(),
        gameCount: value.games.length,
        games: value.games,
      };
      await Deno.writeTextFile(`${opponentDirectory}/${key}.json`, `${JSON.stringify(payload)}\n`);
    }
    console.info(`Built ${season} ${group} opponent shards: ${gamesByOpponent.size}.`);

    // Player detail pages need one player's full-season chart logs. Publish
    // team shards so the Base44 reader downloads only a small team file instead
    // of the full position-group payload on a cold request.
    const gamesByTeam = new Map<string, { team: string; games: Game[] }>();
    for (const game of games) {
      const team = String(game?.team || '').trim();
      if (!team) continue;
      const teamKey = normalizeTeam(team).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!teamKey) continue;
      if (!gamesByTeam.has(teamKey)) gamesByTeam.set(teamKey, { team, games: [] });
      gamesByTeam.get(teamKey)!.games.push(game);
    }

    const teamDirectory = `${cacheRoot}/${season}/teams/${group}`;
    await Deno.mkdir(teamDirectory, { recursive: true });
    for (const [key, value] of gamesByTeam) {
      const payload = {
        sport: 'cfb',
        schemaVersion: 1,
        cacheVersion: 1,
        season,
        positionGroup: group,
        team: value.team,
        updatedAt: new Date().toISOString(),
        gameCount: value.games.length,
        games: value.games,
      };
      await Deno.writeTextFile(`${teamDirectory}/${key}.json`, `${JSON.stringify(payload)}\n`);
    }
    console.info(`Built ${season} ${group} team shards: ${gamesByTeam.size}.`);
  }
}

const index = {
  sport: 'cfb',
  schemaVersion: 1,
  cacheVersion: 1,
  opponentCacheVersion: 1,
  updatedAt: new Date().toISOString(),
  seasons: Object.fromEntries(seasons.map((season) => [String(season), {
    season,
    positionGroups: Object.keys(groups),
  }])),
};
await Deno.writeTextFile(`${cacheRoot}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
