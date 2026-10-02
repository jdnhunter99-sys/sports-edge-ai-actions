# SportsEdgeAI public Actions runner

This public repository hosts GitHub Actions workflows that run publishers for
the private `sports-edge-ai2` repository. Workflows check out their scripts from
the private repository and publish generated data to its existing data branches.

Add the repository secrets required by each workflow before running it:

- `PRIVATE_REPO_TOKEN` with access to read the private source and write its data branches
- `PROPLINE_API_KEY` for both PropLine workflows
- `CFBD_API_KEY` for CFB team stats
- `SHARP_API_KEY` for NCAAF SharpOdds
- `PINNACLE_GUEST_API_KEY`, `NOVIG_CLIENT_ID`, `NOVIG_CLIENT_SECRET`, and `REBET_API_KEY` when configured for SharpOdds

All workflows support manual dispatch. Base44 remains responsible for scheduled dispatches.
