#!/usr/bin/env python3
"""Publish ESPN NFL injury reports enriched with role/usage impact scores."""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path


OUTPUT_VALUE = os.environ.get("NFL_INJURY_OUTPUT_DIR", "").strip()
if not OUTPUT_VALUE:
    raise RuntimeError("NFL_INJURY_OUTPUT_DIR is required")
OUTPUT_ROOT = Path(OUTPUT_VALUE).expanduser()

ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
NFLVERSE_RELEASE_ROOT = "https://github.com/nflverse/nflverse-data/releases/download"
USER_AGENT = "SportsEdgeAI-NFL-Injury-Publisher/1.0 (+https://github.com/jdnhunter99-sys/sports-edge-ai-actions)"
ROLE_WEIGHT = 0.60
USAGE_WEIGHT = 0.40
STATUS_MULTIPLIERS = {
    "out": 1.0,
    "doubtful": 1.0,
    "questionable": 0.5,
    "probable": 0.0,
    "active": 0.0,
    "available": 0.0,
    "healthy": 0.0,
    "injured reserve": 1.0,
    "reserve/injured": 1.0,
    "physically unable to perform": 1.0,
    "pup": 1.0,
    "non-football injury": 1.0,
    "out for season": 1.0,
}

TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LAC": "Los Angeles Chargers", "LAR": "Los Angeles Rams",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SF": "San Francisco 49ers", "SEA": "Seattle Seahawks", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WSH": "Washington Commanders",
}
TEAM_ALIASES = {
    "JAC": "JAX", "JACKSONVILLE": "JAX", "LA": "LAR", "ST LOUIS": "LAR",
    "OAK": "LV", "SD": "LAC", "SAN DIEGO": "LAC", "WAS": "WSH", "WFT": "WSH",
    "WASHINGTON REDSKINS": "WSH", "WASHINGTON FOOTBALL TEAM": "WSH",
    "GNB": "GB", "KAN": "KC", "TAM": "TB", "SFO": "SF",
}
TEAM_NAME_LOOKUP = {
    re.sub(r"[^a-z0-9]", "", name.lower()): abbr
    for abbr, name in TEAM_NAMES.items()
}

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
OFFENSE_POSITIONS = {"QB", "RB", "FB", "WR", "TE", "OL", "OT", "T", "G", "C", "OG", "OC", "LT", "RT", "LG", "RG"}
DEFENSE_POSITIONS = {"DL", "DE", "DT", "NT", "EDGE", "LB", "ILB", "OLB", "MLB", "CB", "DB", "S", "FS", "SS"}
SPECIAL_POSITIONS = {"K", "P", "LS"}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def request_bytes(url: str, *, attempts: int = 4, timeout: int = 60) -> bytes:
    last_error = None
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json,text/csv,application/octet-stream,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            code = getattr(error, "code", None)
            if code is not None and code not in (408, 425, 429) and code < 500:
                break
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"GET failed for {url}: {last_error}")


def load_espn_report() -> dict:
    payload = json.loads(request_bytes(ESPN_INJURIES_URL).decode("utf-8-sig"))
    teams = payload.get("injuries")
    if payload.get("status") != "success" or not isinstance(teams, list) or len(teams) != 32:
        raise RuntimeError(f"ESPN NFL injury feed returned incomplete league data ({len(teams) if isinstance(teams, list) else 0}/32 teams)")
    return payload


def fetch_csv_release(release: str, filename: str) -> list[dict[str, str]]:
    url = f"{NFLVERSE_RELEASE_ROOT}/{release}/{filename}.gz"
    data = gzip.decompress(request_bytes(url))
    text = data.decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise RuntimeError(f"nflverse release contained no rows: {url}")
    return rows


def load_nflverse_metrics(season: int) -> tuple[int, list[dict], list[dict], list[dict]]:
    failures = []
    for data_season in (season, season - 1):
        try:
            snap_rows = fetch_csv_release("snap_counts", f"snap_counts_{data_season}.csv")
            stat_rows = fetch_csv_release("stats_player", f"stats_player_week_{data_season}.csv")
            try:
                depth_rows = fetch_csv_release("depth_charts", f"depth_charts_{data_season}.csv")
            except Exception as error:
                print(f"WARN depth charts unavailable for {data_season}; using snap and workload data only: {error}", flush=True)
                depth_rows = []
            return data_season, snap_rows, stat_rows, depth_rows
        except Exception as error:
            failures.append(f"{data_season}: {error}")
    raise RuntimeError("Could not load NFL player usage data: " + " | ".join(failures))


def normalize_team(value: str) -> str:
    raw = str(value or "").strip().upper()
    if raw in TEAM_NAMES:
        return raw
    if raw in TEAM_ALIASES:
        return TEAM_ALIASES[raw]
    return TEAM_NAME_LOOKUP.get(re.sub(r"[^a-z0-9]", "", raw.lower()), "")


def normalize_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or ""))
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    tokens = re.sub(r"[^a-z0-9]", " ", plain.casefold()).split()
    while tokens and tokens[-1] in SUFFIXES:
        tokens.pop()
    if len(tokens) > 2 and len(tokens[0]) == len(tokens[1]) == 1:
        tokens[:2] = ["".join(tokens[:2])]
    return " ".join(tokens)


def float_value(value: object) -> float:
    try:
        number = float(str(value or "").replace("%", "").strip())
        return number if number == number else 0.0
    except (ValueError, TypeError):
        return 0.0


def int_value(value: object) -> int:
    try:
        return int(float(str(value or "").strip()))
    except (ValueError, TypeError):
        return 0


def position_bucket(position: str) -> str:
    pos = str(position or "").strip().upper()
    if pos in {"QB"}:
        return "qb"
    if pos in {"RB", "FB", "HB"}:
        return "backfield"
    if pos in {"WR", "TE"}:
        return "pass_catcher"
    if pos in {"K", "P", "LS"}:
        return f"special_{pos.lower()}"
    if pos in OFFENSE_POSITIONS:
        return "offense_line"
    if pos in DEFENSE_POSITIONS:
        return "defense"
    return "other"


def workload_metric(row: dict[str, str], position: str) -> float | None:
    bucket = position_bucket(position)
    if bucket == "qb":
        return sum(float_value(row.get(field)) for field in ("attempts", "sacks_suffered", "carries"))
    if bucket == "backfield":
        return float_value(row.get("carries")) + float_value(row.get("targets"))
    if bucket == "pass_catcher":
        return float_value(row.get("targets"))
    if bucket == "special_k":
        return float_value(row.get("fg_att")) + float_value(row.get("pat_att"))
    if bucket == "special_p":
        return float_value(row.get("pt_att"))
    return None


def snap_share(row: dict[str, str], position: str) -> float:
    pos = str(position or "").strip().upper()
    field = "offense_pct" if pos in OFFENSE_POSITIONS else "defense_pct" if pos in DEFENSE_POSITIONS else "st_pct" if pos in SPECIAL_POSITIONS else ""
    values = [float_value(row.get(field))] if field else [float_value(row.get(key)) for key in ("offense_pct", "defense_pct", "st_pct")]
    value = max(values or [0.0])
    if value > 1.0:
        value /= 100.0
    return min(1.0, max(0.0, value))


def depth_chart_value(rank: int) -> float:
    return {1: 1.0, 2: 0.65, 3: 0.40, 4: 0.25, 5: 0.15}.get(rank, 0.08 if rank > 5 else 0.0)


def prepare_player_metrics(snap_rows: list[dict], stat_rows: list[dict], depth_rows: list[dict]) -> dict[tuple[str, str], dict]:
    snap_by_player: dict[tuple[str, str], list[dict]] = defaultdict(list)
    stats_by_player: dict[tuple[str, str], list[dict]] = defaultdict(list)
    depth_by_player: dict[tuple[str, str], tuple[str, int, str]] = {}

    all_weeks = []
    for row in snap_rows:
        team = normalize_team(row.get("team", ""))
        name = normalize_name(row.get("player", ""))
        if not team or not name:
            continue
        week = int_value(row.get("week"))
        if week:
            all_weeks.append(week)
        snap_by_player[(team, name)].append({**row, "_week": week})

    for row in stat_rows:
        if str(row.get("season_type", "REG")).upper() not in ("REG", "2", ""):
            continue
        team = normalize_team(row.get("team", ""))
        name = normalize_name(row.get("player_display_name") or row.get("player_name", ""))
        if not team or not name:
            continue
        week = int_value(row.get("week"))
        if week:
            all_weeks.append(week)
        stats_by_player[(team, name)].append({**row, "_week": week})

    for row in depth_rows:
        team = normalize_team(row.get("team", ""))
        name = normalize_name(row.get("player_name", ""))
        if not team or not name:
            continue
        key = (team, name)
        stamp = str(row.get("dt", ""))
        rank = max(1, int_value(row.get("pos_rank")) or 99)
        espn_id = str(row.get("espn_id") or "").strip()
        old = depth_by_player.get(key)
        if old is None or stamp >= old[0] or (stamp == old[0] and rank < old[1]):
            depth_by_player[key] = (stamp, rank, espn_id)

    latest_week = max(all_weeks or [0])
    cutoff_week = max(1, latest_week - 4)
    window_stats: dict[tuple[str, str], list[dict]] = {}
    team_usage_totals: dict[tuple[str, str], float] = defaultdict(float)
    player_usage_totals: dict[tuple[str, str], float] = defaultdict(float)
    player_positions: dict[tuple[str, str], str] = {}

    for key, rows in stats_by_player.items():
        recent = [row for row in rows if int_value(row.get("_week")) >= cutoff_week]
        if not recent:
            recent = rows
        window_stats[key] = recent
        position = str(recent[-1].get("position") or rows[-1].get("position") or "").upper()
        player_positions[key] = position
        bucket = position_bucket(position)
        for row in recent:
            metric = workload_metric(row, position)
            if metric is None or metric <= 0:
                continue
            player_usage_totals[key] += metric
            team_usage_totals[(key[0], bucket)] += metric

    metrics = {}
    all_keys = set(snap_by_player) | set(stats_by_player) | set(depth_by_player)
    for key in all_keys:
        snap_rows_for_player = snap_by_player.get(key, [])
        relevant_snaps = [row for row in snap_rows_for_player if int_value(row.get("_week")) >= cutoff_week]
        if not relevant_snaps:
            relevant_snaps = snap_rows_for_player

        # Zero-snap inactive weeks do not erase the player's established role;
        # use the most recent games in which the player actually appeared.
        played_rows = [row for row in relevant_snaps if snap_share(row, row.get("position", "")) > 0]
        played_rows.sort(key=lambda row: int_value(row.get("_week")), reverse=True)
        recent_rows = played_rows[:5]
        recent_snap = (
            sum(snap_share(row, row.get("position", "")) * weight for row, weight in zip(recent_rows, (1.0, 0.85, 0.70, 0.55, 0.40))) /
            sum((1.0, 0.85, 0.70, 0.55, 0.40)[:len(recent_rows)])
            if recent_rows else 0.0
        )
        season_rows = [row for row in snap_by_player.get(key, []) if snap_share(row, row.get("position", "")) > 0]
        season_snap = sum(snap_share(row, row.get("position", "")) for row in season_rows) / len(season_rows) if season_rows else 0.0
        depth_record = depth_by_player.get(key)
        depth_rank = depth_record[1] if depth_record else None
        espn_id = depth_record[2] if depth_record else ""
        depth_value = depth_chart_value(depth_rank or 0)
        if recent_rows:
            established_snap = 0.70 * recent_snap + 0.30 * season_snap
            role_value = 0.80 * established_snap + 0.20 * depth_value if depth_record else established_snap
        else:
            role_value = depth_value

        position = player_positions.get(key)
        if not position and snap_rows_for_player:
            position = str(snap_rows_for_player[-1].get("position") or "").upper()
        bucket = position_bucket(position or "")
        denominator = team_usage_totals.get((key[0], bucket), 0.0)
        usage_value = player_usage_totals.get(key, 0.0) / denominator if denominator > 0 else None
        if usage_value is None:
            # For line, defensive, and reserve roles without individual box-score
            # volume, playing-time share is the direct observable usage measure.
            usage_value = recent_snap if recent_rows else depth_value
        usage_value = min(1.0, max(0.0, usage_value))
        role_value = min(1.0, max(0.0, role_value))
        role_score = 5.0 * role_value
        usage_score = 5.0 * usage_value
        base_score = min(5.0, max(0.0, ROLE_WEIGHT * role_score + USAGE_WEIGHT * usage_score))
        metrics[key] = {
            "role_usage_score": round(base_score, 2),
            "role_score": round(role_score, 2),
            "usage_score": round(usage_score, 2),
            "recent_snap_share": round(recent_snap, 4) if recent_rows else None,
            "season_snap_share": round(season_snap, 4) if season_rows else None,
            "usage_share": round(usage_value, 4) if usage_value is not None else None,
            "depth_chart_rank": depth_rank,
            "espn_id": espn_id or None,
            "snap_games_sampled": len(recent_rows),
            "usage_group": bucket,
            "confidence": "high" if recent_rows and denominator > 0 and depth_rank else "medium" if recent_rows and denominator > 0 else "low" if recent_rows or depth_rank else "unmatched",
            "player_position": position or "",
        }
    return metrics


def status_multiplier(status: str) -> tuple[float, bool]:
    clean = re.sub(r"\s+", " ", str(status or "").strip().lower().replace("_", " "))
    if clean in STATUS_MULTIPLIERS:
        return STATUS_MULTIPLIERS[clean], True
    if "injured reserve" in clean or clean == "ir" or "physically unable" in clean or clean == "pup" or "out for season" in clean:
        return 1.0, True
    if "doubtful" in clean or clean == "d":
        return 1.0, True
    if "questionable" in clean or clean == "q":
        return 0.5, True
    if "probable" in clean or clean in {"active", "available", "healthy", "a"}:
        return 0.0, True
    if clean == "out" or clean == "o" or clean.startswith("out "):
        return 1.0, True
    return 0.0, False


def team_abbreviation(team: dict) -> str:
    display = str(team.get("displayName") or "")
    key = re.sub(r"[^a-z0-9]", "", display.lower())
    return TEAM_NAME_LOOKUP.get(key, "")


def injury_has_details(injury: dict) -> bool:
    details = injury.get("details") if isinstance(injury.get("details"), dict) else {}
    detail_fields = (details.get("type"), details.get("location"), details.get("detail"), details.get("returnDate"))
    return any(str(value or "").strip().lower() not in ("", "none", "not specified") for value in detail_fields)


def clean_text(value: object) -> str:
    text = str(value or "").strip()
    return "" if text.casefold() in {"not specified", "none", "n/a", "na", "null"} else text


def build_report(espn: dict, data_season: int, metrics: dict) -> dict:
    team_records = []
    unmapped_teams = []
    metrics_by_espn_id = {
        (team_abbr, str(player_metrics.get("espn_id"))): player_metrics
        for (team_abbr, _), player_metrics in metrics.items()
        if player_metrics.get("espn_id")
    }
    for espn_team in espn.get("injuries", []):
        abbr = team_abbreviation(espn_team)
        name = str(espn_team.get("displayName") or "").strip()
        if not abbr:
            unmapped_teams.append(name)
            continue
        injuries = []
        for entry in espn_team.get("injuries", []):
            athlete = entry.get("athlete") if isinstance(entry.get("athlete"), dict) else {}
            details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
            player_name = str(athlete.get("displayName") or athlete.get("fullName") or "").strip()
            status = str(entry.get("status") or "").strip()
            if not player_name or not status:
                continue
            multiplier, mapped_status = status_multiplier(status)
            if status.lower() in {"active", "healthy"} and not injury_has_details(entry) and not str(entry.get("longComment") or entry.get("shortComment") or "").strip():
                continue

            key = (abbr, normalize_name(player_name))
            player_metrics = metrics.get(key) or metrics_by_espn_id.get((abbr, str(athlete.get("id") or "")), {})
            base_score = float(player_metrics.get("role_usage_score") or 0.0)
            impact_score = round(base_score * multiplier, 2)
            position = athlete.get("position") if isinstance(athlete.get("position"), dict) else {}
            position_name = str(position.get("abbreviation") or position.get("displayName") or player_metrics.get("player_position") or "").strip()
            comments = str(entry.get("longComment") or entry.get("shortComment") or "").strip()
            injury_type = clean_text(details.get("type"))
            location = clean_text(details.get("location"))
            detail = clean_text(details.get("detail"))
            side = clean_text(details.get("side"))
            injuries.append({
                "player": player_name,
                "player_id": str(athlete.get("id") or "").strip() or None,
                "position": position_name,
                "status": status,
                "status_multiplier": multiplier,
                "status_mapped": mapped_status,
                "impact_score": impact_score,
                "base_role_usage_score": round(base_score, 2),
                "role_score": player_metrics.get("role_score"),
                "usage_score": player_metrics.get("usage_score"),
                "impact_inputs": {
                    "recent_snap_share": player_metrics.get("recent_snap_share"),
                    "season_snap_share": player_metrics.get("season_snap_share"),
                    "usage_share": player_metrics.get("usage_share"),
                    "usage_group": player_metrics.get("usage_group"),
                    "depth_chart_rank": player_metrics.get("depth_chart_rank"),
                    "snap_games_sampled": player_metrics.get("snap_games_sampled", 0),
                    "confidence": player_metrics.get("confidence", "unmatched"),
                },
                "injury": injury_type,
                "injury_location": location,
                "injury_detail": detail,
                "injury_side": side,
                "comments": comments,
                "short_comment": str(entry.get("shortComment") or "").strip(),
                "reported_at": entry.get("date"),
                "return_date": details.get("returnDate"),
                "source": (entry.get("source") or {}).get("description") if isinstance(entry.get("source"), dict) else entry.get("source"),
            })

        injuries.sort(key=lambda item: (-float(item.get("impact_score") or 0), item.get("player", "").casefold()))
        impact_total = round(sum(float(item.get("impact_score") or 0) for item in injuries), 2)
        team_records.append({
            "team_id": str(espn_team.get("id") or ""),
            "team": name or TEAM_NAMES.get(abbr, abbr),
            "abbreviation": abbr,
            "injury_count": len(injuries),
            "impact_count": sum(1 for item in injuries if float(item.get("impact_score") or 0) > 0),
            "impact_score": impact_total,
            "impact_rank": None,
            "rank_population": 32,
            "injuries": injuries,
        })

    if unmapped_teams:
        raise RuntimeError("ESPN returned unmapped NFL teams: " + ", ".join(unmapped_teams))
    if len(team_records) != 32 or {team["abbreviation"] for team in team_records} != set(TEAM_NAMES):
        raise RuntimeError(f"Refusing to publish incomplete NFL injury coverage ({len(team_records)}/32 teams)")

    ranked = sorted(team_records, key=lambda team: (-team["impact_score"], team["abbreviation"]))
    previous_score = None
    rank = 0
    for index, team in enumerate(ranked, start=1):
        if team["impact_score"] != previous_score:
            rank = index
            previous_score = team["impact_score"]
        team["impact_rank"] = rank

    generated_at = now_iso()
    source_timestamp = espn.get("timestamp")
    return {
        "sport": "nfl",
        "schema_version": 1,
        "generated_at": generated_at,
        "updated_at": source_timestamp or generated_at,
        "source": "ESPN NFL Injuries",
        "source_url": ESPN_INJURIES_URL,
        "source_timestamp": source_timestamp,
        "season": (espn.get("season") or {}).get("year"),
        "season_type": (espn.get("season") or {}).get("name"),
        "metrics_season": data_season,
        "status_multipliers": STATUS_MULTIPLIERS,
        "score_method": {
            "version": 1,
            "scale": "0-5 per player before availability multiplier",
            "formula": "(role_score * 0.60) + (usage_score * 0.40); final player impact = base score * status multiplier; team impact = sum of player impact scores",
            "role_weight": ROLE_WEIGHT,
            "usage_weight": USAGE_WEIGHT,
            "status_multipliers": {"Out": 1.0, "Doubtful": 1.0, "Questionable": 0.5, "Probable": 0.0},
            "role_inputs": ["recent and season snap share", "latest nflverse depth chart rank"],
            "usage_inputs": ["QB dropbacks", "RB touches", "WR/TE targets", "snap share when individual workload stats are unavailable"],
            "rank_direction": "1 is highest team injury impact",
        },
        "team_count": len(team_records),
        "injury_count": sum(team["injury_count"] for team in team_records),
        "teams": sorted(team_records, key=lambda team: team["abbreviation"]),
        "teams_by_abbreviation": {team["abbreviation"]: team for team in team_records},
    }


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    espn = load_espn_report()
    season = int((espn.get("season") or {}).get("year") or dt.datetime.now().year)
    print(f"NFL injury publisher: ESPN season={season}, source timestamp={espn.get('timestamp')}", flush=True)
    data_season, snap_rows, stat_rows, depth_rows = load_nflverse_metrics(season)
    print(f"Loaded role/usage data for season {data_season}: snap_rows={len(snap_rows)}, player_stat_rows={len(stat_rows)}, depth_chart_rows={len(depth_rows)}", flush=True)
    metrics = prepare_player_metrics(snap_rows, stat_rows, depth_rows)
    report = build_report(espn, data_season, metrics)
    output_path = OUTPUT_ROOT / "nfl-injuries" / "latest.json"
    write_json(output_path, report)
    matched = sum(1 for team in report["teams"] for injury in team["injuries"] if injury["impact_inputs"]["confidence"] != "unmatched")
    print(f"Published {report['injury_count']} injury records across {report['team_count']} teams; {matched}/{report['injury_count']} matched to usage data.", flush=True)
    for team in sorted(report["teams"], key=lambda item: item["impact_rank"]):
        print(f"#{team['impact_rank']:02d} {team['abbreviation']}: impact={team['impact_score']:.2f}, injuries={team['injury_count']}", flush=True)


if __name__ == "__main__":
    main()
