# Pikkit HTTP consensus collector — SportsEdgeAI

**Replacement for the Playwright collector.** Uses the authenticated HTTP responses you verified locally. Run only within the scope of your Pikkit authorization.

## Deploy
1. This HTTP collector replaces the earlier Playwright Pikkit collector; keep only one Pikkit workflow enabled.
2. Add GitHub Actions secret `PIKKIT_AUTH_TOKEN` containing a fresh authorization header value. Do not commit it, publish it, or share it in chat.
3. In Settings → Actions → General, enable **Read and write permissions** for workflows.
4. Actions → **Pikkit Consensus HTTP Publisher** → **Run workflow**. For the first test choose `NCAAFB` and `2` days; after confirming the feed, choose the desired leagues and date window.
5. Successful runs publish a lightweight `data/<league>.json` index and one full event file at `data/events/<league>/<event_id>.json` per game to the `Pikkit-Consensus` branch. The index `detail_path` points to each event file; all timestamps are UTC. Cron runs at minute 7 and 37 of each hour (GitHub scheduling can be delayed).

## What is collected
- `/events/all?query_date=YYYY-MM-DD&league_offset=<cursor>`, following the returned `league_offset` until missing; event IDs deduplicated across the chosen dates.
- `/event/foryou/<id>` per event; parses `community.breakdowns` for moneyline, spread, and total.
- Each sport index contains event IDs, team names, start times, and a `detail_path`; each event file contains that game’s full splits. The publisher removes expired event files for leagues refreshed on that run.
- Waits a random 7–15 seconds between event detail scrapes to reduce rate limiting. The delay is applied only between events, not after the final event.
- Each market has home/away or over/under with **bet_pct and money_pct in 0–100 percent units**, bet counts, dollar handles and labels. Additional fields include home/away teams, game UTC time, source, total event wagering and picks.
- Events from the next five **UTC** dates by default; use inputs to adjust. A selected game with no splits is treated as an error, so a zero-data event cannot silently create false values.

## Safety and operations
- Only the `PIKKIT_AUTH_TOKEN` Actions secret is used; no Playwright, browser credentials, or npm dependencies.
- HTTP 401/403 fails the job; the script does not attempt to bypass verification. Retry with delay only for 429, 5xx and transient network errors.
- Any event error fails the job before writing new data files, protecting previously committed JSON. Missing individual markets are `null`, never guessed.
- Token validity on **GitHub's runner** is not yet tested; successful Mac Terminal access does not guarantee success on GitHub.
- `all` may include sports other than the ones you use. It is usually better to test selected leagues first. Published data is sourced from **Pikkit community betting**, not sportsbook-wide handle.
- `data/*.json` is committable; tokens are never written to files.
- Long-term history is *not* included: each refresh replaces the latest per-league JSON. Add a separate history database if you need movement over time.
- Do not publish these feeds publicly unless your authorization covers redistribution.

## Local test
Run this from the Actions repository root:

```bash
read -s -p 'Pikkit token: ' PIKKIT_AUTH_TOKEN; echo
export PIKKIT_AUTH_TOKEN
python3 scripts/collect.py --leagues NCAAFB --days 2
unset PIKKIT_AUTH_TOKEN
```

## Base44 integration
A Base44 server-side function can fetch the sport index from the `Pikkit-Consensus` branch (GitHub token required for private repos), match teams and `start_time` to a Propline event, then fetch that index row’s `detail_path`. Validate `complete === true` in both files and cache the event snapshot in an entity. This ZIP implements GitHub publishing, **not** the Base44 ingestion function.
