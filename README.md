# SportsEdgeAI Actions and published data

This repository owns the SportsEdgeAI GitHub Actions workflows, their runner
scripts, and the JSON cache branches they publish. Base44 dispatches workflows
from this repository and its backend functions read the published JSON here.

## One-time data migration

Before deploying Base44 readers that point here, run **Migrate published JSON to
Actions repository** once. It copies the existing `cfb-team-stats-data`,
`sharpodds-data`, and `propline-data` branches from `sports-edge-ai2` as a
snapshot of each branch's current files (without copying its old Git history),
and seeds `nfl-projection-backtest-data` from the current app JSON. Player-list
JSON is published by the PropLine workflow on `propline-data`. The migration
does not delete source branches.

## Repository secrets

- `PRIVATE_REPO_TOKEN` with read access to `jdnhunter99-sys/sports-edge-ai2` (used for the one-time migration and the NFL model-source checkout)
- The CFB team-stats publisher reads public SportsDataverse cfbfastR/ESPN release data; it does not require a CFBD API key
- `SHARP_API_KEY` for NCAAF SharpOdds
- `PROPLINE_API_KEY` for both PropLine publishers
- `PIKKIT_AUTH_TOKEN` for the authenticated Pikkit HTTP consensus collector
- `PINNACLE_GUEST_API_KEY`, `NOVIG_CLIENT_ID`, `NOVIG_CLIENT_SECRET`, and `REBET_API_KEY` when configured for SharpOdds

Set Actions' workflow permission to read and write repository contents. The
Base44 Pikkit workflow dispatches this action hourly; the action itself has no
GitHub cron schedule.

## Pikkit community consensus

The **Pikkit Consensus HTTP Publisher** workflow reads authenticated community
consensus endpoints and writes complete per-league snapshots to `data/*.json`.
The Base44 trigger requests MLB, NCAAFB, NBA, NFL, and WNBA for one UTC date per
run. Manual workflow inputs remain available for diagnostics. This is Pikkit
community betting data, not sportsbook-wide handle. See
[`pikkit-consensus/README.md`](pikkit-consensus/README.md) for setup and limits.
