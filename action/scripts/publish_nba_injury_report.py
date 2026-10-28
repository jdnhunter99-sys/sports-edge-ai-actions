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
BROWSERLESS_FUNCTION_URL = "https://production-sfo.browserless.io/function"
INJURY_PAGE_TEMPLATE = "https://official.nba.com/nba-injury-report-{start}-{end2}-season/"
BREF_ADVANCED_TEMPLATE = "https://www.basketball-reference.com/leagues/NBA_{end}_advanced.html"
PDF_PATTERN = re.compile(
    r"Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{1,2})_(\d{2})(AM|PM)\.pdf",
    re.IGNORECASE,
)
STATUS_PATTERN = re.compile(r"\b(Out|Doubtful|Questionable|Probable|Available)\b", re.IGNORECASE)
MATCHUP_PATTERN = re.compile(r"\b(?P<away>[A-Z]{2,3})\s*@\s*(?P<home>[A-Z]{2,3})\b")
GAME_DATE_PATTERN = re.compile(r"\b(?P<date>\d{1,2}/\d{1,2}/\d{4})\b")
GAME_TIME_PATTERN = re.compile(r"\b(?P<time>\d{1,2}:\d{2})\s*\(ET\)")
PLAYER_METRIC_FIELDS = ("minutes_per_game", "usg_pct", "obpm", "dbpm")
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


def extract_report_rows(pdf_bytes: bytes) -> tuple[list[dict], dict[str, list[dict]]]:
    teams = {
        abbreviation: {
            "abbreviation": abbreviation,
            "name": labels[0],
            "players": [],
            "reports": {},
        }
        for abbreviation, labels in TEAM_NAMES.items()
    }
    current_team = None
    current_game = {"game_date": None, "game_time_et": None, "matchup": None}
    last_player = None

    def set_team_report_status(abbreviation: str, status: str) -> None:
        game_key = (current_game["game_date"], current_game["matchup"])
        reports = teams[abbreviation]["reports"]
        report = reports.setdefault(game_key, {
            "game_date": current_game["game_date"],
            "game_time_et": current_game["game_time_et"],
            "matchup": current_game["matchup"],
            "report_status": None,
        })
        if current_game["game_time_et"]:
            report["game_time_et"] = current_game["game_time_et"]
        report["report_status"] = status

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

                matchup_match = MATCHUP_PATTERN.search(line)
                if matchup_match:
                    header_prefix = line[:matchup_match.start()]
                    date_match = GAME_DATE_PATTERN.search(header_prefix)
                    time_match = GAME_TIME_PATTERN.search(header_prefix)
                    raw_game_date = date_match.group("date") if date_match else None
                    game_date = (
                        dt.datetime.strptime(raw_game_date, "%m/%d/%Y").date().isoformat()
                        if raw_game_date
                        else current_game["game_date"]
                    )
                    matchup = f"{matchup_match.group('away')}@{matchup_match.group('home')}"
                    matchup_changed = matchup != current_game["matchup"]
                    if time_match:
                        game_time_et = time_match.group("time")
                    elif matchup_changed:
                        game_time_et = None
                    else:
                        game_time_et = current_game["game_time_et"]
                    current_game = {
                        "game_date": game_date,
                        "game_time_et": game_time_et,
                        "matchup": matchup,
                    }

                team_prefix = report_team_prefix(line)
                if team_prefix:
                    current_team, remainder = team_prefix
                    last_player = None
                    if "not yet submitted" in remainder.casefold():
                        set_team_report_status(current_team, "not_yet_submitted")
                        continue
                    set_team_report_status(current_team, "submitted")
                    if "no players listed" in remainder.casefold():
                        continue
                    line = remainder
                    if not line:
                        continue

                if current_team is None:
                    continue
                if "not yet submitted" in line.casefold():
                    set_team_report_status(current_team, "not_yet_submitted")
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
                set_team_report_status(current_team, "submitted")
                teams[current_team]["players"].append(player)
                last_player = player

    if not any(team["players"] or team["reports"] for team in teams.values()):
        raise RuntimeError("The official injury report PDF yielded no team or player rows")

    invalid_matchups = [
        player for team in teams.values() for player in team["players"]
        if not player["matchup"]
        or player["team_abbreviation"] not in player["matchup"].split("@")
    ]
    if invalid_matchups:
        examples = ", ".join(
            f"{player['player_name']} ({player['team_abbreviation']} in {player['matchup'] or 'no matchup'})"
            for player in invalid_matchups[:5]
        )
        raise RuntimeError(
            f"Parsed {len(invalid_matchups)} player row(s) with a missing or mismatched matchup: {examples}"
        )

    for team in teams.values():
        seen = set()
        unique = []
        for player in team["players"]:
            key = (
                normalize_lookup_name(player["player_name"]),
                player["game_date"],
                player["matchup"],
            )
            if key in seen:
                continue
            seen.add(key)
            unique.append(player)
        team["players"] = unique

    team_reports = {}
    for abbreviation, team in teams.items():
        serialized_reports = []
        for report in team["reports"].values():
            player_count = sum(
                player["game_date"] == report["game_date"]
                and player["matchup"] == report["matchup"]
                for player in team["players"]
            )
            serialized_reports.append({
                "game_date": report["game_date"],
                "game_time_et": report["game_time_et"],
                "matchup": report["matchup"],
                "report_status": report["report_status"] or "submitted",
                "player_count": player_count,
            })
        team_reports[abbreviation] = sorted(
            serialized_reports,
            key=lambda report: (
                report["game_date"] or "",
                report["game_time_et"] or "",
                report["matchup"] or "",
            ),
        )

    return [player for team in teams.values() for player in team["players"]], team_reports


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


def select_player_metrics(candidates: list[dict]) -> dict | None:
    if not candidates:
        return None
    total_row = next((row for row in candidates if row["team"] == "TOT"), None)
    if total_row is not None:
        return total_row
    return max(candidates, key=lambda row: row["games"] or 0)


def player_metrics(rows: list[dict[str, str]]) -> tuple[dict[str, list[dict]], dict[str, int]]:
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

    # Rank one season profile per player. Use Basketball-Reference's TOT row for
    # traded players; if there is no total row, use the player's most-played team.
    profiles = {
        player_key: select_player_metrics(candidates)
        for player_key, candidates in grouped.items()
    }
    rank_populations = {}
    for metric in PLAYER_METRIC_FIELDS:
        ranked_profiles = sorted(
            (
                (player_key, profile[metric])
                for player_key, profile in profiles.items()
                if profile is not None and profile[metric] is not None
            ),
            key=lambda item: item[1],
            reverse=True,
        )
        rank_populations[metric] = len(ranked_profiles)
        previous_value = None
        previous_rank = None
        for position, (player_key, value) in enumerate(ranked_profiles, start=1):
            rank = previous_rank if value == previous_value else position
            profiles[player_key][f"{metric}_rank"] = rank
            previous_value = value
            previous_rank = rank

    return grouped, rank_populations


def selected_profile_metrics(grouped: dict[str, list[dict]], player_key: str) -> dict | None:
    candidates = grouped.get(player_key) or []
    return select_player_metrics(candidates)


def fetch_browserless_page(url: str) -> str:
    token = os.environ.get("BROWSERLESS_TOKEN", "").strip()
    if not token:
        raise RuntimeError("BROWSERLESS_TOKEN is not configured")

    browser_function = """
export default async ({ page, context }) => {
  await page.setUserAgent(context.userAgent);
  await page.setExtraHTTPHeaders(context.headers);
  const response = await page.goto(context.url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  return {
    data: {
      status: response ? response.status() : null,
      body: response ? await response.text() : "",
    },
    type: "application/json",
  };
};
"""
    browserless_url = BROWSERLESS_FUNCTION_URL + "?token=" + urllib.parse.quote(token, safe="")
    request_body = json.dumps({
        "code": browser_function,
        "context": {
            "url": url,
            "userAgent": USER_AGENT,
            "headers": {
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.basketball-reference.com/",
            },
        },
    }).encode("utf-8")
    request = urllib.request.Request(
        browserless_url,
        data=request_body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read(1000).decode("utf-8", errors="replace").replace(token, "[redacted]")
        raise RuntimeError(f"Browserless function request failed with HTTP {error.code}: {detail}") from None
    except Exception as error:
        detail = str(error).replace(token, "[redacted]")
        raise RuntimeError(f"Browserless function request failed: {detail}") from None

    result_data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(result_data, dict):
        raise RuntimeError("Browserless returned an unexpected response shape")
    status = result_data.get("status")
    if status != 200:
        raise RuntimeError(f"Browserless navigation to Basketball-Reference returned HTTP {status}")
    return str(result_data.get("body") or "")


def fetch_advanced_stats(url: str) -> tuple[list[dict[str, str]], str]:
    direct_error = None
    try:
        html = request_bytes(url, headers={
            "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://www.basketball-reference.com/",
        }).decode("utf-8", errors="replace")
        rows = parse_advanced_table(html)
        if rows:
            return rows, "direct"
        direct_error = "direct request returned no advanced table"
    except Exception as error:
        direct_error = str(error)[:300]

    try:
        html = fetch_browserless_page(url)
        rows = parse_advanced_table(html)
        if rows:
            return rows, "browserless"
        raise RuntimeError("Browserless response contained no advanced table")
    except Exception as error:
        raise RuntimeError(
            f"Basketball-Reference direct fetch failed ({direct_error}); "
            f"Browserless fallback failed ({str(error)[:300]})"
        ) from error


def attach_metrics(
    players: list[dict],
    grouped: dict[str, list[dict]] | None,
    stats_available: bool,
) -> None:
    for player in players:
        metrics = selected_profile_metrics(grouped or {}, player["_lookup_name"])
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
                *(metrics.get(f"{field}_rank") for field in PLAYER_METRIC_FIELDS),
            )
            match_status = "matched" if all(value is not None for value in values) else "partial"
        player.update({
            "minutes_per_game": metrics["minutes_per_game"] if metrics else None,
            "usg_pct": metrics["usg_pct"] if metrics else None,
            "obpm": metrics["obpm"] if metrics else None,
            "dbpm": metrics["dbpm"] if metrics else None,
            **{
                f"{field}_rank": metrics.get(f"{field}_rank") if metrics else None
                for field in PLAYER_METRIC_FIELDS
            },
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
    players, team_reports = extract_report_rows(pdf_bytes)
    if not players:
        raise RuntimeError(f"No player rows were parsed from the official NBA PDF: {pdf_url}")

    stats_error = None
    stats_method = "unavailable"
    grouped = None
    rank_populations = {field: 0 for field in PLAYER_METRIC_FIELDS}
    try:
        rows, stats_method = fetch_advanced_stats(bref_url)
        grouped, rank_populations = player_metrics(rows)
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
        reports = team_reports[abbreviation]
        report_statuses = {report["report_status"] for report in reports}
        report_status = (
            "not_in_report" if not report_statuses
            else next(iter(report_statuses)) if len(report_statuses) == 1
            else "mixed"
        )
        teams.append({
            "team_abbreviation": abbreviation,
            "team_name": labels[0],
            "report_status": report_status,
            "player_count": len(team_players),
            "reports": reports,
        })

    metric_counts = defaultdict(int)
    for player in players:
        metric_counts[player["metrics_status"]] += 1
    matched = metric_counts["matched"]
    metric_coverage = {
        "player_count": len(players),
        "matched": matched,
        "partial": metric_counts["partial"],
        "no_current_season_row": metric_counts["no_current_season_row"],
        "source_unavailable": metric_counts["source_unavailable"],
        "complete_coverage_rate": round(matched / len(players), 4) if players else None,
    }
    coverage_status = (
        "unavailable" if grouped is None
        else "complete" if matched == len(players)
        else "partial"
    )

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
            # `available` means a usable source table was retrieved. It does not
            # imply that every injury-report player has a row in that table.
            "available": grouped is not None,
            "all_players_matched": matched == len(players),
            "coverage_status": coverage_status,
            "coverage": metric_coverage,
            "rank_method": "Competition rank; 1 is highest, ties share rank; one season row per player",
            "rank_population": rank_populations,
            "error": stats_error,
            "fields": {
                "minutes_per_game": "Basketball-Reference MP divided by G",
                "minutes_per_game_rank": "Rank by minutes per game among all unique players on the season page",
                "usg_pct": "Basketball-Reference USG%",
                "usg_pct_rank": "Rank by USG% among all unique players on the season page",
                "obpm": "Basketball-Reference OBPM",
                "obpm_rank": "Rank by OBPM among all unique players on the season page",
                "dbpm": "Basketball-Reference DBPM",
                "dbpm_rank": "Rank by DBPM among all unique players on the season page",
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

    submitted_reports = sum(
        report["report_status"] == "submitted"
        for reports in team_reports.values()
        for report in reports
    )
    print(
        f"Published report {report_time_text}: {len(players)} listed players across "
        f"{submitted_reports} submitted team-game reports; "
        f"metrics matched={matched}, partial={metric_counts['partial']}, "
        f"no_current_season_row={metric_counts['no_current_season_row']}, source={stats_method}."
    )


if __name__ == "__main__":
    main()
