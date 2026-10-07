#!/usr/bin/env python3
"""Build compact CFB opponent metrics and player game logs for the app cache branch."""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

OUTPUT = Path(os.environ.get("CFB_STATS_OUTPUT_DIR", "data"))
VERSION = int(os.environ.get("CFB_STATS_CACHE_VERSION", "24"))
NOW = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def current_season() -> int:
    now = datetime.now(timezone.utc)
    return now.year if now.month >= 8 else now.year - 1


def fetch_csv(url: str) -> list[dict[str, str]]:
    request = urllib.request.Request(url, headers={"User-Agent": "SportsEdgeAI-CFB-Prop-Cache/1.0", "Accept": "text/csv,*/*"})
    with urllib.request.urlopen(request, timeout=60) as response:
        text = response.read().decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(text.splitlines()))


def first(row: dict, *keys: str, default=""):
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip() != "":
            return value
    return default


def norm(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def number(value, default=0):
    try:
        parsed = float(str(value).replace(",", "").strip())
        return int(parsed) if parsed.is_integer() else parsed
    except (TypeError, ValueError):
        return default


def nullable_number(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = float(value)
        return int(parsed) if parsed.is_integer() else parsed
    except (TypeError, ValueError):
        return None


def make_opponent_cache(season: int):
    season_file = OUTPUT / f"cfb-team-stats/v{VERSION}/{season}/season.json"
    if not season_file.exists():
        print(f"No materialized team stats for {season}; compact opponent cache will be skipped.")
        return
    data = json.loads(season_file.read_text())
    teams = {}
    for key, payload in (data.get("teams") or {}).items():
        if not isinstance(payload, dict) or not isinstance(payload.get("stats"), dict):
            continue
        teams[key] = {
            "team": payload.get("team"),
            "teamKey": payload.get("teamKey") or key,
            "stats": {"defense": payload["stats"].get("defense") or {}},
            "ranks": {"defense": (payload.get("ranks") or {}).get("defense") or {}},
        }
    out = OUTPUT / f"cfb-prop-center/v1/{season}/opponent-stats.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"sport": "cfb", "schemaVersion": 1, "season": season, "cacheVersion": VERSION,
                               "updated_at": data.get("updated_at") or NOW, "team_count": len(teams), "teams": teams}, separators=(",", ":")) + "\n")
    print(f"Published compact opponent stats {season}: {len(teams)} teams")


def season_logs(season: int):
    box_url = f"https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box/player_box_{season}.csv"
    schedule_url = f"https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_{season}.csv"
    try:
        box_rows = fetch_csv(box_url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            print(f"No player box published for {season}; leave any prior player-log cache intact.")
            return
        raise
    if not box_rows:
        print(f"Player box for {season} is empty; leave any prior player-log cache intact.")
        return
    schedule_rows = fetch_csv(schedule_url)
    schedule = {}
    for row in schedule_rows:
        game_id = str(first(row, "game_id")).strip()
        if game_id and game_id not in schedule:
            schedule[game_id] = row

    players: dict[str, dict] = {}
    for row in box_rows:
        category = str(first(row, "category")).strip().lower()
        if category not in {"passing", "rushing", "receiving"}:
            continue
        game_id = str(first(row, "game_id")).strip()
        player_name = str(first(row, "athlete_name", "player_name", "name")).strip()
        if not game_id or not player_name:
            continue
        player_id = str(first(row, "athlete_id", "player_id", "id")).strip()
        athlete_key = player_id or norm(player_name)
        team_id = str(first(row, "team_id")).strip()
        meta = schedule.get(game_id, {})
        home_id = str(first(meta, "home_id", "home_team_id", "homeId")).strip()
        away_id = str(first(meta, "away_id", "away_team_id", "awayId")).strip()
        home_name = str(first(meta, "home_team")).strip()
        away_name = str(first(meta, "away_team")).strip()
        row_team = str(first(row, "team", "team_name", "school")).strip()
        is_home = team_id == home_id and bool(team_id)
        is_away = team_id == away_id and bool(team_id)
        if not is_home and not is_away and row_team:
            row_key = norm(row_team)
            is_home = bool(home_name and row_key == norm(home_name))
            is_away = bool(away_name and row_key == norm(away_name))
        team_name = home_name if is_home else away_name if is_away else row_team
        opponent_name = away_name if is_home else home_name if is_away else ""
        resolved_team_id = home_id if is_home else away_id if is_away else team_id
        opponent_id = away_id if is_home else home_id if is_away else ""
        entry = players.setdefault(athlete_key, {"playerName": player_name, "playerId": player_id, "season": season, "team": team_name,
                                                  "teamId": resolved_team_id, "gamesById": {}})
        if team_name and (not entry.get("team") or team_name == row_team):
            entry["team"] = team_name
            entry["teamId"] = resolved_team_id
        game = entry["gamesById"].setdefault(game_id, {
            "gameId": game_id, "playerName": player_name, "playerId": player_id, "season": number(first(row, "season"), season),
            "date": str(first(meta, "start_date", "game_date"))[:10],
            "week": nullable_number(first(meta, "week")),
            "seasonType": nullable_number(first(meta, "season_type", "seasonType")),
            "team": team_name or None, "opponent": opponent_name or None,
            "teamId": resolved_team_id or None, "opponentId": opponent_id or None,
            "isHome": is_home if is_home or is_away else None,
            "teamScore": nullable_number(first(meta, "home_points", "home_score") if is_home else first(meta, "away_points", "away_score") if is_away else ""),
            "opponentScore": nullable_number(first(meta, "away_points", "away_score") if is_home else first(meta, "home_points", "home_score") if is_away else ""),
            "passing": None, "rushing": None, "receiving": None,
        })
        if category == "passing":
            comp_att = re.match(r"^\s*(\d+)\s*/\s*(\d+)\s*$", str(first(row, "completions/passingAttempts")))
            game["passing"] = {"comp": int(comp_att.group(1)) if comp_att else 0, "att": int(comp_att.group(2)) if comp_att else 0,
                               "yards": number(first(row, "passingYards")), "tds": number(first(row, "passingTouchdowns")),
                               "ints": number(first(row, "interceptionsThrown", "passingInterceptions", "interceptions", "ints"))}
        elif category == "rushing":
            game["rushing"] = {"att": number(first(row, "rushingAttempts")), "yards": number(first(row, "rushingYards")),
                               "tds": number(first(row, "rushingTouchdowns"))}
        else:
            game["receiving"] = {"rec": number(first(row, "receptions")), "yards": number(first(row, "receivingYards")),
                                 "tds": number(first(row, "receivingTouchdowns")),
                                 "targets": number(first(row, "targets", "receivingTargets", "receiving_targets"))}
        score, opp_score = game.get("teamScore"), game.get("opponentScore")
        if score is not None and opp_score is not None:
            game["score"] = f"{score}-{opp_score}"
            game["result"] = "W" if score > opp_score else "L" if score < opp_score else "T"

    player_list = []
    for value in players.values():
        games = sorted((game for game in value.pop("gamesById").values() if game.get("passing") or game.get("rushing") or game.get("receiving")), key=lambda game: game.get("date") or "")
        if games:
            value["games"] = games
            player_list.append(value)
    player_list.sort(key=lambda player: (norm(player.get("playerName")), player.get("playerId") or ""))
    shards: dict[str, list[dict]] = defaultdict(list)
    for player in player_list:
        first_char = norm(player.get("playerName"))[:1]
        shard = first_char if first_char and first_char[0].isalnum() else "_"
        shards[shard].append(player)
    shard_root = OUTPUT / f"cfb-prop-center/v1/{season}/player-logs"
    shard_root.mkdir(parents=True, exist_ok=True)
    for stale in shard_root.glob("*.json"):
        stale.unlink()
    for shard, shard_players in shards.items():
        out = shard_root / f"{shard}.json"
        out.write_text(json.dumps({"sport": "cfb", "schemaVersion": 1, "season": season, "updated_at": NOW,
                                   "player_count": len(shard_players), "game_count": sum(len(p["games"]) for p in shard_players),
                                   "players": shard_players}, separators=(",", ":")) + "\n")
    print(f"Published CFB player logs {season}: {len(player_list)} players / {sum(len(p['games']) for p in player_list)} player-games across {len(shards)} name shards")


def main():
    global VERSION
    index_path = OUTPUT / "cfb-team-stats/index.json"
    if index_path.exists():
        try:
            VERSION = int(json.loads(index_path.read_text()).get("cacheVersion") or VERSION)
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    current = current_season()
    seasons = [current - 1, current]
    for season in seasons:
        make_opponent_cache(season)
        season_logs(season)


if __name__ == "__main__":
    main()
