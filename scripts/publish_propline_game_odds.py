#!/usr/bin/env python3
"""Publish per-game PropLine caches for SportsEdgeAI game-detail odds.

Design:
- Every run: one bulk current-odds request per sport (h2h, spreads, totals),
  except NFL and CFB, which fetch one event at a time for the next 14 days.
- Never call PropLine /odds/history or /movement in the recurring publisher.
- Append changed quotes to each saved game cache every 10 minutes.
The saved observations become the line-movement history used by the existing overlay.
"""
import json, os, re, shutil, tempfile, time, urllib.error, urllib.request, unicodedata
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from statistics import median
from urllib.parse import quote, urlencode

API = 'https://api.prop-line.com/v1'
MARKETS = 'h2h,spreads,totals'
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
SPORTS = {
    'nfl': 'football_nfl',
    'mlb': 'baseball_mlb',
    'nhl': 'hockey_nhl',
    'wnba': 'basketball_wnba',
    'nba': 'basketball_nba',
    'cfb': 'football_ncaaf',
}
PREFERRED_BOOKS = ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers', 'fanatics']
KEEP_AFTER_HOURS = 72
MAX_HISTORY_DAYS = 30
EVENT_ODDS_WINDOW_DAYS = 14
EVENT_INCLUDE_STARTED_HOURS = 8
EVENT_ODDS_SPORTS = {SPORTS['nfl'], SPORTS['cfb']}


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def norm(v):
    return unicodedata.normalize('NFKD', str(v or '')).encode('ascii', 'ignore').decode().lower().strip()


def slug(v):
    return re.sub(r'[^a-z0-9]+', '-', norm(v)).strip('-') or 'unknown'


def _retry_delay(attempt, retry_after=None):
    if retry_after:
        try:
            return min(30, max(1, float(retry_after)))
        except (TypeError, ValueError):
            pass
    return min(30, 2 ** (attempt + 1))


class PropLineResponseTooLarge(Exception):
    pass


def request_json(url, key, timeout=65, retries=4, context='PropLine request', market_count=1):
    retryable_statuses = {408, 425, 429, 500, 502, 503, 504}
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={'X-API-Key': key, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                content_length = res.headers.get('Content-Length')
                try:
                    oversized = content_length is not None and int(content_length) > MAX_RESPONSE_BYTES
                except (TypeError, ValueError):
                    oversized = False
                if oversized:
                    raise PropLineResponseTooLarge(
                        f'Content-Length {content_length} exceeds {MAX_RESPONSE_BYTES} bytes'
                    )
                body = res.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise PropLineResponseTooLarge(
                        f'response exceeded {MAX_RESPONSE_BYTES} bytes while streaming'
                    )
                return json.loads(body)
        except PropLineResponseTooLarge:
            raise
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 404, 409, 422):
                return None
            if exc.code not in retryable_statuses or attempt >= retries:
                raise
            # Split a multi-market request after a repeated gateway timeout instead
            # of retrying the same large request for the full retry window.
            if exc.code == 504 and market_count > 1 and attempt >= 1:
                raise
            delay = _retry_delay(attempt, exc.headers.get('Retry-After'))
            print(
                f'{context}: PropLine returned HTTP {exc.code}; retry {attempt + 1}/{retries} '
                f'in {delay:.0f}s',
                flush=True,
            )
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt >= retries:
                raise
            delay = _retry_delay(attempt)
            print(
                f'{context}: PropLine request failed ({exc}); retry {attempt + 1}/{retries} '
                f'in {delay:.0f}s',
                flush=True,
            )
            time.sleep(delay)
    return None


def _merge_event_rows(rows):
    merged = {}
    bookmaker_maps = {}
    market_sets = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        event_id = str(row.get('id') or row.get('event_id') or '__single__')
        if event_id not in merged:
            merged[event_id] = {name: value for name, value in row.items() if name != 'bookmakers'}
            merged[event_id]['bookmakers'] = []
            bookmaker_maps[event_id] = {}
            market_sets[event_id] = {}
        else:
            for name, value in row.items():
                if name != 'bookmakers' and merged[event_id].get(name) in (None, '') and value not in (None, ''):
                    merged[event_id][name] = value
        for bookmaker in row.get('bookmakers') or []:
            if not isinstance(bookmaker, dict):
                continue
            book_key = str(bookmaker.get('key') or bookmaker.get('title') or f'book-{len(bookmaker_maps[event_id])}')
            target = bookmaker_maps[event_id].get(book_key)
            if target is None:
                target = {name: value for name, value in bookmaker.items() if name != 'markets'}
                target['markets'] = []
                bookmaker_maps[event_id][book_key] = target
                market_sets[event_id][book_key] = set()
                merged[event_id]['bookmakers'].append(target)
            for market in bookmaker.get('markets') or []:
                if not isinstance(market, dict):
                    continue
                signature = tuple(
                    str(market.get(field) or '')
                    for field in ('key', 'description', 'line_type', 'period', 'team')
                )
                if signature in market_sets[event_id][book_key]:
                    continue
                market_sets[event_id][book_key].add(signature)
                target['markets'].append(market)
    return list(merged.values())


def _merge_market_payloads(payloads):
    payloads = [payload for payload in payloads if isinstance(payload, (dict, list))]
    if not payloads:
        return None
    first = payloads[0]
    if isinstance(first, list):
        return _merge_event_rows([row for payload in payloads if isinstance(payload, list) for row in payload])
    if any(isinstance(payload, dict) and isinstance(payload.get('events'), list) for payload in payloads):
        events = _merge_event_rows([
            row for payload in payloads if isinstance(payload, dict) for row in payload.get('events', [])
        ])
        return {**first, 'events': events}
    return _merge_event_rows([payload for payload in payloads if isinstance(payload, dict)])[0]


def _fetch_market_partitions(provider, markets, key, context='bulk current odds', event_id=None):
    endpoint = f'{API}/sports/{provider}/odds'
    if event_id is not None:
        endpoint = f'{API}/sports/{provider}/events/{quote(str(event_id), safe="")}/odds'
    url = endpoint + '?' + urlencode({'markets': ','.join(markets)})
    try:
        return request_json(
            url,
            key,
            timeout=65,
            retries=4 if len(markets) == 1 else 1,
            context=context,
            market_count=len(markets),
        ), 1
    except PropLineResponseTooLarge as exc:
        reason = str(exc)
    except urllib.error.HTTPError as exc:
        if exc.code != 504 or len(markets) <= 1:
            raise
        reason = f'repeated HTTP {exc.code}'
    if len(markets) <= 1:
        raise PropLineResponseTooLarge(f'{context}: one-market response remains too large ({reason})')
    midpoint = (len(markets) + 1) // 2
    left, right = markets[:midpoint], markets[midpoint:]
    print(
        f'{context}: {reason}; splitting {len(markets)} markets into '
        f'{len(left)} + {len(right)}',
        flush=True,
    )
    left_payload, left_requests = _fetch_market_partitions(provider, left, key, context, event_id)
    right_payload, right_requests = _fetch_market_partitions(provider, right, key, context, event_id)
    return _merge_market_payloads([left_payload, right_payload]), left_requests + right_requests


def _as_utc(value):
    parsed = parse_ts(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _event_odds_row(body, listed_event, event_id):
    row = None
    if isinstance(body, list):
        row = next((item for item in body if isinstance(item, dict) and str(item.get('id') or item.get('event_id')) == str(event_id)), None)
        if row is None:
            row = next((item for item in body if isinstance(item, dict)), None)
    elif isinstance(body, dict):
        if isinstance(body.get('events'), list):
            row = next((item for item in body['events'] if isinstance(item, dict) and str(item.get('id') or item.get('event_id')) == str(event_id)), None)
        elif isinstance(body.get('event'), dict):
            row = body['event']
        elif isinstance(body.get('data'), dict) and ('bookmakers' in body['data'] or isinstance(body['data'].get('event'), dict)):
            row = body['data'].get('event') if isinstance(body['data'].get('event'), dict) else body['data']
        else:
            row = body
    if not isinstance(row, dict):
        row = {}
    return {**listed_event, **row, 'id': row.get('id') or row.get('event_id') or listed_event.get('id') or str(event_id)}


def _fetch_event_window_current(provider, key):
    """Fetch event metadata once, then request game markets one event at a time."""
    listing_url = f'{API}/sports/{provider}/events'
    listed = request_json(listing_url, key, timeout=65, context=f'{provider} events')
    if isinstance(listed, dict) and isinstance(listed.get('events'), list):
        listed = listed['events']
    if not isinstance(listed, list):
        raise ValueError(f'{provider}: unexpected events response')

    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=EVENT_INCLUDE_STARTED_HOURS)
    end = now + timedelta(days=EVENT_ODDS_WINDOW_DAYS)
    candidates = []
    for event in listed:
        if not isinstance(event, dict) or event.get('id') is None:
            continue
        commence = _as_utc(event.get('commence_time'))
        if commence is not None and start <= commence <= end:
            candidates.append((commence, event))
    candidates.sort(key=lambda item: item[0])

    events = []
    request_count = 1  # event-list request
    markets = MARKETS.split(',')
    print(
        f'{provider}: fetching {len(candidates)} events from the last {EVENT_INCLUDE_STARTED_HOURS}h '
        f'through the next {EVENT_ODDS_WINDOW_DAYS} days one game at a time',
        flush=True,
    )
    for index, (_, listed_event) in enumerate(candidates, start=1):
        event_id = str(listed_event['id'])
        context = f'{provider} event {event_id} odds [{index}/{len(candidates)}]'
        body, event_requests = _fetch_market_partitions(
            provider, markets, key, context, event_id=event_id,
        )
        request_count += event_requests
        events.append(_event_odds_row(body, listed_event, event_id))
    return events, request_count


def fetch_current(provider, key):
    markets = MARKETS.split(',')
    if provider in EVENT_ODDS_SPORTS:
        print(f'Fetching PropLine current odds for {provider} per event ({len(markets)} markets)', flush=True)
        try:
            return _fetch_event_window_current(provider, key)
        except Exception as exc:
            raise RuntimeError(f'{provider}: per-event current odds request failed: {exc}') from exc
    print(f'Fetching PropLine current odds for {provider} ({len(markets)} markets)', flush=True)
    try:
        body, request_count = _fetch_market_partitions(provider, markets, key, f'{provider} bulk odds')
    except (PropLineResponseTooLarge, urllib.error.HTTPError) as exc:
        # Some sports exceed PropLine's response cap even after market
        # partitioning. Retry the whole sport as one request per event, matching
        # the safe path used for NFL/CFB and keeping each response bounded.
        should_fetch_per_event = isinstance(exc, PropLineResponseTooLarge) or exc.code == 504
        if not should_fetch_per_event:
            raise RuntimeError(f'{provider}: bulk current odds request failed: {exc}') from exc
        print(f'{provider}: bulk response is too large or timing out; falling back to per-event odds fetch', flush=True)
        try:
            return _fetch_event_window_current(provider, key)
        except Exception as fallback_exc:
            raise RuntimeError(f'{provider}: bulk request failed ({exc}); per-event fallback failed: {fallback_exc}') from fallback_exc
    except Exception as exc:
        raise RuntimeError(f'{provider}: bulk current odds request failed: {exc}') from exc
    if isinstance(body, list):
        return body, request_count
    if isinstance(body, dict) and isinstance(body.get('events'), list):
        return body['events'], request_count
    raise ValueError(f'{provider}: unexpected bulk odds response')


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def market_side(market_key, outcome_name, event):
    name = norm(outcome_name)
    away = norm(event.get('away_team'))
    home = norm(event.get('home_team'))
    if market_key in ('h2h', 'spreads'):
        if name == away:
            return 'away'
        if name == home:
            return 'home'
        if name == 'draw':
            return 'draw'
    if market_key == 'totals':
        if name.startswith('over') or name == 'o':
            return 'over'
        if name.startswith('under') or name == 'u':
            return 'under'
    return name or 'unknown'


def _market_period_is_full_game(market):
    """Return True only for game-level markets (not innings/halves/team totals)."""
    if not isinstance(market, dict):
        return False
    # PropLine team totals use the totals key too, but identify a team on the market.
    if market.get('team') not in (None, '', False):
        return False
    period = market.get('period')
    if isinstance(period, dict):
        period = period.get('key') or period.get('name') or period.get('id')
    if period in (None, '', 0, '0'):
        return True
    normalized = norm(period).replace('-', '_').replace(' ', '_')
    return normalized in ('full_game', 'game', 'match', 'fullgame')


def _outcome_is_available(outcome):
    if not isinstance(outcome, dict):
        return False
    if outcome.get('available') is False or outcome.get('active') is False:
        return False
    if outcome.get('suspended') is True or outcome.get('is_suspended') is True:
        return False
    if outcome.get('is_alternate_line') is True or outcome.get('alternate') is True:
        return False
    price = outcome.get('price')
    try:
        price = float(price)
    except (TypeError, ValueError):
        return False
    return price != 0


def _american_main_score(price):
    """How far a quote is from a normal two-sided main-market price."""
    try:
        price = float(price)
    except (TypeError, ValueError):
        return 10**9
    # -110 is the most common anchor, but +100 should also score well.
    return min(abs(price + 110.0), abs(price - 100.0) + 10.0)


def _candidate(market, outcome, event, captured):
    mk = str(market.get('key') or '')
    return {
        'outcome': outcome,
        'side': market_side(mk, outcome.get('name'), event),
        'line': outcome.get('point'),
        'price': outcome.get('price'),
        'is_main': outcome.get('is_main_line') is True or market.get('is_main_line') is True,
        'explicit_non_main': outcome.get('is_main_line') is False or market.get('is_main_line') is False,
        'captured_at': market.get('last_update') or captured,
    }


def _book_market_candidates(book, market_key, event):
    candidates = []
    for market in book.get('markets') or []:
        if not isinstance(market, dict) or str(market.get('key') or '') != market_key:
            continue
        if not _market_period_is_full_game(market):
            continue
        if market.get('is_alternate_line') is True or market.get('alternate') is True:
            continue
        captured = market.get('last_update') or book.get('last_update')
        for outcome in market.get('outcomes') or []:
            if not _outcome_is_available(outcome):
                continue
            candidate = _candidate(market, outcome, event, captured)
            if candidate['side'] in ('away', 'home', 'over', 'under'):
                candidates.append(candidate)
    return candidates


def _select_moneyline_pair(book, event):
    candidates = _book_market_candidates(book, 'h2h', event)
    sides = {side: [c for c in candidates if c['side'] == side] for side in ('away', 'home')}
    if not sides['away'] and not sides['home']:
        return []

    def best(rows):
        if not rows:
            return None
        # Never discard a real H2H quote solely because is_main_line=false. Some
        # providers use that field inconsistently even though H2H has no ladder.
        return sorted(rows, key=lambda c: (
            0 if c['is_main'] else 1,
            -parse_ts(c['captured_at']).timestamp() if parse_ts(c['captured_at']) else 0,
            _american_main_score(c['price']),
        ))[0]

    return [c for c in (best(sides['away']), best(sides['home'])) if c]


def _select_paired_line(book, market_key, event):
    """Choose exactly one coherent full-game spread/total pair for a book."""
    candidates = _book_market_candidates(book, market_key, event)
    first_side, second_side = (('away', 'home') if market_key == 'spreads' else ('over', 'under'))
    groups = defaultdict(lambda: {first_side: [], second_side: []})
    for c in candidates:
        try:
            line = float(c['line'])
        except (TypeError, ValueError):
            continue
        canonical = abs(line) if market_key == 'spreads' else line
        if c['side'] in groups[canonical]:
            groups[canonical][c['side']].append(c)

    pairs = []
    for canonical, group in groups.items():
        if not group[first_side] or not group[second_side]:
            continue
        for first in group[first_side]:
            for second in group[second_side]:
                try:
                    a, b = float(first['line']), float(second['line'])
                except (TypeError, ValueError):
                    continue
                if market_key == 'spreads':
                    # A game spread must be complementary (+x / -x). Reject bad
                    # cross-market combinations such as +3.5 / +4.5.
                    if abs(abs(a) - abs(b)) > 1e-9 or (a != 0 and b != 0 and a * b > 0):
                        continue
                elif abs(a - b) > 1e-9:
                    continue

                main_count = int(first['is_main']) + int(second['is_main'])
                non_main_count = int(first['explicit_non_main']) + int(second['explicit_non_main'])
                balance = _american_main_score(first['price']) + _american_main_score(second['price'])
                latest = max(parse_ts(first['captured_at']) or datetime.min.replace(tzinfo=timezone.utc),
                             parse_ts(second['captured_at']) or datetime.min.replace(tzinfo=timezone.utc))
                pairs.append((main_count, non_main_count, balance, latest, first, second))

    if not pairs:
        return []

    # Main metadata is useful only as a preference, never as an absolute filter:
    # several PropLine books mark every alternate rung as main. Within the same
    # metadata tier, balanced two-sided pricing identifies the actual main line.
    pairs.sort(key=lambda p: (-p[0], p[1], p[2], -p[3].timestamp()))
    best = pairs[0]
    return [best[4], best[5]]


def selected_book_markets(book, event):
    """Return only the current full-game main markets for one sportsbook."""
    return {
        'h2h': _select_moneyline_pair(book, event),
        'spreads': _select_paired_line(book, 'spreads', event),
        'totals': _select_paired_line(book, 'totals', event),
    }


def current_observations(event, stamp):
    rows = []
    for book in event.get('bookmakers') or []:
        if not isinstance(book, dict):
            continue
        bk = str(book.get('key') or book.get('title') or '').lower()
        title = book.get('title') or bk
        for mk, selected in selected_book_markets(book, event).items():
            for candidate in selected:
                outcome = candidate['outcome']
                rows.append({
                    'captured_at': candidate.get('captured_at') or book.get('last_update') or stamp,
                    'bookmaker': bk,
                    'bookmaker_title': title,
                    'market': mk,
                    'side': candidate['side'],
                    'name': outcome.get('name'),
                    'line': outcome.get('point'),
                    'price': outcome.get('price'),
                    'outcome_id': outcome.get('outcome_id'),
                })
    return rows

def history_observations(payload, event):
    rows = []
    if not isinstance(payload, dict):
        return rows
    for book in payload.get('bookmakers') or []:
        if not isinstance(book, dict):
            continue
        bk = str(book.get('key') or book.get('title') or '').lower()
        title = book.get('title') or bk
        for market in book.get('markets') or []:
            if not isinstance(market, dict):
                continue
            mk = str(market.get('key') or '')
            if mk not in ('h2h', 'spreads', 'totals'):
                continue
            for outcome in market.get('outcomes') or []:
                if not isinstance(outcome, dict):
                    continue
                side = market_side(mk, outcome.get('name'), event)
                snaps = outcome.get('snapshots') or outcome.get('history') or []
                for snap in snaps:
                    if not isinstance(snap, dict):
                        continue
                    captured = snap.get('recorded_at') or snap.get('timestamp') or snap.get('captured_at') or snap.get('last_update')
                    if not captured:
                        continue
                    rows.append({
                        'captured_at': captured,
                        'bookmaker': bk,
                        'bookmaker_title': title,
                        'market': mk,
                        'side': side,
                        'name': outcome.get('name'),
                        'line': snap.get('point'),
                        'price': snap.get('price'),
                        'outcome_id': outcome.get('outcome_id'),
                    })
    return rows


def parse_ts(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except Exception:
        return None


def dedupe_history(rows, commence_time):
    kickoff = parse_ts(commence_time)
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_HISTORY_DAYS)
    clean = []
    seen = set()
    last_by_key = {}
    seen_snapshot_sides = set()
    for row in sorted(rows, key=lambda r: str(r.get('captured_at') or '')):
        ts = parse_ts(row.get('captured_at'))
        if ts and ts < cutoff:
            continue
        if kickoff and ts and ts > kickoff:
            continue
        key = (row.get('bookmaker'), row.get('market'), row.get('side'))
        snapshot_side = (row.get('captured_at'),) + key
        # Old cache files may already contain alternate ladders. Keep one quote
        # per book/market/side at each capture time so those alternates disappear
        # the next time the publisher rewrites the event cache.
        if snapshot_side in seen_snapshot_sides:
            continue
        seen_snapshot_sides.add(snapshot_side)
        value = (row.get('line'), row.get('price'))
        # Keep true movement only; an unchanged quote doesn't add graph value.
        if last_by_key.get(key) == value:
            continue
        last_by_key[key] = value
        uniq = (row.get('captured_at'),) + key + value
        if uniq in seen:
            continue
        seen.add(uniq)
        clean.append(row)
    return clean


def book_rows(event):
    result = []
    for book in event.get('bookmakers') or []:
        if not isinstance(book, dict):
            continue
        row = {
            'key': book.get('key') or slug(book.get('title')),
            'book': book.get('title') or book.get('key'),
            'title': book.get('title') or book.get('key'),
            'last_update': book.get('last_update'),
        }
        selected = selected_book_markets(book, event)
        for c in selected['h2h']:
            if c['side'] == 'away': row['awayML'] = c['price']
            if c['side'] == 'home': row['homeML'] = c['price']
        for c in selected['spreads']:
            if c['side'] == 'away':
                row['awaySpread'], row['awaySpreadOdds'] = c['line'], c['price']
            if c['side'] == 'home':
                row['homeSpread'], row['homeSpreadOdds'] = c['line'], c['price']
        for c in selected['totals']:
            if c['side'] == 'over':
                row['over'] = row['awayTotal'] = c['line']
                row['overOdds'] = row['awayTotalOdds'] = c['price']
            if c['side'] == 'under':
                row['under'] = row['homeTotal'] = c['line']
                row['underOdds'] = row['homeTotalOdds'] = c['price']
        if any(row.get(k) is not None for k in ('awayML','homeML','awaySpread','homeSpread','awayTotal','homeTotal')):
            result.append(row)
    return result

def pick_primary(books):
    by_key = {str(b.get('key') or '').lower(): b for b in books}
    for key in PREFERRED_BOOKS:
        b = by_key.get(key)
        if b:
            return b
    return books[0] if books else {}


def opening_from_history(history, primary_key):
    opens = {}
    wanted = [primary_key] + [b for b in PREFERRED_BOOKS if b != primary_key]
    for market, side, outkey in [
        ('h2h','away','awayML'), ('h2h','home','homeML'),
        ('spreads','away','awaySpread'), ('spreads','home','homeSpread'),
        ('totals','over','total'),
    ]:
        found = None
        for bk in wanted:
            found = next((r for r in history if r.get('bookmaker') == bk and r.get('market') == market and r.get('side') == side), None)
            if found: break
        if found:
            if market == 'h2h': opens[outkey] = found.get('price')
            elif market == 'spreads':
                opens[outkey] = found.get('line')
                opens[outkey + 'Odds'] = found.get('price')
            else:
                opens['total'] = found.get('line')
                opens['overOdds'] = found.get('price')
                under = next((r for r in history if r.get('bookmaker') == found.get('bookmaker') and r.get('market') == 'totals' and r.get('side') == 'under'), None)
                if under: opens['underOdds'] = under.get('price')
    return opens


def history_snapshots(history, event):
    grouped = defaultdict(list)
    for r in history:
        grouped[r['captured_at']].append(r)
    snapshots = []
    market_map = {'h2h': 'moneyline', 'spreads': 'spread', 'totals': 'total'}
    for captured, rows in sorted(grouped.items()):
        markets = []
        by_market_side_line = defaultdict(list)
        for r in rows:
            mt = market_map.get(r.get('market'))
            if not mt: continue
            line = r.get('line')
            group_key = (mt, r.get('side'), line)
            by_market_side_line[group_key].append(r)
        for (mt, side, line), obs in by_market_side_line.items():
            markets.append({
                'quote_type': 'current', 'market_type': mt, 'period': 'full_game',
                'side': side, 'line': line, 'is_main_line': True, 'is_alternate_line': False,
                'bookmakers': [{
                    'bookmaker_id': r.get('bookmaker'), 'name': r.get('bookmaker_title'),
                    'odds': r.get('price'), 'line': r.get('line'), 'available': True,
                    'source_updated_at': r.get('captured_at'), 'source': 'propline'
                } for r in obs]
            })
        snapshots.append({
            'canonical_event_key': f"propline:{event.get('id')}",
            'captured_at': captured,
            'start_time': event.get('commence_time'),
            'away_team': event.get('away_team'), 'home_team': event.get('home_team'),
            'markets': markets,
        })
    return snapshots


def aggregate_series(history, market, event):
    by_time = defaultdict(list)
    for r in history:
        if r.get('market') == market:
            by_time[r.get('captured_at')].append(r)
    series = []
    last = None
    for captured, rows in sorted(by_time.items()):
        row = {'timestamp': captured, 'time': captured}
        for side in ('away','home','over','under'):
            candidates = [r for r in rows if r.get('side') == side]
            if not candidates: continue
            chosen = None
            for bk in PREFERRED_BOOKS:
                chosen = next((r for r in candidates if r.get('bookmaker') == bk), None)
                if chosen: break
            chosen = chosen or candidates[0]
            if market == 'h2h':
                row[side] = chosen.get('price')
                row[side + 'ML'] = chosen.get('price')
            elif market == 'spreads':
                row[side + 'Spread'] = chosen.get('line')
                row[side + 'SpreadOdds'] = chosen.get('price')
                row[side] = chosen.get('line')
            elif market == 'totals':
                row[side] = chosen.get('line')
                row[side + 'Odds'] = chosen.get('price')
                if side == 'over': row['total'] = chosen.get('line')
        comp = tuple((k, row.get(k)) for k in sorted(row) if k not in ('time','timestamp'))
        if comp != last:
            series.append(row)
            last = comp
    return series


def build_cache(sport, event, existing, stamp):
    current_rows = current_observations(event, stamp)
    old_history = existing.get('history', []) if isinstance(existing, dict) else []
    history = list(old_history)
    history.extend(current_rows)
    history = dedupe_history(history, event.get('commence_time'))
    books = book_rows(event)
    primary = pick_primary(books)
    current = {
        'awayML': primary.get('awayML'), 'homeML': primary.get('homeML'),
        'awaySpread': primary.get('awaySpread'), 'homeSpread': primary.get('homeSpread'),
        'awaySpreadOdds': primary.get('awaySpreadOdds'), 'homeSpreadOdds': primary.get('homeSpreadOdds'),
        'total': primary.get('awayTotal') if primary.get('awayTotal') is not None else primary.get('homeTotal'),
        'awayTotal': primary.get('awayTotal'), 'homeTotal': primary.get('homeTotal'),
        'overOdds': primary.get('overOdds'), 'underOdds': primary.get('underOdds'),
        'awayTotalOdds': primary.get('awayTotalOdds'), 'homeTotalOdds': primary.get('homeTotalOdds'),
    }
    opening = opening_from_history(history, str(primary.get('key') or '').lower())
    ml = aggregate_series(history, 'h2h', event)
    spread = aggregate_series(history, 'spreads', event)
    total = aggregate_series(history, 'totals', event)
    line_raw = {
        'source': 'propline', 'event_id': str(event.get('id')),
        'awayTeam': event.get('away_team'), 'homeTeam': event.get('home_team'),
        'openingAwayML': opening.get('awayML'), 'openingHomeML': opening.get('homeML'),
        'currentAwayML': current.get('awayML'), 'currentHomeML': current.get('homeML'),
        'openingAwaySpread': opening.get('awaySpread'), 'openingHomeSpread': opening.get('homeSpread'),
        'currentAwaySpread': current.get('awaySpread'), 'currentHomeSpread': current.get('homeSpread'),
        'openingTotal': opening.get('total'), 'currentTotal': current.get('total'),
        'moneylineMovement': ml, 'spreadMovement': spread, 'totalMovement': total,
        'movements': {'moneyline': ml, 'spread': spread, 'total': total},
    }
    return {
        'ok': True, 'source': 'propline', 'sport': sport,
        'event_id': str(event.get('id')), 'homeTeam': event.get('home_team'), 'awayTeam': event.get('away_team'),
        'home_team': event.get('home_team'), 'away_team': event.get('away_team'),
        'commence_time': event.get('commence_time'), 'updated_at': stamp,
        'current': current, 'opening': opening, 'books': books,
        'bookmakers': books, 'sportsbooks': books,
        'awayML': current.get('awayML'), 'homeML': current.get('homeML'),
        'awaySpread': current.get('awaySpread'), 'homeSpread': current.get('homeSpread'),
        'awaySpreadOdds': current.get('awaySpreadOdds'), 'homeSpreadOdds': current.get('homeSpreadOdds'),
        'total': current.get('total'), 'awayTotal': current.get('awayTotal'), 'homeTotal': current.get('homeTotal'),
        'overOdds': current.get('overOdds'), 'underOdds': current.get('underOdds'),
        'awayTotalOdds': current.get('awayTotalOdds'), 'homeTotalOdds': current.get('homeTotalOdds'),
        'lineMovementRaw': line_raw,
        'moneylineMovement': ml, 'spreadMovement': spread, 'totalMovement': total,
        'movements': line_raw['movements'],
        'history': history, 'historySnapshots': history_snapshots(history, event),
        'movement_tracking': 'bulk_10m',
        # Bet/handle consensus is intentionally absent. The frontend preserves the existing splits source.
        'consensus': None,
    }


def carry_recent_existing(root, sport, current_ids, index_rows):
    index_path = root / 'game-odds' / sport / 'index.json'
    prior = read_json(index_path) or {}
    now = datetime.now(timezone.utc)
    for row in prior.get('events') or []:
        eid = str(row.get('event_id') or '')
        if not eid or eid in current_ids:
            continue
        start = parse_ts(row.get('commence_time'))
        if start and now - start <= timedelta(hours=KEEP_AFTER_HOURS):
            cache_path = root / 'game-odds' / sport / 'events' / f'{slug(eid)}.json'
            if cache_path.exists():
                index_rows.append(row)


def main():
    key = os.environ['PROPLINE_API_KEY'].strip()
    root = Path(os.environ['PROPLINE_OUTPUT_DIR'])
    stamp = iso_now()
    summary = {}
    for sport, provider in SPORTS.items():
        sport_dir = root / 'game-odds' / sport
        backup_dir = None
        backup_parent = None
        had_previous_cache = sport_dir.exists()
        try:
            if sport == 'nhl' and had_previous_cache:
                backup_parent = Path(tempfile.mkdtemp(prefix='propline-nhl-game-odds-'))
                backup_candidate = backup_parent / 'nhl'
                shutil.copytree(sport_dir, backup_candidate)
                backup_dir = backup_candidate
            events, bulk_requests = fetch_current(provider, key)
            index_rows = []
            for event in events:
                if not isinstance(event, dict) or event.get('id') is None:
                    continue
                eid = str(event['id'])
                path = sport_dir / 'events' / f'{slug(eid)}.json'
                existing = read_json(path)
                cache = build_cache(sport, event, existing or {}, stamp)
                write_json(path, cache)
                index_rows.append({
                    'event_id': eid, 'path': f'game-odds/{sport}/events/{slug(eid)}.json',
                    'home_team': event.get('home_team'), 'away_team': event.get('away_team'),
                    'commence_time': event.get('commence_time'), 'updated_at': stamp,
                })
            current_ids = {str(e.get('id')) for e in events if isinstance(e, dict) and e.get('id') is not None}
            carry_recent_existing(root, sport, current_ids, index_rows)
            # Stable ordering and de-duplication by event id.
            by_id = {str(r['event_id']): r for r in index_rows if r.get('event_id')}
            index_rows = sorted(by_id.values(), key=lambda r: str(r.get('commence_time') or ''))
            write_json(sport_dir / 'index.json', {
                'sport': sport, 'provider': provider, 'updated_at': stamp, 'events': index_rows,
            })
            summary[sport] = {
                'current_events': len(events), 'cached_events': len(index_rows),
                'bulk_requests': bulk_requests, 'history_requests': 0,
            }
            print(f'{sport}: {summary[sport]}', flush=True)
        except Exception as exc:
            if sport != 'nhl':
                raise
            # NHL is optional for this run. Roll back any partial NHL file writes,
            # keep its last published index/data intact, and continue the other sports.
            if backup_dir is not None and backup_dir.exists():
                shutil.rmtree(sport_dir, ignore_errors=True)
                sport_dir.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(backup_dir, sport_dir)
            elif not had_previous_cache:
                shutil.rmtree(sport_dir, ignore_errors=True)
            previous_index = read_json(sport_dir / 'index.json') or {}
            previous_events = previous_index.get('events') if isinstance(previous_index, dict) else []
            cached_events = len(previous_events) if isinstance(previous_events, list) else 0
            summary[sport] = {
                'current_events': None,
                'cached_events': cached_events,
                'bulk_requests': 1,
                'history_requests': 0,
                'skipped': True,
                'retained_previous_cache': bool(cached_events),
                'error': str(exc),
            }
            print(
                f'{sport}: fetch/build failed ({exc}); retained the previous NHL cache '
                f'({cached_events} events) and continuing with remaining sports',
                flush=True,
            )
        finally:
            if backup_parent is not None and backup_parent.exists():
                shutil.rmtree(backup_parent, ignore_errors=True)
    write_json(root / 'game-odds' / 'manifest.json', {'updated_at': stamp, 'sports': summary, 'markets': ['h2h','spreads','totals']})
    print('Published PropLine game odds', stamp, flush=True)


if __name__ == '__main__':
    main()
