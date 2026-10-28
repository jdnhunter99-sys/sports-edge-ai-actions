# NBA injury report publisher

The NBA Injury Report Data GitHub Actions workflow runs every 15 minutes during the NBA season months (January–June and October–December) and can also be started manually. It discovers the newest published PDF linked from the current-season page on NBA.com, parses the official report, and enriches each listed player with current-season Basketball-Reference values.

## Published JSON

The workflow pushes to the nba-injury-report-data branch:

- nba-injuries/v1/latest.json — stable path for the latest full snapshot.
- nba-injuries/v1/YYYY-YY/latest.json — latest snapshot for that season.
- nba-injuries/v1/YYYY-YY/reports/YYYY-MM-DD/HH-MMam.json — report-time archive snapshot.

Each JSON contains a teams array with all 30 NBA teams and a top-level players array with every player listed in the PDF. Team entries identify whether a team submitted, has not yet submitted, or was not included in the latest PDF. Player records include team, game date, matchup, report name, status, reason, minutes per game, USG%, OBPM, DBPM, and a metric-match status.

Basketball-Reference advanced stats are taken from the same season as the injury report. MPG is calculated as the table's total MP divided by G. Names are normalized for suffixes and common spelling differences. If a report player has no row yet for the season, that player remains in the JSON and the four metric values are null with metrics_status: no_current_season_row.

The publisher tries Basketball-Reference directly first, then uses the repository's BROWSERLESS_TOKEN Actions secret to fetch the page through Browserless if the direct request is blocked. The token is not stored in the repository files or written to logs. If both routes fail, the official injury report still publishes, the metric fields are null, player_metrics.available is false, and the workflow log explains the failure.

## Sources

- Official NBA injury report index: https://official.nba.com/nba-injury-report-YYYY-YY-season/
- Basketball-Reference advanced stats: https://www.basketball-reference.com/leagues/NBA_YYYY_advanced.html
