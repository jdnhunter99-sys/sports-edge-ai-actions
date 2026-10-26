#!/usr/bin/env python3
"""Publish pre-normalized NBA prop-center data for fast static frontend reads."""
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

OUTPUT_DIR_VALUE = os.environ.get('NBA_PROP_CENTER_OUTPUT_DIR', '').strip()
if not OUTPUT_DIR_VALUE:
    raise RuntimeError('NBA_PROP_CENTER_OUTPUT_DIR is required')
OUTPUT_DIR = Path(OUTPUT_DIR_VALUE).expanduser()
RELEASE_API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/'
RELEASES = {'player': 'espn_nba_player_boxscores', 'team': 'espn_nba_team_boxscores'}
RELEASE_CACHE = {}
PROFILE_FRAMES = ('all', 'l5', 'l10', 'l15')
TEAM_ABBRS = ('ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS')
HEADERS = {'User-Agent': 'SportsEdgeAI-NBA-Prop-Center-Publisher/1.0', 'Accept': 'application/json, text/csv, application/octet-stream, */*'}


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
    aliases={
        'BRK':'BKN','GS':'GSW','GOS':'GSW','NO':'NOP','NOLA':'NOP','NOR':'NOP','NOH':'NOP','NOK':'NOP','NY':'NYK','PHO':'PHX','SA':'SAS','UTAH':'UTA','WSH':'WAS','CHO':'CHA',
        'ATLANTAHAWKS':'ATL','BOSTONCELTICS':'BOS','BROOKLYNNETS':'BKN','CHARLOTTEHORNETS':'CHA','CHICAGOBULLS':'CHI','CLEVELANDCAVALIERS':'CLE','DALLASMAVERICKS':'DAL','DENVERNUGGETS':'DEN','DETROITPISTONS':'DET','GOLDENSTATEWARRIORS':'GSW','HOUSTONROCKETS':'HOU','INDIANAPACERS':'IND','LACLIPPERS':'LAC','LOSANGELESCLIPPERS':'LAC','LOSANGELESLAKERS':'LAL','MEMPHISGRIZZLIES':'MEM','MIAMIHEAT':'MIA','MILWAUKEEBUCKS':'MIL','MINNESOTATIMBERWOLVES':'MIN','NEWORLEANSPELICANS':'NOP','NEWYORKKNICKS':'NYK','OKLAHOMACITYTHUNDER':'OKC','ORLANDOMAGIC':'ORL','PHILADELPHIA76ERS':'PHI','PHOENIXSUNS':'PHX','PORTLANDTRAILBLAZERS':'POR','SACRAMENTOKINGS':'SAC','SANANTONIOSPURS':'SAS','TORONTORAPTORS':'TOR','UTAHJAZZ':'UTA','WASHINGTONWIZARDS':'WAS',
    }
    return aliases.get(raw, raw)


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
        message=f'No {season} NBA {kind}-box CSV asset in SportsDataverse release {RELEASES[kind]}'
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
        'headshot': text(row.get('athlete_headshot_href')),
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
        'playerName': text(row.get('athlete_display_name')), 'headshot': text(row.get('athlete_headshot_href')),
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


def position_values(player_rows, game_ids, defense_team, position):
    per_game = defaultdict(lambda: {'points':0,'rebounds':0,'assists':0,'threes':0,'blocks':0,'steals':0})
    for row in player_rows:
        gid = text(row.get('game_id'))
        if gid not in game_ids or abbr(row.get('opponent_team_abbreviation')) != defense_team:
            continue
        if pos_bucket(row.get('athlete_position_abbreviation') or row.get('athlete_position_name')) != position or not active_player(row):
            continue
        target = per_game[gid]
        for out_key, in_key in (('points','points'),('rebounds','rebounds'),('assists','assists'),('threes','three_point_field_goals_made'),('blocks','blocks'),('steals','steals')):
            target[out_key] += num(row.get(in_key)) or 0
    if not per_game:
        return {}
    rows = list(per_game.values())
    pts=[r['points'] for r in rows]; reb=[r['rebounds'] for r in rows]; ast=[r['assists'] for r in rows]
    threes=[r['threes'] for r in rows]; blocks=[r['blocks'] for r in rows]; steals=[r['steals'] for r in rows]
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
            values.update(position_values(player_rows, game_ids, team, position))
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


def build_season(season, generated_at, required=True):
    player_rows = fetch_release_rows('player', season, required=required)
    team_rows = fetch_release_rows('team', season, required=required)
    team_by_game = {}
    for row in team_rows:
        gid=text(row.get('game_id')); tid=text(row.get('team_id')); team=abbr(row.get('team_abbreviation'))
        if gid and tid: team_by_game[(gid,'id:'+tid)]=row
        if gid and team: team_by_game[(gid,'abbr:'+team)]=row
    players_by_game_team=defaultdict(list)
    for row in player_rows:
        players_by_game_team[(text(row.get('game_id')),text(row.get('team_id')))].append(row)
    normalized_by_id=defaultdict(list)
    profile_aggs=defaultdict(lambda:{'minutesTotal':0,'minutesGames':0,'usageTotal':0,'usageGames':0,'playerName':'','position':'','team':''})
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
        if game['minutes'] is not None:
            agg['minutesTotal']+=game['minutes']; agg['minutesGames']+=1
        if game['usagePct'] is not None:
            agg['usageTotal']+=game['usagePct']; agg['usageGames']+=1
        if game['opponent'] in TEAM_ABBRS and game['gameDate']:
            old=opponent_latest.get(game['opponent'],{}).get(identity)
            if old is None or game['gameDate'] > old['gameDate']:
                compact_game={key:value for key,value in game.items() if key not in ('teammates','teammateIds','teammateNames')}
                opponent_latest.setdefault(game['opponent'],{})[identity]=compact_game
    profiles={}
    for identity,agg in profile_aggs.items():
        profiles[identity]={
            'espnPlayerId':identity if str(identity).isdigit() else None,
            'playerName':agg['playerName'],'position':agg['position'],'team':agg['team'],
            'minutesPerGame':rounded(agg['minutesTotal']/agg['minutesGames'],6) if agg['minutesGames'] else None,
            'usagePct':rounded(agg['usageTotal']/agg['usageGames'],6) if agg['usageGames'] else None,
        }
    profile_by_position={bucket:build_profiles(team_rows,player_rows,bucket) for bucket in ('G','F','C')}
    player_lookup={'byId':{},'byName':{}}
    root=OUTPUT_DIR/'nba-prop-center'/'v1'
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
        raise RuntimeError(f'No regular-season NBA player profiles were built for required season {season}')
    print(f'Built {len(normalized_by_id)} player files and {len(profiles)} regular-season player profiles for {season}',flush=True)
    return {'season':season,'profiles':profiles,'opponentLatest':opponent_latest,'playerLookup':player_lookup,'opponentProfilesByPosition':profile_by_position,'teamCount':len({abbr(r.get("team_abbreviation")) for r in team_rows if abbr(r.get("team_abbreviation")) in TEAM_ABBRS})}


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
            entry['seasons'][season]={'minutesPerGame':profile.get('minutesPerGame'),'usagePct':profile.get('usagePct')}
            if season==str(current):
                entry.update({'playerName':profile.get('playerName'),'position':profile.get('position'),'team':profile.get('team')})
    root=OUTPUT_DIR/'nba-prop-center'/'v1'
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
    root=OUTPUT_DIR/'nba-prop-center'/'v1'
    print(f'NBA prop-center publisher: seasons={previous},{current}; generated={generated_at}',flush=True)
    seasons=[build_season(previous,generated_at,required=True),build_season(current,generated_at,required=False)]
    current_data=next(item for item in seasons if item['season']==current)
    existing_manifest=root/'latest.json'
    if existing_manifest.exists() and not current_data['profiles']:
        try:
            old=json.loads(existing_manifest.read_text(encoding='utf-8'))
            old_count=int(old.get('seasons',{}).get(str(current),{}).get('playerCount',0))
            if int(old.get('currentSeason',0))==current and old_count>0:
                raise RuntimeError(f'Refusing to replace published {current} NBA player profiles with an empty season response')
        except (OSError,ValueError,json.JSONDecodeError):
            pass
    player_profiles=build_opponent_dataset(seasons,current,previous)
    lookup={'byId':{},'byName':{}}
    for season_data in seasons:
        season_data['playerLookup']['byId'] and [lookup['byId'].setdefault(pid,{}).update(paths) for pid,paths in season_data['playerLookup']['byId'].items()]
        for name,by_season in season_data['playerLookup']['byName'].items():
            lookup['byName'].setdefault(name,{}).update(by_season)
    latest={
        'success':True,'schemaVersion':1,'generatedAt':generated_at,'currentSeason':current,'previousSeason':previous,
        'source':'sportsdataverse-espn-nba-player-and-team-boxscores','playerLookup':lookup,
        'opponentProfilesBySeason':{str(item['season']):item['opponentProfilesByPosition'] for item in seasons},
        'playerProfiles':player_profiles,
        'seasons':{str(item['season']):{'playerCount':len(item['profiles']),'teamCount':item['teamCount']} for item in seasons},
        'opponentsPath':'opponents',
    }
    write_json(root/'latest.json',latest)
    previous_data=next(item for item in seasons if item['season']==previous)
    if not previous_data['profiles'] or not previous_data['playerLookup']['byName']:
        raise RuntimeError(f'Refusing to publish incomplete previous NBA prop-center season {previous}')
    print(f'Published NBA prop-center data: {len(lookup["byId"])} ids, {len(lookup["byName"])} names, 30 opponent files',flush=True)


if __name__=='__main__':
    main()
