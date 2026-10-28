# NBA injury report publisher

The NBA Injury Report Data GitHub Actions workflow runs every 15 minutes during the NBA season months (January–June and October–December) and can also be started manually. It discovers the newest published PDF linked from the current-season page on NBA.com, parses the official report, and enriches each listed player with current-season Basketball-Reference values.

## Published JSON

The workflow pushes to the nba-injury-report-data branch:

- nba-injuries/v1/latest.json — stable path for the latest full snapshot.
- nba-injuries/v1/YYYY-YY/latest.json — latest snapshot for that season.
- nba-injuries/v1/YYYY-YY/reports/YYYY-MM-DD/HH-MMam.json — report-time archive snapshot.

Each JSON contains a teams array with all 30 NBA teams and a top-level players array with every player listed in the PDF. Player matchups are read from each game header, including headers without a printed tipoff time; publishing stops if a player's team is not in that row's matchup. Each team entry has a summary `report_status` (`submitted`, `not_yet_submitted`, `not_in_report`, or `mixed`) and a `reports` array with status and player count for each game block. Player records include team, game date, matchup, report name, status, reason, minutes per game, USG%, OBPM, DBPM, each metric's page-wide rank, and a metric-match status.

Basketball-Reference advanced stats are taken from the same season as the injury report. MPG is calculated as the table's total MP divided by G. Names are normalized for suffixes and common spelling differences. If a report player has no row yet for the season, that player remains in the JSON and the metric values and ranks are null with `metrics_status: no_current_season_row`. Each `*_rank` is a competition rank across unique players on the full season page: rank 1 is highest, ties share a rank, and traded players use their `TOT` row when available (otherwise the team row with the most games). `player_metrics.rank_population` gives the valid player count ranked for each metric. In `player_metrics`, `available` means the source table was retrieved; use `coverage_status`, `all_players_matched`, and `coverage` to check whether all player rows have complete metrics. `coverage` reports matched, partial, no-current-season-row, and source-unavailable counts.

The publisher tries Basketball-Reference directly first, then uses the repository's BROWSERLESS_TOKEN Actions secret to fetch the page through Browserless if the direct request is blocked. The token is not stored in the repository files or written to logs. If both routes fail, the official injury report still publishes, the metric fields are null, player_metrics.available is false, and the workflow log explains the failure.

## Sources

- Official NBA injury report index: https://official.nba.com/nba-injury-report-YYYY-YY-season/
- Basketball-Reference advanced stats: https://www.basketball-reference.com/leagues/NBA_YYYY_advanced.html
