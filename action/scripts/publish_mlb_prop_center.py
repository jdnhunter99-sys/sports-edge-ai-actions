#!/usr/bin/env python3
"""Build static MLB Prop Center data from MLB StatsAPI and Baseball Savant."""
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from zoneinfo import ZoneInfo

OUTPUT_DIR_VALUE = os.environ.get('MLB_PROP_CENTER_OUTPUT_DIR', '').strip()
if not OUTPUT_DIR_VALUE:
    raise RuntimeError('MLB_PROP_CENTER_OUTPUT_DIR is required')
OUTPUT_DIR = Path(OUTPUT_DIR_VALUE).expanduser()
MLB_BASE = 'https://statsapi.mlb.com/api/v1'
SAVANT_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv'
TEAM_IDS = {
    'ARI': 109, 'ATL': 144, 'BAL': 110, 'BOS': 111, 'CHC': 112, 'CWS': 145,
    'CIN': 113, 'CLE': 114, 'COL': 115, 'DET': 116, 'HOU': 117, 'KC': 118,
    'LAA': 108, 'LAD': 119, 'MIA': 146, 'MIL': 158, 'MIN': 142, 'NYM': 121,
    'NYY': 147, 'OAK': 133, 'PHI': 143, 'PIT': 134, 'SD': 135, 'SEA': 136,
    'SF': 137, 'STL': 138, 'TB': 139, 'TEX': 140, 'TOR': 141, 'WSH': 120,
}
TEAM_ALIASES = {
    'AZ': 'ARI', 'ATH': 'OAK', 'CHW': 'CWS', 'KCR': 'KC', 'SDP': 'SD',
    'SFG': 'SF', 'TBR': 'TB', 'WSN': 'WSH', 'WAS': 'WSH',
}
ID_TO_TEAM = {value: key for key, value in TEAM_IDS.items()}
SEASON_TYPES = {'R': 'Regular Season', 'F': 'Wild Card', 'D': 'Division Series', 'L': 'League Championship', 'W': 'World Series'}
HEADERS = {
    'User-Agent': 'SportsEdgeAI-MLB-Prop-Center-Publisher/1.0',
    'Accept': 'application/json,text/csv,text/plain,application/octet-stream,*/*',
}


def normalize_team(value):
    raw = re.sub(r'[^A-Z0-9]', '', str(value or '').strip().upper())
    return TEAM_ALIASES.get(raw, raw)


def normalize_name(value):
    value = str(value or '').lower()
    value = re.sub(r'[^a-z0-9]+', ' ', value)
    return re.sub(r'\s+', ' ', value).strip()


def lookup_name(value):
    return re.sub(r'\s+(junior|senior|iii|ii|iv|jr|sr|v|2nd|3rd)$', '', normalize_name(value))


def number(value):
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        result = float(str(value).replace(',', '').strip())
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def n0(value):
    return number(value) or 0.0


def rounded(value, digits=3):
    value = number(value)
    return round(value, digits) if value is not None else None


def request_bytes(url, accept=None, timeout=60, attempts=4):
    headers = dict(HEADERS)
    if accept:
        headers['Accept'] = accept
    last_error = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f'GET failed for {url}: {last_error}')


def request_json(url, timeout=60):
    payload = request_bytes(url, 'application/json', timeout=timeout)
    return json.loads(payload.decode('utf-8-sig', errors='replace'))


def api_url(path, params=None):
    query = urllib.parse.urlencode(params or {}, doseq=True, safe='[],')
    return f'{MLB_BASE}/{path.lstrip("/")}{("?" + query) if query else ""}'


def split_date(value):
    raw = str(value or '')
    match = re.match(r'^(\d{4}-\d{2}-\d{2})', raw)
    if match:
        return match.group(1)
    try:
        return dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).date().isoformat()
    except ValueError:
        return raw[:10]


def group_type(group):
    raw = ' '.join(str(group.get(key) or '') for key in ('displayName', 'name', 'abbreviation')).lower()
    if 'pitch' in raw:
        return 'pitchers'
    if 'hitt' in raw or 'bat' in raw:
        return 'batters'
    return ''


def extract_group_splits(person):
    result = {'batters': [], 'pitchers': []}
    for stat_group in person.get('stats') or []:
        kind = group_type(stat_group.get('group') or {})
        if not kind:
            kind = group_type(stat_group.get('type') or {})
        if not kind:
            continue
        result[kind].extend(split for split in (stat_group.get('splits') or []) if isinstance(split, dict) and isinstance(split.get('stat'), dict))
    return result


def fetch_player_group_fallback(player_id, season, kind):
    group = 'hitting' if kind == 'batters' else 'pitching'
    url = api_url(f'people/{player_id}/stats', {
        'stats': 'gameLog', 'group': group, 'season': season, 'gameType': 'R,F,D,L,W',
    })
    try:
        payload = request_json(url)
        groups = payload.get('stats') or []
        return [split for item in groups for split in item.get('splits', []) if isinstance(split, dict) and isinstance(split.get('stat'), dict)]
    except Exception as error:
        print(f'WARN individual MLB {kind} log unavailable for player {player_id}, {season}: {error}', flush=True)
        return []


def fetch_season_people(season):
    payload = request_json(api_url('sports/1/players', {'season': season}), timeout=90)
    people = payload.get('people') or []
    people = [person for person in people if person.get('id') and person.get('fullName')]
    if not people:
        raise RuntimeError(f'MLB StatsAPI returned no MLB players for {season}')
    print(f'{season}: found {len(people)} MLB player records', flush=True)
    return {str(person['id']): person for person in people}


def fetch_season_schedule(season):
    payload = request_json(api_url('schedule', {
        'sportId': 1, 'season': season, 'gameType': 'R,F,D,L,W',
        'hydrate': 'team,probablePitcher',
    }), timeout=120)
    games = [game for date in (payload.get('dates') or []) for game in (date.get('games') or [])]
    result = {}
    for game in games:
        game_id = str(game.get('gamePk') or '')
        if not game_id:
            continue
        teams = game.get('teams') or {}
        home = teams.get('home') or {}
        away = teams.get('away') or {}
        home_team = home.get('team') or {}
        away_team = away.get('team') or {}
        result[game_id] = {
            'gamePk': game_id,
            'gameDate': game.get('gameDate') or '',
            'season': int(season),
            'gameType': game.get('gameType') or 'R',
            'dayNight': game.get('dayNight') or '',
            'status': (game.get('status') or {}).get('abstractGameState') or '',
            'homeTeamId': number(home_team.get('id')),
            'awayTeamId': number(away_team.get('id')),
            'homeAbbr': normalize_team(home_team.get('abbreviation') or home_team.get('name')),
            'awayAbbr': normalize_team(away_team.get('abbreviation') or away_team.get('name')),
            'homeTeam': home_team.get('name') or '',
            'awayTeam': away_team.get('name') or '',
            'homeScore': number(home.get('score')),
            'awayScore': number(away.get('score')),
            'venue': (game.get('venue') or {}).get('name') or '',
            'homePitcher': normalize_probable(home.get('probablePitcher')),
            'awayPitcher': normalize_probable(away.get('probablePitcher')),
        }
    print(f'{season}: loaded {len(result)} schedule rows', flush=True)
    return result


def normalize_probable(pitcher):
    if not isinstance(pitcher, dict) or not pitcher.get('id'):
        return None
    return {
        'id': str(pitcher.get('id')),
        'name': pitcher.get('fullName') or pitcher.get('name') or '',
        'image': f'https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_100/v1/people/{pitcher.get("id")}/headshot/67/current',
    }


def normalize_split(split, player, kind, season, schedule):
    game = split.get('game') or {}
    game_id = str(game.get('gamePk') or split.get('gamePk') or split.get('gameId') or '')
    meta = schedule.get(game_id) or {}
    team_obj = split.get('team') or {}
    opponent_obj = split.get('opponent') or {}
    team_id = number(team_obj.get('id') or split.get('teamId') or player.get('currentTeam', {}).get('id'))
    team = normalize_team(team_obj.get('abbreviation') or team_obj.get('name') or ID_TO_TEAM.get(int(team_id or 0), ''))
    opponent_id = number(opponent_obj.get('id') or (opponent_obj.get('team') or {}).get('id'))
    opponent = normalize_team(opponent_obj.get('abbreviation') or opponent_obj.get('name') or ID_TO_TEAM.get(int(opponent_id or 0), ''))
    is_home = split.get('isHome')
    if not isinstance(is_home, bool):
        if team_id and team_id == meta.get('homeTeamId'):
            is_home = True
        elif team_id and team_id == meta.get('awayTeamId'):
            is_home = False
        else:
            is_home = None
    if not opponent and team:
        if team == meta.get('homeAbbr'):
            opponent = meta.get('awayAbbr')
            opponent_id = meta.get('awayTeamId')
        elif team == meta.get('awayAbbr'):
            opponent = meta.get('homeAbbr')
            opponent_id = meta.get('homeTeamId')
    if not team and is_home is not None:
        team = meta.get('homeAbbr') if is_home else meta.get('awayAbbr')
        team_id = meta.get('homeTeamId') if is_home else meta.get('awayTeamId')
    date_value = split.get('date') or game.get('gameDate') or meta.get('gameDate') or ''
    date = split_date(date_value)
    game_type = meta.get('gameType') or game.get('gameType') or 'R'
    home_score, away_score = meta.get('homeScore'), meta.get('awayScore')
    team_score = home_score if is_home is True else away_score if is_home is False else None
    opponent_score = away_score if is_home is True else home_score if is_home is False else None
    result = 'W' if team_score is not None and opponent_score is not None and team_score > opponent_score else 'L' if team_score is not None and opponent_score is not None and team_score < opponent_score else 'T' if team_score is not None and opponent_score is not None else '—'
    stat = split.get('stat') or {}
    return {
        'id': f'{player.get("id")}-{game_id or date}', 'playerId': str(player.get('id')),
        'playerName': player.get('fullName') or '', 'type': kind,
        'date': date, 'gameDate': date, 'season': int(season),
        'seasonType': SEASON_TYPES.get(game_type, 'Regular Season'), 'seasonTypeCode': 3 if game_type != 'R' else 2,
        'gamePk': game_id or None, 'gameType': game_type,
        'team': team, 'teamId': team_id, 'opponent': opponent, 'opponentId': opponent_id,
        'homeAway': 'Home' if is_home is True else 'Away' if is_home is False else '—',
        'isHome': is_home, 'result': result,
        'throws': (player.get('pitchHand') or {}).get('code') or '',
        'bats': (player.get('batSide') or {}).get('code') or '',
        'position': (player.get('primaryPosition') or {}).get('abbreviation') or '',
        'stat': stat,
        'game': {
            **meta,
            'gamePk': game_id or meta.get('gamePk'), 'gameDate': meta.get('gameDate') or date_value,
            'season': int(season), 'gameType': game_type, 'dayNight': meta.get('dayNight') or '',
            'homeAbbr': meta.get('homeAbbr') or '', 'awayAbbr': meta.get('awayAbbr') or '',
            'homeScore': home_score, 'awayScore': away_score,
            'teamScore': team_score, 'opponentScore': opponent_score, 'isHome': is_home,
        },
    }


def fetch_hydrated_batch(season, ids):
    hydrate = f'stats(group=[hitting,pitching],type=[gameLog],season={season},gameType=[R,F,D,L,W],sportId=1)'
    url = api_url('people', {'personIds': ','.join(ids), 'hydrate': hydrate})
    payload = request_json(url, timeout=120)
    result = {}
    for person in payload.get('people') or []:
        result[str(person.get('id'))] = (person, extract_group_splits(person))
    return result


def fetch_season_logs(season, people, schedule):
    ids = list(people.keys())
    batches = [ids[index:index + 12] for index in range(0, len(ids), 12)]
    rows_by_id = {player_id: {'batters': [], 'pitchers': []} for player_id in ids}
    profile_by_id = dict(people)
    failed_batch_ids = set()
    print(f'{season}: requesting game logs in {len(batches)} batched people hydrations', flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_hydrated_batch, season, batch): batch for batch in batches}
        for future in as_completed(futures):
            batch = futures[future]
            try:
                found = future.result()
                for player_id, (person, groups) in found.items():
                    profile_by_id[player_id] = {**people.get(player_id, {}), **person}
                    rows_by_id.setdefault(player_id, {'batters': [], 'pitchers': []})
                    for kind in ('batters', 'pitchers'):
                        rows_by_id[player_id][kind] = [normalize_split(split, profile_by_id[player_id], kind, season, schedule) for split in groups.get(kind, [])]
            except Exception as error:
                failed_batch_ids.update(batch)
                print(f'WARN {season} MLB log hydration batch failed ({len(batch)} players): {error}', flush=True)

    # Empty batter or pitcher logs are normal for most players. Only retry batches
    # whose combined hydration actually failed, avoiding thousands of needless API calls.
    missing = [(player_id, kind) for player_id in failed_batch_ids for kind in ('batters', 'pitchers')]
    print(f'{season}: falling back to individual logs for {len(missing)} failed-hydration player/group pairs', flush=True)
    with ThreadPoolExecutor(max_workers=10) as pool:
        future_map = {pool.submit(fetch_player_group_fallback, player_id, season, kind): (player_id, kind) for player_id, kind in missing}
        for future in as_completed(future_map):
            player_id, kind = future_map[future]
            try:
                groups = future.result()
                player = profile_by_id.get(player_id, people[player_id])
                rows_by_id[player_id][kind] = [normalize_split(split, player, kind, season, schedule) for split in groups]
            except Exception as error:
                print(f'WARN {season} player {player_id} {kind} fallback failed: {error}', flush=True)
    total = sum(len(groups['batters']) + len(groups['pitchers']) for groups in rows_by_id.values())
    active = sum(1 for groups in rows_by_id.values() if groups['batters'] or groups['pitchers'])
    print(f'{season}: got {total} game-log rows for {active} players', flush=True)
    return profile_by_id, rows_by_id


def normalize_description(value):
    return re.sub(r'[^a-z0-9]+', '_', str(value or '').lower()).strip('_')


def statcast_signals(rows):
    total = swinging = called = swings = in_zone = out_zone = chase = first_pitches = first_strikes = 0
    first_seen = set()
    completed = {}
    for row in rows:
        desc = normalize_description(row.get('description'))
        zone = number(row.get('zone'))
        pitch_no = number(row.get('pitch_number'))
        game = str(row.get('game_pk') or row.get('gamePk') or row.get('game_date') or '')
        ab = str(row.get('at_bat_number') or '')
        pa = f'{game}:{ab}'
        is_swinging = desc in ('swinging_strike', 'swinging_strike_blocked', 'missed_bunt')
        is_called = desc == 'called_strike'
        is_swing = desc in ('swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip', 'foul_bunt', 'missed_bunt', 'hit_into_play', 'hit_into_play_no_out', 'hit_into_play_score')
        inzone = zone is not None and 1 <= zone <= 9
        total += 1
        if is_swinging: swinging += 1
        if is_called: called += 1
        if is_swing: swings += 1
        if inzone: in_zone += 1
        elif zone is not None:
            out_zone += 1
            if is_swing: chase += 1
        if pitch_no == 1 and pa != ':' and pa not in first_seen:
            first_seen.add(pa)
            first_pitches += 1
            if is_called or is_swing: first_strikes += 1
        event = normalize_description(row.get('events'))
        if event and pa != ':':
            completed[pa] = event
    strikeouts = sum(event in ('strikeout', 'strikeout_double_play') for event in completed.values())
    walks = sum(event in ('walk', 'intent_walk', 'intentional_walk') for event in completed.values())
    pa_count = len(completed)
    if not total:
        return None
    return {
        'K%': rounded(strikeouts / pa_count * 100, 2) if pa_count else None,
        'BB%': rounded(walks / pa_count * 100, 2) if pa_count else None,
        'SwStr%': rounded(swinging / total * 100, 2),
        'CSW%': rounded((called + swinging) / total * 100, 2),
        'Whiff%': rounded(swinging / swings * 100, 2) if swings else None,
        'Chase%': rounded(chase / out_zone * 100, 2) if out_zone else None,
        'Zone%': rounded(in_zone / total * 100, 2),
        'F-Strike%': rounded(first_strikes / first_pitches * 100, 2) if first_pitches else None,
    }


def fetch_statcast_players(player_ids, season, kind):
    """Fetch Statcast rows for a small group of players in one request."""
    player_ids = sorted({str(player_id) for player_id in player_ids if str(player_id).isdigit()})
    if not player_ids:
        return season, kind, {}
    today = dt.date.today().isoformat()
    start = f'{season}-01-01'
    end = today if season == dt.date.today().year else f'{season}-12-31'
    lookup_field = 'batters_lookup[]' if kind == 'batters' else 'pitchers_lookup[]'
    params = {
        'all': 'true', 'hfGT': 'R|', 'hfSea': f'{season}|',
        'player_type': 'batter' if kind == 'batters' else 'pitcher',
        'game_date_gt': start, 'game_date_lt': end, 'type': 'details', 'csv': 'true',
        lookup_field: player_ids,
    }
    url = SAVANT_BASE + '?' + urllib.parse.urlencode(params, doseq=True, safe='[],')
    wanted = set(player_ids)
    id_field = 'batter' if kind == 'batters' else 'pitcher'
    try:
        raw = request_bytes(url, 'text/csv,text/plain,*/*', timeout=120, attempts=3).decode('utf-8-sig', errors='replace')
        if not raw or raw.lstrip().startswith('<'):
            return season, kind, {}
        grouped = defaultdict(lambda: defaultdict(list))
        for row in csv.DictReader(io.StringIO(raw)):
            player_id = str(row.get(id_field) or '').strip()
            if player_id not in wanted:
                continue
            game = str(row.get('game_pk') or '').strip()
            date = split_date(row.get('game_date'))
            game_key = game or f'{date}:'
            grouped[player_id][game_key].append(row)
        result = {}
        for player_id, games in grouped.items():
            result[player_id] = {
                game_key: metrics
                for game_key, rows in games.items()
                if (metrics := statcast_signals(rows))
            }
        return season, kind, result
    except Exception as error:
        print(f'WARN Statcast unavailable for {len(player_ids)} {kind} in {season}: {error}', flush=True)
        return season, kind, {}


def parse_innings_outs(value):
    raw = str(value or '').strip()
    if not raw:
        return 0.0
    whole, _, partial = raw.partition('.')
    return max(0, int(whole or 0) * 3 + (int(partial or 0) if partial in ('1', '2') else 0))


def aggregate_player_profile(player, groups, season):
    bat = groups.get('batters') or []
    pit = groups.get('pitchers') or []
    b = defaultdict(float)
    for row in bat:
        stat = row.get('stat') or {}
        for key in ('hits', 'atBats', 'homeRuns', 'doubles', 'triples', 'runs', 'rbi', 'strikeOuts', 'baseOnBalls', 'hitByPitch', 'sacFlies', 'stolenBases', 'plateAppearances'):
            b[key] += n0(stat.get(key))
    pa = b['plateAppearances'] or b['atBats'] + b['baseOnBalls'] + b['hitByPitch'] + b['sacFlies']
    avg = b['hits'] / b['atBats'] if b['atBats'] else None
    total_bases = b['hits'] + b['doubles'] + 2 * b['triples'] + 3 * b['homeRuns']
    slg = total_bases / b['atBats'] if b['atBats'] else None
    obp_denom = b['atBats'] + b['baseOnBalls'] + b['hitByPitch'] + b['sacFlies']
    obp = (b['hits'] + b['baseOnBalls'] + b['hitByPitch']) / obp_denom if obp_denom else None
    hitting = {
        'AVG': rounded(avg), 'OBP': rounded(obp), 'SLG': rounded(slg),
        'OPS': rounded(obp + slg) if obp is not None and slg is not None else None,
        'ISO': rounded(slg - avg) if slg is not None and avg is not None else None,
        'K%': rounded(b['strikeOuts'] / pa * 100, 2) if pa else None,
        'BB%': rounded(b['baseOnBalls'] / pa * 100, 2) if pa else None,
        'hitsPerGame': rounded(b['hits'] / len(bat)) if bat else None,
        'homeRunsPerGame': rounded(b['homeRuns'] / len(bat)) if bat else None,
        'plateAppearances': rounded(pa, 1), 'games': len(bat),
    }
    p = defaultdict(float)
    outs = 0
    for row in pit:
        stat = row.get('stat') or {}
        outs += parse_innings_outs(stat.get('inningsPitched'))
        for key in ('earnedRuns', 'hits', 'homeRuns', 'strikeOuts', 'baseOnBalls', 'battersFaced', 'gamesStarted', 'pitchesThrown', 'numberOfPitches'):
            p[key] += n0(stat.get(key))
    innings = outs / 3
    pitcher = {
        'ERA': rounded(p['earnedRuns'] * 9 / innings) if innings else None,
        'K%': rounded(p['strikeOuts'] / p['battersFaced'] * 100, 2) if p['battersFaced'] else None,
        'BB%': rounded(p['baseOnBalls'] / p['battersFaced'] * 100, 2) if p['battersFaced'] else None,
        'HR/9': rounded(p['homeRuns'] * 9 / innings) if innings else None,
        'inningsPitched': rounded(innings, 1), 'strikeOuts': rounded(p['strikeOuts'], 1),
        'battersFaced': rounded(p['battersFaced'], 1), 'gamesStarted': int(p['gamesStarted']),
        'games': len(pit),
    }
    return {
        'season': int(season), 'stats': pitcher, 'pitcherStats': pitcher,
        **hitting,
        'bats': (player.get('batSide') or {}).get('code') or '',
        'throws': (player.get('pitchHand') or {}).get('code') or '',
    }


def calculate_team_rankings(season, normalized_players):
    by_team_game = defaultdict(lambda: defaultdict(float))
    opponents = {}
    starter_hand = {}
    dates = {}
    metric_keys = ('hits', 'atBats', 'homeRuns', 'doubles', 'triples', 'runs', 'rbi', 'strikeOuts', 'baseOnBalls', 'hitByPitch', 'sacFlies', 'plateAppearances')
    for player in normalized_players.values():
        for split in player.get('pitchers', []):
            stat = split.get('stat') or {}
            if n0(stat.get('gamesStarted')) < 1:
                continue
            game_id = str(split.get('gamePk') or '')
            team = normalize_team(split.get('team'))
            if game_id and team:
                starter_hand[(game_id, team)] = normalize_hand(split.get('throws') or '')
        for split in player.get('batters', []):
            game_id = str(split.get('gamePk') or '')
            team = normalize_team(split.get('team'))
            opponent = normalize_team(split.get('opponent'))
            if not game_id or team not in TEAM_IDS:
                continue
            dates[game_id] = split.get('date') or dates.get(game_id, '')
            if opponent in TEAM_IDS:
                opponents[(game_id, team)] = opponent
            totals = by_team_game[(game_id, team)]
            stat = split.get('stat') or {}
            for metric in metric_keys:
                totals[metric] += n0(stat.get(metric))

    team_games = defaultdict(list)
    for (game_id, team), values in by_team_game.items():
        opponent = opponents.get((game_id, team))
        if opponent not in TEAM_IDS:
            continue
        team_games[team].append({
            'date': dates.get(game_id, ''), 'season': season, 'opponent': opponent,
            'opponentId': TEAM_IDS[opponent],
            'hand': starter_hand.get((game_id, opponent), ''),
            **values,
        })

    result = {}
    today = dt.date.today().isoformat()
    played_dates = []
    for games_for_team in team_games.values():
        for row in games_for_team:
            game_date = str(row.get('date') or '')[:10]
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}', game_date) and game_date.startswith(f'{season}-') and game_date <= today:
                played_dates.append(game_date)
    as_of = max(played_dates) if played_dates else min(today, f'{season}-12-31')
    windows = {'season': None, 'l7': 7, 'l15': 15, 'l30': 30}
    for team in TEAM_IDS:
        output = {}
        games = sorted(team_games.get(team, []), key=lambda row: row.get('date', ''))
        for key, days in windows.items():
            start = f'{season}-01-01' if days is None else (dt.date.fromisoformat(as_of) - dt.timedelta(days=days - 1)).isoformat()
            in_window = [row for row in games if start <= row.get('date', '') <= as_of]
            buckets = {'overall': in_window, 'vs_rhp': [row for row in in_window if row.get('hand') == 'R'], 'vs_lhp': [row for row in in_window if row.get('hand') == 'L']}
            output[key] = {}
            for split_key, rows in buckets.items():
                totals = defaultdict(float)
                for row in rows:
                    for metric in ('hits', 'atBats', 'homeRuns', 'strikeOuts', 'baseOnBalls', 'hitByPitch', 'sacFlies', 'plateAppearances'):
                        totals[metric] += row.get(metric, 0)
                pa = totals['plateAppearances'] or totals['atBats'] + totals['baseOnBalls'] + totals['hitByPitch'] + totals['sacFlies']
                denom = totals['atBats'] + totals['baseOnBalls'] + totals['hitByPitch'] + totals['sacFlies']
                output[key][split_key] = {
                    'kPct': rounded(totals['strikeOuts'] / pa * 100, 2) if pa else None,
                    'bbPct': rounded(totals['baseOnBalls'] / pa * 100, 2) if pa else None,
                    'avg': rounded(totals['hits'] / totals['atBats']) if totals['atBats'] else None,
                    'obp': rounded((totals['hits'] + totals['baseOnBalls'] + totals['hitByPitch']) / denom) if denom else None,
                    'plateAppearances': round(pa), 'games': len(rows),
                }
        result[team] = output
    return result


def fetch_rosters(season):
    def one(team, team_id):
        try:
            payload = request_json(api_url(f'teams/{team_id}/roster', {'rosterType': 'active', 'season': season}), timeout=60)
            roster = []
            for entry in payload.get('roster') or []:
                person = entry.get('person') or {}
                pos = entry.get('position') or {}
                if not person.get('id') or not person.get('fullName'):
                    continue
                roster.append({
                    'id': str(person['id']), 'playerId': str(person['id']), 'name': person['fullName'],
                    'playerName': person['fullName'], 'position': pos.get('abbreviation') or pos.get('code') or '',
                    'isPitcher': (pos.get('abbreviation') or pos.get('code') or '').upper() == 'P',
                    'team': team, 'teamId': team_id,
                })
            return team, roster
        except Exception as error:
            print(f'WARN roster unavailable for {team}: {error}', flush=True)
            return team, []
    result = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        for future in as_completed([pool.submit(one, team, team_id) for team, team_id in TEAM_IDS.items()]):
            team, roster = future.result()
            result[team] = roster
    return result


def fetch_upcoming_schedule(today):
    start = today
    end = (dt.date.fromisoformat(today) + dt.timedelta(days=7)).isoformat()
    payload = request_json(api_url('schedule', {
        'sportId': 1, 'startDate': start, 'endDate': end,
        'hydrate': 'team,probablePitcher', 'gameType': 'R,F,D,L,W',
    }), timeout=90)
    rows = []
    for game in [game for group in payload.get('dates') or [] for game in group.get('games') or []]:
        teams = game.get('teams') or {}
        home = teams.get('home') or {}; away = teams.get('away') or {}
        home_team = home.get('team') or {}; away_team = away.get('team') or {}
        if not home_team.get('id') or not away_team.get('id'):
            continue
        rows.append({
            'gamePk': str(game.get('gamePk') or ''), 'id': str(game.get('gamePk') or ''),
            'gameDate': game.get('gameDate') or '', 'game_date': split_date(game.get('gameDate')),
            'season': number(game.get('season')) or dt.date.fromisoformat(today).year,
            'gameType': game.get('gameType') or 'R', 'dayNight': game.get('dayNight') or '',
            'homeTeamId': number(home_team.get('id')), 'awayTeamId': number(away_team.get('id')),
            'home_team_id': number(home_team.get('id')), 'away_team_id': number(away_team.get('id')),
            'homeAbbr': normalize_team(home_team.get('abbreviation') or home_team.get('name')),
            'awayAbbr': normalize_team(away_team.get('abbreviation') or away_team.get('name')),
            'home_abbr': normalize_team(home_team.get('abbreviation') or home_team.get('name')),
            'away_abbr': normalize_team(away_team.get('abbreviation') or away_team.get('name')),
            'homeTeam': home_team.get('name') or '', 'awayTeam': away_team.get('name') or '',
            'home_team': home_team.get('name') or '', 'away_team': away_team.get('name') or '',
            'homeScore': number(home.get('score')), 'awayScore': number(away.get('score')),
            'venue': (game.get('venue') or {}).get('name') or '',
            'homePitcher': normalize_probable(home.get('probablePitcher')),
            'awayPitcher': normalize_probable(away.get('probablePitcher')),
            'home_probable_pitcher': normalize_probable(home.get('probablePitcher')),
            'away_probable_pitcher': normalize_probable(away.get('probablePitcher')),
        })
    return rows


def normalize_venue_name(value):
    return re.sub(r'\s+', ' ', re.sub(r'\b(stadium|field|park|ballpark)\b', ' ', re.sub(r'[^a-z0-9]+', ' ', str(value or '').lower()))).strip()


def extract_savant_rows(html):
    for pattern in (r'\bdata\s*=\s*(\[[\s\S]*?\])\s*;', r'\b(?:var|let|const)\s+data\s*=\s*(\[[\s\S]*?\])\s*;'):
        match = re.search(pattern, html)
        if not match:
            continue
        try:
            rows = json.loads(match.group(1))
            if isinstance(rows, list):
                return rows
        except json.JSONDecodeError:
            pass
    raise RuntimeError('Could not parse Baseball Savant park-factor data array')


def park_factor_metric(row, aliases, patterns):
    lower = {str(key).lower(): value for key, value in row.items()}
    for alias in aliases:
        value = number(lower.get(alias.lower()))
        if value is not None:
            return value
    for key, value in lower.items():
        if any(re.search(pattern, key, re.I) for pattern in patterns):
            parsed = number(value)
            if parsed is not None:
                return parsed
    return None


def fetch_park_factor_baselines(season):
    source = 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors'
    parsed_by_venue = {}
    warnings = []
    for rolling in (3, 2, 1):
        query = urllib.parse.urlencode({
            'type': 'year', 'year': season, 'batSide': '', 'stat': 'index_wOBA',
            'condition': 'All', 'rolling': rolling, 'parks': 'mlb',
        })
        try:
            html = request_bytes(f'{source}?{query}', 'text/html,*/*', timeout=90).decode('utf-8', errors='replace')
            rows = extract_savant_rows(html)
            parsed = {}
            for row in rows:
                venue = str(row.get('venue_name') or row.get('venue') or row.get('park_name') or row.get('stadium_name') or '').strip()
                if not venue:
                    continue
                factors = {
                    'hr': park_factor_metric(row, ('index_hr', 'index_homerun', 'index_home_run'), (r'index.*\bhr\b', r'index.*home.*run')),
                    'runs': park_factor_metric(row, ('index_run', 'index_runs', 'index_r'), (r'^index_?r$', r'^index_?runs?$')),
                    'single': park_factor_metric(row, ('index_1b', 'index_single', 'index_singles'), (r'index.*1b', r'index.*single')),
                }
                if all(value is not None for value in factors.values()):
                    parsed[normalize_venue_name(venue)] = {'venue': venue, 'factors': factors, 'rollingYears': rolling}
            if len(parsed) >= 20:
                parsed_by_venue = parsed
                print(f'Baseball Savant park factors: loaded {len(parsed)} venues using {rolling}-year baseline', flush=True)
                break
            warnings.append(f'{rolling}y baseline only had {len(parsed)} usable venues')
        except Exception as error:
            warnings.append(f'{rolling}y baseline failed: {error}')
    if len(parsed_by_venue) < 20:
        raise RuntimeError('Baseball Savant park-factor data was incomplete: ' + '; '.join(warnings))
    return parsed_by_venue


def build_park_factor_map(schedule_by_season, baseline_season):
    baselines = fetch_park_factor_baselines(baseline_season)
    output = {}
    unmatched = set()
    for season, schedule in schedule_by_season.items():
        for game in schedule.values():
            home = normalize_team(game.get('homeAbbr'))
            away = normalize_team(game.get('awayAbbr'))
            venue = str(game.get('venue') or '')
            baseline = baselines.get(normalize_venue_name(venue))
            if not baseline:
                unmatched.add(venue or home)
                continue
            factors = baseline['factors']
            record = {
                'source': 'baseball_savant_statcast_park_factors', 'season': int(season),
                'venue': baseline['venue'], 'homeAbbr': home, 'awayAbbr': away,
                'matchup': f'{away} @ {home}',
                'hrPct': rounded(factors['hr'] - 100, 1),
                'runsPct': rounded(factors['runs'] - 100, 1),
                'singlesPct': rounded(factors['single'] - 100, 1),
                'factors': {key: rounded(value, 1) for key, value in factors.items()},
            }
            game_date = str(game.get('gameDate') or '')[:10]
            if game_date:
                output.setdefault(game_date, []).append(record)
            output[record['matchup']] = record
            output[f'{home} @ {away}'] = record
            output[home] = record
    if unmatched:
        print(f'WARN park factors missing venue match for {len(unmatched)} schedule venue names', flush=True)
    if len([key for key in TEAM_IDS if key in output]) < 20:
        raise RuntimeError('Refusing to publish incomplete MLB park factors; fewer than 20 teams matched a Statcast venue')
    return output


def normalize_hand(value):
    raw = str(value or '').strip().upper()
    return 'R' if raw.startswith('R') else 'L' if raw.startswith('L') else ''


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    temporary = path.with_suffix(path.suffix + '.tmp')
    if path.suffix == '.gz':
        temporary.write_bytes(gzip.compress(encoded, compresslevel=6, mtime=0))
    else:
        temporary.write_bytes(encoded)
    temporary.replace(path)


def main():
    today = dt.datetime.now(ZoneInfo('America/Chicago')).date()
    current = today.year
    seasons = list(range(max(2015, current - 5), current + 1))
    generated_at = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    root = OUTPUT_DIR / 'mlb-prop-center' / 'v1'
    print(f'MLB prop-center publisher: seasons={seasons[0]}-{seasons[-1]}, generated={generated_at}', flush=True)
    all_profiles = {}
    player_lookup = {'byId': {}, 'byName': {}}
    all_player_seasons = {}
    all_opponents = defaultdict(list)
    opponent_rankings = {}
    season_summaries = {}
    statcast_player_ids = defaultdict(set)
    schedules_by_season = {}

    for season in seasons:
        print(f'Loading MLB {season} schedule and players', flush=True)
        schedule = fetch_season_schedule(season)
        schedules_by_season[season] = schedule
        people = fetch_season_people(season)
        people, raw_logs = fetch_season_logs(season, people, schedule)
        normalized_players = {}
        player_count = 0
        for player_id, groups in raw_logs.items():
            player = people.get(player_id, {})
            batters = [row for row in groups.get('batters', []) if row.get('gamePk')]
            pitchers = [row for row in groups.get('pitchers', []) if row.get('gamePk')]
            if not batters and not pitchers:
                continue
            profile = {
                'playerId': player_id, 'playerName': player.get('fullName') or '',
                'team': normalize_team((player.get('currentTeam') or {}).get('abbreviation') or (player.get('currentTeam') or {}).get('name')),
                'teamId': number((player.get('currentTeam') or {}).get('id')),
                'position': (player.get('primaryPosition') or {}).get('abbreviation') or '',
                'bats': (player.get('batSide') or {}).get('code') or '',
                'throws': (player.get('pitchHand') or {}).get('code') or '',
                'headshot': f'https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_100/v1/people/{player_id}/headshot/67/current',
            }
            profile_stats = aggregate_player_profile(player, {'batters': batters, 'pitchers': pitchers}, season)
            all_profiles.setdefault(player_id, {**profile, 'seasons': {}})
            current_profile = all_profiles[player_id]
            if profile.get('team'):
                current_profile.update({key: value for key, value in profile.items() if value not in (None, '')})
            current_profile['seasons'][str(season)] = profile_stats
            normalized_players[player_id] = {'batters': batters, 'pitchers': pitchers, 'profile': profile, 'seasonStats': profile_stats}
            all_player_seasons[(player_id, season)] = normalized_players[player_id]
            player_count += 1
            for row in batters + pitchers:
                if row.get('opponent') in TEAM_IDS:
                    all_opponents[row['opponent']].append(row)
            player_lookup['byId'].setdefault(player_id, {})[str(season)] = f'seasons/{season}/players/{player_id}.json.gz'
            name_key = lookup_name(profile['playerName'])
            if name_key:
                player_lookup['byName'].setdefault(name_key, {}).setdefault(str(season), []).append({'team': profile.get('team'), 'id': player_id, 'file': f'seasons/{season}/players/{player_id}.json.gz'})
            if season in (current, current - 1):
                if batters:
                    statcast_player_ids[(season, 'batters')].add(player_id)
                if pitchers:
                    statcast_player_ids[(season, 'pitchers')].add(player_id)
        if player_count < 30 and season != current:
            raise RuntimeError(f'Refusing to publish incomplete MLB season {season}: only {player_count} players had usable logs')
        print(f'{season}: normalized {player_count} players', flush=True)
        opponent_rankings[str(season)] = calculate_team_rankings(season, normalized_players)
        season_summaries[str(season)] = {'playerCount': player_count, 'teamCount': len({p['profile'].get('team') for p in normalized_players.values() if p['profile'].get('team') in TEAM_IDS}), 'gameCount': len(schedule)}

        season_root = root / 'seasons' / str(season) / 'players'
        for player_id, player in normalized_players.items():
            profile = player['profile']
            payload = {
                'success': True, 'schemaVersion': 1, 'season': season,
                'source': 'mlb-statsapi-game-log',
                'playerProfile': profile,
                'gameCount': max(len(player['batters']), len(player['pitchers'])),
                'games': player['batters'] if profile.get('position') != 'P' else player['pitchers'],
                'gamesByType': {'batters': player['batters'], 'pitchers': player['pitchers']},
                'seasonStats': player['seasonStats'], 'statcastByGame': {},
            }
            write_json(season_root / f'{player_id}.json.gz', payload)

    # Batch pitch-by-pitch requests to avoid making one network call per player.
    statcast_jobs = []
    for (season, kind), player_ids in statcast_player_ids.items():
        ordered_ids = sorted(player_ids, key=lambda value: int(value))
        for offset in range(0, len(ordered_ids), 20):
            statcast_jobs.append((season, kind, ordered_ids[offset:offset + 20]))
    print(f'Fetching Statcast splits in {len(statcast_jobs)} batches for {sum(len(ids) for _, _, ids in statcast_jobs)} player/season groups', flush=True)
    statcast_by_player = defaultdict(dict)
    with ThreadPoolExecutor(max_workers=5) as pool:
        future_context = {
            pool.submit(fetch_statcast_players, player_ids, season, kind): (season, kind, player_ids)
            for season, kind, player_ids in statcast_jobs
        }
        for future in as_completed(future_context):
            season, kind, player_ids = future_context[future]
            _, _, metrics_by_player = future.result()
            for player_id, metrics in metrics_by_player.items():
                if metrics:
                    statcast_by_player[(player_id, season)][kind] = metrics
    for (player_id, season), player in all_player_seasons.items():
        if season not in (current, current - 1):
            continue
        key = f'seasons/{season}/players/{player_id}.json.gz'
        path = root / key
        payload = json.loads(gzip.decompress(path.read_bytes()).decode('utf-8'))
        combined = {}
        for kind in ('batters', 'pitchers'):
            combined.update(statcast_by_player.get((player_id, season), {}).get(kind, {}))
        payload['statcastByGame'] = combined
        write_json(path, payload)

    today_str = today.isoformat()
    rosters = fetch_rosters(current)
    upcoming = fetch_upcoming_schedule(today_str)
    park_factors = build_park_factor_map(schedules_by_season, current)
    for opponent in TEAM_IDS:
        games = all_opponents.get(opponent, [])
        games.sort(key=lambda row: (str(row.get('date') or ''), str(row.get('playerName') or '')), reverse=True)
        write_json(root / 'opponents' / f'{opponent}.json.gz', {
            'success': True, 'schemaVersion': 1, 'opponentTeam': opponent,
            'seasons': seasons, 'games': games,
        })

    write_json(root / 'park-factors.json.gz', {
        'success': True, 'schemaVersion': 1, 'generatedAt': generated_at,
        'source': 'baseball_savant_statcast_park_factors', 'parkFactors': park_factors,
    })

    manifest = {
        'success': True, 'schemaVersion': 1, 'generatedAt': generated_at,
        'currentSeason': current, 'previousSeason': current - 1,
        'seasons': seasons, 'source': 'mlb-statsapi-and-baseball-savant',
        'playerLookup': player_lookup, 'playerProfiles': all_profiles,
        'opponentRankingsBySeason': opponent_rankings,
        'scheduleGames': upcoming, 'rosters': rosters,
        'parkFactorsFile': 'park-factors.json.gz',
        'opponents': {team: f'opponents/{team}.json.gz' for team in TEAM_IDS},
        'seasonSummary': season_summaries,
    }
    write_json(root / 'latest.json', manifest)
    if not player_lookup['byId'] or not all_opponents:
        raise RuntimeError('Refusing to publish MLB prop-center data without player and opponent data')
    print(f'Published MLB Prop Center: {len(player_lookup["byId"])} players; {len(upcoming)} upcoming games; {len(TEAM_IDS)} opponent files', flush=True)


if __name__ == '__main__':
    main()
