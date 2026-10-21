#!/usr/bin/env python3
"""Grade unresolved PropLine EV cache rows using PropLine's event results API."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

SUPPORTED_SPORT_KEYS = (
    "football_nfl",
    "football_ncaaf",
    "basketball_nba",
    "basketball_wnba",
    "baseball_mlb",
    "hockey_nhl",
)
CHICAGO = ZoneInfo("America/Chicago")
API_BASE = "https://api.prop-line.com/v1/sports"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def finite_number(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (number == number and abs(number) != float("inf")):
        return None
    return int(number) if number.is_integer() else number


def canonical_point(value):
    number = finite_number(value)
    if number is None:
        return ""
    return str(number)


def normalized_text(value):
    text = str(value or "").strip().casefold()
    text = re.sub(r"\s*\([^)]*\)\s*$", "", text)
    return re.sub(r"[^a-z0-9]+", "", text)


def outcome_side(value):
    text = str(value or "").strip().casefold()
    if text.startswith("over"):
        return "over"
    if text.startswith("under"):
        return "under"
    if text in {"yes", "no", "draw", "tie"}:
        return text
    return normalized_text(value)


def parse_time(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def event_day(event):
    event = event if isinstance(event, dict) else {}
    start = next((event.get(key) for key in ("commence_time", "start_time", "scheduled_start", "date") if event.get(key)), None)
    parsed = parse_time(start)
    return parsed.astimezone(CHICAGO).date() if parsed else None


def event_start(event):
    event = event if isinstance(event, dict) else {}
    start = next((event.get(key) for key in ("commence_time", "start_time", "scheduled_start", "date") if event.get(key)), None)
    return parse_time(start)


def parse_event(row):
    event = row.get("event")
    if isinstance(event, dict):
        return event
    if isinstance(event, str):
        try:
            parsed = json.loads(event)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, json.JSONDecodeError):
            pass
    return {}


def prop_event_id(event):
    value = event.get("id") or event.get("event_id")
    if value is None:
        return ""
    return str(value).strip()


def cache_event_id(event):
    return str(event.get("external_id") or event.get("id") or event.get("event_id") or "").strip().casefold()


def selection_key(row):
    event = parse_event(row)
    sport = str(row.get("sport_key") or "").strip().casefold()
    event_id = cache_event_id(event)
    market = str(row.get("market_key") or "").strip().casefold()
    side = outcome_side(row.get("outcome_name"))
    point = canonical_point(row.get("point"))
    player = normalized_text(row.get("player_name"))
    if not sport or not event_id or not market or not side:
        return None
    return "|".join((sport, event_id, market, player, side, point))


def event_key(sport, event):
    api_id = prop_event_id(event)
    if not sport or not api_id:
        return None
    return sport, api_id


def is_player_market_row(row, event):
    player = normalized_text(row.get("player_name"))
    if not player:
        return False
    teams = {normalized_text(event.get("home_team")), normalized_text(event.get("away_team"))}
    return player not in teams


def direct_resolution_keys(rows):
    outcomes = defaultdict(lambda: {"api": set(), "webhook": set()})
    for row in rows:
        if str(row.get("event_type") or "").casefold() != "resolution":
            continue
        key = selection_key(row)
        resolution = str(row.get("resolution") or row.get("result") or "").strip().casefold()
        if key and resolution in {"won", "lost", "push", "void", "win", "loss"}:
            source = "api" if row.get("source") == "propline-results-api" else "webhook"
            outcomes[key][source].add(resolution)
    resolved = set()
    for key, sources in outcomes.items():
        values = sources["api"] or sources["webhook"]
        if len(values) == 1:
            resolved.add(key)
    return resolved


def load_cache(output_dir: Path):
    documents = {}
    for sport in SUPPORTED_SPORT_KEYS:
        path = output_dir / f"{sport}.json"
        if not path.exists():
            continue
        document = json.loads(path.read_text())
        if not isinstance(document, dict) or not isinstance(document.get("rows"), list):
            raise SystemExit(f"Refusing to read malformed cache file: {path}")
        documents[sport] = (path, document)
    return documents


def check_cache_key(sport, api_event_id):
    return "|".join(("results_check", sport, api_event_id, "propline-results-api"))


def latest_event_checks(rows):
    checks = {}
    for row in rows:
        if str(row.get("event_type") or "").casefold() != "results_check":
            continue
        if row.get("source") != "propline-results-api":
            continue
        event = parse_event(row)
        key = event_key(str(row.get("sport_key") or ""), event)
        if not key:
            continue
        previous = checks.get(key)
        current_time = parse_time(row.get("last_checked_at") or row.get("received_at"))
        previous_time = parse_time((previous or {}).get("last_checked_at") or (previous or {}).get("received_at"))
        if previous is None or (current_time and (previous_time is None or current_time > previous_time)):
            checks[key] = row
    return checks


def make_check_record(sport, api_event_id, ev_row, checked_at, check_count):
    event = parse_event(ev_row)
    external_event_id = cache_event_id(event)
    return {
        "cache_key": check_cache_key(sport, api_event_id),
        "event_type": "results_check",
        "sport_key": sport,
        "event": event,
        "market_key": None,
        "team": None,
        "player_name": None,
        "outcome_name": None,
        "point": None,
        "bookmaker_key": "propline-results-api",
        "bookmaker_title": "PropLine Results Check",
        "price": None,
        "received_at": checked_at,
        "price_updated_at": None,
        "outcome_id": None,
        "book_outcome_id": None,
        "resolution": None,
        "actual_value": None,
        "resolved_at": None,
        "fair_prob": None,
        "fair_price": None,
        "ev_pct": None,
        "fair_source": None,
        "fair_books": None,
        "devig_method": None,
        "timestamp": checked_at,
        "source": "propline-results-api",
        "last_checked_at": checked_at,
        "check_count": check_count,
        "first_price": None,
        "first_price_received_at": None,
        "external_event_id": external_event_id,
    }


def merge_cache_rows(document, records):
    existing = {row.get("cache_key"): row for row in document["rows"] if isinstance(row, dict) and row.get("cache_key")}
    added = 0
    for record in records:
        prior = existing.get(record["cache_key"])
        existing[record["cache_key"]] = {**prior, **record} if prior else record
        if not prior and record.get("event_type") == "resolution":
            added += 1
    document["rows"] = sorted(existing.values(), key=lambda row: row.get("received_at") or "", reverse=True)
    if records:
        document["updated_at"] = now_iso()
    return added


def write_grade_output(path, rows_by_sport):
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"schema_version": 1, "rows": rows_by_sport}, ensure_ascii=False, separators=(",", ":")) + "\n")


def merge_grade_output(output_dir, results_path):
    payload = json.loads(Path(results_path).read_text())
    rows_by_sport = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows_by_sport, dict):
        raise SystemExit("Grader output file has an invalid rows object")
    documents = load_cache(Path(output_dir))
    merged_count = 0
    for sport, records in rows_by_sport.items():
        if sport not in documents or not isinstance(records, list):
            continue
        path, document = documents[sport]
        existing = {row.get("cache_key"): row for row in document["rows"] if isinstance(row, dict) and row.get("cache_key")}
        for record in records:
            if not isinstance(record, dict) or not record.get("cache_key"):
                continue
            prior = existing.get(record["cache_key"])
            existing[record["cache_key"]] = {**prior, **record} if prior else record
            merged_count += 1
        document["rows"] = sorted(existing.values(), key=lambda row: row.get("received_at") or "", reverse=True)
        if records:
            document["updated_at"] = now_iso()
            path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Merged {merged_count} saved PropLine resolution row(s) without additional API requests")


def fetch_results(sport, event_id, markets, api_key):
    query = {"apiKey": api_key}
    if markets:
        query["markets"] = ",".join(sorted(markets))
    url = f"{API_BASE}/{sport}/events/{event_id}/results?{urlencode(query)}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "RTM-Pro-PropLine-Results-Grader/1.0"})
    try:
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read())
            headers = response.headers
    except HTTPError as error:
        detail = error.read(700).decode("utf-8", "replace")
        if error.code in (401, 403):
            raise RuntimeError(f"PropLine authentication failed (HTTP {error.code}); check PROPLINE_API_KEY") from error
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(str(error)) from error
    if not isinstance(payload, dict):
        raise RuntimeError("PropLine results response was not a JSON object")
    return payload, {
        "used": headers.get("X-Daily-Used") or headers.get("X-RateLimit-Used"),
        "remaining": headers.get("X-Daily-Remaining") or headers.get("X-RateLimit-Remaining"),
        "limit": headers.get("X-Daily-Limit") or headers.get("X-RateLimit-Limit"),
    }


def unwrap_results(payload):
    if isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def iter_outcomes(payload):
    doc = unwrap_results(payload)
    for bookmaker in doc.get("bookmakers") or []:
        if not isinstance(bookmaker, dict):
            continue
        for market in bookmaker.get("markets") or []:
            if not isinstance(market, dict):
                continue
            market_key = str(market.get("key") or "").strip().casefold()
            for outcome in market.get("outcomes") or []:
                if isinstance(outcome, dict):
                    yield bookmaker, market, outcome, market_key


def grade_from_actual(actual, side, point):
    actual_number = finite_number(actual)
    line = finite_number(point)
    if actual_number is None or line is None or side not in {"over", "under"}:
        return None
    if actual_number == line:
        return "push"
    won = actual_number > line if side == "over" else actual_number < line
    return "won" if won else "lost"


def score_result_for_row(row, event_result):
    event = parse_event(row)
    doc = unwrap_results(event_result)
    status = str(doc.get("status") or "").strip().casefold()
    completed = doc.get("completed") is True or status in {"final", "complete", "completed", "finished"}
    if not completed:
        return None
    home = finite_number(doc.get("home_score", event.get("home_score")))
    away = finite_number(doc.get("away_score", event.get("away_score")))
    if home is None or away is None:
        scores = doc.get("scores") or []
        by_name = {normalized_text(item.get("name")): finite_number(item.get("score")) for item in scores if isinstance(item, dict)}
        home = by_name.get(normalized_text(event.get("home_team")), home)
        away = by_name.get(normalized_text(event.get("away_team")), away)
    if home is None or away is None:
        return None

    market = str(row.get("market_key") or "").strip().casefold()
    side = outcome_side(row.get("outcome_name"))
    point = finite_number(row.get("point"))
    label = normalized_text(row.get("outcome_name"))
    home_label = normalized_text(event.get("home_team"))
    away_label = normalized_text(event.get("away_team"))
    if market in {"h2h", "moneyline", "money_line"}:
        if home == away:
            return "push", 0
        if label not in {home_label, away_label}:
            return None
        picked = home if label == home_label else away
        other = away if label == home_label else home
        return ("won" if picked > other else "lost"), picked - other
    if market in {"spreads", "spread", "alternate_spreads", "alternate_spread"}:
        if point is None or label not in {home_label, away_label}:
            return None
        picked, other = (home, away) if label == home_label else (away, home)
        margin = picked + point - other
        return ("won" if margin > 0 else "lost" if margin < 0 else "push"), picked - other
    if market in {"totals", "total", "alternate_totals", "alternate_total"}:
        total = home + away
        result = grade_from_actual(total, side, point)
        return (result, total) if result else None
    if market in {"team_totals", "team_total", "alternate_team_totals", "alternate_team_total"}:
        team = normalized_text(row.get("team") or row.get("player_name"))
        if point is None or team not in {home_label, away_label}:
            return None
        team_score = home if team == home_label else away
        result = grade_from_actual(team_score, side, point)
        return (result, team_score) if result else None
    return None


def result_records_for_event(sport, event_id, ev_rows, payload, received_at):
    doc = unwrap_results(payload)
    exact = defaultdict(set)
    actual_values = defaultdict(set)
    actual_times = defaultdict(set)
    for _bookmaker, market, outcome, market_key in iter_outcomes(payload):
        player = normalized_text(outcome.get("description"))
        if not player:
            market_description = str(market.get("description") or "")
            player = normalized_text(re.sub(r"^.*?\s[-–:]\s*", "", market_description))
        side = outcome_side(outcome.get("name"))
        point = canonical_point(outcome.get("point"))
        resolution = str(outcome.get("resolution") or "").strip().casefold()
        actual = finite_number(outcome.get("actual_value"))
        resolved_at = outcome.get("resolved_at")
        if resolution in {"won", "lost", "push", "void"} and market_key and side:
            exact[(market_key, player, side, point)].add(resolution)
        if actual is not None and market_key and player:
            actual_values[(market_key, player)].add(actual)
            if resolved_at:
                actual_times[(market_key, player)].add(str(resolved_at))

    event_rows = []
    seen = set()
    for ev_row in ev_rows:
        market = str(ev_row.get("market_key") or "").strip().casefold()
        player = normalized_text(ev_row.get("player_name"))
        side = outcome_side(ev_row.get("outcome_name"))
        point = canonical_point(ev_row.get("point"))
        resolution = None
        actual_value = None
        resolved_at = None

        choices = exact.get((market, player, side, point), set())
        values = actual_values.get((market, player), set())
        if len(values) == 1:
            actual_value = next(iter(values))
            # Deriving from the official stat also covers an EV line missing from the exact resolved ladder.
            resolution = grade_from_actual(actual_value, side, ev_row.get("point"))
            times = actual_times.get((market, player), set())
            resolved_at = max(times) if times else None
        if resolution is None and len(choices) == 1:
            resolution = next(iter(choices))
            matching_times = []
            for _bk, mkt, outcome, mkt_key in iter_outcomes(payload):
                if mkt_key != market or normalized_text(outcome.get("description")) != player:
                    continue
                if outcome_side(outcome.get("name")) != side or canonical_point(outcome.get("point")) != point:
                    continue
                if outcome.get("resolved_at"):
                    matching_times.append(str(outcome["resolved_at"]))
                if outcome.get("actual_value") is not None:
                    actual_value = finite_number(outcome.get("actual_value"))
            resolved_at = max(matching_times) if matching_times else None

        score_grade = score_result_for_row(ev_row, payload)
        if resolution is None and score_grade:
            resolution, actual_value = score_grade
        if resolution not in {"won", "lost", "push", "void"}:
            continue

        key = selection_key(ev_row)
        if not key or key in seen:
            continue
        seen.add(key)
        event = parse_event(ev_row)
        external_event_id = cache_event_id(event)
        point_key = canonical_point(ev_row.get("point"))
        row_cache_key = "|".join(("resolution", sport, external_event_id, market, str(ev_row.get("player_name") or ""), str(ev_row.get("outcome_name") or ""), point_key, "propline-results-api"))
        event_rows.append({
            "cache_key": row_cache_key,
            "event_type": "resolution",
            "sport_key": sport,
            "event": event,
            "market_key": ev_row.get("market_key"),
            "team": ev_row.get("team"),
            "player_name": ev_row.get("player_name"),
            "outcome_name": ev_row.get("outcome_name"),
            "point": finite_number(ev_row.get("point")),
            "bookmaker_key": "propline-results-api",
            "bookmaker_title": "PropLine Results",
            "price": None,
            "received_at": received_at,
            "price_updated_at": None,
            "outcome_id": None,
            "book_outcome_id": None,
            "resolution": resolution,
            "actual_value": actual_value,
            "resolved_at": resolved_at or doc.get("resolved_at") or received_at,
            "fair_prob": None,
            "fair_price": None,
            "ev_pct": None,
            "fair_source": None,
            "fair_books": None,
            "devig_method": None,
            "timestamp": resolved_at or doc.get("resolved_at") or received_at,
            "source": "propline-results-api",
            "first_price": None,
            "first_price_received_at": None,
        })
    return event_rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--event-date", help="Optional Chicago calendar date to limit grading (YYYY-MM-DD); by default scans all unresolved events that have started")
    parser.add_argument("--results-output", help="Write fetched resolution rows to a runner-local file for push retries")
    parser.add_argument("--merge-results-file", help="Merge previously fetched resolution rows without calling PropLine")
    args = parser.parse_args()
    if args.merge_results_file:
        merge_grade_output(args.output_dir, args.merge_results_file)
        return
    api_key = os.environ.get("PROPLINE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("PROPLINE_API_KEY is not configured")
    target_day = date.fromisoformat(args.event_date) if args.event_date else None
    output_dir = Path(args.output_dir)
    documents = load_cache(output_dir)
    all_rows = [row for _path, doc in documents.values() for row in doc["rows"] if isinstance(row, dict)]
    already_resolved = direct_resolution_keys(all_rows)
    prior_checks = latest_event_checks(all_rows)
    now = datetime.now(timezone.utc)
    today_chicago = now.astimezone(CHICAGO).date()

    grouped = defaultdict(list)
    for row in all_rows:
        if str(row.get("event_type") or "").casefold() != "ev":
            continue
        sport = str(row.get("sport_key") or "").strip()
        if sport not in SUPPORTED_SPORT_KEYS:
            continue
        event = parse_event(row)
        key = event_key(sport, event)
        start = event_start(event)
        local_day = event_day(event)
        if not key or not start or start >= now:
            continue
        if target_day is not None and local_day != target_day:
            continue
        key = selection_key(row)
        if key and key in already_resolved:
            continue
        grouped[event_key(sport, event)].append(row)

    eligible = {}
    skipped_checked_today = 0
    skipped_expired = 0
    for key, ev_rows in grouped.items():
        marker = prior_checks.get(key)
        if marker:
            checked_at = parse_time(marker.get("last_checked_at") or marker.get("received_at"))
            start = event_start(parse_event(ev_rows[0]))
            age_days = (today_chicago - start.astimezone(CHICAGO).date()).days if start else 0
            if checked_at and checked_at.astimezone(CHICAGO).date() == today_chicago:
                skipped_checked_today += 1
                continue
            # First sweep backfills old history once. Only retry recent unresolved games
            # for two additional days in case PropLine posts their results late.
            if age_days > 2:
                skipped_expired += 1
                continue
        eligible[key] = ev_rows
    grouped = eligible

    scope = f"{target_day.isoformat()} (America/Chicago)" if target_day else "all past dates (America/Chicago)"
    print(f"Reconciling {scope}: {len(grouped)} unique started event(s) with unresolved EV plays; skipped_checked_today={skipped_checked_today}, skipped_retry_window_expired={skipped_expired}")
    if not grouped:
        write_grade_output(args.results_output, {})
        print("No eligible unresolved EV events found; API requests used: 0")
        return

    requests_used = 0
    failures = []
    added = 0
    daily_used = None
    remaining = None
    limit = None
    graded_by_sport = defaultdict(list)
    for (sport, api_event_id), ev_rows in sorted(grouped.items()):
        market_keys = {
            str(row.get("market_key") or "").strip()
            for row in ev_rows
            if is_player_market_row(row, parse_event(row)) and row.get("market_key")
        }
        requests_used += 1
        try:
            payload, quota = fetch_results(sport, api_event_id, market_keys, api_key)
            daily_used = quota.get("used") or daily_used
            remaining = quota.get("remaining") or remaining
            limit = quota.get("limit") or limit
            received_at = now_iso()
            records = result_records_for_event(sport, api_event_id, ev_rows, payload, received_at)
        except RuntimeError as error:
            # Keep going after one broken event; stop if credentials or quota prevent all later requests.
            failures.append(f"{sport}/{api_event_id}: {error}")
            print(f"{sport}/{api_event_id}: results unavailable: {error}", file=sys.stderr)
            if "authentication failed" in str(error).casefold() or "http 429" in str(error).casefold():
                print("PropLine credentials or request limit prevent further event requests; stopping.", file=sys.stderr)
                break
            continue

        marker = prior_checks.get((sport, api_event_id))
        previous_count = finite_number(marker.get("check_count")) if marker else 0
        check_count = int(previous_count or 0) + 1
        check_record = make_check_record(sport, api_event_id, ev_rows[0], received_at, check_count)
        records.append(check_record)
        if not any(record.get("event_type") == "resolution" for record in records):
            print(f"{sport}/{api_event_id}: no matching resolved outcomes yet")
        else:
            print(f"{sport}/{api_event_id}: graded {sum(record.get('event_type') == 'resolution' for record in records)} unique EV selection(s)")
        graded_by_sport[sport].extend(records)
        path, document = documents[sport]
        added += merge_cache_rows(document, records)
        path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")

    write_grade_output(args.results_output, graded_by_sport)
    print(f"Daily results summary: requests_used={requests_used}, propline_daily_used={daily_used or 'unknown'}, daily_limit={limit or 'unknown'}, daily_remaining={remaining or 'unknown'}, resolution_rows_added={added}, events_checked={requests_used - len(failures)}, event_errors={len(failures)}")
    if failures:
        print("Some requests failed and were not marked as checked; a rerun can retry those events.")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
