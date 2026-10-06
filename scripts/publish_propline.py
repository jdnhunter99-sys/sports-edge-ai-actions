#!/usr/bin/env python3
"""Fetch PropLine bulk odds and publish per-player JSON to the private data branch."""
import json, os, re, time, urllib.request, urllib.error, unicodedata
from collections import Counter
from pathlib import Path
from datetime import datetime, timezone

API='https://api.prop-line.com/v1'
# Opening-line enrichment is intentionally limited to the sports that currently
# power SportsEdgeAI player-prop centers. At a 15-minute cadence this keeps the
# Hobby plan (5,000 requests/day) inside quota while preserving all live odds.
OPENING_SPORTS={'nfl','mlb','wnba'}
OPENING_WINDOW_DAYS=14
SPORTS={
 'nfl':('football_nfl','player_1st_td player_2plus_td player_3plus_td player_anytime_td player_extra_points_made player_field_goals_made player_fumbles_lost player_kicking_points player_last_td player_longest_completion player_pass_attempts player_pass_completions player_pass_interceptions player_pass_rush_yds player_pass_tds player_pass_yds player_reception_longest player_receptions player_reception_yds player_rush_attempts player_rush_longest player_rush_reception_yds player_rush_tds player_rush_yds'),
 'nba':('basketball_nba','player_assists player_double_double player_points player_points_10plus player_points_15plus player_points_assists player_points_rebounds player_points_rebounds_assists player_rebounds player_rebounds_assists player_threes'),
 'mlb':('baseball_mlb','batter_1plus_hits batter_1plus_rbis batter_2plus_hits batter_2plus_home_runs batter_2plus_rbis batter_3plus_hits batter_3plus_rbis batter_4plus_hits batter_doubles batter_hits batter_hits_runs_rbis batter_home_runs batter_rbis batter_runs batter_singles batter_stolen_bases batter_strikeouts batter_total_bases batter_triples batter_walks pitcher_earned_runs pitcher_hits_allowed pitcher_outs pitcher_strikeouts pitcher_walks'),
 'wnba':('basketball_wnba','player_assists player_blocks player_double_double player_first_basket player_first_field_goal player_points player_points_10plus player_points_15plus player_points_assists player_points_rebounds player_points_rebounds_assists player_rebounds player_rebounds_assists player_steals player_threes player_triple_double player_turnovers'),
 'cfb':('football_ncaaf','player_1st_td player_2plus_td player_3plus_td player_anytime_td player_pass_tds player_pass_yds player_receptions player_reception_yds player_rush_yds'),
 'tennis':('tennis','player_aces player_break_points_won player_games_won'),
 'epl':('soccer_epl','anytime_goal_scorer player_shots_on_target'),
}
PLAYER_MARKETS={
 'nfl':{'player_pass_yds':'passing_yards','player_pass_tds':'passing_tds','player_pass_completions':'passing_completions','player_pass_attempts':'passing_attempts','player_pass_interceptions':'interceptions_thrown','player_rush_yds':'rushing_yards','player_rush_tds':'rushing_tds','player_rush_attempts':'rushing_attempts','player_reception_yds':'receiving_yards','player_receptions':'receptions','player_anytime_td':'anytime_touchdown','player_rush_reception_yds':'rush_rec_yards'},
 'cfb':{'player_pass_yds':'passing_yards','player_pass_tds':'passing_tds','player_pass_completions':'passing_completions','player_rush_yds':'rushing_yards','player_rush_tds':'rushing_tds','player_reception_yds':'receiving_yards','player_receptions':'receptions','player_anytime_td':'anytime_touchdown'},
 'mlb':{'batter_hits':'hits','batter_total_bases':'total_bases','batter_home_runs':'home_runs','batter_runs':'runs','batter_rbis':'rbi','batter_singles':'singles','batter_doubles':'doubles','batter_walks':'walks','pitcher_strikeouts':'strikeouts','batter_strikeouts':'strikeouts_batter','batter_stolen_bases':'stolen_bases','pitcher_outs':'pitcher_outs','pitcher_earned_runs':'earned_runs','pitcher_hits_allowed':'hits_allowed','pitcher_walks':'walks_allowed','batter_hits_runs_rbis':'hits_runs_rbis'},
 'wnba':{'player_points':'points','player_rebounds':'rebounds','player_assists':'assists','player_threes':'three_pointers_made','player_blocks':'blocks','player_steals':'steals','player_turnovers':'turnovers','player_points_rebounds_assists':'pra','player_points_rebounds':'points_rebounds','player_points_assists':'points_assists','player_rebounds_assists':'rebounds_assists','player_double_double':'double_double','player_triple_double':'triple_double','player_first_basket':'first_basket'},
 'nba':{'player_points':'points','player_rebounds':'rebounds','player_assists':'assists','player_threes':'three_pointers_made','player_points_rebounds_assists':'pra','player_points_rebounds':'points_rebounds','player_points_assists':'points_assists'},
}
def slug(s):
 s=unicodedata.normalize('NFKD',str(s)).encode('ascii','ignore').decode().lower()
 return re.sub(r'[^a-z0-9]+','-',s).strip('-') or 'unknown'
def fetch(sport,key):
 from urllib.parse import urlencode
 provider,markets=SPORTS[sport]
 url=f'{API}/sports/{provider}/odds?'+urlencode({'markets':','.join(markets.split())})
 for attempt in range(2):
  try:
   req=urllib.request.Request(url,headers={'X-API-Key':key,'Accept':'application/json'})
   with urllib.request.urlopen(req,timeout=65) as res: body=json.load(res)
   if isinstance(body,list): return body
   if isinstance(body,dict) and isinstance(body.get('events'),list): return body['events']
   raise ValueError(f'{sport}: unexpected PropLine response shape')
  except (urllib.error.URLError,TimeoutError) as e:
   if attempt: raise
   time.sleep(3)
 raise RuntimeError('unreachable')
def fetch_closing(sport,event_id,key):
 from urllib.parse import urlencode
 provider,markets=SPORTS[sport]
 url=f'{API}/sports/{provider}/events/{event_id}/odds/closing?'+urlencode({
   'markets':','.join(markets.split()),'opening_window':OPENING_WINDOW_DAYS})
 for attempt in range(2):
  try:
   req=urllib.request.Request(url,headers={'X-API-Key':key,'Accept':'application/json'})
   with urllib.request.urlopen(req,timeout=45) as res: return json.load(res)
  except urllib.error.HTTPError as e:
   # Opening history is enrichment only. Never destroy the live-odds publish
   # because one event has no history yet or PropLine temporarily rejects it.
   if e.code in (400,404,409,422): return None
   if attempt: raise
   time.sleep(2)
  except (urllib.error.URLError,TimeoutError):
   if attempt: raise
   time.sleep(2)
 return None

def norm(v):
 return unicodedata.normalize('NFKD',str(v or '')).encode('ascii','ignore').decode().lower().strip()

def opening_index(payload):
 idx={}
 if not isinstance(payload,dict): return idx
 for book in payload.get('bookmakers') or []:
  if not isinstance(book,dict): continue
  bk=norm(book.get('key') or book.get('title'))
  for market in book.get('markets') or []:
   if not isinstance(market,dict): continue
   mk=str(market.get('key') or '')
   period=str(market.get('period') or '')
   team=norm(market.get('team'))
   for o in market.get('outcomes') or []:
    if not isinstance(o,dict): continue
    oid=o.get('outcome_id')
    data={
      'opening_line':o.get('opening_point'),
      'opening_price':o.get('opening_price'),
      'opening_at':o.get('opening_at'),
      'opening_age_seconds':o.get('opening_age_seconds'),
      'closing_line':o.get('point'),
      'closing_price':o.get('price'),
      'closing_at':o.get('closing_at'),
      'closing_is_final':o.get('closing_is_final',payload.get('closing_is_final')),
    }
    if oid is not None: idx[('id',str(oid))]=data
    # Do NOT key on point: the whole purpose is to retain the match when a
    # line moves from (for example) 62.5 to 64.5.
    desc=norm(o.get('description'))
    side=norm(o.get('name'))
    dfs=norm(o.get('dfs_odds_type'))
    idx[('fallback',bk,mk,desc,side,period,team,dfs)]=data
 return idx

def find_opening(idx,book,market,outcome):
 oid=outcome.get('outcome_id') if isinstance(outcome,dict) else None
 if oid is not None and ('id',str(oid)) in idx: return idx[('id',str(oid))]
 bk=norm(book.get('key') or book.get('title'))
 key=('fallback',bk,str(market.get('key') or ''),norm(outcome.get('description')),
      norm(outcome.get('name')),str(market.get('period') or ''),norm(market.get('team')),
      norm(outcome.get('dfs_odds_type')))
 return idx.get(key)

def write_json(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')

def player_name_from_outcome(outcome):
 # PropLine's standard O/U shape has the player in description. Keep the
 # alternate fields as a forward-compatible fallback if the upstream shape
 # changes, and support player-name YES/N+ outcomes where name is the player.
 for field in ('description','player_name','playerName','player'):
  value=outcome.get(field)
  if isinstance(value,str) and value.strip(): return value.strip()
 name=outcome.get('name')
 if isinstance(name,str) and name.strip() and norm(name) not in {'over','under','yes','no','o','u'}:
  return name.strip()
 return None

def describe_empty_response(sport,events):
 markets=Counter(); outcomes=0; sample=None
 for ev in events:
  if not isinstance(ev,dict): continue
  for book in ev.get('bookmakers') or []:
   if not isinstance(book,dict): continue
   for market in book.get('markets') or []:
    if not isinstance(market,dict): continue
    markets[str(market.get('key') or '<missing>')]+=1
    for outcome in market.get('outcomes') or []:
     if not isinstance(outcome,dict): continue
     outcomes+=1
     if sample is None: sample={key:outcome.get(key) for key in ('name','description','player','player_name','point') if key in outcome}
 print(f'{sport}: no described player outcomes; events={len(events)}, market_rows={sum(markets.values())}, outcomes={outcomes}, market_keys={dict(markets.most_common(20))}, sample_outcome={sample}',flush=True)

def build_sport(sport,events,root,stamp,key):
 index=[]; count=0
 for ev in events:
  if not isinstance(ev,dict) or ev.get('id') is None: continue
  eid=str(ev['id']); players={}
  open_idx={}
  if sport in OPENING_SPORTS:
   try:
    open_idx=opening_index(fetch_closing(sport,eid,key))
   except Exception as exc:
    print(f'{sport} event {eid}: opening-line enrichment skipped: {exc}',flush=True)
  for book in ev.get('bookmakers') or []:
   if not isinstance(book,dict): continue
   for market in book.get('markets') or []:
    if not isinstance(market,dict) or market.get('key') not in SPORTS[sport][1].split(): continue
    for outcome in market.get('outcomes') or []:
     if not isinstance(outcome,dict): continue
     name=player_name_from_outcome(outcome)
     if not isinstance(name,str) or not name.strip(): continue
     p=players.setdefault(name,{'player':name,'sport':sport,'event_id':eid,
       'home_team':ev.get('home_team'),'away_team':ev.get('away_team'),
       'commence_time':ev.get('commence_time'),'fetched_at':stamp,'markets':{},
       'player_id':outcome.get('player_id') or outcome.get('athlete_id'),
       'team':outcome.get('team') or outcome.get('team_abbr') or outcome.get('team_abbreviation')})
     row={
       'bookmaker':book.get('key') or book.get('title'),
       'bookmaker_title':book.get('title'),
       'bookmaker_last_update':book.get('last_update'),
       'market_last_update':market.get('last_update'),
       'selection':outcome.get('name'),'line':outcome.get('point'),
       'price':outcome.get('price'),'outcome':outcome}
     opening=find_opening(open_idx,book,market,outcome) if open_idx else None
     if opening:
      # Keep live line/price authoritative. Opening/closing fields are metadata.
      row.update(opening)
     p['markets'].setdefault(market['key'],[]).append(row)
  for name,player in players.items():
   rel=f'{sport}/events/{slug(eid)}/players/{slug(name)}.json'
   write_json(root/rel,player)
   index.append({'player':name,'player_id':player.get('player_id'),'event_id':eid,'path':rel,'commence_time':ev.get('commence_time'),
     'home_team':ev.get('home_team'),'away_team':ev.get('away_team'),
     'team':player.get('team'),'markets':list(player['markets'])})
   count+=1
 if not count:
  describe_empty_response(sport,events)
  if sport != 'cfb': raise ValueError(f'{sport}: zero described player outcomes; refusing empty publish')
  # A temporary upstream CFB gap must not prevent fresh data for every other
  # sport from publishing. main() will retain the prior CFB cache when present.
  return {'players':0,'events':len(events),'empty_response':True}
 write_json(root/sport/'index.json',{'sport':sport,'fetched_at':stamp,'players':index})
 return {'players':count,'events':len(events)}

def build_player_list(sport,screen,index,stamp):
 # This compact index is derived from the same PropLine response that produced
 # the detailed player-odds files. A player appears only when PropLine returned
 # at least one player market for them.
 by_key={}
 for entry in index:
  name=str(entry.get('player') or '').strip()
  if not name: continue
  key=norm(name)
  player=by_key.setdefault(key,{
   'playerId':entry.get('player_id'), 'name':name, 'team':entry.get('team'),
   'opponent':entry.get('opponent'), 'eventId':str(entry.get('event_id') or ''),
   'markets':[], 'props':[]})
  markets=[PLAYER_MARKETS.get(sport,{}).get(market,market) for market in (entry.get('markets') or [])]
  player['markets']=sorted(set(player['markets'])|set(markets))
  seen_props={(p.get('eventId'),p.get('market')) for p in player['props']}
  for provider_market in entry.get('markets') or []:
   market=PLAYER_MARKETS.get(sport,{}).get(provider_market,provider_market)
   prop_key=(str(entry.get('event_id') or ''),market)
   if prop_key in seen_props: continue
   seen_props.add(prop_key)
   player['props'].append({
    'player':name, 'playerId':entry.get('player_id'), 'team':entry.get('team'),
    'opponent':entry.get('opponent'), 'gameId':str(entry.get('event_id') or ''),
    'market':market, 'source':'PropLine', 'line':None, 'projection':None,
   })
 return {
  'ok':True, 'sport':sport, 'screen':screen, 'updated_at':stamp,
  'status':'ready' if by_key else 'empty', 'source':'PropLine',
  'player_count':len(by_key), 'prop_count':sum(len(p['props']) for p in by_key.values()),
  'players':list(by_key.values()),
  'props':[prop for player in by_key.values() for prop in player['props']],
 }

def publish_player_lists(root,stamp):
 for sport in SPORTS:
  index_path=root/sport/'index.json'
  try:
   index_data=json.loads(index_path.read_text(encoding='utf-8'))
  except (OSError,json.JSONDecodeError):
   index_data={'players':[]}
  entries=index_data.get('players') if isinstance(index_data,dict) else []
  entries=entries if isinstance(entries,list) else []
  screens=['prop-center']
  if sport=='nfl': screens.append('projections')
  for screen in screens:
   payload=build_player_list(sport,screen,entries,stamp)
   write_json(root/'player-lists'/sport/f'{screen}.json',payload)
   print(f"Published candidate player-lists/{sport}/{screen}.json: {payload['player_count']} PropLine players",flush=True)

def retain_previous_sport_cache(sport,out,root):
 manifest_path=out/'manifest.json'
 try:
  manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
  base=Path(str(manifest.get('base_path') or ''))
  if base.is_absolute() or '..' in base.parts: return None
  previous=out/base/sport
  previous_index=json.loads((previous/'index.json').read_text(encoding='utf-8'))
  players=previous_index.get('players')
  if not isinstance(players,list) or not players: return None
  import shutil
  shutil.copytree(previous,root/sport,dirs_exist_ok=True)
  return len(players)
 except (OSError,ValueError,TypeError,json.JSONDecodeError):
  return None

def main():
 key=os.environ['PROPLINE_API_KEY'].strip(); out=Path(os.environ['PROPLINE_OUTPUT_DIR'])
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'); root=out/'versions'/stamp
 root.mkdir(parents=True,exist_ok=False)
 stats={}
 try:
  for sport in SPORTS:
   events=fetch(sport,key)
   stats[sport]=build_sport(sport,events,root,stamp,key)
   if sport=='cfb' and stats[sport].get('empty_response'):
    retained=retain_previous_sport_cache(sport,out,root)
    if retained is not None:
     stats[sport]={'players':retained,'events':len(events),'reused_previous_cache':True,'fetched_players':0}
     print(f'cfb: upstream returned no player outcomes; retained previous cache ({retained} players)',flush=True)
    else:
     write_json(root/sport/'index.json',{'sport':sport,'fetched_at':stamp,'players':[],'warning':'Upstream returned no described player outcomes; see workflow diagnostics.'})
     stats[sport]={'players':0,'events':len(events),'empty_response':True}
     print('cfb: no prior player-prop cache exists; publishing an empty CFB index while other sports continue',flush=True)
   print(f'{sport}: {stats[sport]}',flush=True)
  publish_player_lists(root,stamp)
 except Exception:
  import shutil
  shutil.rmtree(root,ignore_errors=True)
  raise
 manifest={'version':stamp,'updated_at':datetime.now(timezone.utc).isoformat(),
   'sports':stats,'base_path':f'versions/{stamp}'}
 write_json(out/'manifest.json',manifest)
 import shutil
 versions=sorted(p for p in (out/'versions').iterdir() if p.is_dir())
 for old in versions[:-2]: shutil.rmtree(old)
 print('Published',stamp,flush=True)
if __name__=='__main__':main()
