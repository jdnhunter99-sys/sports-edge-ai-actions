#!/usr/bin/env python3
"""Authorized Pikkit consensus HTTP collector. Standard library only."""
import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = 'https://prod-website.pikkit.app'
MARKETS = {'moneyline': ('home', 'away'), 'spread': ('home', 'away'), 'total': ('over', 'under')}


class NoCommunityData(Exception):
    pass


def fetch_json(path, token, attempts=4):
    url = BASE + path
    req = Request(url, headers={'Authorization': token, 'Accept': 'application/json', 'Origin': 'https://app.pikkit.com', 'User-Agent': 'SportsEdgeAI-consensus-collector/1.0'})
    for n in range(attempts):
        try:
            with urlopen(req, timeout=35) as response:
                return json.load(response)
        except HTTPError as exc:
            if exc.code in (401, 403):
                raise RuntimeError(f'Authentication/access denied (HTTP {exc.code}) on {path}') from None
            if exc.code not in (429, 500, 502, 503, 504) or n == attempts - 1:
                raise RuntimeError(f'HTTP {exc.code} on {path}') from None
            retry_after = exc.headers.get('Retry-After', '')
            delay = min(45, int(retry_after)) if retry_after.isdigit() else min(30, 2 ** n + random.random())
        except (URLError, TimeoutError) as exc:
            if n == attempts - 1:
                raise RuntimeError(f'Network error on {path}: {type(exc).__name__}') from None
            delay = min(30, 2 ** n + random.random())
        time.sleep(delay)
    raise RuntimeError('Request failed')


def discover(date, token, request=fetch_json):
    offset = 0
    seen_offsets = set()
    events = {}
    pages = 0
    while True:
        if offset in seen_offsets or pages >= 30:
            raise RuntimeError(f'Pagination loop or excessive pages for {date}: offset={offset}')
        seen_offsets.add(offset)
        pages += 1
        response = request(f'/events/all?query_date={date}&league_offset={offset}', token)
        if not isinstance(response, dict) or not isinstance(response.get('leagues'), list):
            raise RuntimeError(f'Malformed event listing for {date} offset {offset}')
        for group in response['leagues']:
            if not isinstance(group, list):
                raise RuntimeError('Malformed league group')
            for item in group:
                if not isinstance(item, dict) or item.get('type') != 'event':
                    continue
                event = item.get('value') or {}
                event_id = event.get('_id')
                if event_id:
                    events[event_id] = event
        nxt = response.get('league_offset')
        if nxt is None:
            break
        if not isinstance(nxt, int) or isinstance(nxt, bool) or nxt <= offset:
            raise RuntimeError(f'Invalid pagination offset {nxt!r} after {offset}')
        offset = nxt
    return events, pages


def extract(event_id, listing, payload, timestamp):
    if not isinstance(payload, dict) or not isinstance(payload.get('community'), dict):
        raise NoCommunityData('Missing community data')
    info = payload.get('info') or listing
    evt_info = info.get('event_info') or listing.get('event_info') or {}
    community = payload['community']
    breakdowns = community.get('breakdowns') or {}
    market_data = {}
    for market, sides in MARKETS.items():
        block = breakdowns.get(market)
        if not block:
            market_data[market] = None
            continue
        out = {}
        for side in sides:
            source = block.get(side)
            if not isinstance(source, dict):
                raise ValueError(f'{market}.{side} absent')
            for field in ('bet_pct', 'handle_pct', 'bets', 'handle'):
                if not isinstance(source.get(field), (int, float)) or isinstance(source[field], bool):
                    raise ValueError(f'{market}.{side}.{field} invalid')
            if not (0 <= source['bet_pct'] <= 1 and 0 <= source['handle_pct'] <= 1):
                raise ValueError(f'{market}.{side}: fraction out of range')
            if source['bets'] < 0 or source['handle'] < 0:
                raise ValueError(f'{market}.{side}: negative count/handle')
            out[side] = {
                'label': source.get('label'),
                'bets': source['bets'],
                'handle': round(source['handle'], 2),
                'bet_pct': round(source['bet_pct'] * 100, 4),
                'money_pct': round(source['handle_pct'] * 100, 4)
            }
        if abs(sum(out[s]['bet_pct'] for s in sides) - 100) > .2 or abs(sum(out[s]['money_pct'] for s in sides) - 100) > .2:
            raise ValueError(f'{market}: percentages do not sum to 100')
        market_data[market] = out
    if not any(market_data.values()):
        raise ValueError('No consensus market data')
    lg = (evt_info.get('league') or {}).get('short') or (listing.get('event_info') or {}).get('league', {}).get('short')
    return {
        'event_id': event_id, 'league': lg, 'start_time': info.get('start_time') or listing.get('start_time'),
        'status': info.get('status') or listing.get('status'),
        'home': (evt_info.get('home') or {}).get('full'), 'away': (evt_info.get('away') or {}).get('full'),
        'name': evt_info.get('full_name'), 'source': 'pikkit-community',
        'captured_at': timestamp, 'total_wagered': community.get('total_wagered'),
        'total_picks': community.get('num_picks'), 'markets': market_data
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start-date', default=os.getenv('START_DATE', dt.datetime.now(dt.timezone.utc).date().isoformat()))
    parser.add_argument('--days', type=int, default=int(os.getenv('DAYS_AHEAD', '1')))
    parser.add_argument('--leagues', default=os.getenv('LEAGUES', 'all'), help='all or comma-separated Pikkit league labels e.g. NCAAFB,MLB,NFL')
    parser.add_argument('--out', default='data')
    parser.add_argument('--delay', type=float, default=float(os.getenv('REQUEST_DELAY_SECONDS', '0.7')))
    parser.add_argument('--event-delay-min', type=float, default=float(os.getenv('EVENT_DELAY_MIN_SECONDS', '5')))
    parser.add_argument('--event-delay-max', type=float, default=float(os.getenv('EVENT_DELAY_MAX_SECONDS', '10')))
    args = parser.parse_args()
    token = os.getenv('PIKKIT_AUTH_TOKEN', '').strip()
    if not token:
        print('Missing PIKKIT_AUTH_TOKEN environment variable', file=sys.stderr)
        return 2
    if not 1 <= args.days <= 14 or args.delay < 0 or args.event_delay_min < 0 or args.event_delay_max < args.event_delay_min:
        parser.error('--days must be 1–14; delays must be nonnegative and event-delay-max must be at least event-delay-min')
    start = dt.date.fromisoformat(args.start_date)
    leagues_filter = None if args.leagues.lower() == 'all' else {v.strip().upper() for v in args.leagues.split(',') if v.strip()}
    captured_at = dt.datetime.now(dt.timezone.utc).isoformat()
    all_events = {}
    for k in range(args.days):
        date = (start + dt.timedelta(days=k)).isoformat()
        events, pages = discover(date, token)
        all_events.update(events)
        print(f'{date}: {len(events)} events across {pages} listing pages', flush=True)
        time.sleep(args.delay)
    selected = {event_id: e for event_id, e in all_events.items() if leagues_filter is None or (e.get('event_info', {}).get('league', {}).get('short') or '').upper() in leagues_filter}
    if not selected:
        print('No events discovered for selected leagues; not overwriting feeds', file=sys.stderr)
        return 1
    by_league = {}
    errors = []
    for count, (event_id, listing) in enumerate(selected.items(), 1):
        try:
            payload = fetch_json(f'/event/foryou/{event_id}', token)
            result = extract(event_id, listing, payload, captured_at)
            by_league.setdefault(result['league'] or 'UNKNOWN', []).append(result)
            print(f'[{count}/{len(selected)}] OK {event_id}', flush=True)
        except NoCommunityData as exc:
            listing_league = ((listing.get('event_info') or {}).get('league') or {}).get('short') or 'UNKNOWN'
            by_league.setdefault(listing_league, [])
            print(f'[{count}/{len(selected)}] SKIP {event_id}: {exc}', flush=True)
        except Exception as exc:
            errors.append({'event_id': event_id, 'reason': str(exc)})
            print(f'[{count}/{len(selected)}] ERROR {event_id}: {exc}', file=sys.stderr, flush=True)
        if count < len(selected):
            delay = random.uniform(args.event_delay_min, args.event_delay_max)
            print(f'Waiting {delay:.1f}s before the next event scrape', flush=True)
            time.sleep(delay)
    if errors:
        print(f'{len(errors)} event failures; refusing to publish incomplete files. First errors: {json.dumps(errors[:8])}', file=sys.stderr)
        return 1
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for lg, games in by_league.items():
        games.sort(key=lambda e: (e['start_time'] or '', e['event_id']))
        league_slug = lg.lower()
        if not re.fullmatch(r'[a-z0-9_-]+', league_slug):
            raise ValueError(f'Unsafe league code for output path: {lg!r}')
        event_index = []
        for game in games:
            event_id = str(game['event_id'])
            if not re.fullmatch(r'[A-Za-z0-9_-]+', event_id):
                raise ValueError(f'Unsafe event ID for output path: {event_id!r}')
            detail_path = f'events/{league_slug}/{event_id}.json'
            detail = {**game, 'generated_at': captured_at, 'complete': True}
            target = out_dir / detail_path
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(detail, separators=(',', ':'), ensure_ascii=False) + '\n')
            tmp.replace(target)
            event_index.append({
                key: game.get(key) for key in (
                    'event_id', 'league', 'start_time', 'status', 'home', 'away',
                    'name', 'source', 'captured_at'
                )
            } | {'detail_path': detail_path})
        index_doc = {
            'source': 'pikkit-community', 'generated_at': captured_at,
            'complete': True, 'league': lg, 'events_count': len(games),
            'events': event_index
        }
        target = out_dir / f'{league_slug}.json'
        tmp = target.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(index_doc, separators=(',', ':'), ensure_ascii=False) + '\n')
        tmp.replace(target)
        print(f'Wrote {target}: index for {len(games)} events and {len(games)} event files')
    return 0

if __name__ == '__main__':
    sys.exit(main())
