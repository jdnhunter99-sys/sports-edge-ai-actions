import { fetchCFBLineMovementSlate } from '../base44/shared/cfbLineMovements.ts';
import { canonicalCfbTeam } from '../base44/shared/cfbOddsTeams.ts';
import { fetchMlbLineMovementRequest } from './line_movement_parsers/mlb.ts';
import { fetchNFLLineMovementSlate } from './line_movement_parsers/nfl.ts';
import { fetchNBALineMovementRequest } from './line_movement_parsers/nba.ts';
import { fetchWNBALineMovementRequest } from './line_movement_parsers/wnba.ts';
import { fetchNHLLineMovementRequest } from './line_movement_parsers/nhl.ts';

type SportKey = 'nfl' | 'ncaaf' | 'nba' | 'wnba' | 'nhl' | 'mlb';
type GameRecord = Record<string, unknown> & {
  sport: SportKey;
  game_date: string;
  game_id: string;
  path: string;
  updated_at: string;
  away_team: string;
  home_team: string;
  away_team_abbr: string | null;
  home_team_abbr: string | null;
};

const OUTPUT_ROOT = Deno.env.get('LINE_MOVEMENT_OUTPUT_DIR') || `${Deno.cwd()}/data/line-movement-graphs/v1`;
const DATE_OFFSETS = Array.from({ length: 7 }, (_, index) => index);
const SPORTS: SportKey[] = ['nfl', 'ncaaf', 'nba', 'wnba', 'nhl', 'mlb'];
const parsers: Partial<Record<SportKey, (request: Request) => Promise<Response>>> = {
  nba: fetchNBALineMovementRequest,
  wnba: fetchWNBALineMovementRequest,
  nhl: fetchNHLLineMovementRequest,
  mlb: fetchMlbLineMovementRequest,
};

function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateKey: string, offset: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function hasMovement(game: any): boolean {
  const arrays = [
    game?.moneylineMovement,
    game?.spreadMovement,
    game?.totalMovement,
    game?.movements?.moneyline,
    game?.movements?.spread,
    game?.movements?.total,
  ];
  return arrays.some((value) => Array.isArray(value) && value.length > 0);
}

function cleanGame(game: any, sport: SportKey, gameDate: string): Record<string, unknown> {
  const movements = game?.movements && typeof game.movements === 'object' ? game.movements : {};
  return {
    sport,
    gameDate,
    source: 'scoresandodds-detail-html',
    gameId: game?.gameId || game?.game_id || game?.eventId || null,
    awayTeam: game?.awayTeam || game?.away_team || null,
    homeTeam: game?.homeTeam || game?.home_team || null,
    awayTeamAbbr: game?.awayTeamAbbr || game?.away_team_abbr || null,
    homeTeamAbbr: game?.homeTeamAbbr || game?.home_team_abbr || null,
    moneylineMovement: Array.isArray(game?.moneylineMovement)
      ? game.moneylineMovement
      : Array.isArray(movements.moneyline) ? movements.moneyline : [],
    spreadMovement: Array.isArray(game?.spreadMovement)
      ? game.spreadMovement
      : Array.isArray(movements.spread) ? movements.spread : [],
    totalMovement: Array.isArray(game?.totalMovement)
      ? game.totalMovement
      : Array.isArray(movements.total) ? movements.total : [],
  };
}

function teamIdentity(game: any, side: 'away' | 'home', sport: SportKey) {
  const name = String(game?.[`${side}Team`] || game?.[`${side}_team`] || '').trim();
  let abbr = String(game?.[`${side}TeamAbbr`] || game?.[`${side}_team_abbr`] || '').trim();
  if (!abbr && sport === 'ncaaf' && name) abbr = canonicalCfbTeam(name)?.abbr || '';
  return { name, abbr: abbr || null };
}

function makeRecord(game: any, sport: SportKey, gameDate: string, updatedAt: string): GameRecord | null {
  const gameId = String(game?.gameId || game?.game_id || game?.eventId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const away = teamIdentity(game, 'away', sport);
  const home = teamIdentity(game, 'home', sport);
  if (!gameId || !away.name || !home.name || !hasMovement(game)) return null;

  const path = `games/${sport}/${gameDate}/${gameId}.json`;
  return {
    sport,
    game_date: gameDate,
    game_id: gameId,
    away_team: away.name,
    home_team: home.name,
    away_team_abbr: away.abbr,
    home_team_abbr: home.abbr,
    path,
    updated_at: updatedAt,
  };
}

async function readIndex(): Promise<{ games: GameRecord[]; [key: string]: unknown }> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(`${OUTPUT_ROOT}/index.json`));
    return { ...parsed, games: Array.isArray(parsed?.games) ? parsed.games : [] };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { games: [] };
    throw error;
  }
}

async function writeJsonIfChanged(path: string, value: unknown): Promise<boolean> {
  const fullPath = `${OUTPUT_ROOT}/${path}`;
  const serialized = JSON.stringify(value);
  try {
    const current = (await Deno.readTextFile(fullPath)).trim();
    if (current === serialized) return false;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(fullPath.slice(0, fullPath.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(fullPath, `${serialized}\n`);
  return true;
}

async function fetchSportDate(sport: SportKey, gameDate: string): Promise<any[]> {
  if (sport === 'ncaaf' || sport === 'nfl') {
    const result = sport === 'ncaaf'
      ? await fetchCFBLineMovementSlate(gameDate)
      : await fetchNFLLineMovementSlate(gameDate);
    return Array.isArray(result?.games) ? result.games : [];
  }
  const parser = parsers[sport];
  if (!parser) throw new Error(`No ScoresAndOdds line-movement parser configured for ${sport}`);
  const request = new Request('https://line-movement-publisher.local/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameDate, mode: 'summary', forceLive: true }),
  });
  const response = await parser(request);
  const payload = await response.json().catch(() => ({}));
  const fetchedBoard = response.ok && (
    payload?.success === true
    || Number(payload?.debug?.status) === 200
    || (Array.isArray(payload?.debug?.boardAttempts) && payload.debug.boardAttempts.some((attempt: any) => Number(attempt?.status) === 200))
  );
  if (!fetchedBoard) {
    throw new Error(`${sport} ${gameDate}: ${payload?.error || payload?.message || `HTTP ${response.status}`}`);
  }
  return Array.isArray(payload?.games) ? payload.games : [];
}

async function main() {
  const now = new Date();
  const previousIndex = await readIndex();
  const nextGames = new Map<string, GameRecord>();
  const previousByKey = new Map<string, GameRecord>();
  for (const record of previousIndex.games) {
    const sport = String(record?.sport || '') as SportKey;
    const date = String(record?.game_date || record?.gameDate || '').slice(0, 10);
    const id = String(record?.game_id || record?.gameId || '');
    if (sport && date && id && record?.path) previousByKey.set(`${sport}|${date}|${id}`, record);
  }
  const updatedAt = now.toISOString();
  let successfulScopes = 0;
  let failedScopes = 0;
  let parsedGameCount = 0;
  let changedRecordCount = 0;

  // Query each sport's local calendar date today through six days ahead. Older
  // published files remain in the index, preserving graphs after game day.
  for (const sport of SPORTS) {
    const zone = sport === 'ncaaf' ? 'America/New_York' : 'America/Chicago';
    const today = dateInZone(now, zone);
    for (const offset of DATE_OFFSETS) {
      const gameDate = shiftDate(today, offset);
      try {
        const games = await fetchSportDate(sport, gameDate);
        successfulScopes += 1;
        parsedGameCount += games.length;
        for (const game of games) {
          if (!game || game.error) continue;
          const candidate = makeRecord(game, sport, gameDate, updatedAt);
          if (!candidate) continue;
          const key = `${sport}|${gameDate}|${candidate.game_id}`;
          const prior = previousByKey.get(key);
          const changed = await writeJsonIfChanged(candidate.path, cleanGame(game, sport, gameDate));
          const record = {
            ...candidate,
            updated_at: changed ? updatedAt : prior?.updated_at || updatedAt,
          };
          nextGames.set(key, record);
          if (changed || !prior || JSON.stringify(record) !== JSON.stringify(prior)) changedRecordCount += 1;
        }
        console.info(`[lineMovement] ${sport} ${gameDate}: parsed=${games.length} published=${[...nextGames.values()].filter((entry) => entry.sport === sport && entry.game_date === gameDate).length}`);
      } catch (error) {
        failedScopes += 1;
        console.warn(`[lineMovement] ${sport} ${gameDate} failed:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (!successfulScopes) throw new Error(`All ${failedScopes} ScoresAndOdds sport/date fetches failed; preserving the existing index.`);

  const merged = new Map<string, GameRecord>();
  for (const record of previousIndex.games) {
    const sport = String(record?.sport || '') as SportKey;
    const gameDate = String(record?.game_date || record?.gameDate || '').slice(0, 10);
    const gameId = String(record?.game_id || record?.gameId || '');
    if (sport && gameDate && gameId && record?.path) merged.set(`${sport}|${gameDate}|${gameId}`, record);
  }
  for (const [key, record] of nextGames) merged.set(key, record);

  const index = {
    schema_version: 1,
    source: 'scoresandodds',
    generated_at: changedRecordCount > 0 ? updatedAt : previousIndex.generated_at || updatedAt,
    games: [...merged.values()].sort((a, b) =>
      a.game_date.localeCompare(b.game_date) || a.sport.localeCompare(b.sport) || String(a.away_team || '').localeCompare(String(b.away_team || ''))
    ),
  };
  await writeJsonIfChanged('index.json', index);

  console.info(`[lineMovement] complete: successfulScopes=${successfulScopes} failedScopes=${failedScopes} parsedGames=${parsedGameCount} changedGames=${changedRecordCount} indexedGames=${index.games.length}`);
}

if (import.meta.main) await main();
