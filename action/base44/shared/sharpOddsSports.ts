// Multi-sport registry for the SharpOddsDatabase collector.
//
// Every connector in refreshSharpOddsDatabase is parameterized by a
// SportConfig from this module. Provider identifiers below were each verified
// against the live feeds:
//   - SharpAPI:     league=NFL and league=WNBA return draftkings main markets
//   - VSiN:         sportid=NFL and sportid=WNBA linetracker pages
//   - Novig:        GraphQL game.league _eq "NFL" / "WNBA"
//   - Polymarket:   /v2/leagues/nfl/events and /v2/leagues/wnba/events
//   - Pinnacle:     sport 15 = Football (NFL league 889), sport 4 = Basketball
//                   (WNBA league 578), sport 3 = Baseball (MLB league 246)
//   - Rebet:        sr:sport:16/sr:tournament:31 (NFL),
//                   sr:sport:2/sr:tournament:486 (WNBA), sr:sport:3/sr:tournament:109 (MLB)

import {
  MLB_TEAMS, canonicalMlbTeam, normalizeText,
} from './sharpOddsCommon.ts';
import { CFB_TEAMS, canonicalCfbTeam } from './cfbOddsTeams.ts';

export type TeamDef = { abbr: string; name: string; aliases: string[] };
export type SportConfig = {
  key: string;
  label: string;
  sharpLeague: string;
  vsinSportId: string;
  novigLeague: string;
  polymarketSlug: string;
  pinnacle: { sportId: number; leagueId: number | null };
  rebet: { sportId: string; leagueId: string | null };
  teams: TeamDef[];
  canonical: (value: any) => TeamDef | null;
};

export const SUPPORTED_SPORTS = ['mlb', 'nfl', 'ncaaf', 'wnba'];

export const NFL_TEAMS: TeamDef[] = [
  { abbr: 'ARI', name: 'Arizona Cardinals', aliases: ['ari', 'arizona', 'cardinals', 'arizona cardinals'] },
  { abbr: 'ATL', name: 'Atlanta Falcons', aliases: ['atl', 'atlanta', 'falcons', 'atlanta falcons'] },
  { abbr: 'BAL', name: 'Baltimore Ravens', aliases: ['bal', 'baltimore', 'ravens', 'baltimore ravens'] },
  { abbr: 'BUF', name: 'Buffalo Bills', aliases: ['buf', 'buffalo', 'bills', 'buffalo bills'] },
  { abbr: 'CAR', name: 'Carolina Panthers', aliases: ['car', 'carolina', 'panthers', 'carolina panthers'] },
  { abbr: 'CHI', name: 'Chicago Bears', aliases: ['chi', 'chicago', 'bears', 'chicago bears'] },
  { abbr: 'CIN', name: 'Cincinnati Bengals', aliases: ['cin', 'cincinnati', 'bengals', 'cincinnati bengals'] },
  { abbr: 'CLE', name: 'Cleveland Browns', aliases: ['cle', 'cleveland', 'browns', 'cleveland browns'] },
  { abbr: 'DAL', name: 'Dallas Cowboys', aliases: ['dal', 'dallas', 'cowboys', 'dallas cowboys', 'boys'] },
  { abbr: 'DEN', name: 'Denver Broncos', aliases: ['den', 'denver', 'broncos', 'denver broncos'] },
  { abbr: 'DET', name: 'Detroit Lions', aliases: ['det', 'detroit', 'lions', 'detroit lions'] },
  { abbr: 'GB', name: 'Green Bay Packers', aliases: ['gb', 'gnb', 'green bay', 'packers', 'green bay packers', 'gb packers'] },
  { abbr: 'HOU', name: 'Houston Texans', aliases: ['hou', 'houston', 'texans', 'houston texans'] },
  { abbr: 'IND', name: 'Indianapolis Colts', aliases: ['ind', 'indianapolis', 'colts', 'indianapolis colts'] },
  { abbr: 'JAX', name: 'Jacksonville Jaguars', aliases: ['jax', 'jac', 'jacksonville', 'jaguars', 'jags', 'jacksonville jaguars'] },
  { abbr: 'KC', name: 'Kansas City Chiefs', aliases: ['kc', 'kan', 'kansas city', 'chiefs', 'kc chiefs', 'kansas city chiefs'] },
  { abbr: 'LAC', name: 'Los Angeles Chargers', aliases: ['lac', 'la chargers', 'chargers', 'los angeles chargers', 'sd', 'san diego chargers'] },
  { abbr: 'LAR', name: 'Los Angeles Rams', aliases: ['lar', 'la rams', 'rams', 'los angeles rams', 'stl', 'st louis rams'] },
  { abbr: 'LV', name: 'Las Vegas Raiders', aliases: ['lv', 'lva', 'las vegas', 'raiders', 'lv raiders', 'las vegas raiders', 'oak', 'oakland raiders'] },
  { abbr: 'MIA', name: 'Miami Dolphins', aliases: ['mia', 'miami', 'dolphins', 'miami dolphins'] },
  { abbr: 'MIN', name: 'Minnesota Vikings', aliases: ['min', 'minnesota', 'vikings', 'minnesota vikings'] },
  { abbr: 'NE', name: 'New England Patriots', aliases: ['ne', 'nwe', 'new england', 'patriots', 'pats', 'ne patriots', 'new england patriots'] },
  { abbr: 'NO', name: 'New Orleans Saints', aliases: ['no', 'nor', 'new orleans', 'saints', 'nola', 'new orleans saints'] },
  { abbr: 'NYG', name: 'New York Giants', aliases: ['nyg', 'ny giants', 'giants', 'new york giants'] },
  { abbr: 'NYJ', name: 'New York Jets', aliases: ['nyj', 'ny jets', 'jets', 'new york jets'] },
  { abbr: 'PHI', name: 'Philadelphia Eagles', aliases: ['phi', 'philadelphia', 'eagles', 'philadelphia eagles', 'philly'] },
  { abbr: 'PIT', name: 'Pittsburgh Steelers', aliases: ['pit', 'pittsburgh', 'steelers', 'pittsburgh steelers'] },
  { abbr: 'SEA', name: 'Seattle Seahawks', aliases: ['sea', 'seattle', 'seahawks', 'seattle seahawks'] },
  { abbr: 'SF', name: 'San Francisco 49ers', aliases: ['sf', 'sfo', 'san francisco', '49ers', 'niners', 'sf 49ers', 'san francisco 49ers'] },
  { abbr: 'TB', name: 'Tampa Bay Buccaneers', aliases: ['tb', 'tam', 'tampa bay', 'buccaneers', 'bucs', 'tampa bay buccaneers'] },
  { abbr: 'TEN', name: 'Tennessee Titans', aliases: ['ten', 'tennessee', 'titans', 'tennessee titans'] },
  { abbr: 'WAS', name: 'Washington Commanders', aliases: ['was', 'wsh', 'wsn', 'washington', 'commanders', 'washington commanders', 'wft', 'washington football team'] },
];

export const WNBA_TEAMS: TeamDef[] = [
  { abbr: 'ATL', name: 'Atlanta Dream', aliases: ['atl', 'atlanta', 'dream', 'atl dream', 'atlanta dream'] },
  { abbr: 'CHI', name: 'Chicago Sky', aliases: ['chi', 'chicago', 'sky', 'chi sky', 'chicago sky'] },
  { abbr: 'CON', name: 'Connecticut Sun', aliases: ['con', 'conn', 'connecticut', 'sun', 'con sun', 'conn sun', 'connecticut sun'] },
  { abbr: 'DAL', name: 'Dallas Wings', aliases: ['dal', 'dallas', 'wings', 'dal wings', 'dallas wings'] },
  { abbr: 'GSV', name: 'Golden State Valkyries', aliases: ['gsv', 'gs', 'golden state', 'valkyries', 'gs valkyries', 'golden state valkyries'] },
  { abbr: 'IND', name: 'Indiana Fever', aliases: ['ind', 'indiana', 'fever', 'ind fever', 'indiana fever'] },
  { abbr: 'LVA', name: 'Las Vegas Aces', aliases: ['lva', 'lv', 'las vegas', 'aces', 'ace', 'lva aces', 'lv aces', 'las vegas aces'] },
  { abbr: 'LAS', name: 'Los Angeles Sparks', aliases: ['las', 'la', 'los angeles', 'sparks', 'las sparks', 'la sparks', 'los angeles sparks'] },
  { abbr: 'MIN', name: 'Minnesota Lynx', aliases: ['min', 'minnesota', 'lynx', 'min lynx', 'minnesota lynx'] },
  { abbr: 'NYL', name: 'New York Liberty', aliases: ['nyl', 'ny', 'new york', 'liberty', 'nyl liberty', 'ny liberty', 'new york liberty'] },
  { abbr: 'POR', name: 'Portland Fire', aliases: ['por', 'portland', 'fire', 'por fire', 'portland fire'] },
  { abbr: 'PHO', name: 'Phoenix Mercury', aliases: ['pho', 'phx', 'phoenix', 'mercury', 'pho mercury', 'phoenix mercury'] },
  { abbr: 'SEA', name: 'Seattle Storm', aliases: ['sea', 'seattle', 'storm', 'sea storm', 'seattle storm'] },
  { abbr: 'TOR', name: 'Toronto Tempo', aliases: ['tor', 'toronto', 'tempo', 'tor tempo', 'toronto tempo'] },
  { abbr: 'WAS', name: 'Washington Mystics', aliases: ['was', 'wsh', 'wsn', 'washington', 'mystics', 'was mystics', 'washington mystics'] },
];

// Same two-stage matching semantics as canonicalMlbTeam in sharpOddsCommon:
// exact name/abbr/alias first, then alias substring for longer aliases.
function canonicalFromTeams(teams: TeamDef[], value: any): TeamDef | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  for (const team of teams) {
    if (normalizeText(team.name) === normalized || normalizeText(team.abbr) === normalized) return team;
    if (team.aliases.some((alias) => normalizeText(alias) === normalized)) return team;
  }
  for (const team of teams) {
    if (team.aliases.some((alias) => {
      const a = normalizeText(alias);
      return a.length >= 4 && (normalized.includes(a) || a.includes(normalized));
    })) return team;
  }
  return null;
}

export const SPORTS: Record<string, SportConfig> = {
  mlb: {
    key: 'mlb',
    label: 'MLB',
    sharpLeague: 'MLB',
    vsinSportId: 'MLB',
    novigLeague: 'MLB',
    polymarketSlug: 'mlb',
    pinnacle: { sportId: 3, leagueId: 246 },
    rebet: { sportId: 'sr:sport:3', leagueId: 'sr:tournament:109' },
    teams: MLB_TEAMS as TeamDef[],
    canonical: canonicalMlbTeam as any,
  },
  nfl: {
    key: 'nfl',
    label: 'NFL',
    sharpLeague: 'NFL',
    vsinSportId: 'NFL',
    novigLeague: 'NFL',
    polymarketSlug: 'nfl',
    pinnacle: { sportId: 15, leagueId: 889 },
    rebet: { sportId: 'sr:sport:16', leagueId: 'sr:tournament:31' },
    teams: NFL_TEAMS,
    canonical: (value: any) => canonicalFromTeams(NFL_TEAMS, value),
  },
  ncaaf: {
    key: 'ncaaf',
    label: 'NCAAF',
    sharpLeague: 'NCAAF',
    vsinSportId: 'CFB',
    novigLeague: 'NCAAF',
    polymarketSlug: 'cfb',
    // Arcadia's NFL and NCAAF share sport 15. No hard-coded NCAA league id is
    // used until it is verified; SharpAPI/VSiN/Novig/Polymarket/Rebet still run.
    pinnacle: { sportId: 15, leagueId: null },
    // Rebet shares sr:sport:16 across NFL/NCAAF. Without an invented tournament
    // id, fetch the sport feed and filter to canonical CFB teams locally.
    rebet: { sportId: 'sr:sport:16', leagueId: null },
    teams: CFB_TEAMS,
    canonical: canonicalCfbTeam as any,
  },
  wnba: {
    key: 'wnba',
    label: 'WNBA',
    sharpLeague: 'WNBA',
    vsinSportId: 'WNBA',
    novigLeague: 'WNBA',
    polymarketSlug: 'wnba',
    pinnacle: { sportId: 4, leagueId: 578 },
    rebet: { sportId: 'sr:sport:2', leagueId: 'sr:tournament:486' },
    teams: WNBA_TEAMS,
    canonical: (value: any) => canonicalFromTeams(WNBA_TEAMS, value),
  },
};

export function getSportConfig(sport: any): SportConfig | null {
  const raw = String(sport || '').trim().toLowerCase();
  const key = raw === 'cfb' ? 'ncaaf' : raw;
  return SPORTS[key] || null;
}

// Side inference for sources that label selections by team name rather than by
// an explicit home/away flag. Sport-aware replacement for the MLB-only
// inferTeamSide helper in sharpOddsCommon.
export function inferTeamSideForSport(cfg: SportConfig, selectionType: string, selection: string, away: string, home: string) {
  const st = String(selectionType || '').toLowerCase();
  if (st === 'away' || st.includes('away')) return 'away';
  if (st === 'home' || st.includes('home')) return 'home';
  const selected = cfg.canonical(selection);
  const a = cfg.canonical(away);
  const h = cfg.canonical(home);
  if (selected?.abbr && selected.abbr === a?.abbr) return 'away';
  if (selected?.abbr && selected.abbr === h?.abbr) return 'home';
  return null;
}
