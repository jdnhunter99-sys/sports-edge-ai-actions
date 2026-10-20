#!/usr/bin/env python3
"""Consume a signed PropLine repository_dispatch payload into per-sport JSON cache files."""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def finite_number(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def first_present(*values):
    for value in values:
        if value is not None:
            return value
    return None


def make_candidate(item, fallback_event_type, received_at):
    event = item.get("event") if isinstance(item.get("event"), dict) else {}
    current = item.get("current") if isinstance(item.get("current"), dict) else {}
    sport_key = str(item.get("sport_key") or "").strip()
    if not sport_key:
        return None

    event_type = str(item.get("event_type") or fallback_event_type or "unknown")
    event_key = str(event.get("external_id") or event.get("id") or sport_key)
    point = first_present(item.get("point"), current.get("point"))
    price = first_present(item.get("price"), current.get("price_american"), item.get("price_american"))

    cache_key = "|".join([
        event_type,
        sport_key,
        event_key,
        str(item.get("market_key") or ""),
        str(item.get("player_name") or ""),
        str(item.get("outcome_name") or ""),
        "" if point is None else str(point),
        str(item.get("bookmaker_key") or ""),
    ])

    return {
        "cache_key": cache_key,
        "event_type": event_type,
        "sport_key": sport_key,
        "event": event,
        "market_key": item.get("market_key") or None,
        "player_name": item.get("player_name") or None,
        "outcome_name": item.get("outcome_name") or None,
        "point": finite_number(point),
        "bookmaker_key": item.get("bookmaker_key") or None,
        "bookmaker_title": item.get("bookmaker_title") or None,
        "price": finite_number(price),
        "received_at": received_at,
        "price_updated_at": item.get("price_updated_at") or None,
        "fair_prob": finite_number(item.get("fair_prob")),
        "fair_price": finite_number(item.get("fair_price")),
        "ev_pct": finite_number(item.get("ev_pct")),
        "fair_source": item.get("fair_source") or None,
        "fair_books": item.get("fair_books") or None,
        "devig_method": item.get("devig_method") or None,
        "timestamp": item.get("timestamp") or None,
        "source": "inbound-webhook",
    }


def merge_rows(existing_rows, candidates):
    rows = {
        row.get("cache_key"): row
        for row in existing_rows
        if isinstance(row, dict) and row.get("cache_key")
    }

    for candidate in candidates:
        key = candidate["cache_key"]
        prior = rows.get(key) or {}
        old_first = finite_number(prior.get("first_price"))
        old_current = finite_number(prior.get("price"))
        new_price = finite_number(candidate.get("price"))
        first_price = old_first if old_first is not None else (
            old_current if old_current is not None else new_price
        )
        first_received = (
            prior.get("first_price_received_at")
            or (prior.get("received_at") if old_first is not None else None)
            or (prior.get("received_at") if old_current is not None else None)
            or (candidate.get("received_at") if new_price is not None else None)
        )
        rows[key] = {
            **candidate,
            "first_price": first_price,
            "first_price_received_at": first_received,
        }

    return sorted(
        rows.values(),
        key=lambda row: (row.get("received_at") or ""),
        reverse=True,
    )


def items_from_payload(payload, fallback_event_type):
    if isinstance(payload, list):
        return [(item, fallback_event_type) for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    if payload.get("batch") and isinstance(payload.get("events"), list):
        batch_type = payload.get("event_type") or fallback_event_type
        return [
            (entry.get("data") if isinstance(entry.get("data"), dict) else entry, batch_type)
            for entry in payload["events"]
            if isinstance(entry, dict)
        ]
    return [(payload, payload.get("event_type") or fallback_event_type)]


def write_json(path: Path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)


def run_self_test():
    stamp1 = "2026-10-20T12:00:00.000Z"
    stamp2 = "2026-10-20T12:01:00.000Z"
    first = make_candidate({
        "event_type": "ev",
        "sport_key": "basketball_nba",
        "event": {"id": 123, "home_team": "Home", "away_team": "Away"},
        "market_key": "player_points",
        "player_name": "Test Player",
        "outcome_name": "Over",
        "point": 20.5,
        "bookmaker_key": "testbook",
        "price": -110,
        "ev_pct": 2.5,
    }, "ev", stamp1)
    updated = dict(first, price=-120, received_at=stamp2)
    merged = merge_rows([], [first])
    merged = merge_rows(merged, [updated])
    assert len(merged) == 1
    assert merged[0]["first_price"] == -110
    assert merged[0]["first_price_received_at"] == stamp1
    assert merged[0]["price"] == -120
    assert merged[0]["received_at"] == stamp2
    print("PropLine webhook cache self-test passed: row mapping and first-price preservation are valid.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-file")
    parser.add_argument("--output-dir")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return
    if not args.event_file or not args.output_dir:
        parser.error("--event-file and --output-dir are required")

    envelope = json.loads(Path(args.event_file).read_text())
    client = envelope.get("client_payload") or {}
    payload = client.get("payload")
    if payload is None:
        raise SystemExit("repository_dispatch did not include client_payload.payload")

    event_type = client.get("prop_line_event")
    delivery_id = client.get("delivery_id")
    sequence = client.get("sequence")
    output_dir = Path(args.output_dir)
    received_at = now_iso()

    if event_type == "test" or (
        isinstance(payload, dict) and payload.get("event_type") == "test"
    ):
        test_path = output_dir / "tests" / "latest.json"
        write_json(test_path, {
            "received_at": received_at,
            "delivery_id": delivery_id,
            "sequence": sequence,
            "payload": payload,
        })
        print(f"Stored PropLine test delivery at {test_path}")
        return

    grouped = defaultdict(list)
    for item, fallback_type in items_from_payload(payload, event_type):
        candidate = make_candidate(item, fallback_type, received_at)
        if candidate:
            grouped[candidate["sport_key"]].append(candidate)

    if not grouped:
        raise SystemExit("Webhook payload contained no cacheable rows with sport_key")

    for sport_key, candidates in grouped.items():
        slug = re.sub(r"[^a-z0-9_-]+", "_", sport_key.lower()).strip("_")
        if not slug:
            raise SystemExit(f"Invalid sport key: {sport_key!r}")
        path = output_dir / f"{slug}.json"
        existing_rows = []
        if path.exists():
            document = json.loads(path.read_text())
            if not isinstance(document, dict) or not isinstance(document.get("rows"), list):
                raise SystemExit(f"Refusing to overwrite malformed cache file: {path}")
            existing_rows = document["rows"]

        merged = merge_rows(existing_rows, candidates)
        write_json(path, {
            "schema_version": 1,
            "sport_key": sport_key,
            "updated_at": received_at,
            "rows": merged,
        })
        print(f"Updated {path}: {len(candidates)} incoming row(s), {len(merged)} cached row(s)")


if __name__ == "__main__":
    main()

