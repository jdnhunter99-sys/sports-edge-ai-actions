#!/usr/bin/env python3
"""Build pregame NBA team-stat snapshots and publish static JSON files."""

import concurrent.futures
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

OUTPUT_ROOT_VALUE = os.environ.get("NBA_STATS_OUTPUT_DIR", "").strip()
if not OUTPUT_ROOT_VALUE:
    raise RuntimeError("NBA_STATS_OUTPUT_DIR is required")
OUTPUT_ROOT = Path(OUTPUT_ROOT_VALUE).expanduser()

TZ = ZoneInfo("America/Chicago")
NBA_SCHEDULE_TZ = ZoneInfo("America/New_York")
TODAY = dt.datetime.now(TZ).date()
SEASON_START_YEAR = TODAY.year if TODAY.month >= 7 else TODAY.year - 1
SEASON_END_YEAR = SEASON_START_YEAR + 1
SEASON_LABEL = str(SEASON_START_YEAR) + "-" + str(SEASON_END_YEAR)[-2:]
SEASON_FOLDER = SEASON_LABEL
DATA_ROOT = OUTPUT_ROOT / "nba-team-stats"
RAW_ROOT = DATA_ROOT / "raw" / SEASON_FOLDER
PUBLISH_ROOT = DATA_ROOT / "v1" / SEASON_FOLDER
SCHEDULE_URL = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json"
ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
BOX_SCORE_URL = "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{game_id}.json"
NBA_STATS_URL = "https://stats.nba.com/stats/leaguedashteamstats"
SPORTSDATAVERSE_RELEASE_API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/"
RAW_HEADERS = {
    "User-Agent": "SportsEdgeAI-NBA-Stats-Publisher/1.0",
    "Accept": "application/json, text/plain, */*",
}
NBA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nba.com",
    "Referer": "https://www.nba.com/",
    "Connection": "keep-alive",
}
TIMEFRAMES = {
    "season": {"last_n": 0, "location": ""},
    "last3": {"last_n": 3, "location": ""},
    "last5": {"last_n": 5, "location": ""},
    "last10": {"last_n": 10, "location": ""},
    "last15": {"last_n": 15, "location": ""},
    "home": {"last_n": 0, "location": "Home"},
    "away": {"last_n": 0, "location": "Road"},
}
ABBR_ALIASES = {
    "GS": "GSW", "NO": "NOP", "NY": "NYK", "SA": "SAS", "UTAH": "UTA",
    "PHO": "PHX", "WSH": "WAS",
}
NAME_TO_ABBR = {
    "atlanta hawks": "ATL", "boston celtics": "BOS", "brooklyn nets": "BKN",
    "charlotte hornets": "CHA", "chicago bulls": "CHI", "cleveland cavaliers": "CLE",
    "dallas mavericks": "DAL", "denver nuggets": "DEN", "detroit pistons": "DET",
    "golden state warriors": "GSW", "houston rockets": "HOU", "indiana pacers": "IND",
    "los angeles clippers": "LAC", "la clippers": "LAC", "los angeles lakers": "LAL",
    "la lakers": "LAL", "memphis grizzlies": "MEM", "miami heat": "MIA",
    "milwaukee bucks": "MIL", "minnesota timberwolves": "MIN", "new orleans pelicans": "NOP",
    "new york knicks": "NYK", "oklahoma city thunder": "OKC", "orlando magic": "ORL",
    "philadelphia 76ers": "PHI", "phoenix suns": "PHX", "portland trail blazers": "POR",
    "sacramento kings": "SAC", "san antonio spurs": "SAS", "toronto raptors": "TOR",
    "utah jazz": "UTA", "washington wizards": "WAS",
}
CORE_FIELDS = (
    "team_score", "field_goals_made", "field_goals_attempted",
    "three_point_field_goals_made", "three_point_field_goals_attempted",
    "free_throws_made", "free_throws_attempted", "offensive_rebounds",
    "defensive_rebounds", "assists", "turnovers", "steals", "blocks", "fouls",
)
METRIC_MAP = {
    "offense": {
        "offensiveRating": "OFF_RATING", "pace": "PACE", "possessions": "POSS",
        "turnoverPct": "TM_TOV_PCT", "offensiveReboundPct": "OREB_PCT",
        "assistPct": "AST_PCT", "assistToTurnover": "AST_TOV",
        "effectiveFgPct": "EFG_PCT", "trueShootingPct": "TS_PCT",
    },
    "defense": {
        "defensiveRating": "DEF_RATING", "defensiveReboundPct": "DREB_PCT",
    },
    "advanced": {"netRating": "NET_RATING", "totalReboundPct": "REB_PCT"},
}


def num(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def rounded(value, digits=4):
    value = num(value)
    return round(value, digits) if value is not None else None


def metric(value, lower_is_better=False):
    return {
        "value": rounded(value),
        "rank": None,
        "percentile": None,
        "lowerIsBetter": bool(lower_is_better),
    }


def safe_div(numerator, denominator):
    numerator = num(numerator)
    denominator = num(denominator)
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def average(values):
    present = [num(value) for value in values]
    present = [value for value in present if value is not None]
    return sum(present) / len(present) if present else None


def total(rows, key):
    values = [num(row.get(key)) for row in rows]
    if not values or any(value is None for value in values):
        return None
    return sum(values)


def average_field(rows, key):
    return average([row.get(key) for row in rows])


def normalize_abbr(value):
    raw = str(value or "").strip().upper()
    return ABBR_ALIASES.get(raw, raw)


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def parse_date(value):
    text = str(value or "").strip()
    if not text:
        return None
    iso = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if iso:
        return f"{iso.group(1)}-{int(iso.group(2)):02d}-{int(iso.group(3)):02d}"
    mdy = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if mdy:
        return f"{mdy.group(3)}-{int(mdy.group(1)):02d}-{int(mdy.group(2)):02d}"
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.date().isoformat()
    except ValueError:
        return None


def first(mapping, keys):
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return value
    return None


def http_bytes(url, headers=None, attempts=4, timeout=30):
    last_error = None
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers=headers or RAW_HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last_error = error
            code = getattr(error, "code", None)
            if code is not None and code not in (403, 408, 425, 429) and code < 500:
                break
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"Request failed for {url}: {last_error}")


def http_json(url, headers=None, attempts=4, timeout=30):
    body = http_bytes(url, headers=headers, attempts=attempts, timeout=timeout)
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid JSON from {url}: {error}") from error


def find_schedule_games(payload):
    schedule = payload.get("leagueSchedule") or payload.get("LeagueSchedule") or payload
    season = clean_text(schedule.get("seasonYear") or schedule.get("season") or "")
    if season and season != SEASON_LABEL:
        raise RuntimeError(f"NBA schedule reports season {season}; expected {SEASON_LABEL}")
    dates = schedule.get("gameDates") or schedule.get("GameDates") or []
    games = []
    for date_group in dates:
        for game in date_group.get("games") or date_group.get("Games") or []:
            game_id = clean_text(game.get("gameId") or game.get("GameID"))
            if not re.fullmatch(r"002\d{7}", game_id):
                continue
            raw_date = first(game, ("gameDateEst", "gameDate", "gameDateTimeEst"))
            raw_date = raw_date or date_group.get("gameDate") or date_group.get("GameDate")
            game_date = parse_date(raw_date)
            home = game.get("homeTeam") or game.get("HomeTeam") or {}
            away = game.get("awayTeam") or game.get("AwayTeam") or {}
            home_abbr = normalize_abbr(home.get("teamTricode") or home.get("teamAbbreviation") or home.get("teamCode"))
            away_abbr = normalize_abbr(away.get("teamTricode") or away.get("teamAbbreviation") or away.get("teamCode"))
            if not game_date or not home_abbr or not away_abbr:
                continue
            status = num(game.get("gameStatus") or game.get("gameStatusNum"))
            status_text = clean_text(game.get("gameStatusText") or game.get("gameStatus"))
            games.append({
                "gameId": game_id,
                "gameDate": game_date,
                "status": status,
                "statusText": status_text,
                "completed": status == 3 or "final" in status_text.lower(),
                "homeTeam": {
                    "teamId": clean_text(home.get("teamId") or home.get("teamID")),
                    "abbreviation": home_abbr,
                    "teamCity": clean_text(home.get("teamCity") or ""),
                    "teamName": clean_text(home.get("teamName") or home.get("teamCity") or home_abbr),
                },
                "awayTeam": {
                    "teamId": clean_text(away.get("teamId") or away.get("teamID")),
                    "abbreviation": away_abbr,
                    "teamCity": clean_text(away.get("teamCity") or ""),
                    "teamName": clean_text(away.get("teamName") or away.get("teamCity") or away_abbr),
                },
            })
    unique = {}
    for game in games:
        unique[game["gameId"]] = game
    return sorted(unique.values(), key=lambda game: (game["gameDate"], game["gameId"]))


def espn_game_date(value):
    text = clean_text(value)
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            return parsed.astimezone(NBA_SCHEDULE_TZ).date().isoformat()
        return parsed.date().isoformat()
    except ValueError:
        return parse_date(text)


def find_espn_schedule_games(payload):
    games = []
    for event in payload.get("events") or []:
        season = event.get("season") or {}
        season_type = season.get("type")
        if isinstance(season_type, dict):
            season_type = season_type.get("id") or season_type.get("slug")
        is_regular = str(season_type).lower() in ("2", "regular", "regular-season", "regular season")
        if str(season.get("year") or "") != str(SEASON_END_YEAR) or not is_regular:
            continue

        competition = next(iter(event.get("competitions") or []), {})
        competitors = competition.get("competitors") or []
        home = next((item for item in competitors if item.get("homeAway") == "home"), None)
        away = next((item for item in competitors if item.get("homeAway") == "away"), None)
        if not home or not away:
            continue

        def team_identity(competitor):
            team = competitor.get("team") or {}
            return {
                "teamId": clean_text(team.get("id")),
                "abbreviation": normalize_abbr(team.get("abbreviation")),
                "teamCity": clean_text(team.get("location") or ""),
                "teamName": clean_text(team.get("name") or team.get("displayName") or ""),
            }

        home_team = team_identity(home)
        away_team = team_identity(away)
        game_date = espn_game_date(event.get("date") or competition.get("date"))
        game_id = clean_text(event.get("id") or competition.get("id"))
        if not game_id or not game_date or not home_team["abbreviation"] or not away_team["abbreviation"]:
            continue

        status = competition.get("status") or event.get("status") or {}
        status_type = status.get("type") or {}
        if not isinstance(status_type, dict):
            status_type = {}
        status_text = clean_text(status_type.get("shortDetail") or status_type.get("detail") or status_type.get("description"))
        completed = bool(status_type.get("completed")) or clean_text(status_type.get("state")).lower() in ("post", "final") or "final" in status_text.lower()
        games.append({
            "gameId": game_id,
            "gameDate": game_date,
            "status": 3 if completed else None,
            "statusText": status_text,
            "completed": completed,
            "homeTeam": home_team,
            "awayTeam": away_team,
        })

    unique = {game["gameId"]: game for game in games}
    return sorted(unique.values(), key=lambda game: (game["gameDate"], game["gameId"]))


def fetch_espn_schedule():
    months = [(SEASON_START_YEAR, month) for month in (10, 11, 12)]
    months.extend((SEASON_END_YEAR, month) for month in (1, 2, 3, 4))
    month_payloads = {}
    errors = []

    def fetch_month(year_month):
        year, month = year_month
        query = urllib.parse.urlencode({"dates": f"{year}{month:02d}", "limit": "1000"})
        return http_json(ESPN_SCOREBOARD_URL + "?" + query, headers=RAW_HEADERS, attempts=4, timeout=35)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_month, item): item for item in months}
        for future in concurrent.futures.as_completed(futures):
            year, month = futures[future]
            label = f"{year}-{month:02d}"
            try:
                payload = future.result()
                month_games = find_espn_schedule_games(payload)
                if not month_games:
                    raise RuntimeError("no regular-season games returned")
                month_payloads[label] = month_games
            except Exception as error:
                errors.append(f"{label}: {error}")

    if errors:
        raise RuntimeError("ESPN schedule fallback was incomplete: " + "; ".join(errors))

    unique = {}
    for month_games in month_payloads.values():
        for game in month_games:
            unique[game["gameId"]] = game
    games = sorted(unique.values(), key=lambda game: (game["gameDate"], game["gameId"]))
    if not games:
        raise RuntimeError(f"ESPN schedule returned no {SEASON_LABEL} regular-season games")
    return games


def make_team_name(team):
    return clean_text(" ".join(part for part in (team.get("teamCity"), team.get("teamName")) if part)) or team["abbreviation"]


def parse_minutes(value):
    text = str(value or "").strip()
    iso = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$", text)
    if iso:
        return (int(iso.group(1) or 0) * 60) + int(iso.group(2) or 0) + (float(iso.group(3) or 0) / 60)
    return num(text)


def normalize_box_team(team, game, side, opponent):
    stats = team.get("statistics") or {}
    identity = game["homeTeam"] if side == "home" else game["awayTeam"]
    score = num(team.get("score"))
    if score is None:
        score = num(stats.get("points"))
    result = {
        "game_id": game["gameId"],
        "game_date": game["gameDate"],
        "team_id": clean_text(team.get("teamId") or identity.get("teamId")),
        "team_abbreviation": normalize_abbr(team.get("teamTricode") or identity["abbreviation"]),
        "team_display_name": make_team_name(identity),
        "team_name": clean_text(identity.get("teamName")),
        "team_home_away": side,
        "team_score": score,
        "team_winner": bool(score is not None and opponent is not None and score > opponent),
        "field_goals_made": num(stats.get("fieldGoalsMade")),
        "field_goals_attempted": num(stats.get("fieldGoalsAttempted")),
        "three_point_field_goals_made": num(stats.get("threePointersMade")),
        "three_point_field_goals_attempted": num(stats.get("threePointersAttempted")),
        "free_throws_made": num(stats.get("freeThrowsMade")),
        "free_throws_attempted": num(stats.get("freeThrowsAttempted")),
        "offensive_rebounds": num(stats.get("reboundsOffensive")),
        "defensive_rebounds": num(stats.get("reboundsDefensive")),
        "total_rebounds": num(stats.get("reboundsTotal")),
        "assists": num(stats.get("assists")),
        "turnovers": num(stats.get("turnovers")),
        "steals": num(stats.get("steals")),
        "blocks": num(stats.get("blocks")),
        "fouls": num(stats.get("foulsPersonal")),
        "points_in_paint": num(stats.get("pointsInThePaint")),
        "fast_break_points": num(stats.get("pointsFastBreak")),
        "turnover_points": num(stats.get("pointsFromTurnovers")),
        "largest_lead": num(stats.get("biggestLead")),
        "lead_changes": num(stats.get("leadChanges")),
    }
    missing = [key for key in CORE_FIELDS if result.get(key) is None]
    if missing:
        raise RuntimeError(f"Game {game['gameId']} {side} box score is missing required stats: {', '.join(missing)}")
    return result


def normalize_player_rows(team, game, side):
    rows = []
    stats_team = game["homeTeam"] if side == "home" else game["awayTeam"]
    for player in team.get("players") or []:
        stats = player.get("statistics") or {}
        minutes = parse_minutes(player.get("minutesCalculated") or stats.get("minutesCalculated") or stats.get("minutes"))
        name = clean_text(player.get("name") or player.get("nameI") or (clean_text(player.get("firstName")) + " " + clean_text(player.get("familyName"))))
        if not name:
            continue
        rows.append({
            "game_id": game["gameId"],
            "game_date": game["gameDate"],
            "team_id": clean_text(team.get("teamId") or stats_team.get("teamId")),
            "team_abbreviation": normalize_abbr(team.get("teamTricode") or stats_team["abbreviation"]),
            "athlete_id": clean_text(player.get("personId")),
            "athlete_display_name": name,
            "athlete_position_abbreviation": clean_text(player.get("position") or player.get("positionAbbreviation")),
            "minutes": minutes,
            "points": num(stats.get("points")),
            "starter": bool(player.get("starter")),
            "played": bool(player.get("played")) or (minutes is not None and minutes > 0),
        })
    return rows


def normalize_boxscore(payload, scheduled_game):
    game = payload.get("game") or payload.get("boxscore", {}).get("game") or {}
    home = game.get("homeTeam") or {}
    away = game.get("awayTeam") or {}
    if not home or not away:
        raise RuntimeError(f"NBA boxscore {scheduled_game['gameId']} did not contain both teams")
    home_abbr = normalize_abbr(home.get("teamTricode"))
    away_abbr = normalize_abbr(away.get("teamTricode"))
    if home_abbr != scheduled_game["homeTeam"]["abbreviation"] or away_abbr != scheduled_game["awayTeam"]["abbreviation"]:
        raise RuntimeError(f"NBA boxscore {scheduled_game['gameId']} teams did not match the schedule")
    home_score = num(home.get("score")) or num((home.get("statistics") or {}).get("points"))
    away_score = num(away.get("score")) or num((away.get("statistics") or {}).get("points"))
    home_row = normalize_box_team(home, scheduled_game, "home", away_score)
    away_row = normalize_box_team(away, scheduled_game, "away", home_score)
    return {
        "gameId": scheduled_game["gameId"],
        "gameDate": scheduled_game["gameDate"],
        "home": home_row,
        "away": away_row,
        "players": normalize_player_rows(away, scheduled_game, "away") + normalize_player_rows(home, scheduled_game, "home"),
        "source": "nba-live-boxscore",
    }


def first_csv_asset(tag, year_candidates):
    release = http_json(SPORTSDATAVERSE_RELEASE_API + urllib.parse.quote(tag, safe=""), headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": RAW_HEADERS["User-Agent"],
        "X-GitHub-Api-Version": "2022-11-28",
    })
    assets = release.get("assets") or []
    candidates = []
    for asset in assets:
        name = clean_text(asset.get("name")).lower()
        if not (name.endswith(".csv") or name.endswith(".csv.gz")):
            continue
        if any(str(year) in name for year in year_candidates):
            candidates.append(asset)
    if not candidates:
        raise RuntimeError(f"No season CSV found in SportsDataverse release {tag}")
    candidates.sort(key=lambda asset: (asset["name"].lower().endswith(".csv.gz"), asset["name"]), reverse=True)
    return candidates[0]


def load_sportsdataverse_fallback_rows():
    asset = first_csv_asset(
        "espn_nba_team_boxscores",
        (SEASON_START_YEAR, SEASON_END_YEAR),
    )
    body = http_bytes(asset["browser_download_url"], headers=RAW_HEADERS, attempts=4, timeout=90)
    if asset["name"].lower().endswith(".gz"):
        body = gzip.decompress(body)
    text = body.decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    return [{re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_"): value for key, value in row.items()} for row in rows]


def normalize_sd_row(row, scheduled_game, side, identity):
    def get(*keys):
        return first(row, keys)

    abbr = normalize_abbr(get("team_abbreviation", "team_abbrev", "team_tricode", "team_short_name"))
    if abbr != identity["abbreviation"]:
        raise RuntimeError("SportsDataverse fallback team abbreviation did not match schedule")
    def field_value(*keys):
        return num(get(*keys))

    return {
        "game_id": scheduled_game["gameId"],
        "game_date": scheduled_game["gameDate"],
        "team_id": clean_text(get("team_id", "teamid") or identity["teamId"]),
        "team_abbreviation": abbr,
        "team_display_name": make_team_name(identity),
        "team_name": identity.get("teamName") or "",
        "team_home_away": side,
        "team_score": field_value("team_score", "score", "points", "pts"),
        "team_winner": False,
        "field_goals_made": field_value("field_goals_made", "fgm"),
        "field_goals_attempted": field_value("field_goals_attempted", "fga"),
        "three_point_field_goals_made": field_value("three_point_field_goals_made", "fg3m", "fg3_m"),
        "three_point_field_goals_attempted": field_value("three_point_field_goals_attempted", "fg3a", "fg3_a"),
        "free_throws_made": field_value("free_throws_made", "ftm"),
        "free_throws_attempted": field_value("free_throws_attempted", "fta"),
        "offensive_rebounds": field_value("offensive_rebounds", "oreb"),
        "defensive_rebounds": field_value("defensive_rebounds", "dreb"),
        "total_rebounds": field_value("total_rebounds", "reb"),
        "assists": field_value("assists", "ast"),
        "turnovers": field_value("turnovers", "tov"),
        "steals": field_value("steals", "stl"),
        "blocks": field_value("blocks", "blk"),
        "fouls": field_value("fouls", "personal_fouls", "pf"),
        "points_in_paint": field_value("points_in_paint", "paint_points"),
        "fast_break_points": field_value("fast_break_points"),
        "turnover_points": field_value("turnover_points", "points_off_turnovers"),
        "largest_lead": field_value("largest_lead"),
        "lead_changes": field_value("lead_changes", "lead_change_count"),
    }


def try_sd_box_fallback(game, sd_rows):
    matched = {}
    for row in sd_rows:
        row_date = parse_date(first(row, ("game_date", "date", "game_date_time")))
        abbr = normalize_abbr(first(row, ("team_abbreviation", "team_abbrev", "team_tricode", "team_short_name")))
        if row_date != game["gameDate"] or abbr not in (game["homeTeam"]["abbreviation"], game["awayTeam"]["abbreviation"]):
            continue
        side = "home" if abbr == game["homeTeam"]["abbreviation"] else "away"
        identity = game["homeTeam"] if side == "home" else game["awayTeam"]
        matched[side] = normalize_sd_row(row, game, side, identity)
    if "home" not in matched or "away" not in matched:
        return None
    if any(matched[side].get(key) is None for side in matched for key in CORE_FIELDS):
        return None
    matched["home"]["team_winner"] = matched["home"]["team_score"] > matched["away"]["team_score"]
    matched["away"]["team_winner"] = matched["away"]["team_score"] > matched["home"]["team_score"]
    return {
        "gameId": game["gameId"],
        "gameDate": game["gameDate"],
        "home": matched["home"],
        "away": matched["away"],
        "players": [],
        "source": "sportsdataverse-espn-team-boxscores-fallback",
    }


def load_cached_box(game):
    path = RAW_ROOT / (game["gameId"] + ".json")
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text())
        if value.get("gameDate") == game["gameDate"] and value.get("home", {}).get("team_abbreviation") == game["homeTeam"]["abbreviation"]:
            return value
    except (OSError, json.JSONDecodeError):
        return None
    return None


def fetch_box_for_game(game):
    url = BOX_SCORE_URL.format(game_id=urllib.parse.quote(game["gameId"], safe=""))
    payload = http_json(url, headers=RAW_HEADERS, attempts=4, timeout=30)
    return normalize_boxscore(payload, game)


def complete_boxscores(games):
    RAW_ROOT.mkdir(parents=True, exist_ok=True)
    cutoff = TODAY - dt.timedelta(days=3)
    boxes = {}
    to_fetch = []
    errors = []
    for game in games:
        if not game["completed"]:
            continue
        cached = load_cached_box(game)
        if cached and game["gameDate"] < cutoff.isoformat():
            boxes[game["gameId"]] = cached
        elif not re.fullmatch(r"002\d{7}", game["gameId"]):
            # ESPN event IDs cannot be used with the NBA live boxscore URL.
            # Resolve these completed games from the SportsDataverse release.
            errors.append((game, RuntimeError("schedule fallback uses ESPN event ID")))
        else:
            to_fetch.append((game, cached))

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(fetch_box_for_game, game): (game, cached) for game, cached in to_fetch}
        for future in concurrent.futures.as_completed(futures):
            game, cached = futures[future]
            try:
                box = future.result()
            except Exception as error:
                if cached:
                    print(f"WARN boxscore refresh failed; retaining cached {game['gameId']}: {error}")
                    box = cached
                else:
                    errors.append((game, error))
                    continue
            boxes[game["gameId"]] = box

    sd_rows = None
    for game, error in errors:
        if sd_rows is None:
            try:
                print("NBA Live boxscore unavailable; loading SportsDataverse fallback release")
                sd_rows = load_sportsdataverse_fallback_rows()
            except Exception as fallback_error:
                raise RuntimeError(f"NBA boxscore {game['gameId']} failed ({error}); SportsDataverse fallback failed ({fallback_error})") from fallback_error
        box = try_sd_box_fallback(game, sd_rows)
        if not box:
            raise RuntimeError(f"NBA boxscore {game['gameId']} failed ({error}); no complete SportsDataverse fallback row pair found")
        boxes[game["gameId"]] = box
        print(f"INFO used SportsDataverse boxscore fallback for {game['gameId']}")

    for game_id, box in boxes.items():
        path = RAW_ROOT / (game_id + ".json")
        box["cachedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        path.write_text(json.dumps(box, separators=(",", ":"), allow_nan=False))
    return boxes


def pair_rows(rows):
    by_game = {}
    for row in rows:
        by_game.setdefault(str(row["game_id"]), []).append(row)
    pairs = {}
    for game_id, group in by_game.items():
        if len(group) < 2:
            continue
        for row in group:
            opp = next((candidate for candidate in group if candidate["team_id"] != row["team_id"]), None)
            if opp:
                pairs[(game_id, row["team_id"])] = opp
    return pairs


def value_for(row, key):
    return num(row.get(key))


def calculate_split(rows, pairs):
    games = []
    for row in rows:
        opponent = pairs.get((str(row["game_id"]), str(row["team_id"])))
        if opponent:
            games.append((row, opponent))
    gp = len(games)
    if not gp:
        return empty_split()

    team_rows = [item[0] for item in games]
    opp_rows = [item[1] for item in games]
    pts = total(team_rows, "team_score")
    opp_pts = total(opp_rows, "team_score")
    fga = total(team_rows, "field_goals_attempted")
    fgm = total(team_rows, "field_goals_made")
    fg3a = total(team_rows, "three_point_field_goals_attempted")
    fg3m = total(team_rows, "three_point_field_goals_made")
    fta = total(team_rows, "free_throws_attempted")
    ftm = total(team_rows, "free_throws_made")
    oreb = total(team_rows, "offensive_rebounds")
    dreb = total(team_rows, "defensive_rebounds")
    tov = total(team_rows, "turnovers")
    ast = total(team_rows, "assists")
    stl = total(team_rows, "steals")
    blk = total(team_rows, "blocks")
    pf = total(team_rows, "fouls")
    opp_fga = total(opp_rows, "field_goals_attempted")
    opp_fgm = total(opp_rows, "field_goals_made")
    opp_3a = total(opp_rows, "three_point_field_goals_attempted")
    opp_3m = total(opp_rows, "three_point_field_goals_made")
    opp_fta = total(opp_rows, "free_throws_attempted")
    opp_ftm = total(opp_rows, "free_throws_made")
    opp_oreb = total(opp_rows, "offensive_rebounds")
    opp_dreb = total(opp_rows, "defensive_rebounds")
    opp_tov = total(opp_rows, "turnovers")

    team_estimate = None
    opp_estimate = None
    team_rebound_rate = safe_div(oreb, oreb + opp_dreb) if oreb is not None and opp_dreb is not None else None
    opp_rebound_rate = safe_div(opp_oreb, opp_oreb + dreb) if opp_oreb is not None and dreb is not None else None
    if None not in (fga, fta, oreb, opp_dreb, fgm, tov, team_rebound_rate):
        team_estimate = fga + 0.4 * fta - 1.07 * team_rebound_rate * (fga - fgm) + tov
    if None not in (opp_fga, opp_fta, opp_oreb, dreb, opp_fgm, opp_tov, opp_rebound_rate):
        opp_estimate = opp_fga + 0.4 * opp_fta - 1.07 * opp_rebound_rate * (opp_fga - opp_fgm) + opp_tov
    team_poss = (team_estimate + opp_estimate) / 2 if team_estimate is not None and opp_estimate is not None else None
    poss_per_game = safe_div(team_poss, gp)
    team_turnover_denominator = fga + 0.44 * fta + tov if None not in (fga, fta, tov) else None
    opp_turnover_denominator = opp_fga + 0.44 * opp_fta + opp_tov if None not in (opp_fga, opp_fta, opp_tov) else None

    wins = sum(1 for row, opp in games if value_for(row, "team_score") is not None and value_for(opp, "team_score") is not None and value_for(row, "team_score") > value_for(opp, "team_score"))
    losses = gp - wins
    offense = {
        "pointsPerGame": metric(safe_div(pts, gp)),
        "offensiveRating": metric(safe_div(pts * 100, team_poss) if pts is not None else None),
        "pace": metric(poss_per_game),
        "possessions": metric(poss_per_game),
        "fieldGoalsMade": metric(safe_div(fgm, gp)),
        "fieldGoalsAttempted": metric(safe_div(fga, gp)),
        "fieldGoalPct": metric(safe_div(fgm, fga)),
        "twoPointPct": metric(safe_div(fgm - fg3m, fga - fg3a) if fgm is not None and fg3m is not None and fga is not None and fg3a is not None else None),
        "threePointersMade": metric(safe_div(fg3m, gp)),
        "threePointersAttempted": metric(safe_div(fg3a, gp)),
        "threePointPct": metric(safe_div(fg3m, fg3a)),
        "threePointAttemptRate": metric(safe_div(fg3a, fga)),
        "freeThrowsMade": metric(safe_div(ftm, gp)),
        "freeThrowsAttempted": metric(safe_div(fta, gp)),
        "freeThrowPct": metric(safe_div(ftm, fta)),
        "freeThrowAttemptRate": metric(safe_div(fta, fga)),
        "effectiveFgPct": metric(safe_div(fgm + 0.5 * fg3m, fga) if fgm is not None and fg3m is not None else None),
        "trueShootingPct": metric(safe_div(pts, 2 * (fga + 0.44 * fta)) if pts is not None and fga is not None and fta is not None else None),
        "assists": metric(safe_div(ast, gp)),
        "assistToTurnover": metric(safe_div(ast, tov)),
        "turnovers": metric(safe_div(tov, gp), True),
        "turnoverPct": metric(safe_div(tov, team_turnover_denominator), True),
        "offensiveRebounds": metric(safe_div(oreb, gp)),
        "totalRebounds": metric(safe_div((oreb + dreb) if oreb is not None and dreb is not None else None, gp)),
        "offensiveReboundPct": metric(safe_div(oreb, oreb + opp_dreb) if oreb is not None and opp_dreb is not None else None),
        "pointsInPaint": metric(average_field(team_rows, "points_in_paint")),
        "fastBreakPoints": metric(average_field(team_rows, "fast_break_points")),
        "pointsOffTurnovers": metric(average_field(team_rows, "turnover_points")),
        "largestLead": metric(average_field(team_rows, "largest_lead")),
        "leadChanges": metric(average_field(team_rows, "lead_changes")),
    }
    defense = {
        "pointsAllowedPerGame": metric(safe_div(opp_pts, gp), True),
        "defensiveRating": metric(safe_div(opp_pts * 100, team_poss) if opp_pts is not None else None, True),
        "opponentFieldGoalPct": metric(safe_div(opp_fgm, opp_fga), True),
        "opponentTwoPointPct": metric(safe_div(opp_fgm - opp_3m, opp_fga - opp_3a) if opp_fgm is not None and opp_3m is not None and opp_fga is not None and opp_3a is not None else None, True),
        "opponentThreePointPct": metric(safe_div(opp_3m, opp_3a), True),
        "opponentThreePointAttemptRate": metric(safe_div(opp_3a, opp_fga), True),
        "opponentFreeThrowPct": metric(safe_div(opp_ftm, opp_fta), True),
        "opponentFreeThrowRate": metric(safe_div(opp_fta, opp_fga), True),
        "opponentEffectiveFgPct": metric(safe_div(opp_fgm + 0.5 * opp_3m, opp_fga) if opp_fgm is not None and opp_3m is not None else None, True),
        "opponentTrueShootingPct": metric(safe_div(opp_pts, 2 * (opp_fga + 0.44 * opp_fta)) if opp_pts is not None and opp_fga is not None and opp_fta is not None else None, True),
        "opponentTurnovers": metric(safe_div(opp_tov, gp)),
        "opponentTurnoverPct": metric(safe_div(opp_tov, opp_turnover_denominator)),
        "defensiveRebounds": metric(safe_div(dreb, gp)),
        "defensiveReboundPct": metric(safe_div(dreb, dreb + opp_oreb) if dreb is not None and opp_oreb is not None else None),
        "offensiveReboundsAllowed": metric(safe_div(opp_oreb, gp), True),
        "steals": metric(safe_div(stl, gp)),
        "blocks": metric(safe_div(blk, gp)),
        "fouls": metric(safe_div(pf, gp), True),
        "pointsInPaintAllowed": metric(average_field(opp_rows, "points_in_paint"), True),
        "fastBreakPointsAllowed": metric(average_field(opp_rows, "fast_break_points"), True),
        "pointsAllowedOffTurnovers": metric(average_field(opp_rows, "turnover_points"), True),
        "opponentAssists": metric(safe_div(total(opp_rows, "assists"), gp), True),
        "opponentTotalRebounds": metric(safe_div((opp_oreb + opp_dreb) if opp_oreb is not None and opp_dreb is not None else None, gp), True),
        "opponentDefensiveRebounds": metric(safe_div(opp_dreb, gp), True),
    }
    advanced = {
        "netRating": metric(value_or_none(offense["offensiveRating"]["value"]) - value_or_none(defense["defensiveRating"]["value"]) if offense["offensiveRating"]["value"] is not None and defense["defensiveRating"]["value"] is not None else None),
        "averageMargin": metric(safe_div(pts - opp_pts, gp) if pts is not None and opp_pts is not None else None),
        "assistRate": metric(safe_div(ast, fgm)),
        "assistPct": metric(safe_div(ast, fgm)),
        "totalReboundPct": metric(safe_div((oreb + dreb) if oreb is not None and dreb is not None else None, (oreb + dreb + opp_oreb + opp_dreb) if None not in (oreb, dreb, opp_oreb, opp_dreb) else None)),
    }
    return {
        "sampleSize": gp,
        "record": {
            "gamesPlayed": metric(gp),
            "wins": metric(wins),
            "losses": metric(losses, True),
            "winPct": metric(safe_div(wins, gp)),
            "plusMinus": metric(safe_div(pts - opp_pts, gp) if pts is not None and opp_pts is not None else None),
        },
        "offense": offense,
        "defense": defense,
        "advanced": advanced,
    }


def value_or_none(value):
    return num(value)


def empty_split():
    offense_keys = (
        "pointsPerGame", "offensiveRating", "pace", "possessions", "fieldGoalsMade", "fieldGoalsAttempted",
        "fieldGoalPct", "twoPointPct", "threePointersMade", "threePointersAttempted", "threePointPct",
        "threePointAttemptRate", "freeThrowsMade", "freeThrowsAttempted", "freeThrowPct", "freeThrowAttemptRate",
        "effectiveFgPct", "trueShootingPct", "assists", "assistToTurnover", "turnovers", "turnoverPct",
        "offensiveRebounds", "totalRebounds", "offensiveReboundPct", "pointsInPaint", "fastBreakPoints",
        "pointsOffTurnovers", "largestLead", "leadChanges", "assistPct",
    )
    defense_keys = (
        "pointsAllowedPerGame", "defensiveRating", "opponentFieldGoalPct", "opponentTwoPointPct",
        "opponentThreePointPct", "opponentThreePointAttemptRate", "opponentFreeThrowPct", "opponentFreeThrowRate",
        "opponentEffectiveFgPct", "opponentTrueShootingPct", "opponentTurnovers", "opponentTurnoverPct",
        "defensiveRebounds", "defensiveReboundPct", "offensiveReboundsAllowed", "steals", "blocks", "fouls",
        "pointsInPaintAllowed", "fastBreakPointsAllowed", "pointsAllowedOffTurnovers", "opponentAssists",
        "opponentTotalRebounds", "opponentDefensiveRebounds",
    )
    advanced_keys = ("netRating", "averageMargin", "assistRate", "assistPct", "totalReboundPct")
    return {
        "sampleSize": 0,
        "record": {
            "gamesPlayed": metric(0), "wins": metric(0), "losses": metric(0, True),
            "winPct": metric(None), "plusMinus": metric(None),
        },
        "offense": {key: metric(None, key in ("turnovers", "turnoverPct")) for key in offense_keys},
        "defense": {key: metric(None, key in ("pointsAllowedPerGame", "defensiveRating", "opponentFieldGoalPct", "opponentTwoPointPct", "opponentThreePointPct", "opponentThreePointAttemptRate", "opponentFreeThrowPct", "opponentFreeThrowRate", "opponentEffectiveFgPct", "opponentTrueShootingPct", "offensiveReboundsAllowed", "fouls", "pointsInPaintAllowed", "fastBreakPointsAllowed", "pointsAllowedOffTurnovers", "opponentAssists", "opponentTotalRebounds", "opponentDefensiveRebounds")) for key in defense_keys},
        "advanced": {key: metric(None) for key in advanced_keys},
    }


def apply_official_advanced(split, api_row):
    gp = num(api_row.get("GP"))
    if gp is None or int(gp) != int(split.get("sampleSize", 0)):
        return False
    touched = False
    for section, fields in METRIC_MAP.items():
        for field, source_key in fields.items():
            raw = num(api_row.get(source_key))
            if raw is None:
                continue
            split.setdefault(section, {})
            current = split[section].get(field) or metric(None)
            current["value"] = rounded(raw)
            current["source"] = "nba-stats-leaguedashteamstats"
            split[section][field] = current
            touched = True
    return touched


def fetch_official_advanced():
    result = {}
    errors = {}
    date_to = (TODAY - dt.timedelta(days=1)).strftime("%m/%d/%Y")
    for name, config in TIMEFRAMES.items():
        params = {
            "Conference": "", "DateFrom": "", "DateTo": date_to, "Division": "",
            "GameScope": "", "GameSegment": "", "LastNGames": str(config["last_n"]),
            "LeagueID": "00", "Location": config["location"], "MeasureType": "Advanced",
            "Month": "0", "OpponentTeamID": "0", "Outcome": "", "PORound": "0",
            "PaceAdjust": "N", "PerMode": "PerGame", "Period": "0", "PlayerExperience": "",
            "PlayerPosition": "", "PlusMinus": "N", "Rank": "N", "Season": SEASON_LABEL,
            "SeasonType": "Regular Season", "SeasonSegment": "", "ShotClockRange": "", "StarterBench": "", "TeamID": "",
            "TwoWay": "", "VsConference": "", "VsDivision": "",
        }
        url = NBA_STATS_URL + "?" + urllib.parse.urlencode(params)
        try:
            payload = http_json(url, headers=NBA_HEADERS, attempts=4, timeout=25)
            sets = payload.get("resultSets") or payload.get("resultSet") or []
            if isinstance(sets, dict):
                sets = [sets]
            dataset = next((item for item in sets if item.get("name") == "LeagueDashTeamStats"), sets[0] if sets else None)
            if not dataset:
                raise RuntimeError("NBA Stats response has no LeagueDashTeamStats result set")
            headers = [str(item) for item in dataset.get("headers") or []]
            rows = dataset.get("rowSet") or dataset.get("row_set") or []
            frame = {}
            for values in rows:
                row = dict(zip(headers, values))
                team_id = clean_text(row.get("TEAM_ID"))
                if team_id:
                    frame[team_id] = row
            result[name] = frame
            print(f"INFO NBA Stats Advanced {name}: {len(frame)} teams (DateTo {date_to})")
        except Exception as error:
            errors[name] = str(error)
            result[name] = {}
            print(f"WARN NBA Stats Advanced {name} unavailable; using boxscore-derived metrics: {error}")
        time.sleep(1)
    return result, errors, date_to


def normalized_schedule():
    schedule_source = "nba-live-schedule"
    try:
        payload = http_json(SCHEDULE_URL, headers=NBA_HEADERS, attempts=4, timeout=35)
        games = find_schedule_games(payload)
        if not games:
            raise RuntimeError(f"NBA schedule returned no {SEASON_LABEL} regular-season games")
    except Exception as nba_error:
        print(f"WARN NBA schedule endpoint unavailable; trying ESPN monthly schedule fallback: {nba_error}")
        try:
            games = fetch_espn_schedule()
            schedule_source = "espn-scoreboard-fallback"
        except Exception as espn_error:
            raise RuntimeError(f"NBA schedule failed ({nba_error}); ESPN fallback failed ({espn_error})") from espn_error

    teams = {}
    for game in games:
        for side in ("homeTeam", "awayTeam"):
            team = game[side]
            abbr = team["abbreviation"]
            if not team.get("teamId") or not abbr:
                continue
            teams[abbr] = {
                "id": team["teamId"],
                "abbreviation": abbr,
                "displayName": make_team_name(team),
                "name": team.get("teamName") or "",
            }
    if len(teams) != 30:
        raise RuntimeError(f"NBA schedule identified {len(teams)} teams, expected 30; refusing to publish incomplete league data")
    return games, teams, schedule_source


def team_rows_from_boxes(boxes, games):
    rows = []
    players = []
    for game in games:
        box = boxes.get(game["gameId"])
        if not box:
            continue
        for side in ("home", "away"):
            row = box[side]
            rows.append(row)
        players.extend(box.get("players") or [])
    rows.sort(key=lambda row: (row["game_date"], row["game_id"], row["team_home_away"]))
    return rows, players


def rows_for_team(rows, identity):
    return sorted(
        [row for row in rows if str(row.get("team_id")) == str(identity.get("id")) or normalize_abbr(row.get("team_abbreviation")) == identity.get("abbreviation")],
        key=lambda row: (row.get("game_date") or "", row.get("game_id") or ""),
    )


def rank_split(frame, identities):
    sections = ("record", "offense", "defense", "advanced")
    ranked = {abbr: json.loads(json.dumps(split)) for abbr, split in frame.items()}
    for abbr, split in ranked.items():
        for section in sections:
            values_by_key = {}
            for team_abbr, team_split in frame.items():
                metrics = team_split.get(section) or {}
                for key, item in metrics.items():
                    value = num(item.get("value")) if isinstance(item, dict) else None
                    if value is not None:
                        values_by_key.setdefault(key, []).append((team_abbr, value, bool(item.get("lowerIsBetter"))))
            for key, current in (split.get(section) or {}).items():
                if not isinstance(current, dict):
                    continue
                pool = values_by_key.get(key, [])
                if not pool or num(current.get("value")) is None:
                    current["rank"] = None
                    current["percentile"] = None
                    continue
                lower = bool(current.get("lowerIsBetter"))
                pool.sort(key=lambda item: ((item[1] if lower else -item[1]), identities[item[0]]["displayName"]))
                index = next((i for i, item in enumerate(pool) if item[0] == abbr), -1)
                current["rank"] = index + 1 if index >= 0 else None
                current["percentile"] = round((1 - index / (len(pool) - 1)) * 100, 1) if index >= 0 and len(pool) > 1 else None
    return ranked


def timeframe_rows(team_rows, frame):
    if frame == "season":
        return team_rows
    if frame.startswith("last"):
        limit = int(frame[4:])
        return team_rows[-limit:]
    if frame == "home":
        return [row for row in team_rows if row.get("team_home_away") == "home"]
    if frame == "away":
        return [row for row in team_rows if row.get("team_home_away") == "away"]
    return team_rows


def make_all_frames(rows_before, pairs, identities, official_frames=None, use_official=False):
    frames = {}
    for frame_name in TIMEFRAMES:
        aggregate = {}
        for abbr, identity in identities.items():
            team_rows = rows_for_team(rows_before, identity)
            selected = timeframe_rows(team_rows, frame_name)
            aggregate[abbr] = calculate_split(selected, pairs)
            official_frame = (official_frames or {}).get(frame_name) or {}
            api_row = official_frame.get(str(identity["id"]))
            if api_row is None:
                for candidate in official_frame.values():
                    candidate_abbr = normalize_abbr(candidate.get("TEAM_ABBREVIATION"))
                    if not candidate_abbr:
                        candidate_abbr = NAME_TO_ABBR.get(clean_text(candidate.get("TEAM_NAME")).lower(), "")
                    if candidate_abbr == abbr:
                        api_row = candidate
                        break
            if use_official and api_row:
                apply_official_advanced(aggregate[abbr], api_row)
        frames[frame_name] = rank_split(aggregate, identities)
    return frames


def build_game_log(rows, pairs):
    out = []
    for row in rows:
        opponent = pairs.get((str(row["game_id"]), str(row["team_id"])))
        if not opponent:
            continue
        score = num(row.get("team_score"))
        opp_score = num(opponent.get("team_score"))
        out.append({
            "gameId": row.get("game_id"),
            "date": row.get("game_date"),
            "homeAway": row.get("team_home_away"),
            "opponent": opponent.get("team_display_name"),
            "opponentAbbr": opponent.get("team_abbreviation"),
            "result": "W" if score is not None and opp_score is not None and score > opp_score else "L",
            "teamScore": score,
            "opponentScore": opp_score,
            "margin": score - opp_score if score is not None and opp_score is not None else None,
            "stats": {
                "assists": row.get("assists"),
                "rebounds": row.get("total_rebounds"),
                "turnovers": row.get("turnovers"),
                "fieldGoalPct": safe_div(row.get("field_goals_made"), row.get("field_goals_attempted")),
                "threePointPct": safe_div(row.get("three_point_field_goals_made"), row.get("three_point_field_goals_attempted")),
                "freeThrowPct": safe_div(row.get("free_throws_made"), row.get("free_throws_attempted")),
                "offensiveRebounds": row.get("offensive_rebounds"),
                "defensiveRebounds": row.get("defensive_rebounds"),
                "steals": row.get("steals"),
                "blocks": row.get("blocks"),
                "fouls": row.get("fouls"),
                "pointsInPaint": row.get("points_in_paint"),
                "fastBreakPoints": row.get("fast_break_points"),
                "pointsOffTurnovers": row.get("turnover_points"),
                "largestLead": row.get("largest_lead"),
                "leadChanges": row.get("lead_changes"),
            },
        })
    return out


def build_rotation(player_rows, identity, game_date):
    team_players = [row for row in player_rows if row.get("team_abbreviation") == identity["abbreviation"] and row.get("game_date", "") < game_date and row.get("played")]
    game_ids = sorted(set(row["game_id"] for row in team_players), key=lambda game_id: max((r["game_date"] for r in team_players if r["game_id"] == game_id), default=""))
    last_ids = set(game_ids[-10:])
    recent = [row for row in team_players if row["game_id"] in last_ids]
    grouped = {}
    for row in recent:
        key = row.get("athlete_id") or row.get("athlete_display_name")
        grouped.setdefault(key, []).append(row)
    players = []
    for player_games in grouped.values():
        player_games.sort(key=lambda row: row.get("game_date") or "")
        latest = player_games[-1]
        players.append({
            "playerId": latest.get("athlete_id"),
            "player": latest.get("athlete_display_name"),
            "position": latest.get("athlete_position_abbreviation") or "",
            "games": len(player_games),
            "minutesPerGame": average([row.get("minutes") for row in player_games]),
            "pointsPerGame": average([row.get("points") for row in player_games]),
            "starts": sum(1 for row in player_games if row.get("starter")),
        })
    players.sort(key=lambda row: (-(num(row["minutesPerGame"]) or -1), -(num(row["starts"]) or 0)))
    players = players[:10]
    continuity = None
    if players:
        threshold = min(5, int(players[0]["games"] or 5))
        continuity = safe_div(sum(1 for row in players if row["games"] >= threshold), len(players))
    points_by_game = {}
    for row in recent:
        bucket = points_by_game.setdefault(row["game_id"], {"starters": 0, "bench": 0})
        key = "starters" if row.get("starter") else "bench"
        bucket[key] += num(row.get("points")) or 0
    return {
        "available": bool(players),
        "players": players,
        "continuity": continuity,
        "starterPointsPerGame": average([row["starters"] for row in points_by_game.values()]),
        "benchPointsPerGame": average([row["bench"] for row in points_by_game.values()]),
    }


def day_diff(start, end):
    try:
        return (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days
    except (TypeError, ValueError):
        return None


def build_schedule_context(team_rows, game_date, schedule_games, identity):
    prior = [row["game_date"] for row in team_rows if row.get("game_date") and row["game_date"] < game_date]
    prior = sorted(set(prior))
    previous = prior[-1] if prior else None
    rest_days = max(0, day_diff(previous, game_date) - 1) if previous else None
    recent = [date for date in prior if 0 <= (day_diff(date, game_date) or 999) <= 7]
    return {
        "previousGameDate": previous,
        "restDays": rest_days,
        "backToBack": rest_days == 0 if rest_days is not None else False,
        "gamesInLast7Days": len(recent),
        "scheduleRowsAvailable": bool(schedule_games),
    }


def empty_series_bucket():
    return {"afterWin": {"wins": 0, "losses": 0}, "afterLoss": {"wins": 0, "losses": 0}}


def build_series_context(team_rows, pairs, identity, game_date, current_side):
    completed = rows_for_team(team_rows, identity)
    completed = [row for row in completed if row.get("game_date", "") < game_date]
    buckets = {"away": empty_series_bucket(), "home": empty_series_bucket(), "b2b": empty_series_bucket()}
    previous_row = None
    previous_result = None
    for row in completed:
        opponent = pairs.get((str(row["game_id"]), str(row["team_id"])))
        if not opponent:
            continue
        score = num(row.get("team_score"))
        opp_score = num(opponent.get("team_score"))
        if score is None or opp_score is None or score == opp_score:
            continue
        result = "W" if score > opp_score else "L"
        contexts = []
        if row.get("team_home_away") in ("home", "away"):
            contexts.append(row["team_home_away"])
        if previous_row and day_diff(previous_row.get("game_date"), row.get("game_date")) == 1:
            contexts.append("b2b")
        if previous_result in ("W", "L"):
            result_key = "afterWin" if previous_result == "W" else "afterLoss"
            for context in contexts:
                buckets[context][result_key]["wins" if result == "W" else "losses"] += 1
        previous_row = row
        previous_result = result
    last_date = previous_row.get("game_date") if previous_row else None
    return {
        "rows": buckets,
        "current": {
            "row": current_side,
            "afterResult": previous_result,
            "backToBack": bool(last_date and day_diff(last_date, game_date) == 1),
        },
    }


def compact_stats(row):
    fga = num(row.get("field_goals_attempted"))
    fgm = num(row.get("field_goals_made"))
    fg3a = num(row.get("three_point_field_goals_attempted"))
    fg3m = num(row.get("three_point_field_goals_made"))
    fta = num(row.get("free_throws_attempted"))
    oreb = num(row.get("offensive_rebounds"))
    dreb = num(row.get("defensive_rebounds"))
    tov = num(row.get("turnovers"))
    points = num(row.get("team_score"))
    possessions = fga + 0.44 * fta - oreb + tov if None not in (fga, fta, oreb, tov) else None
    return {
        "possessions": rounded(possessions, 2),
        "offensiveRating": rounded(points * 100 / possessions, 2) if points is not None and possessions else None,
        "fieldGoalPct": rounded(safe_div(fgm, fga)),
        "threePointPct": rounded(safe_div(fg3m, fg3a)),
        "effectiveFgPct": rounded(safe_div(fgm + 0.5 * fg3m, fga) if fgm is not None and fg3m is not None else None),
        "rebounds": (oreb + dreb) if oreb is not None and dreb is not None else None,
        "offensiveRebounds": oreb,
        "defensiveRebounds": dreb,
        "assists": num(row.get("assists")),
        "turnovers": tov,
        "pointsInPaint": num(row.get("points_in_paint")),
        "fastBreakPoints": num(row.get("fast_break_points")),
    }


def build_h2h(rows, pairs, away, home, game_date, limit=10):
    meetings = []
    for row in rows_for_team(rows, away):
        if row.get("game_date", "") >= game_date:
            continue
        opp = pairs.get((str(row["game_id"]), str(row["team_id"])))
        if not opp or normalize_abbr(opp.get("team_abbreviation")) != home["abbreviation"]:
            continue
        row_is_away = row.get("team_home_away") == "away"
        away_row, home_row = (row, opp) if row_is_away else (opp, row)
        away_score = num(away_row.get("team_score"))
        home_score = num(home_row.get("team_score"))
        if away_score is None or home_score is None:
            continue
        meetings.append({
            "gameId": row.get("game_id"),
            "date": row.get("game_date"),
            "awayTeam": away_row.get("team_display_name"),
            "homeTeam": home_row.get("team_display_name"),
            "awayScore": away_score,
            "homeScore": home_score,
            "winner": away_row.get("team_display_name") if away_score > home_score else home_row.get("team_display_name"),
            "margin": abs(away_score - home_score),
            "total": away_score + home_score,
            "awayStats": compact_stats(away_row),
            "homeStats": compact_stats(home_row),
        })
    meetings.sort(key=lambda row: row["date"], reverse=True)
    meetings = meetings[:limit]
    away_wins = sum(1 for game in meetings if game["awayScore"] > game["homeScore"])
    return {
        "meetings": meetings,
        "meetingCount": len(meetings),
        "awayWins": away_wins,
        "homeWins": len(meetings) - away_wins,
        "averageAwayScore": average([game["awayScore"] for game in meetings]),
        "averageHomeScore": average([game["homeScore"] for game in meetings]),
        "averageTotal": average([game["total"] for game in meetings]),
        "averageMargin": average([game["margin"] for game in meetings]),
        "averagePace": average([average([game["awayStats"].get("possessions"), game["homeStats"].get("possessions")]) for game in meetings]),
        "awayAverageFieldGoalPct": average([game["awayStats"].get("fieldGoalPct") for game in meetings]),
        "homeAverageFieldGoalPct": average([game["homeStats"].get("fieldGoalPct") for game in meetings]),
        "awayAverageRebounds": average([game["awayStats"].get("rebounds") for game in meetings]),
        "homeAverageRebounds": average([game["homeStats"].get("rebounds") for game in meetings]),
        "awayAverageTurnovers": average([game["awayStats"].get("turnovers") for game in meetings]),
        "homeAverageTurnovers": average([game["homeStats"].get("turnovers") for game in meetings]),
    }


def leaderboard_section(teams, season_splits, metric_id, label, section, field, lower=False, record=False):
    rows = []
    for abbr, identity in teams.items():
        split = season_splits.get(abbr) or {}
        value_obj = split.get("record") if record else (split.get(section) or {}).get(field)
        numeric = num(value_obj.get("winPct", {}).get("value")) if record else num(value_obj.get("value"))
        rows.append({
            "teamId": identity["id"],
            "teamKey": abbr,
            "teamAbbr": abbr,
            "teamName": identity["displayName"],
            "metric": value_obj,
            "numericValue": numeric,
            "displayValue": value_obj.get("winPct", {}).get("value") if record and value_obj else value_obj.get("value") if value_obj else None,
            "recordText": str(int(num(value_obj.get("wins", {}).get("value")) or 0)) + "-" + str(int(num(value_obj.get("losses", {}).get("value")) or 0)) if record and value_obj else None,
        })
    valid = [row for row in rows if row["numericValue"] is not None]
    valid.sort(key=lambda row: ((row["numericValue"] if lower else -row["numericValue"]), row["teamName"]))
    rank_by_team = {}
    prior_value = None
    prior_rank = 0
    for index, row in enumerate(valid):
        if index and row["numericValue"] == prior_value:
            rank = prior_rank
        else:
            rank = index + 1
        rank_by_team[row["teamKey"]] = rank
        prior_value = row["numericValue"]
        prior_rank = rank
    for row in rows:
        row["rank"] = rank_by_team.get(row["teamKey"])
    rows.sort(key=lambda row: (row["rank"] if row["rank"] is not None else 999, row["teamName"]))
    return {"id": metric_id, "label": label, "path": [section, field], "lowerIsBetter": lower, "rows": rows}


def build_leaderboards(frames, teams):
    season = frames["season"]
    return {
        "offense": leaderboard_section(teams, season, "pointsPerGame", "Points/Game", "offense", "pointsPerGame"),
        "defense": leaderboard_section(teams, season, "pointsAllowedPerGame", "Points Allowed/Game", "defense", "pointsAllowedPerGame", True),
        "standings": leaderboard_section(teams, season, "record", "Record", "record", "record", record=True),
    }


def bundle_for_team(identity, frames, team_rows, player_rows, pairs, game_date, schedule_games):
    splits = {key: frames[key][identity["abbreviation"]] for key in TIMEFRAMES}
    season = splits["season"]
    team_history = [row for row in rows_for_team(team_rows, identity) if row.get("game_date", "") < game_date]
    recent = build_game_log(list(reversed(team_history[-15:])), pairs)
    series_games = build_game_log(team_history, pairs)
    return {
        "identity": {
            "id": identity["id"],
            "abbreviation": identity["abbreviation"],
            "displayName": identity["displayName"],
            "name": identity["name"],
        },
        "record": season["record"],
        "offense": season["offense"],
        "defense": season["defense"],
        "advanced": season["advanced"],
        "splits": {
            **splits,
            "l5": splits["last5"],
            "l10": splits["last10"],
            "l15": splits["last15"],
        },
        "recentGames": recent,
        "seriesGames": series_games,
        "rotation": build_rotation(player_rows, identity, game_date),
        "schedule": build_schedule_context(team_history, game_date, schedule_games, identity),
    }


def snapshot_for_game(game, all_rows, all_players, pairs, teams, official_frames, schedule_games):
    game_date = game["gameDate"]
    rows_before = [row for row in all_rows if row.get("game_date", "") < game_date]
    use_official = game_date >= TODAY.isoformat()
    frames = make_all_frames(rows_before, pairs, teams, official_frames, use_official)
    away_identity = teams[game["awayTeam"]["abbreviation"]]
    home_identity = teams[game["homeTeam"]["abbreviation"]]
    away = bundle_for_team(away_identity, frames, rows_before, all_players, pairs, game_date, schedule_games)
    home = bundle_for_team(home_identity, frames, rows_before, all_players, pairs, game_date, schedule_games)
    as_of_dates = [row["game_date"] for row in rows_before if row.get("game_date")]
    return {
        "success": True,
        "partial": False,
        "source": "nba-live-boxscore" if not use_official else "nba-live-boxscore+nba-stats-advanced-when-available",
        "sourceDescription": "NBA regular-season completed game box scores with official NBA Stats advanced metrics where available",
        "season": SEASON_END_YEAR,
        "seasonLabel": SEASON_LABEL,
        "seasonType": "Regular Season",
        "gameDate": game_date,
        "updatedAt": max(as_of_dates) if as_of_dates else None,
        "requestedGame": {
            "gameId": game["gameId"],
            "awayTeamAbbr": game["awayTeam"]["abbreviation"],
            "homeTeamAbbr": game["homeTeam"]["abbreviation"],
            "status": game.get("statusText"),
        },
        "away": away,
        "home": home,
        "seriesContext": {
            "away": build_series_context(rows_before, pairs, away_identity, game_date, "away"),
            "home": build_series_context(rows_before, pairs, home_identity, game_date, "home"),
        },
        "h2h": build_h2h(rows_before, pairs, away_identity, home_identity, game_date),
        "leaderboards": build_leaderboards(frames, teams),
        "league": {
            "teamCount": len(teams),
            "teams": [
                {"id": identity["id"], "abbreviation": identity["abbreviation"], "displayName": identity["displayName"]}
                for identity in sorted(teams.values(), key=lambda team: team["abbreviation"])
            ],
        },
    }


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    if path.exists() and path.read_text() == encoded:
        return False
    path.write_text(encoded)
    return True


def publish(games, teams, boxes, official_frames, official_errors, advanced_date_to, schedule_source):
    all_rows, all_players = team_rows_from_boxes(boxes, games)
    pairs = pair_rows(all_rows)
    published = []
    latest_team_frames = None
    current_game_dates = sorted(set(game["gameDate"] for game in games if game["gameDate"] >= TODAY.isoformat()))
    latest_snapshot_date = current_game_dates[0] if current_game_dates else TODAY.isoformat()

    for game in games:
        # Publish a pregame snapshot for every scheduled regular-season game.
        payload = snapshot_for_game(game, all_rows, all_players, pairs, teams, official_frames, games)
        if payload["league"]["teamCount"] != 30 or payload["away"]["identity"]["abbreviation"] == payload["home"]["identity"]["abbreviation"]:
            raise RuntimeError("Generated NBA game snapshot failed league/team validation")
        relative_path = "nba-team-stats/v1/" + SEASON_FOLDER + "/games/" + game["gameDate"] + "/" + game["awayTeam"]["abbreviation"] + "-" + game["homeTeam"]["abbreviation"] + ".json"
        output_path = OUTPUT_ROOT / relative_path
        write_json(output_path, payload)
        published.append({
            "gameId": game["gameId"],
            "gameDate": game["gameDate"],
            "awayTeamAbbr": game["awayTeam"]["abbreviation"],
            "homeTeamAbbr": game["homeTeam"]["abbreviation"],
            "status": game.get("statusText"),
            "completed": bool(game["completed"]),
            "path": relative_path.replace("nba-team-stats/v1/" + SEASON_FOLDER + "/", ""),
        })
        if game["gameDate"] == latest_snapshot_date:
            rows_before = [row for row in all_rows if row.get("game_date", "") < game["gameDate"]]
            latest_team_frames = make_all_frames(rows_before, pairs, teams, official_frames, game["gameDate"] >= TODAY.isoformat())

    if latest_team_frames is None:
        latest_team_frames = make_all_frames(
            [row for row in all_rows if row.get("game_date", "") < TODAY.isoformat()],
            pairs, teams, official_frames, True,
        )

    for frame_name, frame in latest_team_frames.items():
        for abbr, identity in teams.items():
            team_payload = {
                "success": True,
                "season": SEASON_END_YEAR,
                "seasonLabel": SEASON_LABEL,
                "seasonType": "Regular Season",
                "timeframe": frame_name,
                "updatedAt": max((row["game_date"] for row in all_rows if row["team_abbreviation"] == abbr and row.get("game_date")), default=None),
                "team": identity,
                "stats": frame[abbr],
            }
            write_json(PUBLISH_ROOT / "teams" / frame_name / (abbr + ".json"), team_payload)

    index = {
        "success": True,
        "schemaVersion": 1,
        "season": SEASON_END_YEAR,
        "seasonLabel": SEASON_LABEL,
        "seasonType": "Regular Season",
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "teamCount": len(teams),
        "completedGamesCached": len(boxes),
        "games": published,
        "sources": {
            "schedule": schedule_source,
            "teamGameRecords": "nba-live-boxscore-with-sportsdataverse-fallback",
            "officialAdvanced": "nba-stats-leaguedashteamstats",
            "officialAdvancedDateTo": advanced_date_to,
            "officialAdvancedFrameErrors": official_errors,
        },
    }
    write_json(PUBLISH_ROOT / "latest.json", index)
    write_json(PUBLISH_ROOT / "manifest.json", index)
    return len(published)


def main():
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"NBA stats publisher: season={SEASON_LABEL}, today={TODAY.isoformat()}")
    games, teams, schedule_source = normalized_schedule()
    print(f"NBA schedule loaded: {len(games)} games; {len(teams)} teams ({schedule_source})")
    boxes = complete_boxscores(games)
    print(f"Completed box scores available: {len(boxes)}")
    official_frames, official_errors, date_to = fetch_official_advanced()
    count = publish(games, teams, boxes, official_frames, official_errors, date_to, schedule_source)
    print(f"Published {count} NBA per-game snapshots, {len(teams)} teams, and {len(TIMEFRAMES)} timeframes.")


if __name__ == "__main__":
    main()

