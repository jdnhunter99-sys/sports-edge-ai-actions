#!/usr/bin/env python3
"""Publish the newest official NBA injury report with Basketball-Reference metrics."""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

import pdfplumber


OUTPUT_VALUE = os.environ.get("NBA_INJURY_OUTPUT_DIR", "").strip()
if not OUTPUT_VALUE:
    raise RuntimeError("NBA_INJURY_OUTPUT_DIR is required")
OUTPUT_ROOT = Path(OUTPUT_VALUE).expanduser()

ET = ZoneInfo("America/New_York")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
INJURY_PAGE_TEMPLATE = "https://official.nba.com/nba-injury-report-{start}-{end2}-season/"
BREF_ADVANCED_TEMPLATE = "https://www.basketball-reference.com/leagues/NBA_{end}_advanced.html"
PDF_PATTERN = re.compile(
    r"Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{1,2})_(\d{2})(AM|PM)\.pdf",
    re.IGNORECASE,
)
STATUS_PATTERN = re.compile(r"\b(Out|Doubtful|Questionable|Probable|Available)\b", re.IGNORECASE)
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

TEAM_NAMES = {
    "ATL": ("Atlanta Hawks",),
    "BOS": ("Boston Celtics",),
    "BKN": ("Brooklyn Nets",),
    "CHA": ("Charlotte Hornets",),
    "CHI": ("Chicago Bulls",),
    "CLE": ("Cleveland Cavaliers",),
    "DAL": ("Dallas Mavericks",),
    "DEN": ("Denver Nuggets",),
    "DET": ("Detroit Pistons",),
    "GSW": ("Golden State Warriors",),
    "HOU": ("Houston Rockets",),
    "IND": ("Indiana Pacers",),
    "LAC": ("LA Clippers", "Los Angeles Clippers"),
    "LAL": ("Los Angeles Lakers", "LA Lakers"),
    "MEM": ("Memphis Grizzlies",),
    "MIA": ("Miami Heat",),
    "MIL": ("Milwaukee Bucks",),
    "MIN": ("Minnesota Timberwolves",),
    "NOP": ("New Orleans Pelicans",),
    "NYK": ("New York Knicks",),
    "OKC": ("Oklahoma City Thunder",),
    "ORL": ("Orlando Magic",),
    "PHI": ("Philadelphia 76ers",),
    "PHX": ("Phoenix Suns",),
    "POR": ("Portland Trail Blazers",),
    "SAC": ("Sacramento Kings",),
    "SAS": ("San Antonio Spurs",),
    "TOR": ("Toronto Raptors",),
    "UTA": ("Utah Jazz",),
    "WAS": ("Washington Wizards",),
}
TEAM_LABELS = sorted(
    ((label, abbr) for abbr, labels in TEAM_NAMES.items() for label in labels),
    key=lambda item: len(item[0]),
    reverse=True,
)
NAME_ALIASES = {
    "nicolas claxton": "nic claxton",
    "kenyon martin": "kj martin",
    "alexandre sarr": "alex sarr",
    "ronald holland": "ron holland",
    "adama bal": "adama alpha bal",
}


def season_for_date(today: dt.date) -> tuple[int, int, str]:
    start = today.year if today.month >= 7 else today.year - 1
    end = start + 1
    return start, end, f"{start}-{end % 100:02d}"


def request_bytes(url: str, *, headers: dict[str, str] | None = None, attempts: int = 4, timeout: int = 45) -> bytes:
    last_error = None
    request_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/pdf,application/octet-stream,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if headers:
        request_headers.update(headers)
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            status = getattr(error, "code", None)
            if status is not None and status not in (403, 408, 425, 429) and status < 500:
                break
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"Request failed for {url}: {last_error}")


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def report_datetime_from_url(url: str) -> dt.datetime | None:
    path = urllib.parse.urlparse(url).path
    match = PDF_PATTERN.search(path)
    if not match:
        return None
    date_part, hour, minute, am_pm = match.groups()
    try:
        parsed = dt.datetime.strptime(
            f"{date_part}_{int(hour):02d}_{minute}{am_pm.upper()}",
            "%Y-%m-%d_%I_%M%p",
        )
    except ValueError:
        return None
    return parsed.replace(tzinfo=ET)


def latest_report_link(page_url: str, now_et: dt.datetime) -> tuple[str, dt.datetime]:
    page_html = request_bytes(page_url).decode("utf-8", errors="replace")
    parser = LinkParser()
    parser.feed(page_html)
    candidates = set()
    for href in parser.links:
        absolute = urllib.parse.urljoin(page_url, href)
        if PDF_PATTERN.search(urllib.parse.urlparse(absolute).path):
            candidates.add(absolute)
    # Catch a linked report even if the site places the URL outside a normal anchor.
    for match in re.findall(
        r"""(?:https?:)?//[^"' <>]+Injury-Report_\d{4}-\d{2}-\d{2}_\d{1,2}_\d{2}(?:AM|PM)\.pdf""",
        page_html,
        flags=re.IGNORECASE,
    ):
        candidates.add(urllib.parse.urljoin(page_url, match))
    dated = [(url, report_datetime_from_url(url)) for url in candidates]
    dated = [(url, stamp) for url, stamp in dated if stamp and stamp <= now_et]
    if not dated:
        raise RuntimeError(f"No published injury-report PDF was found on {page_url}")
    return max(dated, key=lambda item: item[1])


def report_team_prefix(line: str) -> tuple[str, str] | None:
    matchup = re.search(r"\b[A-Z]{2,3}\s*@\s*[A-Z]{2,3}\b", line)
    candidate = line[matchup.end():].strip() if matchup else line.strip()
    folded = candidate.casefold()
    for label, abbreviation in TEAM_LABELS:
        if folded.startswith(label.casefold()):
            suffix = candidate[len(label):].strip()
            return abbreviation, suffix
    return None


def normalize_report_name(raw_name: str) -> str:
    parts = [part.strip() for part in raw_name.split(",") if part.strip()]
    if len(parts) >= 3 and parts[1].casefold().rstrip(".") in SUFFIXES:
        name = f"{parts[2]} {parts[0]} {parts[1]}"
    elif len(parts) >= 2:
        name = f"{parts[1]} {parts[0]}"
    else:
        name = raw_name.strip()
    return re.sub(r"\s+", " ", name).strip()


def normalize_lookup_name(value: str) -> str:
    value = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(value or ""))
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    tokens = re.sub(r"[^a-z0-9 ]", " ", plain.casefold()).split()
    if len(tokens) > 2 and len(tokens[0]) == len(tokens[1]) == 1:
        tokens[:2] = ["".join(tokens[:2])]
    if tokens and tokens[-1] in SUFFIXES:
        tokens.pop()
    normalized = " ".join(tokens)
    return NAME_ALIASES.get(normalized, normalized)


def extract_report_rows(pdf_bytes: bytes) -> tuple[list[dict], dict[str, str]]:
    teams = {
        abbreviation: {
            "abbreviation": abbreviation,
            "name": labels[0],
            "report_status": "not_in_report",
            "players": [],
        }
        for abbreviation, labels in TEAM_NAMES.items()
    }
    current_team = None
    current_game = {"game_date": None, "game_time_et": None, "matchup": None}
    last_player = None
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=2, y_tolerance=3) or ""
            for source_line in text.splitlines():
                line = re.sub(r"\s+", " ", source_line).strip()
                if not line:
                    continue
                if line.casefold().startswith(("injury report:", "page ")):
                    last_player = None
                    continue
                if line.casefold().startswith("game date game time"):
                    last_player = None
                    continue

                game_match = re.search(
                    r"(?:(?P<date>\d{1,2}/\d{1,2}/\d{4})\s+)?"
                    r"(?P<time>\d{1,2}:\d{2})\s*\(ET\)\s*"
                    r"(?P<matchup>[A-Z]{2,3}\s*@\s*[A-Z]{2,3})",
                    line,
                )
                if game_match:
                    raw_game_date = game_match.group("date")
                    game_date = (
                        dt.datetime.strptime(raw_game_date, "%m/%d/%Y").date().isoformat()
                        if raw_game_date
                        else current_game["game_date"]
                    )
                    current_game = {
                        "game_date": game_date,
                        "game_time_et": game_match.group("time"),
                        "matchup": re.sub(r"\s+", "", game_match.group("matchup")),
                    }

                team_prefix = report_team_prefix(line)
                if team_prefix:
                    current_team, remainder = team_prefix
                    team = teams[current_team]
                    team["report_status"] = "submitted"
                    last_player = None
                    if "not yet submitted" in remainder.casefold():
                        team["report_status"] = "not_yet_submitted"
                        continue
                    if "no players listed" in remainder.casefold():
                        continue
                    line = remainder
                    if not line:
                        continue

                if current_team is None:
                    continue
                if "not yet submitted" in line.casefold():
                    teams[current_team]["report_status"] = "not_yet_submitted"
                    last_player = None
                    continue
                if "no players listed" in line.casefold():
                    last_player = None
                    continue

                status_match = STATUS_PATTERN.search(line)
                if not status_match:
                    # PDF extraction often wraps only the reason onto the next line.
                    if last_player and not line.casefold().startswith(("injury report:", "page ")):
                        reason = line.strip()
                        if reason:
                            prior = last_player.get("reason") or ""
                            last_player["reason"] = (prior + " " + reason).strip()
                    continue

                raw_name = line[:status_match.start()].strip(" -|")
                if not raw_name:
                    continue
                player_name = normalize_report_name(raw_name)
                reason = line[status_match.end():].strip(" -|") or None
                player = {
                    "team_abbreviation": current_team,
                    "team_name": teams[current_team]["name"],
                    **current_game,
                    "player_name": player_name,
                    "current_status": status_match.group(1).title(),
                    "reason": reason,
                    "_lookup_name": normalize_lookup_name(player_name),
                }
                teams[current_team]["players"].append(player)
                last_player = player

    if not any(team["players"] or team["report_status"] == "not_yet_submitted" for team in teams.values()):
        raise RuntimeError("The official injury report PDF yielded no team or player rows")
    for team in teams.values():
        seen = set()
        unique = []
        for player in team["players"]:
            key = normalize_lookup_name(player["player_name"])
            if key in seen:
                continue
            seen.add(key)
            unique.append(player)
        team["players"] = unique
    report_statuses = {abbr: team["report_status"] for abbr, team in teams.items()}
    return [player for team in teams.values() for player in team["players"]], report_statuses


class AdvancedTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.in_row = False
        self.stat_name = None
        self.cell_text: list[str] = []
        self.row: dict[str, str] = {}
        self.rows: list[dict[str, str]] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "table" and attributes.get("id") == "advanced":
            self.in_table = True
        elif self.in_table and tag == "tr":
            self.in_row = True
            self.row = {}
        elif self.in_table and self.in_row and tag in ("td", "th"):
            self.stat_name = attributes.get("data-stat")
            self.cell_text = []

    def handle_data(self, data):
        if self.stat_name:
            self.cell_text.append(data)

    def handle_endtag(self, tag):
        if self.stat_name and tag in ("td", "th"):
            self.row[self.stat_name] = " ".join("".join(self.cell_text).split())
            self.stat_name = None
            self.cell_text = []
        elif tag == "tr" and self.in_table and self.in_row:
            if self.row.get("player") or self.row.get("name_display"):
                self.rows.append(self.row)
            self.in_row = False
        elif tag == "table" and self.in_table:
            self.in_table = False


def parse_advanced_table(html: str) -> list[dict[str, str]]:
    html = re.sub(r"<!--\s*", "", html)
    html = re.sub(r"\s*-->", "", html)
    marker = re.search(r"<table\b[^>]*\bid=[\"']advanced[\"']", html, re.IGNORECASE)
    if marker:
        table_end = html.find("</table>", marker.end())
        if table_end >= 0:
            html = html[marker.start():table_end + len("</table>")]
    parser = AdvancedTableParser()
    parser.feed(html)
    return parser.rows


def number(value):
    if value is None:
        return None
    try:
        parsed = float(str(value).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def player_metrics(rows: list[dict[str, str]]) -> dict[str, list[dict]]:
    grouped = defaultdict(list)
    for row in rows:
        raw_name = row.get("player") or row.get("name_display") or ""
        key = normalize_lookup_name(raw_name)
        if not key or key == "player":
            continue
        games = number(row.get("g") or row.get("games"))
        minutes = number(row.get("mp"))
        raw_team = str(row.get("team_id") or row.get("team_name_abbr") or row.get("team") or "").strip().upper()
        row_team = raw_team if raw_team in ("2TM", "3TM", "TOT") else re.sub(r"[^A-Z]", "", raw_team)
        if row_team in ("2TM", "3TM", "TOT"):
            row_team = "TOT"
        grouped[key].append({
            "team": row_team,
            "games": games,
            "minutes": minutes,
            "minutes_per_game": minutes / games if minutes is not None and games and games > 0 else None,
            "usg_pct": number(row.get("usg_pct")),
            "obpm": number(row.get("obpm")),
            "dbpm": number(row.get("dbpm")),
        })
    return grouped


def select_player_metrics(grouped: dict[str, list[dict]], player_key: str, team_abbreviation: str) -> dict | None:
    candidates = grouped.get(player_key) or []
    if not candidates:
        return None
    chosen = next((row for row in candidates if row["team"] == "TOT"), None)
    if chosen is None:
        chosen = next((row for row in candidates if row["team"] == team_abbreviation), None)
    if chosen is None:
        chosen = max(candidates, key=lambda row: row["games"] or 0)
    return chosen


def fetch_advanced_stats(url: str) -> tuple[list[dict[str, str]], str]:
    html = request_bytes(url, headers={
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://www.basketball-reference.com/",
    }).decode("utf-8", errors="replace")
    rows = parse_advanced_table(html)
    if not rows:
        raise RuntimeError("The direct Basketball-Reference response contained no advanced table")
    return rows, "direct"


def attach_metrics(players: list[dict], grouped: dict[str, list[dict]] | None, stats_available: bool) -> None:
    for player in players:
        metrics = select_player_metrics(
            grouped or {},
            player["_lookup_name"],
            player["team_abbreviation"],
        )
        if not stats_available:
            match_status = "source_unavailable"
        elif metrics is None:
            match_status = "no_current_season_row"
        else:
            values = (
                metrics["minutes_per_game"],
                metrics["usg_pct"],
                metrics["obpm"],
                metrics["dbpm"],
            )
            match_status = "matched" if all(value is not None for value in values) else "partial"
        player.update({
            "minutes_per_game": metrics["minutes_per_game"] if metrics else None,
            "usg_pct": metrics["usg_pct"] if metrics else None,
            "obpm": metrics["obpm"] if metrics else None,
            "dbpm": metrics["dbpm"] if metrics else None,
            "metrics_status": match_status,
        })
        player.pop("_lookup_name", None)


def write_json(path: Path, payload: dict) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


def main() -> None:
    now_et = dt.datetime.now(ET)
    start, end, season_label = season_for_date(now_et.date())
    page_url = INJURY_PAGE_TEMPLATE.format(start=start, end2=end % 100)
    bref_url = BREF_ADVANCED_TEMPLATE.format(end=end)
    pdf_url, report_time = latest_report_link(page_url, now_et)
    pdf_bytes = request_bytes(pdf_url, headers={"Accept": "application/pdf,application/octet-stream"})
    players, team_report_status = extract_report_rows(pdf_bytes)
    if not players:
        raise RuntimeError(f"No player rows were parsed from the official NBA PDF: {pdf_url}")

    stats_error = None
    stats_method = "unavailable"
    grouped = None
    try:
        rows, stats_method = fetch_advanced_stats(bref_url)
        grouped = player_metrics(rows)
    except Exception as error:
        stats_error = str(error)[:500]
        print("WARN Basketball-Reference metrics unavailable: " + stats_error)

    attach_metrics(players, grouped, grouped is not None)
    for player in players:
        player["reason"] = player.get("reason") or None
    players.sort(key=lambda row: (row["team_abbreviation"], row["player_name"].casefold()))

    teams = []
    for abbreviation, labels in sorted(TEAM_NAMES.items()):
        team_players = [player for player in players if player["team_abbreviation"] == abbreviation]
        teams.append({
            "team_abbreviation": abbreviation,
            "team_name": labels[0],
            "report_status": team_report_status[abbreviation],
            "player_count": len(team_players),
        })

    report_time_text = report_time.strftime("%Y-%m-%d %I:%M %p ET")
    payload = {
        "schema_version": 1,
        "season": {
            "label": season_label,
            "start_year": start,
            "end_year": end,
        },
        "report": {
            "report_time_et": report_time_text,
            "report_date": report_time.date().isoformat(),
            "report_url": pdf_url,
            "index_url": page_url,
        },
        "player_metrics": {
            "source": "Basketball-Reference advanced table",
            "source_url": bref_url,
            "season_end_year": end,
            "fetch_method": stats_method,
            "available": grouped is not None,
            "error": stats_error,
            "fields": {
                "minutes_per_game": "Basketball-Reference MP divided by G",
                "usg_pct": "Basketball-Reference USG%",
                "obpm": "Basketball-Reference OBPM",
                "dbpm": "Basketball-Reference DBPM",
            },
        },
        "team_count": len(teams),
        "listed_player_count": len(players),
        "teams": teams,
        "players": players,
    }

    report_stamp = report_time.strftime("%I-%M%p").lower()
    archive_path = (
        OUTPUT_ROOT / "nba-injuries" / "v1" / season_label
        / "reports" / report_time.date().isoformat() / f"{report_stamp}.json"
    )
    season_latest = OUTPUT_ROOT / "nba-injuries" / "v1" / season_label / "latest.json"
    stable_latest = OUTPUT_ROOT / "nba-injuries" / "v1" / "latest.json"
    for path in (archive_path, season_latest, stable_latest):
        changed = write_json(path, payload)
        print(("Updated " if changed else "Unchanged ") + str(path.relative_to(OUTPUT_ROOT)))

    matched = sum(player["metrics_status"] == "matched" for player in players)
    partial = sum(player["metrics_status"] == "partial" for player in players)
    print(
        f"Published report {report_time_text}: {len(players)} listed players across "
        f"{sum(team['report_status'] == 'submitted' for team in teams)} submitted teams; "
        f"metrics matched={matched}, partial={partial}, source={stats_method}."
    )


if __name__ == "__main__":
    main()
