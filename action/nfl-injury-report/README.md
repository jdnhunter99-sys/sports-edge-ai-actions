# NFL injury report publisher

The publisher reads ESPN's league-wide NFL injury feed and enriches each listed injury with current role and usage data from nflverse. It publishes one `nfl-injuries/latest.json` snapshot containing all 32 teams.

## Player impact score

Each player's base role/usage score is on a 0–5 scale:

`base score = 0.60 × role score + 0.40 × usage score`

Both components are scaled from 0 to 5 and capped at 5. The role component combines recent and season snap share with the latest depth-chart position when available. Recent snap share uses the player's latest five games with snaps, weighted toward the most recent game; it is blended 70/30 with the season average. When a player has no snap history, depth-chart rank provides the role estimate.

The usage component uses the relevant team workload share when available:

- Quarterbacks: dropbacks plus carries among quarterbacks.
- Running backs/fullbacks: carries plus targets among the backfield.
- Wide receivers/tight ends: targets among pass catchers.
- Other positions: snap share as the observable workload measure.

The final player impact is the base score multiplied by the injury-status multiplier:

- Out, doubtful, injured reserve, PUP, or season-ending: `×1.0`.
- Questionable: `×0.5`.
- Probable, active, or healthy: `×0.0`.

No replacement-player adjustment is applied. The team impact score is the sum of its listed players' final impact scores. Team rank `#1` means the highest current injury impact among all 32 teams. The JSON publishes score components and confidence so the frontend can explain individual scores and callers can audit matching coverage.

## Sources

- ESPN injury statuses, comments, and injury details: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries`
- nflverse snap counts, weekly player statistics, and depth charts: `https://github.com/nflverse/nflverse-data/releases`

