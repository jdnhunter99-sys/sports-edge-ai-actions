#!/usr/bin/env python3
"""Export per-game CFB receiving target totals for the player-log publisher."""
import datetime as dt
import io
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

import pyarrow.parquet as pq

OUTPUT_ROOT = Path(os.environ["CFB_PLAYER_LOGS_OUTPUT_DIR"])
BASE_URL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_adv_receiving/adv_receiving_{season}.parquet"


def current_season() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    return now.year if now.month >= 8 else now.year - 1


def export(season: int) -> None:
    output = OUTPUT_ROOT / "cfb-player-targets" / f"{season}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    url = BASE_URL.format(season=season)
    request = urllib.request.Request(url, headers={"User-Agent": "SportsEdgeAI-CFB-Player-Log-Publisher/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            table = pq.read_table(io.BytesIO(response.read()), columns=[
                "game_id", "pos_team", "receiver_player_name", "Tar",
            ])
    except urllib.error.HTTPError as error:
        # The current-season advanced release can trail the box-score release.
        # Keep the publisher running with an explicit empty target join until
        # that source catches up; historical-season failures should be visible.
        if season == current_season() and error.code == 404:
            output.write_text(json.dumps({"available": False, "targets": []}) + "\n", encoding="utf-8")
            print(f"Advanced receiving targets are not published for {season} yet; wrote an empty join.")
            return
        raise

    targets = []
    for row in table.to_pylist():
        game_id = row.get("game_id")
        team_id = row.get("pos_team")
        player_name = str(row.get("receiver_player_name") or "").strip()
        target_count = row.get("Tar")
        if game_id is None or team_id is None or not player_name or target_count is None:
            continue
        try:
            count = int(target_count)
        except (TypeError, ValueError):
            continue
        if count < 0:
            continue
        targets.append({
            "gameId": str(game_id),
            "teamId": str(team_id),
            "playerName": player_name,
            "targets": count,
        })
    output.write_text(json.dumps({"available": True, "targets": targets}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Exported {len(targets)} player-game target totals for {season}.")


if __name__ == "__main__":
    for season in range(current_season() - 1, current_season() + 1):
        export(season)
