#!/usr/bin/env python3
"""Fetch all CFBDepth injury reports; Python 3.10+, no dependencies.
Run: python3 cfbdepth_injuries.py --out cfbdepth-data
Optional: --teams usa alabama --workers 4
Outputs registry.json, injuries.json, injuries.csv and raw response files.
Nonzero exit means incomplete coverage. Never treats a failed request as no injuries.
"""
import argparse, concurrent.futures, csv, datetime as dt, json, pathlib, re, time
import urllib.request, urllib.error
BASE = 'https://cfbdepth.com'

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def fetch(url):
    # CFBDepth intermittently returns 502s during larger refreshes. Retry
    # transient HTTP failures with bounded backoff before marking a team failed.
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'CFBInjuryCollector/1.0', 'Accept': 'application/json,text/javascript,*/*'})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode('utf-8-sig')
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            delay = e.headers.get('Retry-After', '')
            try:
                wait = float(delay)
            except (TypeError, ValueError):
                wait = 2 ** (attempt + 1)
            time.sleep(min(60, max(1, wait)))
        except (urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2 ** (attempt + 1))

def number(value):
    try:
        n = float(str(value).replace(',', '').strip())
        return int(n) if n.is_integer() else n
    except (ValueError, TypeError):
        return None

def boolean(value):
    s = str(value).strip().lower()
    return True if s == 'true' else False if s == 'false' else None

def date(value):
    try:
        return dt.datetime.strptime(value, '%m/%d/%Y').date().isoformat()
    except (ValueError, TypeError):
        return None

def parse(payload, team):
    if payload.get('success') is not True or not isinstance(payload.get('rows'), list):
        raise ValueError('Invalid API response')
    rows = payload['rows']
    active, cleared, summary, headers = [], [], {}, {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Unexpected row format')
        cells = {k: str(v or '').strip() for k, v in row.items()}
        if cells.get('Col1') == '#:':
            summary = {k: number(cells.get(c)) for k,c in [('reported_count','Col2'),('new_count','Col4'),('impact','Col6'),('impact_average','Col8'),('impact_rank','Col10')]}
        if cells.get('Col1', '').lower() == 'player name':
            headers = {v.rstrip(':').lower(): k for k,v in cells.items() if v}
            continue
        if not headers:
            continue
        def field(label):
            return cells.get(headers.get(label, ''), '')
        name, status = field('player name'), field('status')
        if not name or name == '0' or not status:
            continue
        record = dict(player=name, status=status, position=field('pos'), is_new=boolean(field('new')),
                      rating=number(field('rating')), impact=number(field('impact')),
                      update_date=date(field('update date')), update_date_raw=field('update date'),
                      notes=field('update notes'), lw_raw=field('lw'), injury_type=field('injury type'),
                      confirmed=boolean(field('confirmed')), return_timeframe=field('return timeframe'),
                      original_injury_date=date(field('original injury date')),
                      projected_return=date(field('projected return')), raw_columns=row)
        (cleared if status.lower() == 'cleared' else active).append(record)
    if not headers:
        raise ValueError('Missing player header: refusing to report empty injuries')
    warnings = []
    if summary.get('reported_count') is not None and summary['reported_count'] != len(active):
        warnings.append(f"Source reports {summary['reported_count']} injuries; found {len(active)} named active rows")
    return dict(team_slug=team['slug'], team_name=team['schoolName'], abbreviation=team.get('abbreviation'),
                conference=team.get('conference'), logo_url=team.get('logoUrl'), summary=summary,
                active=active, cleared_history=cleared, warnings=warnings,
                source_timestamp=payload.get('timestamp'), fetched_at=now())

def write(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')
    tmp.replace(path)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', default='cfbdepth-data')
    ap.add_argument('--teams', nargs='+', help='Team slugs; default all teams')
    ap.add_argument('--workers', type=int, default=2)
    args = ap.parse_args()
    out = pathlib.Path(args.out); out.mkdir(parents=True, exist_ok=True)
    raw = out / 'raw'; raw.mkdir(exist_ok=True)
    text = fetch(BASE + '/team-pages/team-config.js?v=1')
    match = re.search(r'window\.CFB_TEAMS\s*=\s*', text)
    if not match:
        raise ValueError('Public team registry format changed')
    registry = json.JSONDecoder().raw_decode(text[match.end():])[0]
    if not isinstance(registry, list) or not registry:
        raise ValueError('Empty team registry')
    write(out / 'registry.json', registry)
    if args.teams:
        unknown = set(args.teams) - {t['slug'] for t in registry}
        if unknown:
            ap.error('Unknown team slugs: ' + ', '.join(sorted(unknown)))
    selected = [t for t in registry if not args.teams or t['slug'] in args.teams]
    def collect(team):
        slug = team['slug']
        if not re.fullmatch(r'[a-z0-9-]+', slug):
            raise ValueError('Invalid team slug')
        sheet, gid = team.get('spreadsheetId', ''), str(team.get('injuryReport', ''))
        if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet) or not gid.isdigit():
            raise ValueError('Missing or invalid sheet mapping')
        url = BASE + '/team-pages/api/sheets/' + sheet + '/data?gid=' + gid
        payload = json.loads(fetch(url))
        result = parse(payload, team)
        result['source_url'] = url
        result['page_url'] = BASE + '/' + slug + '/injury-status'
        write(raw / (slug + '.json'), payload)
        return result
    teams, errors = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        futures = {pool.submit(collect, t): t for t in selected}
        for future in concurrent.futures.as_completed(futures):
            t = futures[future]
            try:
                result = future.result(); teams.append(result)
                print(f"OK {t['slug']}: {len(result['active'])} active, {len(result['cleared_history'])} cleared", flush=True)
            except Exception as e:
                errors.append({'team_slug':t['slug'], 'error':str(e)})
                print(f"ERROR {t['slug']}: {e}", flush=True)
    teams.sort(key=lambda t: t['team_slug'])
    result = dict(fetched_at=now(), complete=not errors, registry_team_count=len(registry),
                  requested_teams=len(selected), successful_teams=len(teams), errors=errors, teams=teams)
    write(out / 'injuries.json', result)
    fields = ['team_slug','team_name','section','player','status','position','is_new','rating','impact','update_date','notes','lw_raw','injury_type','confirmed','return_timeframe','original_injury_date','projected_return']
    with (out / 'injuries.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); writer.writeheader()
        for t in teams:
            for section in ['active','cleared_history']:
                for r in t[section]:
                    writer.writerow(dict(r, team_slug=t['team_slug'], team_name=t['team_name'], section=section))
    print(f"Finished: {len(teams)}/{len(selected)} teams; {sum(len(t['active']) for t in teams)} active rows; {len(errors)} errors")
    return 1 if errors else 0

if __name__ == '__main__':
    raise SystemExit(main())
