#!/usr/bin/env python3
"""Fetch the current ScoresAndOdds player-prop boards and publish JSON list caches.

This runs in GitHub Actions. It deliberately has no Base44 SDK or Base44 HTTP
calls; Base44 reads the completed files from the player-lists-data branch.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://www.scoresandodds.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
SPORTS = {
    "nfl": {
        "prop-center": [
            ("passing_yards", ["/nfl/props", "/nfl/props/passingyards", "/nfl/props/passing-yards"]),
            ("passing_tds", ["/nfl/props/passing_tds", "/nfl/props/passing-touchdowns"]),
            ("passing_completions", ["/nfl/props/completions", "/nfl/props/passing-completions"]),
            ("passing_attempts", ["/nfl/props/passattempts", "/nfl/props/passing-attempts"]),
            ("pass_rush_yards", ["/nfl/props/passingrushingyards", "/nfl/props/passing-rushing-yards"]),
            ("interceptions_thrown", ["/nfl/props/interceptions"]),
            ("rushing_yards", ["/nfl/props/rushingyards", "/nfl/props/rushing-yards"]),
            ("rushing_attempts", ["/nfl/props/rushattempts", "/nfl/props/rushing-attempts"]),
            ("rushing_tds", ["/nfl/props/rushing-touchdowns"]),
            ("receiving_yards", ["/nfl/props/receivingyards", "/nfl/props/receiving-yards"]),
            ("receptions", ["/nfl/props/receptions"]),
            ("receiving_tds", ["/nfl/props/receiving-touchdowns"]),
            ("rush_rec_yards", ["/nfl/props/rushingreceivingyards", "/nfl/props/rushing-receiving-yards"]),
            ("anytime_touchdown", ["/nfl/props/touchdowns"]),
        ],
        "projections": None,
    },
    "cfb": {
        "prop-center": [(key, [path]) for key, path in [
            ("passing_yards", "/ncaaf/props/passing-yards"), ("passing_tds", "/ncaaf/props/passing-touchdowns"),
            ("passing_completions", "/ncaaf/props/passing-completions"), ("passing_attempts", "/ncaaf/props/passing-attempts"),
            ("rushing_yards", "/ncaaf/props/rushing-yards"), ("rushing_attempts", "/ncaaf/props/rushing-attempts"),
            ("rushing_tds", "/ncaaf/props/rushing-touchdowns"), ("receiving_yards", "/ncaaf/props/receiving-yards"),
            ("receptions", "/ncaaf/props/receptions"), ("receiving_tds", "/ncaaf/props/receiving-touchdowns"),
        ]],
    },
    "mlb": {"prop-center": [(key, [path]) for key, path in [
        ("strikeouts", "/mlb/props/strikeouts"), ("earned_runs", "/mlb/props/earned-runs-allowed"),
        ("hits_allowed", "/mlb/props/hits-allowed"), ("walks_allowed", "/mlb/props/walks-allowed"),
        ("pitcher_outs", "/mlb/props/outs"), ("home_runs_allowed", "/mlb/props/home-runs-allowed"),
        ("home_runs", "/mlb/props/home-runs"), ("singles", "/mlb/props/singles"), ("hits", "/mlb/props/hits"),
        ("total_bases", "/mlb/props/total-bases"), ("rbi", "/mlb/props/runs-batted-in"),
        ("stolen_bases", "/mlb/props/steals"), ("hits_runs_rbis", "/mlb/props/hits,-runs-&-rbis"),
    ]]},
    "wnba": {"prop-center": [(key, paths) for key, paths in [
        ("points", ["/wnba/props", "/wnba/props/points"]), ("rebounds", ["/wnba/props/rebounds"]),
        ("assists", ["/wnba/props/assists"]), ("three_pointers_made", ["/wnba/props/3-pointers", "/wnba/props/three-pointers", "/wnba/props/3pointers"]),
        ("points_rebounds", ["/wnba/props/points-&-rebounds", "/wnba/props/points-rebounds", "/wnba/props/points-and-rebounds"]),
        ("points_assists", ["/wnba/props/points-&-assists", "/wnba/props/points-assists"]),
        ("pra", ["/wnba/props/points,-rebounds,-&-assists", "/wnba/props/points-rebounds-assists"]),
        ("rebounds_assists", ["/wnba/props/rebounds-&-assists", "/wnba/props/rebounds-assists"]),
        ("blocks", ["/wnba/props/blocks"]), ("steals", ["/wnba/props/steals"]),
    ]]},
}

def fetch_html(path: str) -> tuple[str, str]:
    req = urllib.request.Request(BASE + path, headers={
        "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8", "Referer": BASE + path.split("/props")[0] + "/props",
    })
    with urllib.request.urlopen(req, timeout=25) as response:
        return response.read().decode("utf-8", "replace"), response.geturl()

def parse_rows(page_sport: str, market: str, body: str) -> list[dict]:
    output = []
    for match in re.finditer(r'<li\b[^>]*class="[^"]*\bborder\b[^"]*"[^>]*>[\s\S]*?</li>', body, re.I):
        row = match.group(0)
        player = re.search(r'<a[^>]+href="[^\"]*/prop-bets/(\d+)/[^\"]*"[^>]*>([\s\S]*?)</a>', row, re.I)
        if not player:
            continue
        name = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html.unescape(player.group(2)))).strip()
        if not name:
            continue
        event = re.search(r'data-event="(?:nfl|ncaaf|mlb|wnba)/([^"]+)"', row, re.I)
        matchup = re.search(r'<span class="bold small gray">([^<]+)</span>', row, re.I)
        matchup_text = html.unescape(matchup.group(1)).strip() if matchup else ""
        team = opponent = None
        is_home = None
        split = re.match(r"(.+?)\s+@\s+(.+)$", matchup_text, re.I)
        if split:
            team, opponent, is_home = split.group(1).strip(), split.group(2).strip(), False
        else:
            split = re.match(r"(.+?)\s+vs\.?\s+(.+)$", matchup_text, re.I)
            if split:
                team, opponent, is_home = split.group(1).strip(), split.group(2).strip(), True
        proj = re.search(r'data-proj="([^"]*)"', row, re.I)
        projection = number(proj.group(1)) if proj else None
        over = re.search(r"o(\d+(?:\.\d+)?)([+-]\d{2,4})", row, re.I)
        under = re.search(r"u(\d+(?:\.\d+)?)([+-]\d{2,4})", row, re.I)
        line = float(over.group(1)) if over else float(under.group(1)) if under else projection
        output.append({"player": name, "playerId": player.group(1), "team": team, "opponent": opponent,
            "isHome": is_home, "matchup": matchup_text or None, "market": market, "line": line,
            "projection": projection, "overOdds": over.group(2) if over else None,
            "underOdds": under.group(2) if under else None, "gameId": event.group(1) if event else None,
            "source": "ScoresAndOdds"})
    return output

def number(value: str):
    try:
        return float(value) if value.strip() else None
    except ValueError:
        return None

def fetch_market(sport: str, market: str, paths: list[str]) -> tuple[str, list[dict], list[dict]]:
    diagnostics = []
    for path in paths:
        try:
            body, final_url = fetch_html(path)
            rows = parse_rows(sport, market, body)
            redirected_base = path != f"/{sport}/props" and final_url.rstrip("/").endswith(f"/{sport}/props")
            diagnostics.append({"path": path, "status": 200, "rows": len(rows), "redirected": redirected_base})
            if rows and not redirected_base:
                return market, rows, diagnostics
        except urllib.error.HTTPError as error:
            diagnostics.append({"path": path, "status": error.code, "rows": 0})
        except Exception as error:
            diagnostics.append({"path": path, "error": str(error)[:200], "rows": 0})
        time.sleep(0.2)
    return market, [], diagnostics

def fetch_screen(sport: str, screen: str, markets: list[tuple[str, list[str]]]) -> dict:
    props, diagnostics = [], {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(fetch_market, sport, market, paths) for market, paths in markets]
        for future in concurrent.futures.as_completed(futures):
            market, rows, attempts = future.result()
            props.extend(rows)
            diagnostics[market] = attempts
    unique, seen = [], set()
    for prop in props:
        key = (prop["playerId"], prop["market"], prop.get("gameId"))
        if key not in seen:
            seen.add(key)
            unique.append(prop)
    players_by_id = {}
    for prop in unique:
        player = players_by_id.setdefault(prop["playerId"], {"playerId": prop["playerId"], "name": prop["player"], "team": prop.get("team"), "opponent": prop.get("opponent"), "markets": [], "props": []})
        if prop["market"] not in player["markets"]:
            player["markets"].append(prop["market"])
        player["props"].append(prop)
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    return {"ok": True, "sport": sport, "screen": screen, "updated_at": now,
        "status": "ready" if unique else "empty",
        "source": "ScoresAndOdds", "player_count": len(players_by_id), "prop_count": len(unique),
        "players": list(players_by_id.values()), "props": unique, "diagnostics": diagnostics}

def main():
    root = Path(os.environ.get("PLAYER_LISTS_OUTPUT_DIR", "player-lists"))
    outputs = {}
    for sport, screens in SPORTS.items():
        for screen, markets in screens.items():
            if markets is None:  # Projection rail consumes the same NFL odds index.
                payload = outputs["nfl/prop-center.json"]
                payload = {**payload, "screen": "projections"}
            else:
                print(f"Fetching {sport}/{screen}", flush=True)
                payload = fetch_screen(sport, screen, markets)
            path = f"{sport}/{screen}.json"
            dest = root / path
            if markets is not None and payload.get("status") == "empty" and dest.is_file():
                try:
                    previous = json.loads(dest.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    previous = None
                if isinstance(previous, dict) and previous.get("ok") is True and previous.get("prop_count", 0) > 0:
                    print(f"WARNING: {path} returned no props; preserving last good cache ({previous.get('prop_count')} props). Market diagnostics: {json.dumps(payload.get('diagnostics', {}), separators=(',', ':'))}", flush=True)
                    continue
            outputs[path] = payload
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            if payload.get("status") == "empty":
                print(f"WARNING: {path} has no current props. Market diagnostics: {json.dumps(payload.get('diagnostics', {}), separators=(',', ':'))}", flush=True)
            print(f"Published candidate {path}: {payload['player_count']} players / {payload['prop_count']} props", flush=True)

    projection_path = root / "nfl/projections.json"
    projection_path.parent.mkdir(parents=True, exist_ok=True)
    projection_path.write_text(json.dumps(outputs["nfl/projections.json"], separators=(",", ":")), encoding="utf-8")

if __name__ == "__main__":
    main()
