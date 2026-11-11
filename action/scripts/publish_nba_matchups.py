#!/usr/bin/env python3
"""Build daily NBA matchup recommendations from published PropLine and NBA data."""
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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from zoneinfo import ZoneInfo

OUTPUT_ROOT = Path(os.environ.get('NBA_MATCHUPS_OUTPUT_DIR', '.')).expanduser()
REPOSITORY = os.environ.get('NBA_MATCHUPS_REPOSITORY', 'jdnhunter99-sys/sports-edge-ai-actions')
DATA_RAW = f'https://raw.githubusercontent.com/{REPOSITORY}/propline-data'
NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
NBA_SHOTS_RELEASE = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/espn_nba_shots'
NBA_SCHEDULE_ROOT = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules'
NBA_INJURY_URL = f'https://raw.githubusercontent.com/{REPOSITORY}/nba-injury-report-data/nba-injuries/v1/latest.json'
HEADERS = {'User-Agent': 'SportsEdgeAI-NBA-Matchups-Publisher/1.0', 'Accept': 'application/json,text/csv,application/octet-stream,*/*'}
ZONE_NAMES = {
    'restricted_area': 'At the rim', 'paint_non_restricted': 'Paint', 'mid_range': 'Mid-range',
    'above_break_3': 'Above-the-break 3', 'left_corner_3': 'Corner 3', 'right_corner_3': 'Corner 3',
}
NBA_TEAMS = {'ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'}
TEAM_ALIASES = {
    'BRK':'BKN','GS':'GSW','GOS':'GSW','NO':'NOP','NOLA':'NOP','NOR':'NOP','NOH':'NOP','NOK':'NOP','NY':'NYK','PHO':'PHX','SA':'SAS','UTAH':'UTA','WSH':'WAS','CHO':'CHA',
    'ATLANTAHAWKS':'ATL','BOSTONCELTICS':'BOS','BROOKLYNNETS':'BKN','CHARLOTTEHORNETS':'CHA','CHICAGOBULLS':'CHI','CLEVELANDCAVALIERS':'CLE','DALLASMAVERICKS':'DAL','DENVERNUGGETS':'DEN','DETROITPISTONS':'DET','GOLDENSTATEWARRIORS':'GSW','HOUSTONROCKETS':'HOU','INDIANAPACERS':'IND','LACLIPPERS':'LAC','LOSANGELESCLIPPERS':'LAC','LOSANGELESLAKERS':'LAL','MEMPHISGRIZZLIES':'MEM','MIAMIHEAT':'MIA','MILWAUKEEBUCKS':'MIL','MINNESOTATIMBERWOLVES':'MIN','NEWORLEANSPELICANS':'NOP','NEWYORKKNICKS':'NYK','OKLAHOMACITYTHUNDER':'OKC','ORLANDOMAGIC':'ORL','PHILADELPHIA76ERS':'PHI','PHOENIXSUNS':'PHX','PORTLANDTRAILBLAZERS':'POR','SACRAMENTOKINGS':'SAC','SANANTONIOSPURS':'SAS','TORONTORAPTORS':'TOR','UTAHJAZZ':'UTA','WASHINGTONWIZARDS':'WAS'
}
MARKETS = [
    {'key':'points','label':'Points','short':'PTS','stat':'PTS/G','defenseKey':'positionPoints','allowedLabel':'points','zoneWeight':0.35},
    {'key':'rebounds','label':'Rebounds','short':'REB','stat':'REB/G','defenseKey':'positionRebounds','allowedLabel':'rebounds'},
    {'key':'assists','label':'Assists','short':'AST','stat':'AST/G','defenseKey':'positionAssists','allowedLabel':'assists'},
    {'key':'three_pointers_made','label':'3PT','short':'3P','stat':'3PM/G','defenseKey':'positionThrees','allowedLabel':'threes','zoneWeight':0.35},
    {'key':'points_rebounds','label':'Pts + Reb','short':'P+R','stat':'P+R/G','defenseKey':'positionPointsRebounds','allowedLabel':'P+R','zoneWeight':0.2},
    {'key':'points_assists','label':'Pts + Ast','short':'P+A','stat':'P+A/G','defenseKey':'positionPointsAssists','allowedLabel':'P+A','zoneWeight':0.2},
    {'key':'pra','label':'PRA','short':'PRA','stat':'PRA/G','defenseKey':'positionPRA','allowedLabel':'PRA','zoneWeight':0.2},
    {'key':'rebounds_assists','label':'Reb + Ast','short':'R+A','stat':'R+A/G','defenseKey':'positionReboundsAssists','allowedLabel':'R+A'},
    {'key':'blocks','label':'Blocks','short':'BLK','stat':'BLK/G','defenseKey':'positionBlocks','allowedLabel':'blocks'},
    {'key':'steals','label':'Steals','short':'STL','stat':'STL/G','defenseKey':'positionSteals','allowedLabel':'steals'},
]


def request_bytes(url, accept=None, timeout=45, attempts=3):
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
                time.sleep(min(2 ** attempt, 5))
    raise RuntimeError(f'GET failed for {url}: {last_error}')


def request_json(url, accept='application/json', timeout=45):
    return json.loads(request_bytes(url, accept, timeout).decode('utf-8-sig'))


def norm_name(value):
    raw = unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode().lower()
    raw = re.sub(r'[^a-z0-9]+', ' ', raw)
    raw = re.sub(r'\s+', ' ', raw).strip()
    return re.sub(r'\s+(junior|senior|iii|ii|iv|jr|sr|v|2nd|3rd)$', '', raw)


def normalize_team(value):
    raw = re.sub(r'[^A-Z0-9]', '', str(value or '').upper())
    return TEAM_ALIASES.get(raw, raw)


def number(value):
    if value is None or isinstance(value, bool) or value == '':
        return None
    try:
        result = float(str(value).replace(',', '').replace('%', ''))
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def average(values):
    values = [number(value) for value in values]
    values = [value for value in values if value is not None]
    return sum(values) / len(values) if values else None


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def central_today():
    return dt.datetime.now(ZoneInfo('America/Chicago')).date()


def central_date_from_iso(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(ZoneInfo('America/Chicago')).date()
    except (TypeError, ValueError):
        return None


def competitor(raw):
    team = raw.get('team') or {}
    abbr = normalize_team(team.get('abbreviation') or team.get('abbr'))
    return {
        'id': str(team.get('id') or ''), 'abbr': abbr, 'abbreviation': abbr, 'teamTricode': abbr,
        'name': team.get('displayName') or team.get('name') or abbr,
        'teamName': team.get('displayName') or team.get('name') or abbr,
        'displayName': team.get('displayName') or team.get('name') or abbr,
        'logo': team.get('logo') or ((team.get('logos') or [{}])[0].get('href') or ''),
        'color': team.get('color') or '', 'secondary': team.get('alternateColor') or '',
        'score': number(raw.get('score')),
    }


def fetch_today_games(today):
    query = urllib.parse.urlencode({'dates':today.strftime('%Y%m%d'),'limit':'100','region':'us','lang':'en'})
    payload = request_json(f'{NBA_SCOREBOARD}?{query}')
    output = []
    for event in payload.get('events') or []:
        competition = (event.get('competitions') or [{}])[0]
        competitors = competition.get('competitors') or []
        away_raw = next((item for item in competitors if item.get('homeAway') == 'away'), {})
        home_raw = next((item for item in competitors if item.get('homeAway') == 'home'), {})
        away, home = competitor(away_raw), competitor(home_raw)
        if away['abbr'] not in NBA_TEAMS or home['abbr'] not in NBA_TEAMS:
            continue
        status = competition.get('status') or event.get('status') or {}
        state = ((status.get('type') or {}).get('state') or '').lower()
        description = ((status.get('type') or {}).get('shortDetail') or (status.get('type') or {}).get('detail') or '')
        if state == 'post' or 'final' in description.lower() or 'postpon' in description.lower() or 'cancel' in description.lower():
            continue
        output.append({
            'id': str(event.get('id') or competition.get('id') or ''),
            'date': event.get('date') or competition.get('date'), 'scheduleDate': today.isoformat(),
            'gameDate': event.get('date') or competition.get('date'),
            'venue': (competition.get('venue') or {}).get('fullName') or '',
            'city': ((competition.get('venue') or {}).get('address') or {}).get('city') or '',
            'status': {'state':state or 'pre','description':description or 'Upcoming','completed':False},
            'away':away, 'home':home,
        })
    return output


def load_propline_player_list():
    url = f'{DATA_RAW}/Player%20Lists/nba/prop-center.json'
    payload = request_json(url)
    if payload.get('ok') is False or not isinstance(payload.get('games'), list):
        raise RuntimeError('Published PropLine NBA player list is unavailable or malformed.')
    return payload


def game_pair(game):
    return normalize_team(game.get('awayTeam') or game.get('away') or game.get('awayTeamAbbr')), normalize_team(game.get('homeTeam') or game.get('home') or game.get('homeTeamAbbr'))


def get_today_prop_games(payload, today, games):
    game_by_pair = {(game['away']['abbr'], game['home']['abbr']): game for game in games}
    output = []
    for item in payload.get('games') or []:
        commence = central_date_from_iso(item.get('commenceTime'))
        if commence and commence != today:
            continue
        away, home = game_pair(item)
        game = game_by_pair.get((away, home))
        if not game:
            continue
        players = []
        seen = set()
        for raw in item.get('players') or []:
            name = str(raw.get('name') or raw.get('player') or '').strip()
            team = normalize_team(raw.get('team'))
            if not name or team not in (away, home):
                continue
            key = f'{team}|{norm_name(name)}'
            if key in seen:
                continue
            seen.add(key)
            players.append({**raw, 'name':name, 'team':team, 'opponent':home if team == away else away})
        if players:
            output.append({'game':game,'players':players})
    return output


def load_manifest():
    url = f'{DATA_RAW}/nba-prop-center/v1/latest.json'
    manifest = request_json(url)
    if manifest.get('success') is False or not manifest.get('playerLookup'):
        raise RuntimeError('Published NBA PropLine player profiles are unavailable.')
    return manifest


def find_player_file(manifest, player, season):
    lookup = manifest.get('playerLookup') or {}
    name_seasons = lookup.get('byName', {}).get(norm_name(player.get('name'))) or {}
    candidates = name_seasons.get(str(season), [])
    if isinstance(candidates, dict):
        candidates = [candidates]
    team = normalize_team(player.get('team'))
    match = next((entry for entry in candidates if not entry.get('team') or normalize_team(entry.get('team')) == team), None)
    if match and match.get('file'):
        return match
    raw_id = str(player.get('playerId') or '').strip()
    if raw_id.startswith('nba:'):
        raw_id = raw_id.split(':',1)[1]
    id_seasons = lookup.get('byId', {}).get(raw_id) or {}
    by_id = id_seasons.get(str(season)) if isinstance(id_seasons, dict) else None
    return {'file':by_id,'id':raw_id} if by_id else None


def fetch_player_season(player, manifest, season):
    entry = find_player_file(manifest, player, season)
    if not entry:
        return player, None
    path = str(entry.get('file') or '').lstrip('/')
    url = f'{DATA_RAW}/nba-prop-center/v1/{urllib.parse.quote(path, safe="/-._")}'
    try:
        raw = request_bytes(url, 'application/json,application/octet-stream', timeout=45)
        if path.endswith('.gz'):
            raw = gzip.decompress(raw)
        payload = json.loads(raw.decode('utf-8-sig'))
        return player, payload
    except Exception as error:
        print(f'WARN could not load NBA profile for {player.get("name")}: {error}', flush=True)
        return player, None


def current_season_games(payload, season, today):
    rows = []
    for game in payload.get('games') or []:
        if number(game.get('season')) not in (None, float(season)):
            continue
        if number(game.get('seasonTypeCode')) not in (None, 2.0):
            continue
        date = str(game.get('gameDate') or game.get('date') or '')[:10]
        if date and date > today.isoformat():
            continue
        minutes = number(game.get('minutes'))
        if minutes is None or minutes <= 0:
            continue
        rows.append(game)
    return rows


def stats_for_player(player, payload, season, today):
    if not payload:
        return None
    profile = payload.get('playerProfile') or {}
    games = current_season_games(payload, season, today)
    if not games:
        return None
    averages = {
        'PTS/G':average([row.get('points') for row in games]),
        'REB/G':average([row.get('rebounds') for row in games]),
        'AST/G':average([row.get('assists') for row in games]),
        '3PM/G':average([row.get('threePointersMade') for row in games]),
        'BLK/G':average([row.get('blocks') for row in games]),
        'STL/G':average([row.get('steals') for row in games]),
        'MIN':average([row.get('minutes') for row in games]),
        'USG%':average([row.get('usagePct') for row in games]),
        'G':len(games),
    }
    for key, compose in {
        'P+R/G':lambda row:(number(row.get('points')) or 0)+(number(row.get('rebounds')) or 0),
        'P+A/G':lambda row:(number(row.get('points')) or 0)+(number(row.get('assists')) or 0),
        'PRA/G':lambda row:(number(row.get('points')) or 0)+(number(row.get('rebounds')) or 0)+(number(row.get('assists')) or 0),
        'R+A/G':lambda row:(number(row.get('rebounds')) or 0)+(number(row.get('assists')) or 0),
    }.items():
        averages[key] = average([compose(row) for row in games])
    return {
        'Player':profile.get('playerName') or player.get('name'), 'name':profile.get('playerName') or player.get('name'),
        'Team':normalize_team(profile.get('team') or player.get('team')), 'team':normalize_team(profile.get('team') or player.get('team')),
        'Pos':profile.get('position') or player.get('position') or '', 'position':profile.get('position') or player.get('position') or '',
        'playerId':player.get('playerId') or entry_player_id(player), 'espnPlayerId':str(profile.get('espnPlayerId') or ''),
        'headshot':profile.get('headshot') or '', 'G':averages['G'],
        **averages,
        '_markets':player.get('markets') or [],
        '_zoneKey':f"{normalize_team(profile.get('team') or player.get('team'))}|{norm_name(profile.get('playerName') or player.get('name'))}",
    }


def entry_player_id(player):
    value = str(player.get('playerId') or '')
    return value.split(':', 1)[-1] if value.startswith('nba:') else value


def load_or_build_zones(season, now):
    folder = OUTPUT_ROOT / 'nba-matchups' / 'v1'
    path = folder / f'shot-zones-{season}.json'
    stale_cache = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
            generated = dt.datetime.fromisoformat(cached.get('generatedAt','').replace('Z','+00:00'))
            if cached.get('season') == season and (now - generated).total_seconds() < 20 * 3600:
                print(f'Reusing cached shot-zone analysis from {cached.get("generatedAt")}', flush=True)
                return cached
            stale_cache = cached
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    try:
        zones = build_shot_zone_analysis(season, now)
    except Exception as current_error:
        print(f'WARN current-season shot-zone analysis unavailable for {season}: {current_error}', flush=True)
        zones = None
        previous_season = season - 1
        previous_path = folder / f'shot-zones-{previous_season}.json'
        try:
            if previous_path.exists():
                zones = json.loads(previous_path.read_text())
                print(f'Using cached NBA shot-zone analysis from {previous_season} as a fallback.', flush=True)
            else:
                zones = build_shot_zone_analysis(previous_season, now)
                print(f'Using NBA shot-zone analysis from {previous_season} as a fallback.', flush=True)
        except Exception as previous_error:
            print(f'WARN previous-season shot-zone fallback unavailable for {previous_season}: {previous_error}', flush=True)
            zones = stale_cache

        if zones:
            source_season = int(zones.get('dataSeason') or zones.get('season') or previous_season)
            zones = {**zones, 'season':season, 'dataSeason':source_season,
                     'source':f"{zones.get('source') or 'SportsDataverse ESPN NBA shots'} (season {source_season} fallback)"}
        else:
            # Shot zones are one recommendation signal; an upstream release delay
            # must not prevent publishing the slate and defense-vs-position analysis.
            zones = {
                'season':season, 'dataSeason':None,
                'generatedAt':now.isoformat().replace('+00:00','Z'),
                'source':'unavailable', 'gameCount':0, 'shotCount':0,
                'rankTeamCount':0, 'players':{}, 'teamDefense':{},
            }
    folder.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(zones, separators=(',',':')))
    tmp.replace(path)
    return zones


def csv_rows_from_url(url, compressed=False):
    request = urllib.request.Request(url, headers={**HEADERS, 'Accept':'application/octet-stream'})
    response = urllib.request.urlopen(request, timeout=300)
    binary = gzip.GzipFile(fileobj=response) if compressed else response
    text = io.TextIOWrapper(binary, encoding='utf-8-sig', errors='replace', newline='')
    return response, csv.DictReader(text)


def build_shot_zone_analysis(season, now):
    schedule_url = f'{NBA_SCHEDULE_ROOT}/nba_schedule_{season}.csv'
    schedule_bytes = request_bytes(schedule_url, 'text/csv,application/octet-stream', timeout=90)
    schedule = csv.DictReader(io.StringIO(schedule_bytes.decode('utf-8-sig', errors='replace')))
    games = {}
    for row in schedule:
        if number(row.get('season_type')) != 2:
            continue
        game_id = str(row.get('game_id') or '').strip()
        away, home = normalize_team(row.get('away_abbreviation')), normalize_team(row.get('home_abbreviation'))
        if game_id and away in NBA_TEAMS and home in NBA_TEAMS:
            games[game_id] = (away, home)
    if not games:
        raise RuntimeError(f'SportsDataverse schedule contained no regular-season games for {season}.')

    release = request_json(NBA_SHOTS_RELEASE, 'application/vnd.github+json')
    # SportsDataverse publishes the canonical file as shots_<season>.csv.
    # The previous pattern required an extra extension segment and missed it.
    assets = [asset for asset in release.get('assets', []) if re.match(rf'^shots_{season}\.csv(?:\.gz)?$', str(asset.get('name') or ''), re.I)]
    assets.sort(key=lambda item: str(item.get('name','')).lower().endswith('.csv.gz'), reverse=True)
    if not assets:
        raise RuntimeError(f'No NBA shot-chart CSV for season {season} was found in the SportsDataverse release.')
    asset = assets[0]
    response, reader = csv_rows_from_url(asset['browser_download_url'], str(asset['name']).lower().endswith('.gz'))
    player_totals = defaultdict(lambda: defaultdict(lambda: {'attempts':0,'makes':0,'points':0}))
    defense_totals = defaultdict(lambda: {'games':set(),'zones':defaultdict(lambda:{'attempts':0,'makes':0,'points':0})})
    game_seen = set()
    rows_read = shots_read = 0
    try:
        fields = {str(name or '').replace('\ufeff','').strip().lower() for name in (reader.fieldnames or [])}
        required = {'game_id','season','team_abbrev','athlete_name_1','score_value','scoring_play','type_text','coordinate_x_raw','coordinate_y_raw'}
        if not required.issubset(fields):
            raise RuntimeError(f'NBA shots CSV is missing columns: {sorted(required-fields)}')
        for row in reader:
            rows_read += 1
            game_id = str(row.get('game_id') or '').strip()
            matchup = games.get(game_id)
            if not matchup or number(row.get('season')) not in (None, float(season)):
                continue
            try:
                points = int(float(row.get('score_value') or ''))
                x, y = float(row.get('coordinate_x_raw') or ''), float(row.get('coordinate_y_raw') or '')
            except (TypeError, ValueError):
                continue
            type_text = str(row.get('type_text') or '')
            if points not in (0,2,3) or re.search(r'free\s*throw|no shot', type_text, re.I):
                continue
            team = normalize_team(row.get('team_abbrev'))
            if team not in matchup:
                continue
            name = str(row.get('athlete_name_1') or '').strip()
            if not name or not (0 <= x <= 50 and -5 <= y <= 40):
                continue
            if game_id not in game_seen:
                game_seen.add(game_id)
                for defending in matchup:
                    defense_totals[defending]['games'].add(game_id)
            dx, dy = x - 25, y - 1
            shot_value = points if points in (2,3) else (3 if math.hypot(dx,dy) >= 22 else 2)
            if shot_value == 3:
                zone = ('left_corner_3' if dx < 0 else 'right_corner_3') if abs(dx) >= 22 and dy <= 9.2 else 'above_break_3'
            elif math.hypot(dx,dy) <= 4:
                zone = 'restricted_area'
            elif abs(dx) <= 8 and dy <= 9.75:
                zone = 'paint_non_restricted'
            else:
                zone = 'mid_range'
            made = str(row.get('scoring_play') or '').strip().lower() in ('true','1','yes')
            player_key = f'{team}|{norm_name(name)}'
            ptotal = player_totals[player_key][zone]
            ptotal['attempts'] += 1
            if made:
                ptotal['makes'] += 1
                ptotal['points'] += points
            defending = matchup[1] if team == matchup[0] else matchup[0]
            dtotal = defense_totals[defending]['zones'][zone]
            dtotal['attempts'] += 1
            if made:
                dtotal['makes'] += 1
                dtotal['points'] += points
            shots_read += 1
    finally:
        response.close()

    team_profiles = {}
    for team, totals in defense_totals.items():
        games_count = len(totals['games'])
        if games_count < 1:
            continue
        team_profiles[team] = {'games':games_count,'zones':{}}
        for zone in ZONE_NAMES:
            z = totals['zones'][zone]
            team_profiles[team]['zones'][zone] = {
                'points_allowed_per_game':z['points']/games_count,
                'attempts_allowed_per_game':z['attempts']/games_count,
                'fg_pct_allowed':z['makes']/z['attempts']*100 if z['attempts'] else None,
                'points_allowed':z['points'],
            }
    rank_team_count = len(team_profiles)
    for zone in ZONE_NAMES:
        ordered = sorted((team for team in team_profiles if team_profiles[team]['zones'][zone]['points_allowed_per_game'] is not None), key=lambda team:(team_profiles[team]['zones'][zone]['points_allowed_per_game'],team))
        previous_value = None
        previous_rank = 0
        for index, team in enumerate(ordered, start=1):
            current_value = team_profiles[team]['zones'][zone]['points_allowed_per_game']
            rank = previous_rank if previous_value is not None and abs(current_value - previous_value) < 1e-9 else index
            team_profiles[team]['zones'][zone]['rank_team_count'] = len(ordered)
            team_profiles[team]['zones'][zone]['rank'] = rank
            previous_value = current_value
            previous_rank = rank
    player_profiles = {}
    for key, totals in player_totals.items():
        attempts = sum(value['attempts'] for value in totals.values())
        if not attempts:
            continue
        player_profiles[key] = {'zones':{}}
        for zone in ZONE_NAMES:
            value = totals[zone]
            player_profiles[key]['zones'][zone] = {
                'attempts':value['attempts'], 'attempt_share_pct':value['attempts']/attempts*100,
                'points_share_pct':value['points']/max(1,sum(item['points'] for item in totals.values()))*100,
                'fg_pct':value['makes']/value['attempts']*100 if value['attempts'] else None,
            }
    if shots_read == 0:
        raise RuntimeError(f'SportsDataverse NBA shot CSV contained no usable regular-season attempts for {season}.')
    print(f'NBA shot-zone cache: {shots_read} attempts from {len(game_seen)} games, {len(player_profiles)} players, {rank_team_count} defenses', flush=True)
    return {
        'season':season,'generatedAt':now.isoformat().replace('+00:00','Z'),'source':'SportsDataverse ESPN NBA shots','sourceUpdatedAt':release.get('published_at') or release.get('updated_at'),
        'gameCount':len(game_seen),'shotCount':shots_read,'rankTeamCount':rank_team_count,'players':player_profiles,'teamDefense':team_profiles,
    }


def load_injuries(today):
    try:
        payload = request_json(NBA_INJURY_URL, timeout=20)
        players = payload.get('players') or []
        rows = [row for row in players if str(row.get('game_date') or '')[:10] == today.isoformat()]
        by_team = defaultdict(list)
        for row in rows:
            by_team[normalize_team(row.get('team_abbreviation'))].append(row)
        return by_team, (payload.get('report') or {}).get('report_time_et')
    except Exception as error:
        print(f'WARN latest NBA injury report unavailable: {error}', flush=True)
        return defaultdict(list), None


def status_key(value):
    status = str(value or '').lower()
    if 'out' in status: return 'out'
    if 'doubt' in status: return 'doubtful'
    if 'question' in status: return 'questionable'
    if 'prob' in status: return 'probable'
    return ''


def position_buckets(position):
    value = str(position or '').upper()
    return [bucket for bucket in ('G','F','C') if bucket in value]


def profile_for_player(opponent_profiles, opponent, position):
    buckets = position_buckets(position)
    profiles = [opponent_profiles.get(bucket,{}).get(opponent,{}).get('all') for bucket in buckets]
    profiles = [profile for profile in profiles if profile]
    if not profiles:
        return None
    rank_keys = set(key for profile in profiles for key in (profile.get('ranks') or {}))
    value_keys = set(key for profile in profiles for key in (profile.get('values') or {}))
    ranks = {key:average([(profile.get('ranks') or {}).get(key) for profile in profiles]) for key in rank_keys}
    values = {key:average([(profile.get('values') or {}).get(key) for profile in profiles]) for key in value_keys}
    return {'team':profiles[0].get('team') or opponent,'games':min([int(profile.get('games') or 0) for profile in profiles if int(profile.get('games') or 0)] or [0]),'ranks':ranks,'values':values,'positionLabel':'/'.join(buckets),'primaryBucket':buckets[0] if buckets else ''}


def rank_to_score(rank):
    rank = number(rank)
    if rank is None or rank < 1 or rank > 30:
        return None
    return (rank - 1) / 29 * 100


def zone_evidence(player_zone_profile, opponent_profile, market_key):
    if market_key not in {'points','three_pointers_made','points_rebounds','points_assists','pra'} or not player_zone_profile:
        return None
    weighted = []
    keys = list(ZONE_NAMES)
    if market_key == 'three_pointers_made':
        keys = [key for key in keys if key.endswith('_3')]
    for key in keys:
        player_zone = (player_zone_profile.get('zones') or {}).get(key) or {}
        defense_zone = (((opponent_profile or {}).get('zones') or {}).get(key) or {})
        if number(defense_zone.get('rank_team_count')) != 30:
            continue
        rank = number(defense_zone.get('rank'))
        score = rank_to_score(rank)
        share = number(player_zone.get('attempt_share_pct') or player_zone.get('points_share_pct')) or 0
        if score is None or share <= 0:
            continue
        weighted.append({'key':key,'label':ZONE_NAMES[key],'rank':rank,'score':score,'share':share,'allowed':number(defense_zone.get('points_allowed_per_game'))})
    if not weighted:
        return None
    total_share = sum(zone['share'] for zone in weighted)
    top = max(weighted, key=lambda zone:zone['score']*zone['share'])
    return {'score':sum(zone['score']*zone['share'] for zone in weighted)/total_share,'topZone':top,'coveredZones':len(weighted)}


def make_reasons(candidate):
    reasons = []
    market = candidate['bestMarket']['market']['label']
    if candidate['defenseRank'] >= 21:
        reasons.append({'label':f'Weak {market} defense vs {candidate["profile"]["positionLabel"]}','tone':'blue'})
    elif candidate['defenseRank'] >= 16:
        reasons.append({'label':f'Favorable {market} defense vs {candidate["profile"]["positionLabel"]}','tone':'blue'})
    elif candidate['defenseRank'] <= 10:
        reasons.append({'label':f'Tough {market} defense vs {candidate["profile"]["positionLabel"]}','tone':'slate'})
    if candidate.get('zone',{}).get('topZone') and candidate['zone']['score'] >= 60:
        reasons.append({'label':f'{candidate["zone"]["topZone"]["label"]} edge','tone':'green'})
    if candidate.get('opponentUnavailableCount',0) > 0:
        reasons.append({'label':f'{candidate["opponentUnavailableCount"]} opponent unavailable','tone':'amber'})
    if candidate.get('playerInjuryStatus') in ('questionable','probable'):
        reasons.append({'label':candidate['playerInjuryStatus'],'tone':'amber'})
    return reasons[:3]


def build_recommendations(today, slate, player_rows, opponent_profiles, zone_data, injury_by_team):
    team_defense = zone_data.get('teamDefense') or {}
    zone_players = zone_data.get('players') or {}
    out = []
    seen = set()
    for game_group in slate:
        game = game_group['game']
        away, home = game['away']['abbr'], game['home']['abbr']
        for listed in game_group['players']:
            team = normalize_team(listed.get('team'))
            opponent = home if team == away else away
            row_key = f'{team}|{norm_name(listed.get("name"))}'
            row = player_rows.get(row_key)
            if not row:
                continue
            name, position = row['Player'], row.get('position') or listed.get('position') or ''
            if not position_buckets(position):
                continue
            if row.get('MIN') is None or row['MIN'] < 12 or not row.get('G'):
                continue
            profile = profile_for_player(opponent_profiles, opponent, position)
            if not profile:
                continue
            market_set = set(listed.get('markets') or [])
            markets = []
            opponent_zone = team_defense.get(opponent)
            player_zone = zone_players.get(row.get('_zoneKey'))
            for market in MARKETS:
                if market_set and market['key'] not in market_set:
                    continue
                player_average = number(row.get(market['stat']))
                defense_rank = number((profile.get('ranks') or {}).get(market['defenseKey']))
                defense_value = number((profile.get('values') or {}).get(market['defenseKey']))
                defense_score = rank_to_score(defense_rank)
                if player_average is None or player_average <= 0 or defense_score is None:
                    continue
                zone = zone_evidence(player_zone, opponent_zone, market['key']) if market.get('zoneWeight') else None
                score = defense_score * (1 - market.get('zoneWeight',0)) + zone['score'] * market['zoneWeight'] if zone else defense_score
                markets.append({'market':market,'playerAverage':player_average,'defenseRank':defense_rank,'defenseValue':defense_value,'defenseScore':defense_score,'score':round(score),'zone':zone})
            markets.sort(key=lambda matchup:matchup['score'], reverse=True)
            if not markets:
                continue
            side = 'away' if team == away else 'home'
            status_rows = injury_by_team.get(team, [])
            target = norm_name(name)
            player_injury = next((injury for injury in status_rows if norm_name(injury.get('player_name')) == target), None)
            player_status = status_key((player_injury or {}).get('current_status'))
            if player_status in ('out','doubtful'):
                continue
            opponent_rows = injury_by_team.get(opponent, [])
            opponent_out_count = sum(1 for injury in opponent_rows if status_key(injury.get('current_status')) in ('out','doubtful'))
            key = f'{team}|{norm_name(name)}'
            if key in seen:
                continue
            seen.add(key)
            player = {key:value for key,value in row.items() if not key.startswith('_')}
            player.update({'Player':name,'name':name,'Team':team,'team':team,'Pos':position,'position':position,'playerId':listed.get('playerId') or row.get('playerId'),'espnPlayerId':row.get('espnPlayerId'),'headshot':row.get('headshot')})
            best = markets[0]
            candidate = {
                'key':key,'player':player,'game':game,'side':side,'opponent':opponent,
                'opponentTeam':game['home'] if side == 'away' else game['away'],
                'playerTeam':game[side], 'profile':profile,'marketMatchups':markets,'bestMarket':best,
                'defenseRank':best['defenseRank'],'defenseValue':best['defenseValue'],'defenseScore':best['defenseScore'],
                'score':round(average([match['score'] for match in markets[:3]]) or 0),
                'marketAverage':best['playerAverage'],'minutes':row['MIN'],'gamesPlayed':row['G'],
                'playerInjuryStatus':player_status if player_status in ('questionable','probable') else '',
                'opponentUnavailableCount':opponent_out_count,'zone':best.get('zone'),
            }
            candidate['reasons'] = make_reasons(candidate)
            out.append(candidate)
    out.sort(key=lambda row:(-row['score'],-row['defenseRank'],-row['minutes']))
    return out[:10]


def publish():
    today = central_today()
    now = utc_now()
    scoreboard = fetch_today_games(today)
    prop_payload = load_propline_player_list()
    slate = get_today_prop_games(prop_payload, today, scoreboard)
    manifest = load_manifest()
    season = int(manifest.get('currentSeason') or today.year + (1 if today.month >= 10 else 0))
    opp_by_season = manifest.get('opponentProfilesBySeason') or {}
    opponent_profiles = opp_by_season.get(str(season)) or {}
    if not opponent_profiles:
        raise RuntimeError(f'NBA prop-center manifest has no opponent profiles for current season {season}.')

    all_listed = [player for group in slate for player in group['players']]
    unique = {}
    for player in all_listed:
        unique.setdefault(f"{normalize_team(player.get('team'))}|{norm_name(player.get('name'))}", player)
    print(f'NBA Matchups: {today.isoformat()} scoreboard games={len(scoreboard)}, PropLine-matched games={len(slate)}, unique players={len(unique)}', flush=True)

    results = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(fetch_player_season, player, manifest, season) for player in unique.values()]
        for future in as_completed(futures):
            player, payload = future.result()
            key = f"{normalize_team(player.get('team'))}|{norm_name(player.get('name'))}"
            row = stats_for_player(player, payload, season, today) if payload else None
            if row:
                results[key] = row
    zones = load_or_build_zones(season, now)
    injury_by_team, injury_timestamp = load_injuries(today)
    recommendations = build_recommendations(today, slate, results, opponent_profiles, zones, injury_by_team)
    player_rows = list(results.values())
    for row in player_rows:
        row.pop('_markets', None)
        row.pop('_zoneKey', None)
    games = [group['game'] for group in slate]
    payload = {
        'success':True,'schemaVersion':1,'sport':'nba','date':today.isoformat(),
        'generatedAt':now.isoformat().replace('+00:00','Z'),'currentSeason':season,
        'source':{'slate':'ESPN scoreboard','playerLists':'PropLine published player lists','playerStats':'PropLine published NBA prop-center logs','opponentDefense':'PropLine published NBA prop-center profiles','shootingZones':zones.get('source'),'injuries':'NBA injury report publisher'},
        'propLineUpdatedAt':prop_payload.get('updated_at'),'injuryReportTimestamp':injury_timestamp,
        'zoneDataStatus':'ready' if zones.get('rankTeamCount',0) >= 30 else ('partial' if zones.get('shotCount') else 'unavailable'),'zoneTeamCount':zones.get('rankTeamCount',0),
        'games':games,'gameCount':len(games),'playerRows':player_rows,'playerCount':len(player_rows),
        'recommendations':recommendations,'recommendationCount':len(recommendations),
        'quality':{'scoreboardGameCount':len(scoreboard),'propLineMatchedGameCount':len(slate),'playersWithStats':len(results),'zoneShotCount':zones.get('shotCount',0)},
    }
    out = OUTPUT_ROOT / 'nba-matchups' / 'v1' / 'latest.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, separators=(',',':')))
    tmp.replace(out)
    print(f'Published {len(recommendations)} matchup recommendations from {len(games)} games to {out}', flush=True)


if __name__ == '__main__':
    publish()
