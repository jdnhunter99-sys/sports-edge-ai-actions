#!/usr/bin/env python3
"""Fetch PropLine bulk odds and publish per-player JSON to the private data branch."""
import json, os, re, time, urllib.request, urllib.error, unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
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

def player_identity(value,name):
 raw=str(value or '').strip()
 if raw:
  if raw.lower().startswith('espn:'): raw=raw.split(':',1)[1].strip()
  return 'id:'+raw.casefold()
 return 'name:'+norm(name)

def cfb_name_parts(value):
 name=str(value or '').strip()
 match=re.search(r'\s+\(([A-Z0-9]{2,6})\)$',name)
 return (name[:match.start()].strip(),match.group(1)) if match else (name,None)

def is_non_player(sport,name):
 key=re.sub(r'[^a-z0-9]+',' ',norm(name)).strip()
 if key in {'no touchdown scorer','no goal scorer','no home run','none','no player'}: return True
 if sport=='cfb' and re.search(r'\b(defense|defence|d st|def st|dst)\b',key): return True
 return False

ESPN_LEAGUES={
 'nfl':('football','nfl'),'cfb':('football','college-football'),
 'nba':('basketball','nba'),'wnba':('basketball','wnba'),
 'mlb':('baseball','mlb'),'epl':('soccer','eng.1'),
}

def espn_roster_index(sport,events,cache_root):
 """Resolve PropLine player IDs/names to event teams and positions."""
 if sport not in ESPN_LEAGUES: return {'by_id':{},'by_name':{},'event_teams':{},'by_abbr':{}}
 category,league=ESPN_LEAGUES[sport]
 base=f'https://site.api.espn.com/apis/site/v2/sports/{category}/{league}'
 cache_dir=Path(cache_root)/'team-rosters'/sport
 cache_dir.mkdir(parents=True,exist_ok=True)
 directory_path=cache_dir/'directory.json'
 try:
  cached=json.loads(directory_path.read_text(encoding='utf-8'))
  cached_at=datetime.fromisoformat(str(cached.get('fetched_at','')).replace('Z','+00:00'))
  directory=cached.get('teams') if (datetime.now(timezone.utc)-cached_at).total_seconds()<7*86400 else None
 except (OSError,ValueError,TypeError,json.JSONDecodeError): directory=None
 if not isinstance(directory,list):
  try:
   req=urllib.request.Request(base+'/teams?limit=500',headers={'Accept':'application/json','User-Agent':'RTMPro-Player-List-Cache'})
   with urllib.request.urlopen(req,timeout=30) as res: body=json.load(res)
   teams=[]
   def walk(value):
    if isinstance(value,dict):
     team=value.get('team') if isinstance(value.get('team'),dict) else value
     if team.get('id') and (team.get('abbreviation') or team.get('displayName')): teams.append(team)
     for child in value.values(): walk(child)
    elif isinstance(value,list):
     for child in value: walk(child)
   walk(body)
   directory=list({str(team.get('id')):team for team in teams}.values())
   if directory: write_json(directory_path,{'fetched_at':datetime.now(timezone.utc).isoformat(),'teams':directory})
  except Exception as exc:
   print(f'{sport}: ESPN team directory unavailable; using PropLine team metadata: {exc}',flush=True)
   directory=[]
 unique={str(team.get('id')):team for team in directory if isinstance(team,dict) and team.get('id')}
 aliases={}
 for team in unique.values():
  for value in (team.get('displayName'),team.get('shortDisplayName'),team.get('name'),team.get('location'),team.get('abbreviation')):
   if value: aliases[norm(value)]=team
 event_teams={}; team_ids=set()
 for event in events:
  eid=str(event.get('id') or ''); matched=[]
  for side in ('home_team','away_team'):
   raw=norm(event.get(side)); candidate=aliases.get(raw)
   if candidate is None and raw:
    matches=[team for alias,team in aliases.items() if len(alias)>3 and (alias in raw or raw in alias)]
    if len({str(team.get('id')) for team in matches})==1: candidate=matches[0]
   if candidate: matched.append(candidate); team_ids.add(str(candidate['id']))
  event_teams[eid]=matched
 def roster(team_id):
  path=cache_dir/f'{team_id}.json'
  try:
   data=json.loads(path.read_text(encoding='utf-8'))
   fetched=datetime.fromisoformat(str(data.get('fetched_at','')).replace('Z','+00:00'))
   if (datetime.now(timezone.utc)-fetched).total_seconds()<7*86400 and isinstance(data.get('athletes'),list): return team_id,data['athletes']
  except (OSError,ValueError,TypeError,json.JSONDecodeError): pass
  url=f'{base}/teams/{team_id}/roster'
  req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'RTMPro-Player-List-Cache'})
  with urllib.request.urlopen(req,timeout=25) as res: payload=json.load(res)
  rows=[]
  def collect(value):
   if isinstance(value,dict):
    if value.get('id') and (value.get('displayName') or value.get('fullName') or value.get('name')): rows.append(value)
    for child in value.values(): collect(child)
   elif isinstance(value,list):
    for child in value: collect(child)
  collect(payload.get('athletes') or [])
  write_json(path,{'fetched_at':datetime.now(timezone.utc).isoformat(),'athletes':rows})
  return team_id,rows
 by_id={}; by_name=defaultdict(list)
 if team_ids:
  with ThreadPoolExecutor(max_workers=10) as pool:
   futures=[pool.submit(roster,team_id) for team_id in sorted(team_ids)]
   for future in as_completed(futures):
    try: team_id,athletes=future.result()
    except Exception as exc:
     print(f'{sport}: ESPN roster fetch skipped: {exc}',flush=True); continue
    team=unique.get(team_id,{})
    team_data={'id':team_id,'team':team.get('abbreviation') or team.get('shortDisplayName') or team.get('displayName'),'team_name':team.get('displayName') or team.get('name')}
    for athlete in athletes:
     pid=str(athlete.get('id') or '').strip(); name=athlete.get('displayName') or athlete.get('fullName') or athlete.get('name')
     pos=athlete.get('position')
     info={**team_data,'position':pos.get('abbreviation') if isinstance(pos,dict) else pos}
     if pid: by_id[pid]=info
     if name: by_name[norm(name)].append(info)
 by_abbr={norm(team.get('abbreviation')):{'id':str(team.get('id')),'team':team.get('abbreviation'),'team_name':team.get('displayName') or team.get('name')} for team in unique.values() if team.get('abbreviation')}
 return {'by_id':by_id,'by_name':dict(by_name),'event_teams':event_teams,'by_abbr':by_abbr}

def roster_team_for(sport,outcome,name,event,roster_index):
 direct=outcome.get('team') or outcome.get('team_abbr') or outcome.get('team_abbreviation')
 if direct:
  known=roster_index.get('by_abbr',{}).get(norm(direct),{})
  return {**known,'team':direct,'position':outcome.get('position')}
 clean,suffix=cfb_name_parts(name) if sport=='cfb' else (name,None)
 if suffix and sport=='cfb':
  return {**roster_index.get('by_abbr',{}).get(norm(suffix),{}),'team':roster_index.get('by_abbr',{}).get(norm(suffix),{}).get('team') or suffix,'position':outcome.get('position')}
 if sport not in ESPN_LEAGUES or not roster_index: return {'team':None,'position':outcome.get('position')}
 raw_id=str(outcome.get('player_id') or outcome.get('athlete_id') or '').strip()
 pid=raw_id.split(':',1)[1] if raw_id.lower().startswith('espn:') else raw_id
 candidate=roster_index.get('by_id',{}).get(pid)
 allowed={str(team.get('id')) for team in roster_index.get('event_teams',{}).get(str(event.get('id') or ''),[])}
 if candidate and (not allowed or str(candidate.get('id')) in allowed): return candidate
 name_key=norm(clean)
 candidates=[row for row in roster_index.get('by_name',{}).get(name_key,[]) if not allowed or str(row.get('id')) in allowed]
 if len(candidates)==1: return candidates[0]
 return {'team':None,'position':outcome.get('position')}

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

def market_quote_rows(player):
 output={}
 for market,rows in (player.get('markets') or {}).items():
  output[market]=[{
   'selection':row.get('selection'),'line':row.get('line'),'price':row.get('price'),
   'bookmaker':row.get('bookmaker'),'bookmakerTitle':row.get('bookmaker_title'),
   'lastUpdate':row.get('market_last_update') or row.get('bookmaker_last_update'),
  } for row in rows if isinstance(row,dict)]
 return output

def american_best(rows):
 candidates=[]
 for row in rows:
  try: price=float(row.get('price'))
  except (TypeError,ValueError): continue
  candidates.append((price,row))
 return max(candidates,key=lambda item:item[0])[1] if candidates else None

def prop_quote_fields(market_quotes):
 quotes=[row for row in (market_quotes or []) if isinstance(row,dict)]
 by_line=defaultdict(lambda:{'over':[],'under':[],'other':[]})
 all_odds=[]
 for row in quotes:
  try: line=float(row.get('line'))
  except (TypeError,ValueError): line=None
  side=norm(row.get('selection'))
  bucket='over' if side in {'over','o','yes'} else 'under' if side in {'under','u','no'} else 'other'
  by_line[line][bucket].append(row)
  all_odds.append({**row,'line':line})
 line_rows=[]
 for line,group in by_line.items():
  over=american_best(group['over']); under=american_best(group['under'])
  line_rows.append({'line':line,'overOdds':over.get('price') if over else None,
   'underOdds':under.get('price') if under else None,
   'bestOverBook':over.get('bookmakerTitle') or over.get('bookmaker') if over else None,
   'bestUnderBook':under.get('bookmakerTitle') or under.get('bookmaker') if under else None,
   'selectedLineOdds':[row for row in group['over']+group['under']]})
 # Select the line with the most book quotes; break ties by the newest update.
 line_rows.sort(key=lambda row:(-len(row['selectedLineOdds']),str(row.get('line') or '')))
 selected=line_rows[0] if line_rows else None
 over=american_best([row for row in quotes if norm(row.get('selection')) in {'over','o','yes'}])
 under=american_best([row for row in quotes if norm(row.get('selection')) in {'under','u','no'}])
 return {
  'line':selected.get('line') if selected else None,
  'overOdds':over.get('price') if over else None,'underOdds':under.get('price') if under else None,
  'bestOverOdds':over.get('price') if over else None,'bestUnderOdds':under.get('price') if under else None,
  'bestOverBook':(over.get('bookmakerTitle') or over.get('bookmaker')) if over else None,
  'bestUnderBook':(under.get('bookmakerTitle') or under.get('bookmaker')) if under else None,
  'lineOptions':line_rows,'selectedLineOdds':selected.get('selectedLineOdds',[]) if selected else [],
  'allOdds':all_odds,
 }

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

def opponent_for(team_info,event,roster_index):
 participants=roster_index.get('event_teams',{}).get(str(event.get('id') or ''),[])
 own_id=str(team_info.get('id') or '')
 own_abbr=norm(team_info.get('team'))
 own_name=norm(team_info.get('team_name'))
 own=next((team for team in participants if (own_id and str(team.get('id'))==own_id) or (own_abbr and norm(team.get('abbreviation'))==own_abbr) or (own_name and norm(team.get('displayName'))==own_name)),None)
 if own and len(participants)==2:
  other=next((team for team in participants if str(team.get('id'))!=str(own.get('id'))),None)
  if other: return other.get('abbreviation') or other.get('shortDisplayName') or other.get('displayName')
 return None

def is_home_for(team_info,event,roster_index):
 participants=roster_index.get('event_teams',{}).get(str(event.get('id') or ''),[])
 own_id=str(team_info.get('id') or '')
 own_abbr=norm(team_info.get('team'))
 if own_id:
  for side,team in zip(('home','away'),participants):
   if str(team.get('id'))==own_id: return side=='home'
 if own_abbr:
  for side,team in zip(('home','away'),participants):
   if norm(team.get('abbreviation'))==own_abbr: return side=='home'
 return None

def build_sport(sport,events,root,stamp,key,roster_index=None):
 roster_index=roster_index or {'by_id':{},'by_name':{},'event_teams':{},'by_abbr':{}}
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
     raw_name=player_name_from_outcome(outcome)
     name,team_suffix=cfb_name_parts(raw_name) if sport=='cfb' and raw_name else (raw_name,None)
     if not isinstance(name,str) or not name.strip(): continue
     if is_non_player(sport,raw_name): continue
     player_id=outcome.get('player_id') or outcome.get('athlete_id')
     identity=player_identity(player_id,name)
     team_info=roster_team_for(sport,outcome,raw_name,ev,roster_index)
     p=players.get(identity)
     if p is None:
      p={'player':name,'sport':sport,'event_id':eid,
       'home_team':ev.get('home_team'),'away_team':ev.get('away_team'),
       'commence_time':ev.get('commence_time'),'fetched_at':stamp,'markets':{},
       'player_id':player_id,'team':team_info.get('team'),'team_id':team_info.get('id'),'position':team_info.get('position')}
      players[identity]=p
     elif len(name)<len(p.get('player') or ''):
      p['player']=name
     if p.get('team') in (None,'') and team_info.get('team'): p['team']=team_info.get('team')
     if p.get('position') in (None,'') and team_info.get('position'): p['position']=team_info.get('position')
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
  for player in players.values():
   name=player['player']
   rel=f'{sport}/events/{slug(eid)}/players/{slug(name)}.json'
   write_json(root/rel,player)
   opponent=opponent_for({'id':player.get('team_id'),'team':player.get('team'),'team_name':None},ev,roster_index) if player.get('team') else None
   home_flag=is_home_for({'id':player.get('team_id'),'team':player.get('team')},ev,roster_index) if player.get('team') else None
   index.append({'player':name,'player_id':player.get('player_id'),'event_id':eid,'path':rel,'commence_time':ev.get('commence_time'),
     'home_team':ev.get('home_team'),'away_team':ev.get('away_team'),
     'team':player.get('team'),'opponent':opponent,'position':player.get('position'),'is_home':home_flag,'markets':list(player['markets']),
     'market_quotes':market_quote_rows(player)})
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
 games={}
 for entry in index:
  name=str(entry.get('player') or '').strip()
  if not name: continue
  if is_non_player(sport,name): continue
  # CFB responses sometimes append a school abbreviation to the player name
  # (for example "AJ Little (USM)") even when another outcome for that same
  # athlete uses the plain name. Prefer the clean display name and retain the
  # school code as a team fallback. The same ID-first identity rule also
  # protects other sports if an upstream name varies between markets.
  qualifier=re.search(r'\s+\(([A-Z0-9]{2,6})\)$',name) if sport=='cfb' else None
  clean_name=name[:qualifier.start()].strip() if qualifier else name
  team=entry.get('team') or (qualifier.group(1) if qualifier else None)
  player_id=entry.get('player_id')
  identity=player_identity(player_id,clean_name)
  key=identity
  player=by_key.get(key)
  if player is None:
   player={
    'playerId':player_id, 'name':clean_name, 'team':team,
    'opponent':entry.get('opponent'), 'eventId':str(entry.get('event_id') or ''),
    'position':entry.get('position'),'isHome':entry.get('is_home'),
    'markets':[], 'props':[]}
   by_key[key]=player
  else:
   # Keep the clearest name when PropLine supplied variants for one athlete.
   current_qualified=bool(re.search(r'\s+\([A-Z0-9]{2,6}\)$',str(player.get('name') or '')))
   if (current_qualified and not qualifier) or (len(clean_name)<len(str(player.get('name') or '')) and not qualifier):
    player['name']=clean_name
   if player.get('team') in (None,'') and team: player['team']=team
   if player.get('opponent') in (None,'') and entry.get('opponent'): player['opponent']=entry.get('opponent')
   if player.get('position') in (None,'') and entry.get('position'): player['position']=entry.get('position')
  markets=[PLAYER_MARKETS.get(sport,{}).get(market,market) for market in (entry.get('markets') or [])]
  player['markets']=sorted(set(player['markets'])|set(markets))
  seen_props={(p.get('eventId'),p.get('market')) for p in player['props']}
  for provider_market in entry.get('markets') or []:
   market=PLAYER_MARKETS.get(sport,{}).get(provider_market,provider_market)
   prop_key=(str(entry.get('event_id') or ''),market)
   if prop_key in seen_props: continue
   seen_props.add(prop_key)
   quote_fields=prop_quote_fields((entry.get('market_quotes') or {}).get(provider_market,[]))
   player['props'].append({
    'player':player['name'], 'playerId':player.get('playerId'), 'team':player.get('team'),
    'opponent':entry.get('opponent'), 'gameId':str(entry.get('event_id') or ''),
    'homeTeam':entry.get('home_team'),'awayTeam':entry.get('away_team'),
    'commenceTime':entry.get('commence_time'),'position':entry.get('position'),'isHome':entry.get('is_home'),
    **quote_fields,'market':market, 'source':'PropLine', 'projection':None,
   })
 # Normalize props again after merging name variants so every row uses the
 # canonical player display name/team, including rows added before a rename.
 for player in by_key.values():
  for prop in player['props']:
   prop['player']=player['name']
   prop['playerId']=player.get('playerId')
   if prop.get('team') in (None,''): prop['team']=player.get('team')
   if prop.get('opponent') in (None,''): prop['opponent']=player.get('opponent')
 for entry in index:
  name=str(entry.get('player') or '').strip()
  if not name: continue
  clean_name,qualifier=cfb_name_parts(name) if sport=='cfb' else (name,None)
  player_id=entry.get('player_id')
  identity=player_identity(player_id,clean_name)
  player=by_key.get(identity)
  if player is None: continue
  event_id=str(entry.get('event_id') or '')
  game=games.setdefault(event_id,{
   'id':event_id,'eventId':event_id,'homeTeam':entry.get('home_team'),
   'awayTeam':entry.get('away_team'),'commenceTime':entry.get('commence_time'),
   'players':[]})
  game_player=next((p for p in game['players'] if player_identity(p.get('playerId'),p.get('name'))==identity),None)
  if game_player is None:
   game_player={'playerId':player.get('playerId'),'name':player.get('name'),'team':entry.get('team') or player.get('team') or qualifier,
    'opponent':entry.get('opponent') or player.get('opponent'),'position':entry.get('position'),
    'isHome':entry.get('is_home'),'markets':[],'props':[]}
   game['players'].append(game_player)
  game_player['markets']=sorted(set(game_player['markets'])|set(PLAYER_MARKETS.get(sport,{}).get(m,m) for m in (entry.get('markets') or [])))
  for prop in player['props']:
   if str(prop.get('gameId') or '')!=event_id: continue
   if not any(row.get('gameId')==prop.get('gameId') and row.get('market')==prop.get('market') for row in game_player['props']):
    game_player['props'].append(prop)
 games_list=sorted(games.values(),key=lambda game:(str(game.get('commenceTime') or ''),game.get('id') or ''))
 return {
  'ok':True, 'sport':sport, 'screen':screen, 'updated_at':stamp,
  'status':'ready' if by_key else 'empty', 'source':'PropLine',
  'player_count':len(by_key), 'prop_count':sum(len(p['props']) for p in by_key.values()),
  'game_count':len(games_list),'games':games_list,'players':list(by_key.values()),
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
   team_count=sum(bool(player.get('team')) for player in payload['players'])
   print(f"Published candidate player-lists/{sport}/{screen}.json: {payload['game_count']} games / {payload['player_count']} unique PropLine players ({team_count} with team metadata) / {payload['prop_count']} player-market rows",flush=True)

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
   roster_index=espn_roster_index(sport,events,out)
   stats[sport]=build_sport(sport,events,root,stamp,key,roster_index)
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
