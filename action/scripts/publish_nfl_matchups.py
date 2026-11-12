#!/usr/bin/env python3
"""Publish daily NFL matchup recommendations from PropLine and nflverse data."""
import csv
import datetime as dt
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

OUTPUT_ROOT = Path(os.environ.get('NFL_MATCHUPS_OUTPUT_DIR', '.')).expanduser()
REPOSITORY = os.environ.get('NFL_MATCHUPS_REPOSITORY', 'jdnhunter99-sys/sports-edge-ai-actions')
DATA_RAW = f'https://raw.githubusercontent.com/{REPOSITORY}/propline-data'
NFL_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
NFL_STATS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv'
NFL_INJURY_URL = f'https://raw.githubusercontent.com/{REPOSITORY}/nfl-injury-report-data/nfl-injuries/latest.json'
HEADERS = {'User-Agent': 'SportsEdgeAI-NFL-Matchups-Publisher/1.0', 'Accept': 'application/json,text/csv,application/octet-stream,*/*'}
NFL_TEAMS = {'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH'}
TEAM_ALIASES = {
    'ARZ':'ARI','BLT':'BAL','CLV':'CLE','GNB':'GB','JAC':'JAX','KAN':'KC','LA':'LAR','OAK':'LV','SD':'LAC',
    'SFO':'SF','TAM':'TB','WAS':'WSH','WFT':'WSH','WDC':'WSH','WASHINGTON':'WSH','WASHINGTONCOMMANDERS':'WSH',
    'SANFRANCISCO':'SF','SANFRANCISCO49ERS':'SF','NEWENGLAND':'NE','NEWENGLANDPATRIOTS':'NE',
    'KANSASCITY':'KC','KANSASCITYCHIEFS':'KC','LASVEGAS':'LV','LASVEGASRAIDERS':'LV',
    'LOSANGELESRAMS':'LAR','LOSANGELESCHARGERS':'LAC','NEWYORKGIANTS':'NYG','NEWYORKJETS':'NYJ',
    'TAMPABAY':'TB','TAMPABAYBUCCANEERS':'TB','GREENBAY':'GB','GREENBAYPACKERS':'GB',
    'NEWORLEANS':'NO','NEWORLEANSSAINTS':'NO','ARIZONA':'ARI','ARIZONACARDINALS':'ARI',
    'BALTIMORE':'BAL','BALTIMORERAVENS':'BAL','BUFFALO':'BUF','BUFFALOBILLS':'BUF',
    'CAROLINA':'CAR','CAROLINAPANTHERS':'CAR','CHICAGO':'CHI','CHICAGOBEARS':'CHI',
    'CINCINNATI':'CIN','CINCINNATIBENGALS':'CIN','CLEVELAND':'CLE','CLEVELANDBROWNS':'CLE',
    'DALLAS':'DAL','DALLASCOWBOYS':'DAL','DENVER':'DEN','DENVERBRONCOS':'DEN','DETROIT':'DET','DETROITLIONS':'DET',
    'HOUSTON':'HOU','HOUSTONTEXANS':'HOU','INDIANAPOLIS':'IND','INDIANAPOLISCOLTS':'IND',
    'JACKSONVILLE':'JAX','JACKSONVILLEJAGUARS':'JAX','MIAMI':'MIA','MIAMIDOLPHINS':'MIA','MINNESOTA':'MIN','MINNESOTAVIKINGS':'MIN',
    'PHILADELPHIA':'PHI','PHILADELPHIAEAGLES':'PHI','PITTSBURGH':'PIT','PITTSBURGHSTEELERS':'PIT',
    'SEATTLE':'SEA','SEATTLESEAHAWKS':'SEA','ATLANTA':'ATL','ATLANTAFALCONS':'ATL','TENNESSEE':'TEN','TENNESSEETITANS':'TEN',
}
POSITIONS = {'QB','RB','WR','TE'}

# Defense values come from the same player-week population used by the NFL
# positional-defense function. Ranks run from least to most production allowed;
# therefore a high rank is a favorable offensive matchup.
MARKETS = {
    'passing_yards': {'label':'Passing Yards','short':'PASS YDS','average':'passing_yards','defense':'passing_yards','allowedLabel':'passing yards'},
    'passing_tds': {'label':'Passing TDs','short':'PASS TD','average':'passing_tds','defense':'passing_tds','allowedLabel':'passing TDs'},
    'passing_completions': {'label':'Completions','short':'COMP','average':'completions','defense':'completions','allowedLabel':'completions'},
    'passing_attempts': {'label':'Pass Attempts','short':'PASS ATT','average':'attempts','defense':'attempts','allowedLabel':'pass attempts'},
    'rushing_yards': {'label':'Rushing Yards','short':'RUSH YDS','average':'rushing_yards','defense':'rushing_yards','allowedLabel':'rushing yards'},
    'rushing_tds': {'label':'Rushing TDs','short':'RUSH TD','average':'rushing_tds','defense':'rushing_tds','allowedLabel':'rushing TDs'},
    'rushing_attempts': {'label':'Rush Attempts','short':'CARRIES','average':'carries','defense':'carries','allowedLabel':'rush attempts'},
    'receiving_yards': {'label':'Receiving Yards','short':'REC YDS','average':'receiving_yards','defense':'receiving_yards','allowedLabel':'receiving yards'},
    'receptions': {'label':'Receptions','short':'REC','average':'receptions','defense':'receptions','allowedLabel':'receptions'},
    'rush_rec_yards': {'label':'Rush + Rec Yards','short':'R+R YDS','average':'rush_rec_yards','defense':'rush_rec_yards','allowedLabel':'rush + receiving yards'},
}


def request_bytes(url, timeout=90, attempts=3):
    last_error = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 5))
    raise RuntimeError(f'GET failed for {url}: {last_error}')


def request_json(url, timeout=45):
    return json.loads(request_bytes(url, timeout).decode('utf-8-sig'))


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
    found = [number(value) for value in values]
    found = [value for value in found if value is not None]
    return sum(found) / len(found) if found else None


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


def team_from_espn(raw):
    team = raw.get('team') or {}
    abbr = normalize_team(team.get('abbreviation') or team.get('abbr'))
    logos = team.get('logos') or []
    return {
        'id':str(team.get('id') or ''), 'abbr':abbr, 'abbreviation':abbr, 'teamTricode':abbr,
        'name':team.get('displayName') or team.get('name') or abbr,
        'teamName':team.get('displayName') or team.get('name') or abbr,
        'displayName':team.get('displayName') or team.get('name') or abbr,
        'logo':team.get('logo') or (logos[0].get('href') if logos else '') or '',
        'color':team.get('color') or '', 'secondary':team.get('alternateColor') or '',
        'score':number(raw.get('score')),
    }


def fetch_today_games(today):
    query = urllib.parse.urlencode({'dates':today.strftime('%Y%m%d'),'limit':'100','region':'us','lang':'en'})
    payload = request_json(f'{NFL_SCOREBOARD}?{query}')
    output = []
    for event in payload.get('events') or []:
        competition = (event.get('competitions') or [{}])[0]
        competitors = competition.get('competitors') or []
        away_raw = next((item for item in competitors if item.get('homeAway') == 'away'), {})
        home_raw = next((item for item in competitors if item.get('homeAway') == 'home'), {})
        away, home = team_from_espn(away_raw), team_from_espn(home_raw)
        if away['abbr'] not in NFL_TEAMS or home['abbr'] not in NFL_TEAMS:
            continue
        status = competition.get('status') or event.get('status') or {}
        state = str((status.get('type') or {}).get('state') or '').lower()
        description = (status.get('type') or {}).get('shortDetail') or (status.get('type') or {}).get('detail') or ''
        if state == 'post' or 'final' in str(description).lower() or any(term in str(description).lower() for term in ('postpon', 'cancel')):
            continue
        output.append({
            'id':str(event.get('id') or competition.get('id') or ''), 'date':event.get('date') or competition.get('date'),
            'scheduleDate':today.isoformat(), 'gameDate':event.get('date') or competition.get('date'),
            'venue':(competition.get('venue') or {}).get('fullName') or '',
            'city':((competition.get('venue') or {}).get('address') or {}).get('city') or '',
            'status':{'state':state or 'pre','description':description or 'Upcoming','completed':False},
            'away':away,'home':home,
        })
    return output


def load_propline_player_list():
    payload = request_json(f'{DATA_RAW}/Player%20Lists/nfl/prop-center.json')
    if payload.get('ok') is not True or not isinstance(payload.get('games'), list):
        raise RuntimeError('Published PropLine NFL player list is unavailable or malformed.')
    return payload


def game_pair(game):
    return normalize_team(game.get('awayTeam') or game.get('away') or game.get('awayTeamAbbr')), normalize_team(game.get('homeTeam') or game.get('home') or game.get('homeTeamAbbr'))


def get_today_prop_games(payload, today, games):
    game_by_pair = {(game['away']['abbr'], game['home']['abbr']):game for game in games}
    output = []
    for item in payload.get('games') or []:
        commence = central_date_from_iso(item.get('commenceTime'))
        if commence and commence != today:
            continue
        away, home = game_pair(item)
        game = game_by_pair.get((away, home))
        if not game:
            continue
        players, seen = [], set()
        for raw in item.get('players') or []:
            name, team = str(raw.get('name') or raw.get('player') or '').strip(), normalize_team(raw.get('team'))
            position = str(raw.get('position') or '').strip().upper()
            if not name or team not in (away, home) or position not in POSITIONS:
                continue
            identity = f'{team}|{norm_name(name)}'
            if identity in seen:
                continue
            seen.add(identity)
            players.append({**raw,'name':name,'team':team,'position':position,'opponent':home if team == away else away})
        if players:
            output.append({'game':game,'players':players})
    return output


def fetch_player_stats(season):
    url = NFL_STATS_URL.format(season=season)
    text = request_bytes(url, timeout=180).decode('utf-8-sig', errors='replace')
    rows = list(csv.DictReader(io.StringIO(text)))
    filtered = []
    for row in rows:
        if int(number(row.get('season')) or 0) != season or str(row.get('season_type') or '').upper() != 'REG':
            continue
        if str(row.get('position') or '').upper() not in POSITIONS:
            continue
        if not str(row.get('game_id') or '').strip():
            continue
        row['_team'] = normalize_team(row.get('team'))
        row['_opponent'] = normalize_team(row.get('opponent_team'))
        row['_name_key'] = norm_name(row.get('player_display_name') or row.get('player_name'))
        row['_position'] = str(row.get('position') or '').upper()
        if row['_team'] not in NFL_TEAMS or row['_opponent'] not in NFL_TEAMS or not row['_name_key']:
            continue
        filtered.append(row)
    if not filtered:
        raise RuntimeError(f'nflverse returned no regular-season NFL player rows for {season}.')
    return filtered


def load_injuries():
    try:
        payload = request_json(NFL_INJURY_URL, timeout=20)
        by_team = payload.get('teams_by_abbreviation') or {}
        return {normalize_team(team):row for team,row in by_team.items()}, payload.get('source_timestamp') or payload.get('updated_at')
    except Exception as error:
        print(f'WARN NFL injury snapshot unavailable: {error}', flush=True)
        return {}, None


def status_key(value):
    status = str(value or '').strip().lower()
    if 'out' in status or 'injured reserve' in status or 'reserve/injured' in status or 'physically unable' in status or status == 'pup': return 'out'
    if 'doubt' in status: return 'doubtful'
    if 'question' in status: return 'questionable'
    if 'prob' in status: return 'probable'
    if status == 'active' or 'available' in status: return 'active'
    return ''


def injury_index(injuries):
    result = {}
    for team, payload in injuries.items():
        for injury in payload.get('injuries') or []:
            key = f'{team}|{norm_name(injury.get("player") or injury.get("player_name"))}'
            result[key] = injury
    return result


def usable_player_games(rows):
    # Player-week rows with no pass attempt, carry, target, or reception are
    # not a meaningful offensive appearance for this matchup dataset.
    return [row for row in rows if any((number(row.get(field)) or 0) > 0 for field in ('attempts','carries','targets','receptions'))]


def player_value(row, market_key):
    if market_key == 'rush_rec_yards':
        return (number(row.get('rushing_yards')) or 0) + (number(row.get('receiving_yards')) or 0)
    market = MARKETS[market_key]
    return number(row.get(market['average']))


def defense_value(rows, position, market_key):
    selected = [row for row in rows if row['_position'] == position]
    if not selected:
        return None
    if market_key == 'rush_rec_yards':
        if position not in ('RB','WR','TE'):
            return None
        grouped = defaultdict(float)
        for row in selected:
            grouped[str(row['game_id'])] += (number(row.get('rushing_yards')) or 0) + (number(row.get('receiving_yards')) or 0)
        return average(grouped.values())
    stat = MARKETS[market_key]['average']
    grouped = defaultdict(float)
    for row in selected:
        grouped[str(row['game_id'])] += number(row.get(stat)) or 0
    return average(grouped.values())


def build_defense_profiles(rows):
    by_defense_position = defaultdict(list)
    for row in rows:
        by_defense_position[(row['_opponent'], row['_position'])].append(row)
    metrics = defaultdict(dict)
    for team in NFL_TEAMS:
        for position in POSITIONS:
            group = by_defense_position.get((team, position), [])
            for market_key in MARKETS:
                value = defense_value(group, position, market_key)
                if value is not None:
                    metrics[(position, market_key)][team] = value
    ranks = defaultdict(dict)
    for key, team_values in metrics.items():
        ordered = sorted(team_values.items(), key=lambda item:item[1])
        rank = 1
        for index, (team, value) in enumerate(ordered):
            if index and value != ordered[index - 1][1]:
                rank = index + 1
            ranks[key][team] = {'rank':rank,'value':value,'rankTeamCount':len(ordered)}
    return ranks


def player_lookup(rows):
    by_team_name = defaultdict(list)
    by_name = defaultdict(list)
    by_player_id = defaultdict(list)
    for row in usable_player_games(rows):
        # Multiple traded-team rows can share a player and game; merge those
        # weekly records by game below before the final averages are computed.
        key = (row['_team'], row['_name_key'], row['_position'])
        by_team_name[key].append(row)
        by_name[(row['_name_key'], row['_position'])].append(row)
        if row.get('player_id'):
            by_player_id[(str(row.get('player_id')), row['_position'])].append(row)
    return by_team_name, by_name, by_player_id


def unique_games(rows):
    by_game = {}
    for row in rows:
        game = str(row.get('game_id') or '')
        if not game:
            continue
        if game not in by_game:
            by_game[game] = row
        else:
            merged = dict(by_game[game])
            for field in ('passing_yards','passing_tds','completions','attempts','rushing_yards','rushing_tds','carries','receiving_yards','receptions','targets'):
                merged[field] = (number(merged.get(field)) or 0) + (number(row.get(field)) or 0)
            by_game[game] = merged
    return list(by_game.values())


def player_averages(listed, lookup):
    by_team_name, by_name, _ = lookup
    team, name, position = normalize_team(listed.get('team')), norm_name(listed.get('name')), str(listed.get('position') or '').upper()
    # Keep the full current-season sample for traded players, with exact-team
    # matching as a fallback for duplicate names.
    source = by_name.get((name, position)) or by_team_name.get((team, name, position)) or []
    games = unique_games(source)
    if not games:
        return None
    markets = {}
    listed_markets = set(str(value).strip().lower() for value in listed.get('markets') or [])
    position_markets = {
        'QB': ['passing_yards','passing_tds','passing_completions','passing_attempts','rushing_yards'],
        'RB': ['rushing_yards','rushing_tds','rushing_attempts','receiving_yards','receptions','rush_rec_yards'],
        'WR': ['receiving_yards','receptions','rush_rec_yards'],
        'TE': ['receiving_yards','receptions','rush_rec_yards'],
    }.get(position, [])
    for key in position_markets:
        if listed_markets and key not in listed_markets:
            continue
        values = [player_value(row,key) for row in games]
        values = [value for value in values if value is not None]
        if values:
            markets[key] = average(values)
    return {'games':len(games),'markets':markets,'sourceRows':games}


def stat_player_row(listed, stats, game):
    player = {
        'playerId':listed.get('playerId') or '', 'espnPlayerId':str(listed.get('playerId') or '').replace('espn:',''),
        'nflversePlayerId':str((stats.get('sourceRows') or [{}])[0].get('player_id') or ''),
        'Player':listed.get('name'),'name':listed.get('name'),'Team':normalize_team(listed.get('team')),'team':normalize_team(listed.get('team')),
        'position':listed.get('position'),'Pos':listed.get('position'),'headshot':listed.get('headshot') or listed.get('headshotUrl') or listed.get('image') or '',
        'gamesPlayed':stats.get('games',0),
    }
    player['_playerId'] = player['nflversePlayerId']
    for key,value in (stats.get('markets') or {}).items():
        player[f'{key}PerGame'] = value
    return player


def build_recommendations(slate, player_rows, defense_ranks, injury_rows, season):
    injuries = injury_index(injury_rows)
    output, seen = [], set()
    for game_group in slate:
        game = game_group['game']
        away, home = game['away']['abbr'], game['home']['abbr']
        for listed in game_group['players']:
            team, position = normalize_team(listed.get('team')), str(listed.get('position') or '').upper()
            opponent = home if team == away else away
            key = f'{team}|{norm_name(listed.get("name"))}'
            if key in seen:
                continue
            stats = player_rows.get(key)
            if not stats:
                continue
            player_injury = injuries.get(key) or {}
            player_status = status_key(player_injury.get('status'))
            if player_status in ('out','doubtful','active'):
                continue
            listed_markets = set(str(value).strip().lower() for value in listed.get('markets') or [])
            matches = []
            for market_key, market in MARKETS.items():
                player_avg = (stats.get('markets') or {}).get(market_key)
                position_ranks = defense_ranks.get((position, market_key), {})
                matchup = position_ranks.get(opponent)
                if player_avg is None or not matchup:
                    continue
                # Props-to-check must be backed by a current PropLine market.
                # Market evidence can include averages even if this player lacks
                # an O/U offer today, just as it does in the NBA discovery.
                matches.append({
                    'market':{'key':market_key,'label':market['label'],'short':market['short'],'allowedLabel':market['allowedLabel']},
                    'playerAverage':player_avg,'defenseRank':matchup['rank'],'defenseValue':matchup['value'],
                    'rankTeamCount':matchup['rankTeamCount'],'available':not listed_markets or market_key in listed_markets,
                })
            if not matches:
                continue
            favorable = [item for item in matches if item['defenseRank'] >= 25]
            unfavorable = [item for item in matches if item['defenseRank'] <= 5]
            if not favorable and not unfavorable:
                continue
            directional = favorable or unfavorable
            rank_scores = [abs(((item['defenseRank'] - 1) / 31 * 100) - 50) * 2 for item in directional]
            score = sum(sorted(rank_scores, reverse=True)[:3]) / min(3, len(rank_scores))
            status_display = player_status if player_status in ('questionable','probable') else ''
            team_game = game['away'] if team == away else game['home']
            opponent_game = game['home'] if team == away else game['away']
            player = dict(stats['player'])
            player.update({'Team':team,'team':team,'position':position,'Pos':position,'Player':listed.get('name'),'name':listed.get('name')})
            seen.add(key)
            output.append({
                'key':key,'player':player,'game':game,'side':'away' if team == away else 'home','opponent':opponent,
                'opponentTeam':opponent_game,'playerTeam':team_game,'profile':{'position':position,'games':stats['gamesPlayed']},
                'marketMatchups':matches,'score':round(score,1),'gamesPlayed':stats['gamesPlayed'],
                'playerInjuryStatus':status_display,'hasFavorableSignal':bool(favorable),'hasUnfavorableSignal':bool(unfavorable),
                'favorableMarketKeys':[item['market']['key'] for item in favorable],
                'unfavorableMarketKeys':[item['market']['key'] for item in unfavorable],
                'opponentUnavailableCount':sum(1 for injury in (injury_rows.get(opponent,{}).get('injuries') or []) if status_key(injury.get('status')) in ('out','doubtful')),
                'season':season,
            })
    output.sort(key=lambda row:(-row['score'],-row['gamesPlayed'],row['player'].get('Player') or ''))
    selected = {row['key']:row for row in [item for item in output if item['hasFavorableSignal']][:10]}
    selected.update({row['key']:row for row in [item for item in output if item['hasUnfavorableSignal']][:10]})
    return sorted(selected.values(), key=lambda row:(-row['score'],-row['gamesPlayed'],row['player'].get('Player') or ''))


def publish():
    today = central_today()
    season = today.year if today.month >= 8 else today.year - 1
    now = dt.datetime.now(dt.timezone.utc)
    scoreboard = fetch_today_games(today)
    prop_payload = load_propline_player_list()
    slate = get_today_prop_games(prop_payload, today, scoreboard)
    print(f'NFL Matchups: {today.isoformat()} scoreboard games={len(scoreboard)}, PropLine-matched games={len(slate)}', flush=True)
    rows = fetch_player_stats(season)
    print(f'Loaded {len(rows)} nflverse regular-season player-week rows for {season}.', flush=True)
    defense_ranks = build_defense_profiles(rows)
    lookup = player_lookup(rows)
    unique = {}
    for group in slate:
        for listed in group['players']:
            key = f'{normalize_team(listed.get("team"))}|{norm_name(listed.get("name"))}'
            unique.setdefault(key,listed)
    player_rows, internal_stats = [], {}
    for key, listed in unique.items():
        stats = player_averages(listed, lookup)
        if not stats:
            continue
        row = stat_player_row(listed, stats, None)
        internal_stats[key] = {'markets':stats['markets'],'gamesPlayed':stats['games'],'player':row}
        player_rows.append(row)
    injury_rows, injury_timestamp = load_injuries()
    recommendations = build_recommendations(slate, internal_stats, defense_ranks, injury_rows, season)
    games = [group['game'] for group in slate]
    payload = {
        'success':True,'schemaVersion':1,'sport':'nfl','date':today.isoformat(),
        'generatedAt':now.isoformat().replace('+00:00','Z'),'currentSeason':season,
        'source':{'slate':'ESPN scoreboard','playerLists':'PropLine published NFL player lists','playerStats':'nflverse stats_player_week','opponentDefense':'nflverse player-week stats grouped by opponent and position','injuries':'NFL injury report publisher'},
        'propLineUpdatedAt':prop_payload.get('updated_at'),'injuryReportTimestamp':injury_timestamp,
        'games':games,'gameCount':len(games),'playerRows':player_rows,'playerCount':len(player_rows),
        'recommendations':recommendations,'recommendationCount':len(recommendations),
        'quality':{'scoreboardGameCount':len(scoreboard),'propLineMatchedGameCount':len(slate),'playersWithCurrentSeasonStats':len(player_rows),'nflverseWeeklyRows':len(rows)},
    }
    out = OUTPUT_ROOT / 'nfl-matchups' / 'v1' / 'latest.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload, separators=(',',':')))
    tmp.replace(out)
    print(f'Published {len(recommendations)} matchup recommendations from {len(games)} games to {out}', flush=True)


if __name__ == '__main__':
    publish()
