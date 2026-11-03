#!/usr/bin/env python3
"""Publish pre-normalized NCAAB prop-center data for fast static frontend reads."""
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

OUTPUT_DIR_VALUE = os.environ.get('NCAAB_PROP_CENTER_OUTPUT_DIR', '').strip()
if not OUTPUT_DIR_VALUE:
    raise RuntimeError('NCAAB_PROP_CENTER_OUTPUT_DIR is required')
OUTPUT_DIR = Path(OUTPUT_DIR_VALUE).expanduser()
RELEASE_API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/'
RELEASES = {'player': 'espn_mens_college_basketball_player_boxscores', 'team': 'espn_mens_college_basketball_team_boxscores'}
RELEASE_CACHE = {}
PROFILE_FRAMES = ('all', 'l5', 'l10', 'l15')
TEAM_ABBRS = set()
DIVISION_ONE_TEAM_IDS = set()
HEADERS = {'User-Agent': 'SportsEdgeAI-NCAAB-Prop-Center-Publisher/1.0', 'Accept': 'application/json, text/csv, application/octet-stream, */*'}


def normalize_header(value):
    return re.sub(r'[^a-z0-9]+', '_', str(value or '').strip().lower()).strip('_')


def normalize_name(value):
    value = unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', value)).strip()


def normalize_player_lookup_name(value):
    return re.sub(r'\s+(junior|senior|iii|ii|iv|jr|sr|v|2nd|3rd)$', '', normalize_name(value))


def num(value):
    if value is None or isinstance(value, bool) or value == '':
        return None
    try:
        value = float(re.sub(r'[^0-9.+-]', '', str(value)))
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def rounded(value, digits=2):
    value = num(value)
    return round(value, digits) if value is not None else None


def text(value):
    value = str(value or '').strip()
    return '' if value in ('null', 'undefined') else value


def abbr(value):
    raw = re.sub(r'[^A-Z0-9]', '', str(value or '').strip().upper())
    return raw


def iso_date(value):
    raw = str(value or '').strip()
    if not raw:
        return ''
    match = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', raw)
    if match:
        return f'{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}'
    try:
        return dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).date().isoformat()
    except ValueError:
        return raw


def season_type(row):
    raw = next((row.get(key) for key in ('season_type','season_type_id','seasontype','season_type_name','seasonTypeName','game_type') if row.get(key) not in (None, '')), None)
    numeric = num(raw)
    if numeric is not None and numeric > 0:
        return int(numeric)
    label = re.sub(r'[^a-z]', '', str(raw or '').lower())
    if 'playoff' in label or 'postseason' in label:
        return 3
    if 'preseason' in label:
        return 1
    return 2


def bool_value(value):
    if value in (True, 1, '1') or str(value).lower() == 'true':
        return True
    if value in (False, 0, '0') or str(value).lower() == 'false':
        return False
    return None


def active_player(row):
    return bool_value(row.get('did_not_play')) is not True and (num(row.get('minutes')) or 0) > 0


def pos_bucket(value):
    raw = str(value or '').upper()
    if 'G' in raw: return 'G'
    if 'C' in raw: return 'C'
    if 'F' in raw: return 'F'
    return ''


def average(values):
    values = [num(v) for v in values]
    values = [v for v in values if v is not None]
    return rounded(sum(values) / len(values)) if values else None


def summarize_player_games(games):
    games = [game for game in games if game.get('seasonTypeCode') == 2]
    if not games:
        return {'gamesPlayed': 0}
    count = len(games)
    fields = ('points','rebounds','assists','threePointersMade','threePointersAttempted','fieldGoalsMade',
              'fieldGoalsAttempted','freeThrowsMade','freeThrowsAttempted','offensiveRebounds',
              'defensiveRebounds','steals','blocks','turnovers','minutes','usagePct')
    totals = {field: sum(num(game.get(field)) or 0 for game in games) for field in fields}
    result = {'gamesPlayed': count}
    for field,total in totals.items():
        result['minutesPerGame' if field == 'minutes' else 'usagePct' if field == 'usagePct' else f'{field}PerGame'] = rounded(total / count, 3)
    three_attempts = totals['threePointersAttempted']
    field_attempts = totals['fieldGoalsAttempted']
    free_attempts = totals['freeThrowsAttempted']
    result.update({
        'threePointPct': rounded(100 * totals['threePointersMade'] / three_attempts, 2) if three_attempts else None,
        'fieldGoalPct': rounded(100 * totals['fieldGoalsMade'] / field_attempts, 2) if field_attempts else None,
        'freeThrowPct': rounded(100 * totals['freeThrowsMade'] / free_attempts, 2) if free_attempts else None,
        'pointsReboundsPerGame': rounded((totals['points'] + totals['rebounds']) / count, 3),
        'pointsAssistsPerGame': rounded((totals['points'] + totals['assists']) / count, 3),
        'reboundsAssistsPerGame': rounded((totals['rebounds'] + totals['assists']) / count, 3),
        'praPerGame': rounded((totals['points'] + totals['rebounds'] + totals['assists']) / count, 3),
    })
    return result


def first(row, *keys):
    return next((row.get(k) for k in keys if row.get(k) not in (None, '')), None)


def request_bytes(url, accept=None, timeout=90, attempts=4):
    headers = dict(HEADERS)
    if accept:
        headers['Accept'] = accept
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last = error
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f'GET failed for {url}: {last}')


def fetch_release_rows(kind, season, required=True):
    if kind not in RELEASE_CACHE:
        RELEASE_CACHE[kind] = json.loads(request_bytes(RELEASE_API + urllib.parse.quote(RELEASES[kind], safe=''), 'application/vnd.github+json', timeout=30).decode('utf-8'))
    release = RELEASE_CACHE[kind]
    assets = [asset for asset in release.get('assets', []) if str(asset.get('name', '')).lower().endswith(('.csv', '.csv.gz')) and str(season) in str(asset.get('name', ''))]
    preference = ('player_box', 'player-box', 'player_boxscores') if kind == 'player' else ('team_box', 'team-box', 'team_boxscores')
    assets.sort(key=lambda asset: (any(word in asset.get('name', '').lower() for word in preference), asset.get('name', '').lower().endswith('.csv.gz'), asset.get('name', '')), reverse=True)
    if not assets:
        message=f'No {season} NCAAB {kind}-box CSV asset in SportsDataverse release {RELEASES[kind]}'
        if required: raise RuntimeError(message)
        print(f'WARN {message}; publishing this season as empty until the release is available',flush=True)
        return []
    asset = assets[0]
    payload = request_bytes(asset['browser_download_url'], 'application/octet-stream', timeout=180)
    if asset['name'].lower().endswith('.gz'):
        payload = gzip.decompress(payload)
    reader = csv.DictReader(io.StringIO(payload.decode('utf-8-sig', errors='replace')))
    rows = [{normalize_header(key): parse_cell(value) for key, value in row.items() if key is not None} for row in reader]
    if not rows:
        message=f'SportsDataverse asset {asset["name"]} contained no rows'
        if required: raise RuntimeError(message)
        print(f'WARN {message}; publishing this season as empty until data is available',flush=True)
        return []
    print(f'Loaded {len(rows)} rows from {asset["name"]}', flush=True)
    return rows


def fetch_division_one_team_ids():
    url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams?limit=1000&groups=50'
    payload = json.loads(request_bytes(url, 'application/json', timeout=30).decode('utf-8'))
    teams = payload.get('sports', [{}])[0].get('leagues', [{}])[0].get('teams', [])
    ids = {text(item.get('team', {}).get('id')) for item in teams if text(item.get('team', {}).get('id'))}
    if len(ids) < 300:
        raise RuntimeError(f'ESPN Division I team directory returned only {len(ids)} teams; refusing to mix NCAA divisions')
    print(f'Loaded {len(ids)} ESPN Division I team IDs for the NCAAB filter', flush=True)
    return ids


def parse_cell(value):
    value = str(value or '').strip()
    if value in ('', 'NA', 'NaN', 'null', 'None'):
        return None
    if value in ('TRUE', 'FALSE'):
        return value == 'TRUE'
    try:
        if re.fullmatch(r'-?\d+(\.\d+)?', value):
            return float(value) if '.' in value else int(value)
    except ValueError:
        pass
    return value


def derive_usage(row, team_row):
    minutes = num(row.get('minutes'))
    fga = num(row.get('field_goals_attempted'))
    fta = num(row.get('free_throws_attempted'))
    tov = num(row.get('turnovers'))
    tfga = num(team_row.get('field_goals_attempted')) if team_row else None
    tfta = num(team_row.get('free_throws_attempted')) if team_row else None
    ttov = num(first(team_row or {}, 'turnovers', 'total_turnovers')) if team_row else None
    if None in (minutes, fga, fta, tov, tfga, tfta, ttov) or minutes <= 0:
        return None
    team_used = tfga + .44 * tfta + ttov
    if team_used <= 0:
        return None
    return rounded(100 * (fga + .44 * fta + tov) * 40 / (minutes * team_used), 1)


def normalize_teammate(row):
    return {
        'id': text(row.get('athlete_id')) or None,
        'name': text(row.get('athlete_display_name')),
        'shortName': text(row.get('athlete_short_name')),
        'headshot': text(row.get('athlete_headshot_href')) or (f'https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/{text(row.get("athlete_id"))}.png' if text(row.get('athlete_id')) else ''),
        'position': text(row.get('athlete_position_abbreviation') or row.get('athlete_position_name')),
        'teamAbbreviation': abbr(row.get('team_abbreviation')),
        'minutes': num(row.get('minutes')),
    }


def normalize_game(row, team_row, season):
    game_id = text(row.get('game_id'))
    team_score = num(row.get('team_score') if row.get('team_score') is not None else (team_row or {}).get('team_score'))
    opp_score = num(row.get('opponent_team_score') if row.get('opponent_team_score') is not None else (team_row or {}).get('opponent_team_score'))
    team = abbr(row.get('team_abbreviation') or (team_row or {}).get('team_abbreviation'))
    opponent = abbr(row.get('opponent_team_abbreviation') or (team_row or {}).get('opponent_team_abbreviation'))
    home_away_raw = str(row.get('home_away') or (team_row or {}).get('team_home_away') or '').lower()
    home_away = 'Home' if home_away_raw.startswith('h') else 'Away' if home_away_raw.startswith(('a','r')) else '—'
    points = num(row.get('points'))
    rebounds = num(row.get('rebounds'))
    assists = num(row.get('assists'))
    three_m = num(row.get('three_point_field_goals_made'))
    three_a = num(row.get('three_point_field_goals_attempted'))
    fgm = num(row.get('field_goals_made'))
    fga = num(row.get('field_goals_attempted'))
    ftm = num(row.get('free_throws_made'))
    fta = num(row.get('free_throws_attempted'))
    win = bool_value(row.get('team_winner'))
    if win is None and team_row:
        win = bool_value(team_row.get('team_winner'))
    if win is None and team_score is not None and opp_score is not None:
        win = team_score > opp_score
    code = season_type(row)
    game_date = iso_date(row.get('game_date'))
    minutes = num(row.get('minutes'))
    return {
        'id': game_id or f'{row.get("athlete_id", "player")}-{game_date}', 'gameId': game_id,
        'espnPlayerId': text(row.get('athlete_id')) or None,
        'playerName': text(row.get('athlete_display_name')), 'headshot': text(row.get('athlete_headshot_href')) or (f'https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/{text(row.get("athlete_id"))}.png' if text(row.get('athlete_id')) else ''),
        'position': text(row.get('athlete_position_abbreviation') or row.get('athlete_position_name')),
        'season': season, 'seasonType': 'Playoffs' if code == 3 else 'Pre Season' if code == 1 else 'Regular Season',
        'seasonTypeCode': code, 'gameDate': game_date, 'date': game_date, 'team': team, 'opponent': opponent,
        'homeAway': home_away, 'result': 'W' if win is True else 'L' if win is False else '—',
        'winLoss': 'W' if win is True else 'L' if win is False else None,
        'teamScore': team_score, 'opponentScore': opp_score,
        'score': f'{team_score:g}-{opp_score:g}' if team_score is not None and opp_score is not None else '—',
        'margin': rounded(team_score - opp_score) if team_score is not None and opp_score is not None else None,
        'minutes': minutes, 'points': points, 'rebounds': rebounds, 'assists': assists,
        'threePointersMade': three_m, 'threePointersAttempted': three_a,
        'threePointPct': rounded(100 * three_m / three_a, 1) if three_m is not None and three_a is not None and three_a > 0 else None,
        'fieldGoalsMade': fgm, 'fieldGoalsAttempted': fga,
        'fieldGoalPct': rounded(100 * fgm / fga, 1) if fgm is not None and fga is not None and fga > 0 else None,
        'freeThrowsMade': ftm, 'freeThrowsAttempted': fta,
        'freeThrowPct': rounded(100 * ftm / fta, 1) if ftm is not None and fta is not None and fta > 0 else None,
        'offensiveRebounds': num(row.get('offensive_rebounds')), 'defensiveRebounds': num(row.get('defensive_rebounds')),
        'steals': num(row.get('steals')), 'blocks': num(row.get('blocks')), 'turnovers': num(row.get('turnovers')),
        'personalFouls': num(row.get('fouls')), 'plusMinus': num(row.get('plus_minus')),
        'usagePct': None,
        'potentialAssists': num(row.get('potential_assists')), 'reboundChances': num(row.get('rebound_chances')),
        'passesMade': num(row.get('passes_made')), 'teammates': [], 'teammateIds': [], 'teammateNames': [],
    }


def make_pair_map(team_rows):
    by_game = defaultdict(list)
    for row in team_rows:
        gid = text(row.get('game_id'))
        if gid:
            by_game[gid].append(row)
    pairs = {}
    for gid, rows in by_game.items():
        for row in rows:
            team_id = text(row.get('team_id'))
            opp_id = text(row.get('opponent_team_id'))
            opp_abbr = abbr(row.get('opponent_team_abbreviation'))
            paired = next((candidate for candidate in rows if opp_id and text(candidate.get('team_id')) == opp_id), None)
            if paired is None and opp_abbr:
                paired = next((candidate for candidate in rows if abbr(candidate.get('team_abbreviation')) == opp_abbr), None)
            if paired:
                pairs[(gid, team_id or abbr(row.get('team_abbreviation')))] = paired
    return pairs


def possessions(team, opponent):
    def estimate(row):
        return (num(row.get('field_goals_attempted')) or 0) + .44 * (num(row.get('free_throws_attempted')) or 0) - (num(row.get('offensive_rebounds')) or 0) + (num(first(row, 'turnovers', 'total_turnovers')) or 0)
    return (estimate(team) + estimate(opponent)) / 2


def build_position_game_totals(player_rows):
    totals = defaultdict(lambda: {'points':0,'rebounds':0,'assists':0,'threes':0,'blocks':0,'steals':0})
    for row in player_rows:
        gid = text(row.get('game_id'))
        defense_team = abbr(row.get('opponent_team_abbreviation'))
        position = pos_bucket(row.get('athlete_position_abbreviation') or row.get('athlete_position_name'))
        if not gid or not defense_team or not position:
            continue
        if not active_player(row):
            continue
        target = totals[(defense_team, position, gid)]
        for out_key, in_key in (('points','points'),('rebounds','rebounds'),('assists','assists'),('threes','three_point_field_goals_made'),('blocks','blocks'),('steals','steals')):
            target[out_key] += num(row.get(in_key)) or 0
    return totals


def position_values(position_game_totals, game_ids, defense_team, position):
    per_game = [position_game_totals[(defense_team, position, gid)] for gid in game_ids if (defense_team, position, gid) in position_game_totals]
    if not per_game:
        return {}
    pts=[r['points'] for r in per_game]; reb=[r['rebounds'] for r in per_game]; ast=[r['assists'] for r in per_game]
    threes=[r['threes'] for r in per_game]; blocks=[r['blocks'] for r in per_game]; steals=[r['steals'] for r in per_game]
    return {
        'positionPoints':average(pts),'positionRebounds':average(reb),'positionAssists':average(ast),'positionThrees':average(threes),'positionBlocks':average(blocks),'positionSteals':average(steals),
        'positionPointsRebounds':average([a+b for a,b in zip(pts,reb)]),'positionPointsAssists':average([a+b for a,b in zip(pts,ast)]),
        'positionReboundsAssists':average([a+b for a,b in zip(reb,ast)]),'positionPRA':average([a+b+c for a,b,c in zip(pts,reb,ast)]),
    }


def build_profiles(team_rows, player_rows, position):
    by_team = defaultdict(list)
    for row in team_rows:
        team = abbr(row.get('team_abbreviation'))
        game_date = iso_date(row.get('game_date'))
        if team and game_date:
            by_team[team].append(row)
    pairs = make_pair_map(team_rows)
    position_game_totals = build_position_game_totals(player_rows)
    profiles = {}
    for team, unsorted in by_team.items():
        rows = sorted(unsorted, key=lambda row: iso_date(row.get('game_date')))
        frames = {}
        for frame in PROFILE_FRAMES:
            sample = rows[-int(frame[1:]):] if frame != 'all' else rows
            metrics = defaultdict(list)
            game_ids = set()
            for row in sample:
                gid = text(row.get('game_id'))
                opp = pairs.get((gid, text(row.get('team_id')) or team))
                if not gid or not opp:
                    continue
                game_ids.add(gid)
                poss = possessions(row, opp)
                if poss > 0 and num(opp.get('team_score')) is not None:
                    metrics['defRtg'].append(100 * num(opp.get('team_score')) / poss)
                for key, source in (
                    ('paintPtsAllowed','points_in_paint'),('threePtAttAllowed','three_point_field_goals_attempted'),
                    ('ftAttAllowed','free_throws_attempted'),('astAllowed','assists'),('rebAllowed','total_rebounds'),
                    ('orebAllowed','offensive_rebounds'),('drebAllowed','defensive_rebounds'),('pointsAllowed','team_score'),
                    ('threePtMadeAllowed','three_point_field_goals_made'),('blocksAllowed','blocks'),('stealsAllowed','steals'),
                ):
                    value = num(opp.get(source))
                    if value is not None: metrics[key].append(value)
                turnovers = num(first(row,'turnovers','total_turnovers'))
                if turnovers is not None: metrics['opponentTurnovers'].append(turnovers)
                if poss > 0: metrics['pace'].append(poss)
            values = {key: average(metrics.get(key, [])) for key in ('defRtg','paintPtsAllowed','pace','threePtAttAllowed','ftAttAllowed','astAllowed','rebAllowed','orebAllowed','drebAllowed','pointsAllowed','threePtMadeAllowed','blocksAllowed','stealsAllowed','opponentTurnovers')}
            values.update(position_values(position_game_totals, game_ids, team, position))
            frames[frame] = {'team':team,'games':len(game_ids),'values':values,'ranks':{},'shotZones':{}}
        profiles[team] = frames
    for frame in PROFILE_FRAMES:
        metrics = {key for item in profiles.values() for key in item[frame]['values']}
        for metric in metrics:
            rows = [(team, item[frame]['values'].get(metric)) for team,item in profiles.items()]
            rows = [(team,value) for team,value in rows if value is not None]
            reverse = metric in ('pace','opponentTurnovers')
            rows.sort(key=lambda pair: pair[1], reverse=reverse)
            for index,(team,_) in enumerate(rows): profiles[team][frame]['ranks'][metric]=index+1
    return profiles


def build_team_profiles(team_rows):
    """Materialize team offense/defense splits so game detail reads published JSON."""
    by_game = defaultdict(list)
    by_team = defaultdict(list)
    for row in team_rows:
        game_id = text(row.get('game_id'))
        team = abbr(row.get('team_abbreviation'))
        if game_id:
            by_game[game_id].append(row)
        if team and text(row.get('team_id')) in DIVISION_ONE_TEAM_IDS and iso_date(row.get('game_date')):
            by_team[team].append(row)
    pair_map = make_pair_map(team_rows)
    frames = ('all', 'l3', 'l5', 'l10', 'l15', 'home', 'away')
    profiles = {}

    def field_total(rows, *aliases):
        observed = [num(first(row, *aliases)) for row in rows]
        observed = [value for value in observed if value is not None]
        return sum(observed) if observed else None

    def rate(numerator, denominator):
        if numerator is None or denominator is None or denominator == 0:
            return None
        return rounded(numerator / denominator, 6)

    def estimate_possessions(team, opponent):
        fga = num(first(team, 'field_goals_attempted')) or 0
        fgm = num(first(team, 'field_goals_made')) or 0
        fta = num(first(team, 'free_throws_attempted')) or 0
        oreb = num(first(team, 'offensive_rebounds')) or 0
        tov = num(first(team, 'turnovers', 'total_turnovers', 'team_turnovers')) or 0
        if not opponent:
            return fga + 0.4 * fta - oreb + tov

        opp_fga = num(first(opponent, 'field_goals_attempted')) or 0
        opp_fgm = num(first(opponent, 'field_goals_made')) or 0
        opp_fta = num(first(opponent, 'free_throws_attempted')) or 0
        opp_oreb = num(first(opponent, 'offensive_rebounds')) or 0
        opp_tov = num(first(opponent, 'turnovers', 'total_turnovers', 'team_turnovers')) or 0
        dreb = num(first(team, 'defensive_rebounds')) or 0
        opp_dreb = num(first(opponent, 'defensive_rebounds')) or 0
        team_orb_rate = oreb / (oreb + opp_dreb) if oreb + opp_dreb else 0
        opp_orb_rate = opp_oreb / (opp_oreb + dreb) if opp_oreb + dreb else 0
        team_poss = fga + 0.4 * fta - 1.07 * team_orb_rate * (fga - fgm) + tov
        opp_poss = opp_fga + 0.4 * opp_fta - 1.07 * opp_orb_rate * (opp_fga - opp_fgm) + opp_tov
        return 0.5 * (team_poss + opp_poss)

    for team, unsorted in by_team.items():
        rows = sorted(unsorted, key=lambda row: iso_date(row.get('game_date')))
        team_frames = {}
        for frame in frames:
            if frame == 'home':
                sample = [row for row in rows if str(row.get('team_home_away') or '').lower().startswith('h')]
            elif frame == 'away':
                sample = [row for row in rows if str(row.get('team_home_away') or '').lower().startswith(('a', 'r'))]
            else:
                sample = rows[-int(frame[1:]):] if frame != 'all' else rows
            if not sample:
                team_frames[frame] = {'games': 0, 'values': {}, 'ranks': {}, 'rankTeamCounts': {}}
                continue
            game_pairs = []
            for row in sample:
                game_id = text(row.get('game_id'))
                team_id = text(row.get('team_id')) or team
                game_pairs.append((row, pair_map.get((game_id, team_id))))
            opponent_rows = [opponent for _, opponent in game_pairs if opponent]
            gp = len(sample)

            own_pts = field_total(sample, 'team_score')
            opp_pts = field_total(sample, 'opponent_team_score')
            fgm = field_total(sample, 'field_goals_made')
            fga = field_total(sample, 'field_goals_attempted')
            three_m = field_total(sample, 'three_point_field_goals_made')
            three_a = field_total(sample, 'three_point_field_goals_attempted')
            ftm = field_total(sample, 'free_throws_made')
            fta = field_total(sample, 'free_throws_attempted')
            oreb = field_total(sample, 'offensive_rebounds')
            dreb = field_total(sample, 'defensive_rebounds')
            tov = field_total(sample, 'turnovers', 'total_turnovers', 'team_turnovers')
            ast = field_total(sample, 'assists')
            opp_fgm = field_total(opponent_rows, 'field_goals_made')
            opp_fga = field_total(opponent_rows, 'field_goals_attempted')
            opp_three_m = field_total(opponent_rows, 'three_point_field_goals_made')
            opp_three_a = field_total(opponent_rows, 'three_point_field_goals_attempted')
            opp_ftm = field_total(opponent_rows, 'free_throws_made')
            opp_fta = field_total(opponent_rows, 'free_throws_attempted')
            opp_oreb = field_total(opponent_rows, 'offensive_rebounds')
            opp_dreb = field_total(opponent_rows, 'defensive_rebounds')
            opp_tov = field_total(opponent_rows, 'turnovers', 'total_turnovers', 'team_turnovers')
            poss_values = [estimate_possessions(row, opponent) for row, opponent in game_pairs]
            poss_values = [value for value in poss_values if value and value > 0]
            poss_total = sum(poss_values) if poss_values else None
            opp_gp = len(opponent_rows)

            def per_game(total, games=gp):
                return rounded(total / games, 3) if total is not None and games else None

            def opponent_average(*aliases):
                return per_game(field_total(opponent_rows, *aliases), opp_gp)

            team_results = []
            for row in sample:
                score = num(row.get('team_score'))
                opponent_score = num(row.get('opponent_team_score'))
                if score is not None and opponent_score is not None:
                    team_results.append('W' if score > opponent_score else 'L' if score < opponent_score else 'T')

            values = {
                'pointsPerGame': per_game(own_pts),
                'offensiveRating': rate(own_pts * 100, poss_total) if own_pts is not None else None,
                'pace': per_game(poss_total),
                'fieldGoalsMade': per_game(fgm), 'fieldGoalsAttempted': per_game(fga),
                'fieldGoalPct': rate(fgm, fga), 'twoPointPct': rate((fgm - three_m) if fgm is not None and three_m is not None else None, (fga - three_a) if fga is not None and three_a is not None else None),
                'threePointersMade': per_game(three_m), 'threePointersAttempted': per_game(three_a),
                'threePointPct': rate(three_m, three_a), 'threePointAttemptRate': rate(three_a, fga),
                'freeThrowsMade': per_game(ftm), 'freeThrowsAttempted': per_game(fta),
                'freeThrowPct': rate(ftm, fta), 'freeThrowAttemptRate': rate(fta, fga),
                'effectiveFgPct': rate((fgm + 0.5 * three_m) if fgm is not None and three_m is not None else None, fga),
                'trueShootingPct': rate(own_pts, 2 * (fga + 0.44 * fta)) if own_pts is not None and fga is not None and fta is not None else None,
                'assists': per_game(ast), 'assistToTurnover': rate(ast, tov),
                'turnovers': per_game(tov), 'turnoverPct': rate(tov, poss_total),
                'offensiveRebounds': per_game(oreb),
                'offensiveReboundPct': rate(oreb, oreb + opp_dreb) if oreb is not None and opp_dreb is not None else None,
                'assistPct': rate(ast, fgm),
                'totalReboundPct': rate((oreb + dreb) if oreb is not None and dreb is not None else None, (oreb + dreb + opp_oreb + opp_dreb) if None not in (oreb, dreb, opp_oreb, opp_dreb) else None),
                'pointsInPaint': per_game(field_total(sample, 'points_in_paint')),
                'fastBreakPoints': per_game(field_total(sample, 'fast_break_points')),
                'pointsOffTurnovers': per_game(field_total(sample, 'turnover_points', 'points_off_turnovers')),
                'pointsAllowedPerGame': per_game(opp_pts),
                'defensiveRating': rate(opp_pts * 100, poss_total) if opp_pts is not None else None,
                'opponentFieldGoalPct': rate(opp_fgm, opp_fga),
                'opponentTwoPointPct': rate((opp_fgm - opp_three_m) if opp_fgm is not None and opp_three_m is not None else None, (opp_fga - opp_three_a) if opp_fga is not None and opp_three_a is not None else None),
                'opponentThreePointPct': rate(opp_three_m, opp_three_a),
                'opponentThreePointAttemptRate': rate(opp_three_a, opp_fga),
                'opponentFreeThrowPct': rate(opp_ftm, opp_fta),
                'opponentFreeThrowRate': rate(opp_fta, opp_fga),
                'opponentEffectiveFgPct': rate((opp_fgm + 0.5 * opp_three_m) if opp_fgm is not None and opp_three_m is not None else None, opp_fga),
                'opponentTrueShootingPct': rate(opp_pts, 2 * (opp_fga + 0.44 * opp_fta)) if opp_pts is not None and opp_fga is not None and opp_fta is not None else None,
                'opponentTurnovers': per_game(opp_tov, opp_gp),
                'opponentTurnoverPct': rate(opp_tov, poss_total),
                'defensiveRebounds': per_game(dreb),
                'defensiveReboundPct': rate(dreb, dreb + opp_oreb) if dreb is not None and opp_oreb is not None else None,
                'offensiveReboundsAllowed': per_game(opp_oreb, opp_gp),
                'steals': per_game(field_total(sample, 'steals')),
                'blocks': per_game(field_total(sample, 'blocks')),
                'fouls': per_game(field_total(sample, 'fouls')),
                'pointsInPaintAllowed': opponent_average('points_in_paint'),
                'fastBreakPointsAllowed': opponent_average('fast_break_points'),
                'pointsAllowedOffTurnovers': opponent_average('turnover_points', 'points_off_turnovers'),
                'opponentAssists': per_game(field_total(opponent_rows, 'assists'), opp_gp),
                'opponentTotalRebounds': per_game(field_total(opponent_rows, 'total_rebounds'), opp_gp),
                'opponentDefensiveRebounds': per_game(opp_dreb, opp_gp),
            }
            values.update({
                'wins': team_results.count('W'), 'losses': team_results.count('L'),
                'ties': team_results.count('T'), 'record': f"{team_results.count('W')}-{team_results.count('L')}-{team_results.count('T')}",
                'winPct': rounded(100 * team_results.count('W') / len(team_results), 1) if team_results else None,
            })
            team_frames[frame] = {'games': len(sample), 'values': values, 'ranks': {}, 'rankTeamCounts': {}}
        profiles[team] = team_frames
    lower_metrics = {
        'turnovers', 'turnoverPct', 'pointsAllowedPerGame', 'defensiveRating', 'opponentFieldGoalPct',
        'opponentTwoPointPct', 'opponentThreePointPct', 'opponentThreePointAttemptRate',
        'opponentFreeThrowPct', 'opponentFreeThrowRate', 'opponentEffectiveFgPct',
        'opponentTrueShootingPct', 'offensiveReboundsAllowed', 'fouls', 'pointsInPaintAllowed',
        'fastBreakPointsAllowed', 'pointsAllowedOffTurnovers', 'opponentAssists',
        'opponentTotalRebounds', 'opponentDefensiveRebounds',
    }
    for frame in frames:
        metric_keys = {key for frame_data in profiles.values() for key in frame_data[frame]['values']}
        for metric in metric_keys:
            ordered = [(team, entry[frame]['values'].get(metric)) for team, entry in profiles.items()]
            ordered = [(team, value) for team, value in ordered if value is not None]
            ordered.sort(key=lambda item: item[1], reverse=metric not in lower_metrics)
            for rank, (team, _) in enumerate(ordered, 1):
                profiles[team][frame]['ranks'][metric] = rank
                profiles[team][frame]['rankTeamCounts'][metric] = len(ordered)
    return profiles


def build_team_directory(team_rows):
    teams = {}
    aliases = {}
    for row in team_rows:
        team_abbr = abbr(row.get('team_abbreviation'))
        if not team_abbr:
            continue
        display = text(row.get('team_display_name')) or text(row.get('team_name'))
        location = text(row.get('team_location'))
        entry = teams.setdefault(team_abbr, {
            'abbr': team_abbr,
            'id': text(row.get('team_id')) or None,
            'name': display or location or team_abbr,
            'location': location or None,
            'logo': text(row.get('team_logo')) or None,
            'color': text(row.get('team_color')) or None,
            'alternateColor': text(row.get('team_alternate_color')) or None,
        })
        if not entry.get('id') and text(row.get('team_id')):
            entry['id'] = text(row.get('team_id'))
        if not entry.get('logo') and text(row.get('team_logo')):
            entry['logo'] = text(row.get('team_logo'))
        for alias in (team_abbr, text(row.get('team_id')), display, location, text(row.get('team_name')), text(row.get('team_short_display_name')), text(row.get('team_slug'))):
            key = normalize_name(alias)
            if key:
                aliases[key] = team_abbr
    return teams, aliases


def build_season(season, generated_at, required=True):
    player_rows = fetch_release_rows('player', season, required=required)
    all_team_rows = fetch_release_rows('team', season, required=required)
    player_rows = [row for row in player_rows if text(row.get('team_id')) in DIVISION_ONE_TEAM_IDS]
    team_rows = [row for row in all_team_rows if text(row.get('team_id')) in DIVISION_ONE_TEAM_IDS]
    print(f'Filtered {season} release to {len(player_rows)} Division I player rows and {len(team_rows)} team rows', flush=True)
    team_by_game = {}
    season_teams = {abbr(row.get('team_abbreviation')) for row in team_rows if abbr(row.get('team_abbreviation'))}
    TEAM_ABBRS.update(season_teams)
    for row in team_rows:
        gid=text(row.get('game_id')); tid=text(row.get('team_id')); team=abbr(row.get('team_abbreviation'))
        if gid and tid: team_by_game[(gid,'id:'+tid)]=row
        if gid and team: team_by_game[(gid,'abbr:'+team)]=row
    players_by_game_team=defaultdict(list)
    for row in player_rows:
        players_by_game_team[(text(row.get('game_id')),text(row.get('team_id')))].append(row)
    normalized_by_id=defaultdict(list)
    profile_aggs=defaultdict(lambda:{
        'minutesTotal':0,'minutesGames':0,'usageTotal':0,'usageGames':0,
        'totals':defaultdict(float),'games':0,'playerName':'','position':'','team':'','headshot':'',
    })
    opponent_latest={}
    normalized_regular=[]
    for row in player_rows:
        if not active_player(row):
            continue
        gid=text(row.get('game_id')); tid=text(row.get('team_id')); team=abbr(row.get('team_abbreviation'))
        team_row=team_by_game.get((gid,'id:'+tid)) or team_by_game.get((gid,'abbr:'+team))
        game=normalize_game(row,team_row,season)
        game['usagePct']=derive_usage(row,team_row)
        game['teammates']=[normalize_teammate(candidate) for candidate in players_by_game_team.get((gid,tid),[]) if text(candidate.get('athlete_id')) != text(row.get('athlete_id')) and active_player(candidate)]
        game['teammateIds']=[t['id'] for t in game['teammates'] if t['id']]
        game['teammateNames']=[t['name'] for t in game['teammates'] if t['name']]
        if game['gameDate']:
            normalized_by_id[text(row.get('athlete_id')) or normalize_name(game['playerName'])].append(game)
        if season_type(row) != 2:
            continue
        normalized_regular.append((row,game))
        identity=text(row.get('athlete_id')) or normalize_name(game['playerName'])
        agg=profile_aggs[identity]
        agg['playerName']=game['playerName']; agg['position']=game['position']; agg['team']=game['team']
        agg['headshot']=game.get('headshot') or agg['headshot']
        agg['games'] += 1
        for field in ('points','rebounds','assists','threePointersMade','threePointersAttempted','fieldGoalsMade','fieldGoalsAttempted','freeThrowsMade','freeThrowsAttempted','offensiveRebounds','defensiveRebounds','steals','blocks','turnovers'):
            value = game.get(field)
            if value is not None:
                agg['totals'][field] += value
        if game['minutes'] is not None:
            agg['minutesTotal']+=game['minutes']; agg['minutesGames']+=1
        if game['usagePct'] is not None:
            agg['usageTotal']+=game['usagePct']; agg['usageGames']+=1
        if game['opponent'] and game['gameDate']:
            old=opponent_latest.get(game['opponent'],{}).get(identity)
            if old is None or game['gameDate'] > old['gameDate']:
                compact_game={key:value for key,value in game.items() if key not in ('teammates','teammateIds','teammateNames')}
                opponent_latest.setdefault(game['opponent'],{})[identity]=compact_game
    profiles={}
    for identity,agg in profile_aggs.items():
        regular_games = sorted((game for game in normalized_by_id.get(identity, []) if game.get('seasonTypeCode') == 2), key=lambda game: game.get('gameDate') or '')
        games_played = max(1, int(agg['games']))
        averages = {f'{field}PerGame': rounded(total / games_played, 3) for field,total in agg['totals'].items()}
        three_attempts = agg['totals'].get('threePointersAttempted', 0)
        field_attempts = agg['totals'].get('fieldGoalsAttempted', 0)
        free_attempts = agg['totals'].get('freeThrowsAttempted', 0)
        points_total = agg['totals'].get('points', 0)
        rebounds_total = agg['totals'].get('rebounds', 0)
        assists_total = agg['totals'].get('assists', 0)
        profiles[identity]={
            'espnPlayerId':identity if str(identity).isdigit() else None,
            'playerName':agg['playerName'],'position':agg['position'],'team':agg['team'],'headshot':agg['headshot'] or None,
            'gamesPlayed':agg['games'],
            'minutesPerGame':rounded(agg['minutesTotal']/agg['minutesGames'],6) if agg['minutesGames'] else None,
            'usagePct':rounded(agg['usageTotal']/agg['usageGames'],6) if agg['usageGames'] else None,
            **averages,
            'threePointPct':rounded(100 * agg['totals'].get('threePointersMade', 0) / three_attempts, 2) if three_attempts else None,
            'fieldGoalPct':rounded(100 * agg['totals'].get('fieldGoalsMade', 0) / field_attempts, 2) if field_attempts else None,
            'freeThrowPct':rounded(100 * agg['totals'].get('freeThrowsMade', 0) / free_attempts, 2) if free_attempts else None,
            'pointsReboundsPerGame':rounded((points_total + rebounds_total) / games_played, 3),
            'pointsAssistsPerGame':rounded((points_total + assists_total) / games_played, 3),
            'reboundsAssistsPerGame':rounded((rebounds_total + assists_total) / games_played, 3),
            'praPerGame':rounded((points_total + rebounds_total + assists_total) / games_played, 3),
            'frames': {
                'all': summarize_player_games(regular_games),
                'l5': summarize_player_games(regular_games[-5:]),
                'l10': summarize_player_games(regular_games[-10:]),
                'l15': summarize_player_games(regular_games[-15:]),
            },
        }
    profile_by_position={bucket:build_profiles(team_rows,player_rows,bucket) for bucket in ('G','F','C')}
    player_lookup={'byId':{},'byName':{}}
    root=OUTPUT_DIR/'ncaab-prop-center'/'v1'
    for identity,games in normalized_by_id.items():
        games.sort(key=lambda game:game['gameDate'])
        latest=games[-1]
        espn_id=latest.get('espnPlayerId') or (identity if str(identity).isdigit() else '')
        player_name=latest.get('playerName','')
        bucket=pos_bucket(latest.get('position'))
        teammate_directory=build_teammate_directory(games)
        for game in games:
            game.pop('teammates',None)
        payload={
            'success':True,'schemaVersion':1,'season':season,
            'source':'sportsdataverse-espn-player-box','playerProfile':{
                'playerId':None,'espnPlayerId':espn_id or None,'playerName':player_name,
                'headshot':latest.get('headshot') or None,'position':latest.get('position') or None,
                'positionBucket':bucket,'team':latest.get('team') or None,
            },
            'gameCount':len(games),'games':games,'teammates':teammate_directory,
            'opponentProfiles':{},'pbpContext':None,
        }
        filename=(urllib.parse.quote(identity,safe='') if str(identity).isdigit() else re.sub(r'[^a-z0-9-]+','-',normalize_name(player_name).replace(' ','-')).strip('-')) or 'unknown'
        relative=f'seasons/{season}/players/{filename}.json.gz'
        write_json(root/relative,payload)
        if espn_id:
            player_lookup['byId'].setdefault(str(espn_id),{})[str(season)]=relative
        name_key=normalize_player_lookup_name(player_name)
        if name_key:
            player_lookup['byName'].setdefault(name_key,{}).setdefault(str(season),[]).append({'team':latest.get('team'),'file':relative,'id':espn_id or None})
    if required and not profiles:
        raise RuntimeError(f'No regular-season NCAAB player profiles were built for required season {season}')
    print(f'Built {len(normalized_by_id)} player files and {len(profiles)} regular-season player profiles for {season}',flush=True)
    team_profiles = build_team_profiles([row for row in all_team_rows if season_type(row) == 2])
    team_directory, team_aliases = build_team_directory(team_rows)
    return {'season':season,'profiles':profiles,'teamProfiles':team_profiles,'teamDirectory':team_directory,'teamAliases':team_aliases,'opponentLatest':opponent_latest,'playerLookup':player_lookup,'opponentProfilesByPosition':profile_by_position,'teamCount':len({abbr(r.get("team_abbreviation")) for r in team_rows if abbr(r.get("team_abbreviation")) in TEAM_ABBRS})}


def build_teammate_directory(games):
    teammates={}
    for game in games:
        for teammate in game.get('teammates',[]):
            key=str(teammate.get('id') or normalize_name(teammate.get('name')))
            if not key: continue
            current=teammates.get(key)
            if not current:
                current={**teammate,'gamesTogether':0}; teammates[key]=current
            current['gamesTogether']+=1
            if not current.get('headshot') and teammate.get('headshot'): current['headshot']=teammate['headshot']
    return sorted(teammates.values(),key=lambda row:(-row.get('gamesTogether',0),row.get('name','').lower()))


def build_opponent_dataset(seasons, current, previous):
    player_profiles={}
    for season_data in seasons:
        season=str(season_data['season'])
        for identity,profile in season_data['profiles'].items():
            entry=player_profiles.setdefault(identity,{'espnPlayerId':profile.get('espnPlayerId'),'playerName':profile.get('playerName'),'position':profile.get('position'),'team':profile.get('team'),'seasons':{}})
            entry['seasons'][season]={key:value for key,value in profile.items() if key not in ('espnPlayerId','playerName','position','team','headshot')}
            if season==str(current):
                entry.update({'playerName':profile.get('playerName'),'position':profile.get('position'),'team':profile.get('team')})
    root=OUTPUT_DIR/'ncaab-prop-center'/'v1'
    for opponent in TEAM_ABBRS:
        latest={}
        for season_data in seasons:
            for identity,game in season_data['opponentLatest'].get(opponent,{}).items():
                old=latest.get(identity)
                if old is None or game['gameDate']>old['gameDate']:
                    latest[identity]=game
        games=sorted(latest.values(),key=lambda game:(game.get('gameDate',''),game.get('playerName','')),reverse=True)
        write_json(root/'opponents'/f'{opponent}.json.gz',{
            'success':True,'schemaVersion':1,'opponentTeam':opponent,
            'seasons':[current,previous],'games':games,
        })
    return player_profiles


def write_json(path,payload):
    path.parent.mkdir(parents=True,exist_ok=True)
    encoded=json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
    temporary=path.with_suffix(path.suffix+'.tmp')
    if path.suffix == '.gz':
        temporary.write_bytes(gzip.compress(encoded,compresslevel=6,mtime=0))
    else:
        temporary.write_bytes(encoded)
    temporary.replace(path)


def main():
    today=dt.datetime.now(ZoneInfo('America/Chicago')).date()
    end_year=today.year+1 if today.month>=7 else today.year
    current=end_year; previous=end_year-1
    generated_at=dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')
    root=OUTPUT_DIR/'ncaab-prop-center'/'v1'
    print(f'NCAAB prop-center publisher: seasons={previous},{current}; generated={generated_at}',flush=True)
    global DIVISION_ONE_TEAM_IDS
    DIVISION_ONE_TEAM_IDS = fetch_division_one_team_ids()
    # The current-season file is part of the published contract. Do not report
    # a successful refresh with an empty current season when SportsDataverse
    # has released the season asset.
    seasons=[build_season(previous,generated_at,required=True),build_season(current,generated_at,required=True)]
    current_data=next(item for item in seasons if item['season']==current)
    existing_manifest=root/'latest.json'
    if existing_manifest.exists() and not current_data['profiles']:
        try:
            old=json.loads(existing_manifest.read_text(encoding='utf-8'))
            old_count=int(old.get('seasons',{}).get(str(current),{}).get('playerCount',0))
            if int(old.get('currentSeason',0))==current and old_count>0:
                raise RuntimeError(f'Refusing to replace published {current} NCAAB player profiles with an empty season response')
        except (OSError,ValueError,json.JSONDecodeError):
            pass
    player_profiles=build_opponent_dataset(seasons,current,previous)
    team_directory={}
    team_aliases={}
    for season_data in seasons:
        team_directory.update(season_data.get('teamDirectory') or {})
        team_aliases.update(season_data.get('teamAliases') or {})
    lookup={'byId':{},'byName':{}}
    for season_data in seasons:
        season_data['playerLookup']['byId'] and [lookup['byId'].setdefault(pid,{}).update(paths) for pid,paths in season_data['playerLookup']['byId'].items()]
        for name,by_season in season_data['playerLookup']['byName'].items():
            lookup['byName'].setdefault(name,{}).update(by_season)
    previous_data=next(item for item in seasons if item['season']==previous)
    if not previous_data['profiles'] or not previous_data['playerLookup']['byName']:
        raise RuntimeError(f'Refusing to publish incomplete previous NCAAB prop-center season {previous}')
    latest={
        'success':True,'schemaVersion':1,'generatedAt':generated_at,'currentSeason':current,'previousSeason':previous,
        'source':'sportsdataverse-espn-ncaab-player-and-team-boxscores','playerLookup':lookup,
        'opponentProfilesBySeason':{str(item['season']):item['opponentProfilesByPosition'] for item in seasons},
        'teamProfilesBySeason':{str(item['season']):item['teamProfiles'] for item in seasons},
        'playerProfiles':player_profiles,
        'teamDirectory':team_directory,'teamAliases':team_aliases,
        'seasons':{str(item['season']):{'playerCount':len(item['profiles']),'teamCount':item['teamCount']} for item in seasons},
        'opponentsPath':'opponents',
    }
    write_json(root/'latest.json',latest)
    print(f'Published NCAAB prop-center data: {len(lookup["byId"])} ids, {len(lookup["byName"])} names, {len(TEAM_ABBRS)} opponent files',flush=True)


if __name__=='__main__':
    main()
