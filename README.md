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
- `CFBD_API_KEY` for the CFB team-stats publisher
- `SHARP_API_KEY` for NCAAF SharpOdds
- `PROPLINE_API_KEY` for both PropLine publishers
- `PINNACLE_GUEST_API_KEY`, `NOVIG_CLIENT_ID`, `NOVIG_CLIENT_SECRET`, and `REBET_API_KEY` when configured for SharpOdds

Set Actions' workflow permission to read and write repository contents. Base44
continues to dispatch these workflows, including scheduled triggers.
