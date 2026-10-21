// SportsDataverse cfbfastR/ESPN release adapter for the CFB team-stats cache.
// It converts the public, per-season cfbfastR Parquet assets into the source rows
// consumed by the existing CFB calculator. No CFBD endpoint or API key is used.

import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'npm:hyparquet@1.31.1';
import { compressors } from 'npm:hyparquet-compressors@1.1.1';

type SourceRow = Record<string, any>;
type Params = Record<string, any>;

const RELEASE_ROOT = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/';
const RELEASES: Record<string, { tag: string; file: string; columns: string[] }> = {
  teams: { tag: 'espn_cfb_teams', file: 'cfb_teams', columns: ['season', 'team_id', 'abbreviation', 'display_name', 'short_display_name', 'name', 'nickname', 'location', 'is_fbs', 'is_exhibition'] },
  schedules: { tag: 'espn_cfb_schedules', file: 'cfb_schedule', columns: ['game_id', 'week', 'season_type', 'game_date', 'home_id', 'home_team', 'home_score', 'away_id', 'away_team', 'away_score', 'status'] },
  team_box: { tag: 'espn_cfb_team_box', file: 'team_box', columns: ['game_id', 'season', 'team_id', 'home_away', 'firstDowns', 'thirdDownEff', 'fourthDownEff', 'totalYards', 'netPassingYards', 'completionAttempts', 'rushingYards', 'rushingAttempts', 'totalPenaltiesYards', 'turnovers', 'fumblesLost', 'interceptions', 'possessionTime'] },
  player_box: { tag: 'espn_cfb_player_box', file: 'player_box', columns: ['game_id', 'team_id', 'category', 'passingTouchdowns', 'rushingTouchdowns', 'hurries', 'fieldGoalsMade/fieldGoalAttempts', 'extraPointsMade/extraPointAttempts', 'punts', 'puntYards', 'touchbacks', 'puntsInside20', 'kickReturns', 'kickReturnYards', 'kickReturnTouchdowns', 'puntReturns', 'puntReturnYards', 'puntReturnTouchdowns'] },
  adv_team: { tag: 'espn_cfb_adv_team', file: 'adv_team', columns: ['game_id', 'week', 'pos_team', 'rushes', 'rush_yards', 'EPA_rushing_overall', 'EPA_rushing_per_play', 'EPA_explosive_rushing', 'EPA_explosive_rushing_rate', 'passes', 'EPA_passing_overall', 'EPA_passing_per_play', 'EPA_explosive_passing', 'EPA_explosive_passing_rate', 'scrimmage_plays', 'EPA_overall_off', 'EPA_per_play', 'EPA_explosive', 'EPA_explosive_rate', 'rushing_stuff', 'rushing_power', 'rushing_power_success', 'line_yards', 'second_level_yards', 'open_field_yards'] },
  adv_defensive: { tag: 'espn_cfb_adv_defensive', file: 'adv_defensive', columns: ['game_id', 'week', 'def_pos_team', 'scrimmage_plays', 'TFL', 'havoc_total', 'fumbles', 'def_int', 'num_pass_plays', 'sacks', 'pass_breakups'] },
  adv_situational: { tag: 'espn_cfb_adv_situational', file: 'adv_situational', columns: ['game_id', 'week', 'pos_team', 'EPA_success', 'EPA_success_pass', 'EPA_success_rush'] },
  play_by_play: { tag: 'espn_cfb_pbp', file: 'play_by_play', columns: [
    'game_id', 'week', 'sequenceNumber', 'status_type_completed', 'text', 'type.text', 'orig_play_type',
    'period.number', 'clock.displayValue', 'start.down', 'start.distance', 'start.yardsToEndzone', 'start.pos_team.name',
    'pos_team', 'pass', 'pass_attempt', 'rush', 'sack', 'EPA_scrimmage', 'EPA', 'EPA_success',
    'EPA_explosive_pass', 'EPA_explosive_rush', 'yds_rushed',
    'yds_receiving', 'statYardage', 'yds_sacked', 'drive.id', 'drive.result', 'drive.displayResult',
    'drive.isScore', 'drive.team.displayName', 'drive.team.shortDisplayName', 'drive.offensivePlays',
    'drive.timeElapsed.displayValue', 'start.pos_team_score', 'end.pos_team_score', 'scoringPlay',
    'punt', 'punt_play', 'fg_attempt', 'fg_made', 'yds_fg', 'yds_punted', 'yds_punt_gained',
    'yds_punt_return', 'kickoff_play', 'yds_kickoff', 'yds_kickoff_return',
    'kickoff_tb', 'punt_tb', 'penalty_flag', 'scrimmage_play', 'pos_unit',
    'line_yards', 'second_level_yards', 'open_field_yards',
  ] },
  linescores: { tag: 'espn_cfb_linescores', file: 'linescores', columns: ['game_id', 'team_id', 'period', 'value'] },
};

// The current ESPN-native Parquet releases use camelCase fields for box stats.
// Normalize those fields once so the existing CFB calculator can keep its stable shape.
const COLUMN_ALIASES: Record<string, Record<string, string>> = {
  team_box: {
    first_downs: 'firstDowns', third_down_eff: 'thirdDownEff', fourth_down_eff: 'fourthDownEff',
    total_yards: 'totalYards', net_passing_yards: 'netPassingYards', completion_attempts: 'completionAttempts',
    rushing_yards: 'rushingYards', rushing_attempts: 'rushingAttempts',
    total_penalties_yards: 'totalPenaltiesYards', fumbles_lost: 'fumblesLost', possession_time: 'possessionTime',
  },
  player_box: {
    passing_touchdowns: 'passingTouchdowns', rushing_touchdowns: 'rushingTouchdowns',
    field_goals_made_field_goal_attempts: 'fieldGoalsMade/fieldGoalAttempts',
    extra_points_made_extra_point_attempts: 'extraPointsMade/extraPointAttempts',
    punt_yards: 'puntYards', punts_inside20: 'puntsInside20', kick_returns: 'kickReturns',
    kick_return_yards: 'kickReturnYards', kick_return_touchdowns: 'kickReturnTouchdowns',
    punt_returns: 'puntReturns', punt_return_yards: 'puntReturnYards', punt_return_touchdowns: 'puntReturnTouchdowns',
  },
};

function clean(value: unknown): string {
  const out = String(value ?? '').trim();
  return out === 'NA' || out === 'NaN' || out === 'null' ? '' : out;
}

function number(value: unknown): number | null {
  const raw = clean(value).replace(/,/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function truth(value: unknown): boolean {
  return /^(true|1|yes|y)$/i.test(clean(value));
}

function isCompletedGame(row: SourceRow): boolean {
  const explicit = row.status_type_completed ?? row.completed;
  if (explicit != null && clean(explicit) !== '') return truth(explicit);
  const status = textValue(row, 'status_type_name', 'status').toUpperCase();
  if (status) return /^(?:STATUS_)?FINAL(?:$|[_ /-])/.test(status);
  return number(row.home_score) != null && number(row.away_score) != null;
}

function textValue(row: SourceRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = clean(row[key]);
    if (value) return value;
  }
  return '';
}

function numValue(row: SourceRow, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = number(row[key]);
    if (value != null) return value;
  }
  return null;
}

function sum(rows: SourceRow[], key: string): number | null {
  const values = rows.map((row) => number(row[key])).filter((value): value is number => value != null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator != null && denominator != null && denominator > 0 ? numerator / denominator : null;
}

function pair(value: unknown): [number, number] {
  const match = clean(value).match(/^\s*(-?\d+(?:\.\d+)?)\s*[/-]\s*(-?\d+(?:\.\d+)?)\s*$/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function seasonFrom(params: Params): number {
  const now = new Date();
  return Number(params?.year) || (now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!result.has(key)) result.set(key, []);
    result.get(key)!.push(row);
  }
  return result;
}

function parquetColumnNames(schema: any): Set<string> {
  const names = new Set<string>();
  const visit = (node: any, prefix = '') => {
    for (const child of node?.children || []) {
      const name = clean(child?.element?.name);
      if (!name) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      names.add(name);
      names.add(path);
      if (child?.children?.length) visit(child, path);
    }
  };
  visit(schema);
  return names;
}

export class SportsDataverseCfbSource {
  readonly name = 'sportsdataverse-cfbfastr-espn';
  private data = new Map<string, Promise<SourceRow[]>>();
  private weekSelections = new WeakMap<SourceRow[], Map<number, SourceRow[]>>();
  private completedIds = new Map<number, Promise<Set<string>>>();

  private async dataset(name: string, season: number): Promise<SourceRow[]> {
    const definition = RELEASES[name];
    if (!definition) throw new Error(`Unknown SportsDataverse CFB dataset: ${name}`);
    const key = `${name}:${season}`;
    if (!this.data.has(key)) {
      this.data.set(key, (async () => {
        const url = `${RELEASE_ROOT}${definition.tag}/${definition.file}_${season}.parquet`;
        let lastError = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const file = await asyncBufferFromUrl({
              url,
              requestInit: {
                headers: {
                  'User-Agent': 'SportsEdgeAI-CFB-Stats-Publisher/1.0',
                  Accept: 'application/vnd.apache.parquet,*/*',
                },
              },
            });
            const schema = parquetSchema(await parquetMetadataAsync(file));
            const availableColumns = parquetColumnNames(schema);
            const columns = definition.columns.filter((column) => availableColumns.has(column));
            const missingColumns = definition.columns.filter((column) => !availableColumns.has(column));
            if (missingColumns.length) {
              console.warn(`SportsDataverse ${name} ${season} is missing requested Parquet columns: ${missingColumns.join(', ')}`);
            }
            const sourceRows = await parquetReadObjects({ file, columns, compressors }) as SourceRow[];
            const aliases = COLUMN_ALIASES[name] || {};
            const rows = sourceRows.map((row) => {
              const normalized = { ...row };
              for (const [target, source] of Object.entries(aliases)) {
                if (!(target in normalized) && source in row) normalized[target] = row[source];
              }
              return normalized;
            });
            if (rows.length) return rows;
            throw new Error(`SportsDataverse ${name} Parquet file for ${season} was empty.`);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 700));
          }
        }
        throw new Error(`SportsDataverse ${name} download failed for ${season}: ${lastError || 'unknown HTTP error'}`);
      })());
    }
    return await this.data.get(key)!;
  }

  private async optionalDataset(name: string, season: number): Promise<SourceRow[]> {
    try { return await this.dataset(name, season); }
    catch (error) {
      if (name === 'linescores') return [];
      throw error;
    }
  }

  private async teams(season: number): Promise<SourceRow[]> {
    return await this.dataset('teams', season);
  }

  private async fbsTeams(season: number): Promise<SourceRow[]> {
    return (await this.teams(season)).filter((row) => truth(row.is_fbs) && !truth(row.is_exhibition));
  }

  private async completedGames(season: number): Promise<SourceRow[]> {
    const [schedule, fbs] = await Promise.all([this.dataset('schedules', season), this.fbsTeams(season)]);
    const fbsIds = new Set(fbs.map((row) => clean(row.team_id)));
    return schedule.filter((row) =>
      isCompletedGame(row) && number(row.home_score) != null && number(row.away_score) != null &&
      (fbsIds.has(clean(row.home_id)) || fbsIds.has(clean(row.away_id)))
    );
  }

  private async completedGameIds(season: number): Promise<Set<string>> {
    if (!this.completedIds.has(season)) {
      this.completedIds.set(season, this.completedGames(season).then((games) => new Set(games.map((row) => clean(row.game_id)))));
    }
    return await this.completedIds.get(season)!;
  }

  private async playRows(season: number): Promise<SourceRow[]> {
    return await this.dataset('play_by_play', season);
  }

  private async selectedByWeek(rows: SourceRow[], params: Params): Promise<SourceRow[]> {
    const season = seasonFrom(params);
    let selection = this.weekSelections.get(rows);
    if (!selection) {
      const completed = await this.completedGameIds(season);
      selection = new Map<number, SourceRow[]>();
      for (const row of rows) {
        if (!completed.has(clean(row.game_id))) continue;
        const week = number(row.week) ?? 0;
        if (!selection.has(week)) selection.set(week, []);
        selection.get(week)!.push(row);
      }
      this.weekSelections.set(rows, selection);
    }
    const week = number(params.week);
    return week == null ? [...selection.values()].flat() : selection.get(week) || [];
  }

  private async gameBoxes(params: Params): Promise<any[]> {
    const season = seasonFrom(params);
    const [schedule, teams, box, playerBox, defensive, linescores] = await Promise.all([
      this.completedGames(season), this.teams(season), this.dataset('team_box', season),
      this.dataset('player_box', season), this.dataset('adv_defensive', season), this.optionalDataset('linescores', season),
    ]);
    const fbsIds = new Set((await this.fbsTeams(season)).map((row) => clean(row.team_id)));
    const teamById = new Map(teams.map((row) => [clean(row.team_id), row]));
    const scheduleById = new Map(schedule.map((row) => [clean(row.game_id), row]));
    const defenseByGameTeam = new Map(defensive.map((row) => [clean(row.game_id) + '|' + clean(row.def_pos_team), row]));
    const playersByGameTeam = groupBy(playerBox, (row) => clean(row.game_id) + '|' + clean(row.team_id));
    const linesByGameTeam = groupBy(linescores, (row) => clean(row.game_id) + '|' + clean(row.team_id));
    const week = number(params.week);
    const boxesByGame = groupBy(box.filter((row) => {
      const game = scheduleById.get(clean(row.game_id));
      return Boolean(game) && (week == null || number(game!.week) === week) &&
        (fbsIds.has(clean(row.team_id)) || clean(row.team_id) === clean(game!.home_id) || clean(row.team_id) === clean(game!.away_id));
    }), (row) => clean(row.game_id));
    const games = schedule.filter((game) => week == null || number(game.week) === week);
    const out: any[] = [];

    for (const game of games) {
      const gameId = clean(game.game_id);
      const teamRows = boxesByGame.get(gameId) || [];
      if (teamRows.length < 2) continue;
      const mappedTeams: any[] = [];
      for (const teamRow of teamRows) {
        const teamId = clean(teamRow.team_id);
        const opponentId = teamId === clean(game.home_id) ? clean(game.away_id) : clean(game.home_id);
        const playerRows = playersByGameTeam.get(`${gameId}|${teamId}`) || [];
        const playerCategoryRows = (category: string) => playerRows.filter((row) => clean(row.category).toLowerCase() === category.toLowerCase());
        const hasCategory = (category: string) => playerCategoryRows(category).length > 0;
        const addPlayerSum = (target: string, category: string, field: string, combine?: { other: string; separator: string }) => {
          const selected = playerCategoryRows(category);
          if (!selected.length) return;
          const left = selected.reduce((total, row) => total + (number(row[field]) ?? 0), 0);
          const value = combine
            ? `${left}${combine.separator}${selected.reduce((total, row) => total + (number(row[combine.other]) ?? 0), 0)}`
            : String(left);
          stats.push({ category: target, stat: value });
        };
        const stats: any[] = [];
        const add = (category: string, value: unknown) => {
          if (clean(value) !== '') stats.push({ category, stat: String(value) });
        };

        add('totalYards', teamRow.total_yards);
        add('netPassingYards', teamRow.net_passing_yards);
        add('completionAttempts', teamRow.completion_attempts);
        add('rushingYards', teamRow.rushing_yards);
        add('rushingAttempts', teamRow.rushing_attempts);
        add('firstDowns', teamRow.first_downs);
        add('thirdDownEff', teamRow.third_down_eff);
        add('fourthDownEff', teamRow.fourth_down_eff);
        add('totalPenaltiesYards', teamRow.total_penalties_yards);
        add('turnovers', teamRow.turnovers);
        add('fumblesLost', teamRow.fumbles_lost);
        add('interceptions', teamRow.interceptions);
        add('possessionTime', teamRow.possession_time);
        if (hasCategory('passing')) addPlayerSum('passingTouchdowns', 'passing', 'passing_touchdowns');
        if (hasCategory('rushing')) addPlayerSum('rushingTouchdowns', 'rushing', 'rushing_touchdowns');

        // Team sacks allowed are the opponent defense's sacks from cfbfastR's
        // per-game defensive unit table. Hurries/TFL/PBUs/forced fumbles are
        // mapped from the same season's ESPN box releases.
        const opponentDefense = defenseByGameTeam.get(`${gameId}|${opponentId}`);
        if (opponentDefense) add('sacks', opponentDefense.sacks);
        const ownDefense = defenseByGameTeam.get(`${gameId}|${teamId}`);
        if (ownDefense) {
          add('tacklesForLoss', ownDefense.TFL);
          add('passesDeflected', ownDefense.pass_breakups);
          add('fumblesForced', ownDefense.fumbles);
        }
        addPlayerSum('qbHurries', 'defensive', 'hurries');
        addPlayerSum('fieldGoalsMadeFieldGoalsAttempted', 'kicking', 'field_goals_made_field_goal_attempts');
        addPlayerSum('extraPointsMadeExtraPointsAttempted', 'kicking', 'extra_points_made_extra_point_attempts');
        addPlayerSum('puntsYards', 'punting', 'punts', { other: 'punt_yards', separator: '-' });
        addPlayerSum('puntsInside20', 'punting', 'punts_inside20');
        addPlayerSum('puntTouchbacks', 'punting', 'touchbacks');
        addPlayerSum('kickReturnsYards', 'kickReturns', 'kick_returns', { other: 'kick_return_yards', separator: '-' });
        addPlayerSum('kickReturnTouchdowns', 'kickReturns', 'kick_return_touchdowns');
        addPlayerSum('puntReturnsYards', 'puntReturns', 'punt_returns', { other: 'punt_return_yards', separator: '-' });
        addPlayerSum('puntReturnTouchdowns', 'puntReturns', 'punt_return_touchdowns');

        const team = teamById.get(teamId) || {};
        const scores = (linesByGameTeam.get(`${gameId}|${teamId}`) || [])
          .sort((a, b) => (number(a.period) ?? 0) - (number(b.period) ?? 0))
          .map((row) => number(row.value) ?? 0);
        mappedTeams.push({
          team: textValue(team, 'location', 'short_display_name') || textValue(teamRow, 'team_display_name'),
          teamId: Number(teamId),
          homeAway: clean(teamRow.home_away).toLowerCase(),
          points: teamId === clean(game.home_id) ? number(game.home_score) : number(game.away_score),
          stats,
        });
        (mappedTeams[mappedTeams.length - 1] as any).lineScores = scores;
      }
      const home = mappedTeams.find((team) => team.homeAway === 'home');
      const away = mappedTeams.find((team) => team.homeAway === 'away');
      if (home && away) out.push({ id: gameId, teams: mappedTeams, homeLineScores: home.lineScores, awayLineScores: away.lineScores });
    }
    return out;
  }

  private async mappedPlays(params: Params): Promise<any[]> {
    const rows = await this.selectedByWeek(await this.playRows(seasonFrom(params)), params);
    const teams = await this.teams(seasonFrom(params));
    const teamById = new Map(teams.map((row) => [clean(row.team_id), row]));
    return rows.map((row) => {
      const offenseId = clean(row.pos_team);
      const offenseMeta = teamById.get(offenseId) || {};
      const sack = truth(row.sack);
      const passPlay = truth(row.pass);
      const passAttempt = row.pass_attempt == null || clean(row.pass_attempt) === ''
        ? passPlay && !sack
        : truth(row.pass_attempt);
      const rush = truth(row.rush);
      let playType = textValue(row, 'type.text', 'orig_play_type');
      if (sack) playType = 'Sack';
      else if (passPlay) playType = 'Pass';
      else if (rush) playType = 'Rush';
      const yards = sack
        ? -Math.abs(number(row.yds_sacked) ?? 0)
        : rush ? number(row.yds_rushed) : passPlay ? number(row.yds_receiving) : number(row.statYardage);
      return {
        gameId: clean(row.game_id),
        offense: textValue(offenseMeta, 'location', 'short_display_name') || textValue(row, 'start.pos_team.name', 'drive.team.shortDisplayName', 'drive.team.displayName'),
        playType,
        playText: textValue(row, 'text'),
        yardsGained: yards ?? 0,
        down: number(row.down) ?? number(row['start.down']) ?? 0,
        distance: number(row.distance) ?? number(row['start.distance']) ?? 0,
        yardsToGoal: number(row['start.yardsToEndzone']) ?? 0,
        ppa: numValue(row, 'EPA_scrimmage', 'EPA'),
        success: row.EPA_success == null || clean(row.EPA_success) === '' ? undefined : truth(row.EPA_success),
        period: number(row['period.number']) ?? 0,
        clock: textValue(row, 'clock.displayValue'),
        driveId: textValue(row, 'drive.id'),
        playTextScoring: truth(row['drive.isScore']),
        scoring: truth(row.scoringPlay),
        isPass: row.pass_attempt == null || clean(row.pass_attempt) === ''
          ? (row.pass == null || clean(row.pass) === '' ? undefined : passAttempt)
          : passAttempt,
        isPassPlay: row.pass == null || clean(row.pass) === '' ? undefined : passPlay,
        isRush: row.rush == null || clean(row.rush) === '' ? undefined : rush,
        isSack: row.sack == null || clean(row.sack) === '' ? undefined : sack,
        isScrimmage: row.scrimmage_play == null || clean(row.scrimmage_play) === '' ? undefined : truth(row.scrimmage_play),
        explosivePass: row.EPA_explosive_pass == null || clean(row.EPA_explosive_pass) === '' ? undefined : truth(row.EPA_explosive_pass),
        explosiveRush: row.EPA_explosive_rush == null || clean(row.EPA_explosive_rush) === '' ? undefined : truth(row.EPA_explosive_rush),
        lineYards: number(row.line_yards),
        secondLevelYards: number(row.second_level_yards),
        openFieldYards: number(row.open_field_yards),
      };
    });
  }

  private async mappedDrives(params: Params): Promise<any[]> {
    const season = seasonFrom(params);
    const raw = await this.selectedByWeek(await this.playRows(season), params);
    const ordered = [...raw].sort((a, b) => (number(a.sequenceNumber) ?? 0) - (number(b.sequenceNumber) ?? 0));
    const teams = await this.teams(season);
    const teamById = new Map(teams.map((row) => [clean(row.team_id), row]));
    const groups = new Map<string, { first: SourceRow; last: SourceRow; offense: string; gameId: string }>();
    for (const row of ordered) {
      const gameId = clean(row.game_id);
      const driveId = clean(row['drive.id']);
      if (!gameId || !driveId) continue;
      const teamId = clean(row.pos_team);
      const team = teamById.get(teamId) || {};
      const offense = textValue(team, 'location', 'short_display_name') || textValue(row, 'drive.team.shortDisplayName', 'drive.team.displayName', 'start.pos_team.name');
      const key = `${gameId}|${driveId}`;
      if (!groups.has(key)) groups.set(key, { first: row, last: row, offense, gameId });
      else groups.get(key)!.last = row;
    }
    const counts = new Map<string, number>();
    return [...groups.values()].map((group) => {
      const countKey = `${group.gameId}|${group.offense}`;
      const driveNumber = (counts.get(countKey) || 0) + 1;
      counts.set(countKey, driveNumber);
      return {
        gameId: group.gameId,
        id: textValue(group.first, 'drive.id'),
        offense: group.offense,
        driveNumber,
        plays: number(group.first['drive.offensivePlays']) ?? 0,
        driveResult: textValue(group.last, 'drive.result', 'drive.displayResult'),
        scoring: truth(group.last['drive.isScore']),
        startOffenseScore: number(group.first['start.pos_team_score']) ?? 0,
        endOffenseScore: number(group.last['end.pos_team_score']) ?? 0,
        elapsed: textValue(group.last, 'drive.timeElapsed.displayValue'),
      };
    });
  }

  private async advanced(params: Params): Promise<any[]> {
    const season = seasonFrom(params);
    const [games, fbs, teams, offenseRows, defenseRows, situationRows] = await Promise.all([
      this.completedGames(season), this.fbsTeams(season), this.teams(season), this.dataset('adv_team', season),
      this.dataset('adv_defensive', season), this.dataset('adv_situational', season),
    ]);
    const gameById = new Map(games.map((row) => [clean(row.game_id), row]));
    const completedIds = new Set(gameById.keys());
    const startWeek = number(params.startWeek) ?? 1;
    const endWeek = number(params.endWeek) ?? Number.MAX_SAFE_INTEGER;
    const inRange = (row: SourceRow) => completedIds.has(clean(row.game_id)) &&
      number(row.week) != null && number(row.week)! >= startWeek && number(row.week)! <= endWeek;
    const offense = offenseRows.filter(inRange);
    const defense = defenseRows.filter(inRange);
    const situations = situationRows.filter(inRange);
    const offenseByGameTeam = new Map(offense.map((row) => [clean(row.game_id) + '|' + clean(row.pos_team), row]));
    const situationByGameTeam = new Map(situations.map((row) => [clean(row.game_id) + '|' + clean(row.pos_team), row]));
    const defenseByTeam = groupBy(defense, (row) => clean(row.game_id) + '|' + clean(row.def_pos_team));

    const aggregate = (rows: SourceRow[], situationalRows: SourceRow[], defenseRowsForTeam: SourceRow[]) => {
      const rushes = sum(rows, 'rushes');
      const passes = sum(rows, 'passes');
      const plays = sum(rows, 'scrimmage_plays');
      const rushPower = sum(rows, 'rushing_power');
      const defensivePlays = sum(defenseRowsForTeam, 'scrimmage_plays');
      const result: any = {
        ppa: ratio(sum(rows, 'EPA_overall_off'), plays),
        successRate: ratio(sum(situationalRows, 'EPA_success'), plays),
        passingPlays: {
          ppa: ratio(sum(rows, 'EPA_passing_overall'), passes),
          totalPPA: sum(rows, 'EPA_passing_overall'),
          successRate: ratio(sum(situationalRows, 'EPA_success_pass'), passes),
          rate: ratio(passes, plays),
          explosiveness: ratio(sum(rows, 'EPA_explosive_passing'), passes),
        },
        rushingPlays: {
          ppa: ratio(sum(rows, 'EPA_rushing_overall'), rushes),
          successRate: ratio(sum(situationalRows, 'EPA_success_rush'), rushes),
          rate: ratio(rushes, plays),
          explosiveness: ratio(sum(rows, 'EPA_explosive_rushing'), rushes),
        },
        stuffRate: ratio(sum(rows, 'rushing_stuff'), rushes),
        powerSuccess: ratio(sum(rows, 'rushing_power_success'), rushPower),
        explosiveness: ratio(sum(rows, 'EPA_explosive'), plays),
        lineYards: ratio(sum(rows, 'line_yards'), rushes),
        secondLevelYards: ratio(sum(rows, 'second_level_yards'), rushes),
        openFieldYards: ratio(sum(rows, 'open_field_yards'), rushes),
        havoc: { total: ratio(sum(defenseRowsForTeam, 'havoc_total'), defensivePlays) },
      };
      return result;
    };

    const output: any[] = [];
    for (const team of fbs) {
      const teamId = clean(team.team_id);
      const ownRows = offense.filter((row) => clean(row.pos_team) === teamId);
      const ownSituations = ownRows.map((row) => situationByGameTeam.get(clean(row.game_id) + '|' + teamId)).filter(Boolean) as SourceRow[];
      const opponentRows: SourceRow[] = [];
      const opponentSituations: SourceRow[] = [];
      const ownDefenseRows: SourceRow[] = [];
      for (const row of ownRows) {
        const game = gameById.get(clean(row.game_id));
        if (!game) continue;
        const opponentId = clean(game.home_id) === teamId ? clean(game.away_id) : clean(game.home_id);
        const opponent = offenseByGameTeam.get(clean(row.game_id) + '|' + opponentId);
        if (opponent) opponentRows.push(opponent);
        const opponentSituation = situationByGameTeam.get(clean(row.game_id) + '|' + opponentId);
        if (opponentSituation) opponentSituations.push(opponentSituation);
        ownDefenseRows.push(...(defenseByTeam.get(clean(row.game_id) + '|' + teamId) || []));
      }
      output.push({
        team: textValue(team, 'location', 'short_display_name', 'display_name'),
        offense: aggregate(ownRows, ownSituations, []),
        defense: aggregate(opponentRows, opponentSituations, ownDefenseRows),
      });
    }
    return output;
  }

  private async seasonStandard(params: Params): Promise<any[]> {
    const season = seasonFrom(params);
    const [schedule, teams, box, players, advanced] = await Promise.all([
      this.completedGames(season), this.fbsTeams(season), this.dataset('team_box', season),
      this.dataset('player_box', season), this.dataset('adv_team', season),
    ]);
    const completed = new Set(schedule.filter((game) => {
      const week = number(game.week) ?? 0;
      return week >= (number(params.startWeek) ?? 1) && week <= (number(params.endWeek) ?? Number.MAX_SAFE_INTEGER);
    }).map((game) => clean(game.game_id)));
    const boxByTeam = groupBy(box.filter((row) => completed.has(clean(row.game_id))), (row) => clean(row.team_id));
    const playerByTeam = groupBy(players.filter((row) => completed.has(clean(row.game_id))), (row) => clean(row.team_id));
    const advByTeam = groupBy(advanced.filter((row) => completed.has(clean(row.game_id))), (row) => clean(row.pos_team));
    const result: any[] = [];
    for (const team of teams) {
      const teamId = clean(team.team_id);
      const teamBoxes = boxByTeam.get(teamId) || [];
      const teamPlayers = playerByTeam.get(teamId) || [];
      const teamAdvanced = advByTeam.get(teamId) || [];
      const passing = teamBoxes.reduce((total, row) => {
        const [made, attempts] = pair(row.completion_attempts);
        total.completions += made;
        total.attempts += attempts;
        return total;
      }, { completions: 0, attempts: 0 });
      const values: Record<string, number | string> = {
        totalYards: teamBoxes.reduce((total, row) => total + (number(row.net_passing_yards) ?? 0) + (number(row.rushing_yards) ?? 0), 0),
        netPassingYards: sum(teamBoxes, 'net_passing_yards'),
        attempts: passing.attempts,
        completions: passing.completions,
        passingTDs: teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'passing').reduce((total, row) => total + (number(row.passing_touchdowns) ?? 0), 0),
        interceptionsThrown: sum(teamBoxes, 'interceptions'),
        rushingAttempts: sum(teamBoxes, 'rushing_attempts'),
        rushingYards: sum(teamBoxes, 'rushing_yards'),
        rushingTDs: teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'rushing').reduce((total, row) => total + (number(row.rushing_touchdowns) ?? 0), 0),
        firstDowns: sum(teamBoxes, 'first_downs'),
        plays: sum(teamAdvanced, 'scrimmage_plays'),
      };
      for (const [target, field] of [
        ['fieldGoals', 'field_goals_made_field_goal_attempts'],
        ['extraPoints', 'extra_points_made_extra_point_attempts'],
      ]) {
        const category = target === 'fieldGoals' ? 'kicking' : 'kicking';
        const pairRows = teamPlayers.filter((row) => clean(row.category).toLowerCase() === category);
        const [made, attempts] = pairRows.reduce((total, row) => {
          const [rowMade, rowAttempts] = pair(row[field]);
          total[0] += rowMade;
          total[1] += rowAttempts;
          return total;
        }, [0, 0]);
        values[target] = `${made}/${attempts}`;
      }
      values.punts = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'punting').reduce((total, row) => total + (number(row.punts) ?? 0), 0);
      values.puntYards = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'punting').reduce((total, row) => total + (number(row.punt_yards) ?? 0), 0);
      values.puntsInside20 = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'punting').reduce((total, row) => total + (number(row.punts_inside20) ?? 0), 0);
      values.puntTouchbacks = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'punting').reduce((total, row) => total + (number(row.touchbacks) ?? 0), 0);
      values.kickReturns = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'kickreturns').reduce((total, row) => total + (number(row.kick_returns) ?? 0), 0);
      values.kickReturnYards = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'kickreturns').reduce((total, row) => total + (number(row.kick_return_yards) ?? 0), 0);
      values.kickReturnTouchdowns = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'kickreturns').reduce((total, row) => total + (number(row.kick_return_touchdowns) ?? 0), 0);
      values.puntReturns = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'puntreturns').reduce((total, row) => total + (number(row.punt_returns) ?? 0), 0);
      values.puntReturnYards = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'puntreturns').reduce((total, row) => total + (number(row.punt_return_yards) ?? 0), 0);
      values.puntReturnTouchdowns = teamPlayers.filter((row) => clean(row.category).toLowerCase() === 'puntreturns').reduce((total, row) => total + (number(row.punt_return_touchdowns) ?? 0), 0);
      const displayName = textValue(team, 'location', 'short_display_name', 'display_name');
      for (const [statName, statValue] of Object.entries(values)) {
        result.push({ team: displayName, statName, statValue });
      }
    }
    return result;
  }

  async get(path: string, params: Params = {}): Promise<any[]> {
    const season = seasonFrom(params);
    if (path === '/teams/fbs') {
      return (await this.fbsTeams(season)).map((row) => ({
        school: textValue(row, 'location', 'short_display_name', 'display_name'),
        name: textValue(row, 'display_name'),
        abbreviation: textValue(row, 'abbreviation'),
      }));
    }
    if (path === '/games') {
      const [games, teams, linescores] = await Promise.all([
        this.completedGames(season), this.teams(season), this.optionalDataset('linescores', season),
      ]);
      const teamById = new Map(teams.map((row) => [clean(row.team_id), row]));
      const linesByGameTeam = groupBy(linescores, (row) => clean(row.game_id) + '|' + clean(row.team_id));
      return games.map((row) => {
        const homeId = clean(row.home_id);
        const awayId = clean(row.away_id);
        const lineScores = (teamId: string) => (linesByGameTeam.get(clean(row.game_id) + '|' + teamId) || [])
          .sort((a, b) => (number(a.period) ?? 0) - (number(b.period) ?? 0))
          .map((item) => number(item.value) ?? 0);
        return {
          id: clean(row.game_id),
          week: number(row.week),
          seasonType: number(row.season_type),
          startDate: textValue(row, 'game_date'),
          completed: true,
          homeTeam: textValue(teamById.get(homeId) || {}, 'location', 'short_display_name') || textValue(row, 'home_location', 'home_team'),
          awayTeam: textValue(teamById.get(awayId) || {}, 'location', 'short_display_name') || textValue(row, 'away_location', 'away_team'),
          homePoints: number(row.home_score),
          awayPoints: number(row.away_score),
          homeLineScores: lineScores(homeId),
          awayLineScores: lineScores(awayId),
        };
      });
    }
    if (path === '/games/teams') return await this.gameBoxes(params);
    if (path === '/plays') return await this.mappedPlays(params);
    if (path === '/drives') return await this.mappedDrives(params);
    if (path === '/passing/teams/games') {
      const rows = await this.selectedByWeek(await this.dataset('adv_team', season), params);
      const teams = await this.teams(season);
      const teamById = new Map(teams.map((row) => [clean(row.team_id), row]));
      return rows.map((row) => ({
        gameId: clean(row.game_id),
        team: textValue(teamById.get(clean(row.pos_team)) || {}, 'location', 'short_display_name'),
        offense: {
          airYardsAttemptsAvailable: 0,
          totalAirYards: 0,
          totalPpa: number(row.EPA_passing_overall),
          ppaAttemptsAvailable: number(row.EPA_passing_overall) == null ? 0 : number(row.passes) ?? 0,
        },
      }));
    }
    if (path === '/stats/season/advanced') return await this.advanced(params);
    if (path === '/stats/season') return await this.seasonStandard(params);
    throw new Error(`Unsupported SportsDataverse CFB source route: ${path}`);
  }
}
