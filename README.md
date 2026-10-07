# SportsEdgeAI public Actions runner

This repository hosts the GitHub Actions publishers used by SportsEdgeAI. The CFB
team-stats publisher is self-contained here: it fetches CFBD data, computes the
team frames, and publishes JSON to the private `sports-edge-ai2` data branch. Other
publishers may read source code from `sports-edge-ai2` as described by their workflows.

Add the repository secrets required by each workflow before running it:

- `PRIVATE_REPO_TOKEN` with access to write generated data to the private repository branches
- `PROPLINE_API_KEY` for both PropLine workflows
- `CFBD_API_KEY` for CFB team stats
- `SHARP_API_KEY` for NCAAF SharpOdds
- `PINNACLE_GUEST_API_KEY`, `NOVIG_CLIENT_ID`, `NOVIG_CLIENT_SECRET`, and `REBET_API_KEY` when configured for SharpOdds

All workflows support manual dispatch. Base44 remains responsible for scheduled dispatches.
