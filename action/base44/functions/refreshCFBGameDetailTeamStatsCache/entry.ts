// CFB game-detail team stats cache.
//
// Mirrors the NFL Game Detail cache contract while sourcing CFB data from the
// supported CollegeFootballData API instead of the retired SportsDataverse
// release CSV.  Each run downloads the season schedule once, then downloads
// team box scores once per completed week and builds Season/L5/L10/L15 team
// windows plus league ranks.
//
// Required secret: CFBD_API_KEY

import { normalizeCFBSchool, cfbDisplayName } from '../../shared/cfbTeamIdentity.ts';
import { canonicalCfbTeam, CFB_TEAMS } from '../../shared/cfbOddsTeams.ts';

const CFBD_BASE = 'https://api.collegefootballdata.com';
const DEFAULT_TIMEFRAMES = ['season', 'L5', 'L10', 'L15'];
const MAX_TEAMS_PER_RUN = 180;
const CACHE_VERSION = 22;
const CURRENT_SOURCE_MAX_AGE_MS = 55 * 60 * 1000;
const HISTORICAL_SOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;


function teamKey(value: any): string {
  const canonical = canonicalCfbTeam(value);
  if (canonical?.abbr) return normalizeCFBSchool(canonical.abbr);
  return normalizeCFBSchool(value);
}

const INVERSE_STAT_KEYS = new Set([
  // Shared NFL/CFB stats whose NFL cache explicitly ranks lower values better.
  'interceptionRate',
  'sackRateAllowed',
  'pressureRateAllowed',
  'pressurePctAllowed',
  'hurriesAllowed',
  'hurryPct',
  'turnoverRate',
  'penaltiesPerGame',
  'penaltyYardsPerGame',
  'stuffRate',
  'stuffRateAllowed',
  'pointsAllowedPerGame',
  'yardsAllowedPerGame',
  'yardsPerPlayAllowed',
  'defensiveEpaPerPlay',
  'epaAllowedPerPlay',
  'defensiveSuccessRate',
  'successRateAllowed',
  'pointsAllowedPerDrive',
  'passingYardsAllowed',
  'passingYardsAllowedPerGame',
  'completionPctAllowed',
  'completionPercentageAllowed',
  'completionsAllowedPerGame',
  'yardsPerAttemptAllowed',
  'passYardsPerAttemptAllowed',
  'ypaAllowed',
  'yardsPerPassAllowed',
  'passingTouchdownsAllowed',
  'passingTDsAllowed',
  'passingTouchdownsAllowedPerGame',
  'passEpaAllowed',
  'passEpaAllowedPerPlay',
  'passingEpaAllowed',
  'passSuccessRateAllowed',
  'passingSuccessRateAllowed',
  'explosivePassRateAllowed',
  'explosivePassPctAllowed',
  'airYardsAllowed',
  'airYardsAllowedPerGame',
  'averageDepthOfTargetAllowed',
  'qbRatingAllowed',
  'passerRatingAllowed',
  'cpoeAllowed',
  'rushingYardsAllowed',
  'rushingYardsAllowedPerGame',
  'yardsPerCarryAllowed',
  'rushYardsPerAttemptAllowed',
  'ypcAllowed',
  'yardsPerRushAllowed',
  'rushEpaAllowed',
  'rushEpaAllowedPerPlay',
  'rushingEpaAllowed',
  'rushSuccessRateAllowed',
  'rushingSuccessRateAllowed',
  'explosiveRunRateAllowed',
  'explosiveRushRateAllowed',
  'missedTacklePct',
  'yardsBeforeContactAllowed',
  'adjustedLineYardsAllowed',
  'shortYardageSuccessAllowed',
  'thirdDownPctAllowed',
  'thirdDownConversionPctAllowed',
  'fourthDownPctAllowed',
  'openingDriveScorePctAllowed',
  'redZoneEfficiencyAllowed',
  'redZoneScorePctAllowed',
  'redZoneTdPctAllowed',
  'redZoneTouchdownPctAllowed',
  'goalToGoTdPctAllowed',
  'goalToGoTouchdownPctAllowed',
  'firstHalfPointsAllowed',
  'firstHalfPointsAllowedPerGame',
  'secondHalfPointsAllowed',
  'secondHalfPointsAllowedPerGame',
  'fourthQuarterPointsAllowed',
  'fourthQuarterPointsAllowedPerGame',
  'twoMinuteDefensePpa',
  'twoMinuteDefenseEpa',
  'twoMinuteEpaAllowed',
  'puntReturnYardsAllowed',
  'returnYardsAllowed',
  'oppAvgStartingFieldPosition',
  'oppAvgDriveStartYardLine',
  'passingAttemptsAllowedPerGame',
  'yardsPerCompletionAllowed',
  'firstDownsAllowedPerGame',
  'turnovers',
  'sacksAllowedPerGame',
  'yardsPerPassAllowed',
  'passingTouchdownsAllowedPerGame',
  'passYardsPerAttemptAllowed',
  'qbHurriesAllowedPerGame',
]);

function safeJsonParse(value: string) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function n(value: any, fallback = 0): number {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value).replace(/,/g, '').replace(/%/g, '').trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveStatsSeason(value: any): number {
  const explicit = n(value, 0);
  if (explicit >= 2000) return explicit;
  const now = new Date();
  return now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}

function todayCentral(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

function normalizeRequestedTimeframe(value: any): string | null {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'SEASON') return 'season';
  if (['L5', 'L10', 'L15'].includes(raw)) return raw;
  return null;
}

function normalizeCategory(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parsePair(value: any): [number, number] {
  const raw = String(value ?? '').trim();
  const match = raw.match(/(-?\d+(?:\.\d+)?)\s*[-/]\s*(-?\d+(?:\.\d+)?)/);
  return match ? [n(match[1]), n(match[2])] : [0, 0];
}

function parseClockSeconds(value: any): number {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d+):(\d{1,2})$/);
  if (!match) return n(value, 0);
  return n(match[1]) * 60 + n(match[2]);
}

function safeDiv(a: number, b: number): number | null {
  return b ? a / b : null;
}

function round(value: number | null, decimals = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function asPct(value: any): number | null {
  const parsed = n(value, NaN);
  if (!Number.isFinite(parsed)) return null;
  return round(Math.abs(parsed) <= 1.000001 ? parsed * 100 : parsed, 1);
}

function finiteOrNull(value: any, decimals = 3): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed, decimals) : null;
}

interface BoxTotals {
  totalYards: number;
  netPassingYards: number;
  rushingYards: number;
  rushingAttempts: number;
  firstDowns: number;
  thirdConv: number;
  thirdAtt: number;
  fourthConv: number;
  fourthAtt: number;
  comp: number;
  passAtt: number;
  passingTouchdowns: number;
  rushingTouchdowns: number;
  turnovers: number;
  fumblesLost: number;
  interceptions: number;
  tacklesForLoss: number;
  qbHurries: number;
  passesDeflected: number;
  forcedFumbles: number;
  pens: number;
  penYards: number;
  possessionSeconds: number;
  sacks: number;
  sackYards: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  extraPointsMade: number;
  extraPointsAttempted: number;
  extraPointsMadeReported: boolean;
  extraPointsAttemptedReported: boolean;
  punts: number;
  puntYards: number;
  kickReturns: number;
  kickReturnYards: number;
  kickReturnTouchdowns: number;
  puntReturns: number;
  puntReturnYards: number;
  puntReturnTouchdowns: number;
  redZoneAttempts: number;
  redZoneScores: number;
  redZoneTouchdowns: number;
  puntsInside20: number;
  puntTouchbacks: number;
  netPuntYards: number;
  kickoffs: number;
  kickoffTouchbacks: number;
}

function emptyTotals(): BoxTotals {
  return {
    totalYards: 0, netPassingYards: 0, rushingYards: 0, rushingAttempts: 0,
    firstDowns: 0, thirdConv: 0, thirdAtt: 0, fourthConv: 0, fourthAtt: 0,
    comp: 0, passAtt: 0, passingTouchdowns: 0, rushingTouchdowns: 0,
    turnovers: 0, fumblesLost: 0, interceptions: 0, tacklesForLoss: 0,
    qbHurries: 0, passesDeflected: 0, forcedFumbles: 0, pens: 0, penYards: 0, possessionSeconds: 0, sacks: 0, sackYards: 0,
    fieldGoalsMade: 0, fieldGoalsAttempted: 0, extraPointsMade: 0,
    extraPointsAttempted: 0, extraPointsMadeReported: false, extraPointsAttemptedReported: false,
    punts: 0, puntYards: 0, kickReturns: 0,
    kickReturnYards: 0, kickReturnTouchdowns: 0, puntReturns: 0,
    puntReturnYards: 0, puntReturnTouchdowns: 0, redZoneAttempts: 0,
    redZoneScores: 0, redZoneTouchdowns: 0, puntsInside20: 0,
    puntTouchbacks: 0, netPuntYards: 0, kickoffs: 0, kickoffTouchbacks: 0,
  };
}

function teamBoxTotals(team: any): BoxTotals {
  const out = emptyTotals();
  const stats = Array.isArray(team?.stats) ? team.stats : [];
  for (const item of stats) {
    const key = normalizeCategory(item?.category ?? item?.name ?? item?.label);
    const value = item?.stat ?? item?.value ?? item?.displayValue;
    if (!key) continue;

    if (['totalyards', 'totaloffense'].includes(key)) out.totalYards = n(value);
    else if (['netpassingyards', 'passingyards', 'passyards'].includes(key)) out.netPassingYards = n(value);
    else if (['rushingyards', 'rushyards'].includes(key)) out.rushingYards = n(value);
    else if (['rushingattempts', 'rushattempts', 'carries'].includes(key)) out.rushingAttempts = n(value);
    else if (['firstdowns', 'totalfirstdowns'].includes(key)) out.firstDowns = n(value);
    else if (['thirddowneff', 'thirddownefficiency', '3rddownefficiency'].includes(key)) [out.thirdConv, out.thirdAtt] = parsePair(value);
    else if (['fourthdowneff', 'fourthdownefficiency', '4thdownefficiency'].includes(key)) [out.fourthConv, out.fourthAtt] = parsePair(value);
    else if (['completionattempts', 'completionsattempts', 'compatt'].includes(key)) [out.comp, out.passAtt] = parsePair(value);
    else if (['passingtouchdowns', 'passingtds', 'passtds'].includes(key)) out.passingTouchdowns = n(value);
    else if (['rushingtouchdowns', 'rushingtds', 'rushtds'].includes(key)) out.rushingTouchdowns = n(value);
    else if (key === 'turnovers') out.turnovers = n(value);
    else if (['fumbleslost', 'lostfumbles'].includes(key)) out.fumblesLost = n(value);
    else if (['interceptions', 'interceptionsthrown'].includes(key)) out.interceptions = n(value);
    else if (['tacklesforloss', 'tfl'].includes(key)) out.tacklesForLoss = n(value);
    else if (['qbhurries', 'quarterbackhurries'].includes(key)) out.qbHurries = n(value);
    else if (['passesdeflected', 'passbreakups', 'pbus'].includes(key)) out.passesDeflected = n(value);
    else if (['fumblesforced', 'forcedfumbles'].includes(key)) out.forcedFumbles = n(value);
    else if (['totalpenaltiesyards', 'penaltiesyards'].includes(key)) [out.pens, out.penYards] = parsePair(value);
    else if (['possessiontime', 'timeofpossession'].includes(key)) out.possessionSeconds = parseClockSeconds(value);
    else if (['sacksyardslost', 'sacks'].includes(key)) {
      const pair = parsePair(value);
      if (pair[1] || String(value).includes('-')) { out.sacks = pair[0]; out.sackYards = pair[1]; }
      else out.sacks = n(value);
    }
    else if (['redzoneeff', 'redzoneefficiency', 'redzone'].includes(key)) [out.redZoneScores, out.redZoneAttempts] = parsePair(value);
    else if (['redzoneattempts', 'redzoneatt'].includes(key)) out.redZoneAttempts = n(value);
    else if (['redzonescores', 'redzonescoring'].includes(key)) out.redZoneScores = n(value);
    else if (['redzonetouchdowns', 'redzonetds'].includes(key)) out.redZoneTouchdowns = n(value);
    else if (['fieldgoalsmadefieldgoalsattempted', 'fieldgoalsmadeattempted', 'fieldgoals'].includes(key)) {
      const pair = parsePair(value);
      if (pair[1] || /[-/]/.test(String(value))) [out.fieldGoalsMade, out.fieldGoalsAttempted] = pair;
      else out.fieldGoalsMade = n(value);
    }
    else if (['fieldgoalsmade', 'fgmade'].includes(key)) out.fieldGoalsMade = n(value);
    else if (['fieldgoalsattempted', 'fieldgoalattempts', 'fgattempts'].includes(key)) out.fieldGoalsAttempted = n(value);
    else if (['extrapointsmadeextrapointsattempted', 'extrapointsmadeattempted', 'extrapoints'].includes(key)) {
      const pair = parsePair(value);
      if (pair[1] || /[-/]/.test(String(value))) {
        [out.extraPointsMade, out.extraPointsAttempted] = pair;
        out.extraPointsMadeReported = true;
        out.extraPointsAttemptedReported = true;
      } else {
        out.extraPointsMade = n(value);
        out.extraPointsMadeReported = true;
      }
    }
    else if (['extrapointsmade', 'xpmade', 'patmade', 'pointaftertouchdownmade'].includes(key)) {
      out.extraPointsMade = n(value);
      out.extraPointsMadeReported = true;
    }
    else if (['extrapointsattempted', 'extrapointattempts', 'xpattempts', 'patattempts', 'pointaftertouchdownattempts'].includes(key)) {
      out.extraPointsAttempted = n(value);
      out.extraPointsAttemptedReported = true;
    }
    else if (['puntsyards', 'punting'].includes(key)) {
      const pair = parsePair(value);
      if (pair[1] || /[-/]/.test(String(value))) [out.punts, out.puntYards] = pair;
      else out.punts = n(value);
    }
    else if (key === 'punts') out.punts = n(value);
    else if (['puntyards', 'grosspuntyards'].includes(key)) out.puntYards = n(value);
    else if (['netpuntyards', 'netpuntingyards'].includes(key)) out.netPuntYards = n(value);
    else if (['puntsinside20', 'inside20'].includes(key)) out.puntsInside20 = n(value);
    else if (['punttouchbacks', 'puntstouchbacks'].includes(key)) out.puntTouchbacks = n(value);
    else if (['kickoffs', 'kickoffattempts'].includes(key)) out.kickoffs = n(value);
    else if (['kickofftouchbacks', 'touchbacks'].includes(key)) out.kickoffTouchbacks = n(value);
    else if (['kickreturnsyards'].includes(key)) [out.kickReturns, out.kickReturnYards] = parsePair(value);
    else if (key === 'kickreturns') {
      const pair = parsePair(value);
      if (pair[1] || /[-/]/.test(String(value))) [out.kickReturns, out.kickReturnYards] = pair;
      else out.kickReturns = n(value);
    }
    else if (['kickreturnyards'].includes(key)) out.kickReturnYards = n(value);
    else if (['puntreturnsyards'].includes(key)) [out.puntReturns, out.puntReturnYards] = parsePair(value);
    else if (key === 'puntreturns') {
      const pair = parsePair(value);
      if (pair[1] || /[-/]/.test(String(value))) [out.puntReturns, out.puntReturnYards] = pair;
      else out.puntReturns = n(value);
    }
    else if (['puntreturnyards'].includes(key)) out.puntReturnYards = n(value);
    else if (['kickreturntouchdowns', 'kickreturntds'].includes(key)) out.kickReturnTouchdowns = n(value);
    else if (['puntreturntouchdowns', 'puntreturntds'].includes(key)) out.puntReturnTouchdowns = n(value);
  }

  // Some feeds omit an explicit turnover total.
  if (!out.turnovers && (out.fumblesLost || out.interceptions)) out.turnovers = out.fumblesLost + out.interceptions;
  return out;
}

interface SituationalGameMetrics {
  driveCoverage: boolean;
  playCoverage: boolean;
  drives: number;
  scoringDrives: number;
  touchdownDrives: number;
  offensiveDrivePoints: number;
  redZoneTrips: number;
  redZoneScores: number;
  redZoneTouchdowns: number;
  goalToGoTrips: number;
  goalToGoTouchdowns: number;
  goalToGoPlays: number;
  goalToGoSuccesses: number;
  thirdDownPpaSum: number;
  thirdDownPpaPlays: number;
  fourthDownAttempts: number;
  explosivePasses: number;
  passAttempts: number;
  passPpaSum: number;
  passPpaPlays: number;
  passLikePlays: number;
  successfulPassPlays: number;
  explosiveRushes: number;
  rushAttempts: number;
  rushPpaSum: number;
  rushPpaPlays: number;
  successfulRushAttempts: number;
  scrimmagePpaSum: number;
  scrimmagePpaPlays: number;
  scrimmagePlays: number;
  successfulScrimmagePlays: number;
  shortYardageRushAttempts: number;
  shortYardageRushConversions: number;
  earlyDownPassPlays: number;
  earlyDownScrimmagePlays: number;
  twoMinutePpaSum: number;
  twoMinutePpaPlays: number;
  driveElapsedSeconds: number;
  drivePlays: number;
  openingDriveScore: number;
  openingDriveTouchdown: number;
}

interface PassingGameMetrics {
  airYardsAttempts: number;
  totalAirYards: number;
  totalPpa: number;
  ppaAttempts: number;
}

interface SpecialTeamsGameMetrics {
  playCoverage: boolean;
  fieldGoalAttempts: number;
  fieldGoalsMade: number;
  fieldGoalAttempts40Plus: number;
  fieldGoalsMade40Plus: number;
  fieldGoalAttempts50Plus: number;
  fieldGoalsMade50Plus: number;
  longestFieldGoalMade: number;
  extraPointAttempts: number;
  extraPointsMade: number;
  punts: number;
  grossPuntYards: number;
  puntReturnYardsAllowed: number;
  puntTouchbacks: number;
  puntsInside20: number;
  kickoffs: number;
  kickoffTouchbacks: number;
  ppaSum: number;
  ppaPlays: number;
}

interface TeamGame {
  gameId: string;
  date: string;
  week: number;
  pointsFor: number;
  pointsAgainst: number;
  lineScores?: number[];
  opponentLineScores?: number[];
  own: BoxTotals;
  opp: BoxTotals;
  situational?: SituationalGameMetrics;
  oppSituational?: SituationalGameMetrics;
  passing?: PassingGameMetrics;
  oppPassing?: PassingGameMetrics;
  specialTeams?: SpecialTeamsGameMetrics;
  oppSpecialTeams?: SpecialTeamsGameMetrics;
}

function clockSeconds(clock: any): number {
  if (clock == null) return 0;
  if (typeof clock === 'number') return Math.max(0, clock);
  if (typeof clock === 'string') return parseClockSeconds(clock);
  return Math.max(0, n(clock?.minutes, 0) * 60 + n(clock?.seconds, 0));
}

function emptySituational(): SituationalGameMetrics {
  return {
    driveCoverage: false, playCoverage: false, drives: 0, scoringDrives: 0, touchdownDrives: 0, offensiveDrivePoints: 0,
    redZoneTrips: 0, redZoneScores: 0, redZoneTouchdowns: 0, goalToGoTrips: 0, goalToGoTouchdowns: 0,
    goalToGoPlays: 0, goalToGoSuccesses: 0, thirdDownPpaSum: 0, thirdDownPpaPlays: 0, fourthDownAttempts: 0,
    explosivePasses: 0, passAttempts: 0, passPpaSum: 0, passPpaPlays: 0, passLikePlays: 0, successfulPassPlays: 0,
    explosiveRushes: 0, rushAttempts: 0, rushPpaSum: 0, rushPpaPlays: 0,
    successfulRushAttempts: 0, scrimmagePpaSum: 0, scrimmagePpaPlays: 0, scrimmagePlays: 0, successfulScrimmagePlays: 0,
    shortYardageRushAttempts: 0, shortYardageRushConversions: 0, earlyDownPassPlays: 0,
    earlyDownScrimmagePlays: 0, twoMinutePpaSum: 0, twoMinutePpaPlays: 0, driveElapsedSeconds: 0, drivePlays: 0,
    openingDriveScore: 0, openingDriveTouchdown: 0,
  };
}

function isPassLike(play: any): boolean {
  const type = normalizeCategory(play?.playType);
  const text = String(play?.playText || '').toLowerCase();
  if (/sack/.test(type) || /sacked/.test(text)) return false;
  return /pass|interception/.test(type) || /\bpass(?:es|ed)?\b|intercepted/.test(text);
}

function isSackPlay(play: any): boolean {
  const type = normalizeCategory(play?.playType);
  const text = String(play?.playText || '').toLowerCase();
  return /sack/.test(type) || /sacked/.test(text);
}

function isRushLike(play: any): boolean {
  const type = normalizeCategory(play?.playType);
  const text = String(play?.playText || '').toLowerCase();
  if (/kick|punt|return|sack|pass|interception/.test(type)) return false;
  if (/kneel/.test(type) || /kneels?/.test(text)) return false;
  return /rush|run/.test(type) || /\b(?:rush|run|scramble)s?\b/.test(text);
}

function playSucceeded(play: any): boolean {
  const yards = n(play?.yardsGained, 0);
  const distance = Math.max(0, n(play?.distance, 0));
  const yardsToGoal = Math.max(0, n(play?.yardsToGoal, 0));
  const text = `${play?.playType || ''} ${play?.playText || ''}`.toLowerCase();
  if (/touchdown/.test(text) || (yardsToGoal > 0 && yards >= yardsToGoal)) return true;
  const down = n(play?.down, 0);
  if (down <= 1) return distance <= 0 ? yards > 0 : yards >= distance * 0.5;
  if (down === 2) return distance <= 0 ? yards > 0 : yards >= distance * 0.7;
  if (down === 3 || down === 4) return distance <= 0 ? yards > 0 : yards >= distance;
  return false;
}

function situationalByGameTeam(drives: any[], plays: any[]): Map<string, SituationalGameMetrics> {
  const buckets = new Map<string, any>();
  const ensure = (gameId: any, offense: any) => {
    const key = `${String(gameId)}|${teamKey(offense)}`;
    if (!buckets.has(key)) buckets.set(key, {
      metrics: emptySituational(), drives: [], redZoneDriveIds: new Set<string>(), goalToGoDriveIds: new Set<string>(),
    });
    return buckets.get(key);
  };

  for (const play of plays || []) {
    const offenseKey = teamKey(play?.offense);
    if (!offenseKey || play?.gameId == null) continue;
    const bucket = ensure(play.gameId, play.offense);
    const m: SituationalGameMetrics = bucket.metrics;
    m.playCoverage = true;
    const driveId = String(play?.driveId || '');
    const pass = isPassLike(play);
    const sack = isSackPlay(play);
    const rush = isRushLike(play);
    const scrimmage = pass || sack || rush;
    const yardsGained = n(play?.yardsGained, 0);
    const down = n(play?.down, 0);
    const yardsToGoal = n(play?.yardsToGoal, 0);
    const distance = n(play?.distance, 0);
    const ppa = play?.ppa == null || play?.ppa === '' ? NaN : Number(play.ppa);

    if (scrimmage) {
      m.scrimmagePlays += 1;
      if (playSucceeded(play)) m.successfulScrimmagePlays += 1;
      if (Number.isFinite(ppa)) {
        m.scrimmagePpaSum += ppa;
        m.scrimmagePpaPlays += 1;
      }
    }

    if (pass) {
      m.passAttempts += 1;
      if (yardsGained >= 20) m.explosivePasses += 1;
    }
    if (pass || sack) {
      m.passLikePlays += 1;
      if (playSucceeded(play)) m.successfulPassPlays += 1;
      if (Number.isFinite(ppa)) {
        m.passPpaSum += ppa;
        m.passPpaPlays += 1;
      }
    }
    if (rush) {
      m.rushAttempts += 1;
      if (playSucceeded(play)) m.successfulRushAttempts += 1;
      if (Number.isFinite(ppa)) {
        m.rushPpaSum += ppa;
        m.rushPpaPlays += 1;
      }
      if ((down === 3 || down === 4) && distance > 0 && distance <= 2) {
        m.shortYardageRushAttempts += 1;
        if (yardsGained >= distance || /touchdown/.test(String(play?.playText || '').toLowerCase())) {
          m.shortYardageRushConversions += 1;
        }
      }
      if (yardsGained >= 10) m.explosiveRushes += 1;
    }
    if (scrimmage && (down === 1 || down === 2)) {
      m.earlyDownScrimmagePlays += 1;
      if (pass || sack) m.earlyDownPassPlays += 1;
    }
    if (scrimmage && down === 3 && Number.isFinite(ppa)) {
      m.thirdDownPpaSum += ppa;
      m.thirdDownPpaPlays += 1;
    }
    if (scrimmage && down === 4) m.fourthDownAttempts += 1;
    if (driveId && yardsToGoal > 0 && yardsToGoal <= 20) bucket.redZoneDriveIds.add(driveId);
    const goalToGo = scrimmage && yardsToGoal > 0 && yardsToGoal <= 10 && distance >= yardsToGoal;
    if (goalToGo) {
      if (driveId) bucket.goalToGoDriveIds.add(driveId);
      m.goalToGoPlays += 1;
      if (playSucceeded(play)) m.goalToGoSuccesses += 1;
    }
    const period = n(play?.period, 0);
    const remaining = clockSeconds(play?.clock);
    if (scrimmage && (period === 2 || period === 4) && remaining <= 120 && Number.isFinite(ppa)) {
      m.twoMinutePpaSum += ppa;
      m.twoMinutePpaPlays += 1;
    }
  }

  for (const drive of drives || []) {
    const offenseKey = teamKey(drive?.offense);
    if (!offenseKey || drive?.gameId == null) continue;
    const bucket = ensure(drive.gameId, drive.offense);
    bucket.metrics.driveCoverage = true;
    bucket.drives.push(drive);
  }

  const out = new Map<string, SituationalGameMetrics>();
  for (const [key, bucket] of buckets.entries()) {
    const m: SituationalGameMetrics = bucket.metrics;
    const drivesSorted = [...bucket.drives].sort((a: any, b: any) => n(a?.driveNumber, 999) - n(b?.driveNumber, 999));
    const validDrives = drivesSorted.filter((drive: any) => {
      const result = String(drive?.driveResult || '').toLowerCase();
      return n(drive?.plays, 0) > 0 && !/end of half|end of game/.test(result);
    });
    m.drives = validDrives.length;
    for (const drive of validDrives) {
      const delta = Math.max(0, n(drive?.endOffenseScore, 0) - n(drive?.startOffenseScore, 0));
      const result = String(drive?.driveResult || '').toLowerCase();
      const scored = delta > 0 || drive?.scoring === true;
      const td = delta >= 6 || /touchdown|\btd\b/.test(result);
      if (scored) m.scoringDrives += 1;
      if (td) m.touchdownDrives += 1;
      m.offensiveDrivePoints += delta;
      m.driveElapsedSeconds += clockSeconds(drive?.elapsed);
      m.drivePlays += Math.max(0, n(drive?.plays, 0));
      const driveId = String(drive?.id || '');
      if (bucket.redZoneDriveIds.has(driveId)) {
        m.redZoneTrips += 1;
        if (scored) m.redZoneScores += 1;
        if (td) m.redZoneTouchdowns += 1;
      }
      if (bucket.goalToGoDriveIds.has(driveId)) {
        m.goalToGoTrips += 1;
        if (td) m.goalToGoTouchdowns += 1;
      }
    }
    const opening = validDrives[0];
    if (opening) {
      const delta = Math.max(0, n(opening?.endOffenseScore, 0) - n(opening?.startOffenseScore, 0));
      const result = String(opening?.driveResult || '').toLowerCase();
      m.openingDriveScore = delta > 0 || opening?.scoring === true ? 1 : 0;
      m.openingDriveTouchdown = delta >= 6 || /touchdown|\btd\b/.test(result) ? 1 : 0;
    }
    out.set(key, m);
  }
  return out;
}

function passingGameByTeam(rows: any[]): Map<string, PassingGameMetrics> {
  const out = new Map<string, PassingGameMetrics>();
  for (const row of rows || []) {
    const key = `${String(row?.gameId)}|${teamKey(row?.team)}`;
    if (!row?.gameId || !teamKey(row?.team)) continue;
    const off = row?.offense || {};
    out.set(key, {
      airYardsAttempts: Math.max(0, n(off?.airYardsAttemptsAvailable, 0)),
      totalAirYards: n(off?.totalAirYards, 0),
      totalPpa: n(off?.totalPpa, 0),
      ppaAttempts: Math.max(0, n(off?.ppaAttemptsAvailable, 0)),
    });
  }
  return out;
}

function emptySpecialTeamsGame(): SpecialTeamsGameMetrics {
  return {
    playCoverage: false,
    fieldGoalAttempts: 0,
    fieldGoalsMade: 0,
    fieldGoalAttempts40Plus: 0,
    fieldGoalsMade40Plus: 0,
    fieldGoalAttempts50Plus: 0,
    fieldGoalsMade50Plus: 0,
    longestFieldGoalMade: 0,
    extraPointAttempts: 0,
    extraPointsMade: 0,
    punts: 0,
    grossPuntYards: 0,
    puntReturnYardsAllowed: 0,
    puntTouchbacks: 0,
    puntsInside20: 0,
    kickoffs: 0,
    kickoffTouchbacks: 0,
    ppaSum: 0,
    ppaPlays: 0,
  };
}

function fieldGoalDistance(play: any): number | null {
  const text = String(play?.playText || '');
  const direct =
    text.match(/(\d{1,2})\s*(?:yd|yard)s?\s+field\s+goal/i) ||
    text.match(/field\s+goal[^0-9]{0,30}(\d{1,2})\s*(?:yd|yard)s?/i);
  if (direct) {
    const value = n(direct[1], 0);
    return value >= 10 && value <= 75 ? value : null;
  }
  const ytg = n(play?.yardsToGoal, 0);
  const fallback = ytg > 0 ? ytg + 17 : 0;
  return fallback >= 10 && fallback <= 75 ? fallback : null;
}

function puntDistance(play: any): number | null {
  const text = String(play?.playText || '');
  const direct =
    text.match(/\bpunts?\s+(?:the\s+ball\s+)?(\d{1,2})\s+yards?\b/i) ||
    text.match(/\bpunt(?:ed)?[^0-9]{0,24}(\d{1,2})\s+yards?\b/i);
  if (direct) {
    const value = n(direct[1], 0);
    return value > 0 && value <= 90 ? value : null;
  }
  const gained = Math.abs(n(play?.yardsGained, 0));
  return gained > 0 && gained <= 90 ? gained : null;
}

function puntReturnDistance(play: any): number {
  const text = String(play?.playText || '');
  const patterns = [
    /returned[^.]*?\bfor\s+(-?\d{1,2})\s+yards?\b/i,
    /return(?:ed)?[^.]*?\bfor\s+(-?\d{1,2})\s+yards?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Math.max(0, n(match[1], 0));
  }
  return 0;
}

function specialTeamsByGameTeam(plays: any[]): Map<string, SpecialTeamsGameMetrics> {
  const out = new Map<string, SpecialTeamsGameMetrics>();
  const ensure = (gameId: any, team: any) => {
    const key = `${String(gameId)}|${teamKey(team)}`;
    if (!out.has(key)) out.set(key, emptySpecialTeamsGame());
    return out.get(key)!;
  };

  for (const play of plays || []) {
    if (play?.gameId == null || !teamKey(play?.offense)) continue;
    const typeRaw = String(play?.playType || '').toLowerCase();
    const text = String(play?.playText || '').toLowerCase();
    const normalized = normalizeCategory(play?.playType);
    const m = ensure(play.gameId, play.offense);

    const isFieldGoal = /fieldgoal/.test(normalized) || /\bfield goal\b/.test(text);
    const isExtraPoint = /extrapoint|blockedpat/.test(normalized) || /\bextra point\b|\bpat\b/.test(text);
    const isPunt = /punt/.test(normalized) && !/penalty/.test(normalized);
    const isKickoff = /kickoff/.test(normalized) && !/penalty/.test(normalized);

    if (!(isFieldGoal || isExtraPoint || isPunt || isKickoff)) continue;
    m.playCoverage = true;

    const ppa = Number(play?.ppa);
    if (Number.isFinite(ppa)) {
      m.ppaSum += ppa;
      m.ppaPlays += 1;
    }

    if (isFieldGoal) {
      m.fieldGoalAttempts += 1;
      const made = /fieldgoalgood/.test(normalized) ||
        (play?.scoring === true && !/miss|block/.test(`${typeRaw} ${text}`));
      const distance = fieldGoalDistance(play);
      if (distance != null) {
        if (distance >= 40) m.fieldGoalAttempts40Plus += 1;
        if (distance >= 50) m.fieldGoalAttempts50Plus += 1;
      }
      if (made) {
        m.fieldGoalsMade += 1;
        if (distance != null) {
          if (distance >= 40) m.fieldGoalsMade40Plus += 1;
          if (distance >= 50) m.fieldGoalsMade50Plus += 1;
          m.longestFieldGoalMade = Math.max(m.longestFieldGoalMade, distance);
        }
      }
      continue;
    }

    if (isExtraPoint) {
      m.extraPointAttempts += 1;
      const outcome = `${typeRaw} ${text}`;
      const made = /(?:extrapoint|pat|pointafter)(?:good|made)/.test(normalized) ||
        ((play?.scoring === true || /\b(?:good|made)\b/.test(outcome)) && !/miss|block|no good|failed/.test(outcome));
      if (made) m.extraPointsMade += 1;
      continue;
    }

    if (isPunt) {
      m.punts += 1;
      const distance = puntDistance(play);
      const returnYards = puntReturnDistance(play);
      if (distance != null) {
        m.grossPuntYards += distance;
        m.puntReturnYardsAllowed += returnYards;
      }
      const touchback = /touchback/.test(`${typeRaw} ${text}`);
      if (touchback) m.puntTouchbacks += 1;
      if (!touchback && distance != null) {
        const ytg = n(play?.yardsToGoal, 0);
        const receivingOwnYardLine = ytg - Math.max(0, distance - returnYards);
        if (receivingOwnYardLine > 0 && receivingOwnYardLine < 20) m.puntsInside20 += 1;
      }
      continue;
    }

    if (isKickoff) {
      m.kickoffs += 1;
      if (/touchback/.test(`${typeRaw} ${text}`)) m.kickoffTouchbacks += 1;
    }
  }

  return out;
}

function computeStats(log: TeamGame[]) {
  if (!log.length) return null;
  const games = log.length;
  const own = emptyTotals();
  const opp = emptyTotals();
  let pointsFor = 0;
  let pointsAgainst = 0;
  let firstHalfPoints = 0;
  let secondHalfPoints = 0;
  let fourthQuarterPoints = 0;
  let lineScoreGames = 0;
  let driveCoverageGames = 0;
  let playCoverageGames = 0;
  let drives = 0;
  let scoringDrives = 0;
  let touchdownDrives = 0;
  let offensiveDrivePoints = 0;
  let redZoneTrips = 0;
  let redZoneScores = 0;
  let redZoneTouchdowns = 0;
  let goalToGoTrips = 0;
  let goalToGoTouchdowns = 0;
  let goalToGoPlays = 0;
  let goalToGoSuccesses = 0;
  let thirdDownPpaSum = 0;
  let thirdDownPpaPlays = 0;
  let fourthDownAttempts = 0;
  let explosivePasses = 0;
  let situationalPassAttempts = 0;
  let passPpaSum = 0;
  let passPpaPlays = 0;
  let passLikePlays = 0;
  let successfulPassPlays = 0;
  let explosiveRushes = 0;
  let situationalRushAttempts = 0;
  let rushPpaSum = 0;
  let rushPpaPlays = 0;
  let successfulRushAttempts = 0;
  let scrimmagePpaSum = 0;
  let scrimmagePpaPlays = 0;
  let scrimmagePlays = 0;
  let successfulScrimmagePlays = 0;
  let shortYardageRushAttempts = 0;
  let shortYardageRushConversions = 0;
  let earlyDownPassPlays = 0;
  let earlyDownScrimmagePlays = 0;
  let twoMinutePpaSum = 0;
  let twoMinutePpaPlays = 0;
  let driveElapsedSeconds = 0;
  let drivePlays = 0;
  let openingDriveScores = 0;
  let openingDriveTouchdowns = 0;
  let passingAirYardsAttempts = 0;
  let passingTotalAirYards = 0;
  let passingTotalPpa = 0;
  let passingPpaAttempts = 0;
  let opponentLineScoreGames = 0;
  let firstHalfPointsAllowed = 0;
  let secondHalfPointsAllowed = 0;
  let fourthQuarterPointsAllowed = 0;
  let defensiveDriveCoverageGames = 0;
  let defensivePlayCoverageGames = 0;
  let defensiveDrives = 0;
  let defensiveDrivePoints = 0;
  let defensiveRedZoneTrips = 0;
  let defensiveRedZoneScores = 0;
  let defensiveRedZoneTouchdowns = 0;
  let defensiveGoalToGoTrips = 0;
  let defensiveGoalToGoTouchdowns = 0;
  let defensiveOpeningDriveScores = 0;
  let defensiveExplosivePasses = 0;
  let defensivePassAttempts = 0;
  let defensiveExplosiveRushes = 0;
  let defensiveRushAttempts = 0;
  let defensiveSuccessfulRushAttempts = 0;
  let defensiveShortYardageRushAttempts = 0;
  let defensiveShortYardageRushConversions = 0;
  let twoMinuteDefensePpaSum = 0;
  let twoMinuteDefensePpaPlays = 0;
  let opponentPassingAirYardsAttempts = 0;
  let opponentPassingTotalAirYards = 0;
  let specialTeamsCoverageGames = 0;
  let stFieldGoalAttempts = 0;
  let stFieldGoalsMade = 0;
  let stFieldGoalAttempts40Plus = 0;
  let stFieldGoalsMade40Plus = 0;
  let stFieldGoalAttempts50Plus = 0;
  let stFieldGoalsMade50Plus = 0;
  let stLongestFieldGoalMade = 0;
  let stExtraPointAttempts = 0;
  let stExtraPointsMade = 0;
  let xpMadeFromGames = 0;
  let xpAttemptsFromGames = 0;
  let stPunts = 0;
  let stGrossPuntYards = 0;
  let stPuntReturnYardsAllowed = 0;
  let stPuntTouchbacks = 0;
  let stPuntsInside20 = 0;
  let stKickoffs = 0;
  let stKickoffTouchbacks = 0;
  let stPpaSum = 0;
  let stPpaPlays = 0;

  const add = (target: BoxTotals, source: BoxTotals) => {
    for (const key of Object.keys(target) as Array<keyof BoxTotals>) {
      if (key === 'extraPointsMadeReported' || key === 'extraPointsAttemptedReported') {
        (target as any)[key] = Boolean(target[key] || source[key]);
      } else {
        (target as any)[key] += (source as any)[key];
      }
    }
  };

  for (const game of log) {
    pointsFor += game.pointsFor;
    pointsAgainst += game.pointsAgainst;
    add(own, game.own);
    add(opp, game.opp);

    const lineScores = Array.isArray(game.lineScores) ? game.lineScores.map((value) => n(value, 0)) : [];
    if (lineScores.length >= 2) {
      lineScoreGames += 1;
      firstHalfPoints += n(lineScores[0], 0) + n(lineScores[1], 0);
      secondHalfPoints += n(lineScores[2], 0) + n(lineScores[3], 0);
      fourthQuarterPoints += n(lineScores[3], 0);
    }

    const opponentLineScores = Array.isArray(game.opponentLineScores) ? game.opponentLineScores.map((value) => n(value, 0)) : [];
    if (opponentLineScores.length >= 2) {
      opponentLineScoreGames += 1;
      firstHalfPointsAllowed += n(opponentLineScores[0], 0) + n(opponentLineScores[1], 0);
      secondHalfPointsAllowed += n(opponentLineScores[2], 0) + n(opponentLineScores[3], 0);
      fourthQuarterPointsAllowed += n(opponentLineScores[3], 0);
    }

    const sit = game.situational;
    if (sit?.driveCoverage) {
      driveCoverageGames += 1;
      drives += sit.drives;
      scoringDrives += sit.scoringDrives;
      touchdownDrives += sit.touchdownDrives;
      offensiveDrivePoints += sit.offensiveDrivePoints;
      redZoneTrips += sit.redZoneTrips;
      redZoneScores += sit.redZoneScores;
      redZoneTouchdowns += sit.redZoneTouchdowns;
      goalToGoTrips += sit.goalToGoTrips;
      goalToGoTouchdowns += sit.goalToGoTouchdowns;
      driveElapsedSeconds += sit.driveElapsedSeconds;
      drivePlays += sit.drivePlays;
      openingDriveScores += sit.openingDriveScore;
      openingDriveTouchdowns += sit.openingDriveTouchdown;
    }
    if (sit?.playCoverage) {
      playCoverageGames += 1;
      goalToGoPlays += sit.goalToGoPlays;
      goalToGoSuccesses += sit.goalToGoSuccesses;
      thirdDownPpaSum += sit.thirdDownPpaSum;
      thirdDownPpaPlays += sit.thirdDownPpaPlays;
      fourthDownAttempts += sit.fourthDownAttempts;
      explosivePasses += sit.explosivePasses;
      situationalPassAttempts += sit.passAttempts;
      passPpaSum += sit.passPpaSum;
      passPpaPlays += sit.passPpaPlays;
      passLikePlays += sit.passLikePlays;
      successfulPassPlays += sit.successfulPassPlays;
      explosiveRushes += sit.explosiveRushes;
      situationalRushAttempts += sit.rushAttempts;
      rushPpaSum += sit.rushPpaSum;
      rushPpaPlays += sit.rushPpaPlays;
      successfulRushAttempts += sit.successfulRushAttempts;
      scrimmagePpaSum += sit.scrimmagePpaSum;
      scrimmagePpaPlays += sit.scrimmagePpaPlays;
      scrimmagePlays += sit.scrimmagePlays;
      successfulScrimmagePlays += sit.successfulScrimmagePlays;
      shortYardageRushAttempts += sit.shortYardageRushAttempts;
      shortYardageRushConversions += sit.shortYardageRushConversions;
      earlyDownPassPlays += sit.earlyDownPassPlays;
      earlyDownScrimmagePlays += sit.earlyDownScrimmagePlays;
      twoMinutePpaSum += sit.twoMinutePpaSum;
      twoMinutePpaPlays += sit.twoMinutePpaPlays;
    }

    const passing = game.passing;
    if (passing) {
      passingAirYardsAttempts += passing.airYardsAttempts;
      passingTotalAirYards += passing.totalAirYards;
      passingTotalPpa += passing.totalPpa;
      passingPpaAttempts += passing.ppaAttempts;
    }

    const oppSit = game.oppSituational;
    if (oppSit?.driveCoverage) {
      defensiveDriveCoverageGames += 1;
      defensiveDrives += oppSit.drives;
      defensiveDrivePoints += oppSit.offensiveDrivePoints;
      defensiveRedZoneTrips += oppSit.redZoneTrips;
      defensiveRedZoneScores += oppSit.redZoneScores;
      defensiveRedZoneTouchdowns += oppSit.redZoneTouchdowns;
      defensiveGoalToGoTrips += oppSit.goalToGoTrips;
      defensiveGoalToGoTouchdowns += oppSit.goalToGoTouchdowns;
      defensiveOpeningDriveScores += oppSit.openingDriveScore;
    }
    if (oppSit?.playCoverage) {
      defensivePlayCoverageGames += 1;
      defensiveExplosivePasses += oppSit.explosivePasses;
      defensivePassAttempts += oppSit.passAttempts;
      defensiveExplosiveRushes += oppSit.explosiveRushes;
      defensiveRushAttempts += oppSit.rushAttempts;
      defensiveSuccessfulRushAttempts += oppSit.successfulRushAttempts;
      defensiveShortYardageRushAttempts += oppSit.shortYardageRushAttempts;
      defensiveShortYardageRushConversions += oppSit.shortYardageRushConversions;
      twoMinuteDefensePpaSum += oppSit.twoMinutePpaSum;
      twoMinuteDefensePpaPlays += oppSit.twoMinutePpaPlays;
    }

    const oppPassing = game.oppPassing;
    if (oppPassing) {
      opponentPassingAirYardsAttempts += oppPassing.airYardsAttempts;
      opponentPassingTotalAirYards += oppPassing.totalAirYards;
    }

    const st = game.specialTeams;
    const boxXpComplete = game.own.extraPointsMadeReported && game.own.extraPointsAttemptedReported;
    if (boxXpComplete) {
      xpMadeFromGames += game.own.extraPointsMade;
      xpAttemptsFromGames += game.own.extraPointsAttempted;
    } else if (st?.playCoverage) {
      // Prefer game-level box-score counts, then fall back to tagged plays when
      // a feed omits either XP box-score field.
      xpMadeFromGames += st.extraPointsMade;
      xpAttemptsFromGames += st.extraPointAttempts;
    }
    if (st?.playCoverage) {
      specialTeamsCoverageGames += 1;
      stFieldGoalAttempts += st.fieldGoalAttempts;
      stFieldGoalsMade += st.fieldGoalsMade;
      stFieldGoalAttempts40Plus += st.fieldGoalAttempts40Plus;
      stFieldGoalsMade40Plus += st.fieldGoalsMade40Plus;
      stFieldGoalAttempts50Plus += st.fieldGoalAttempts50Plus;
      stFieldGoalsMade50Plus += st.fieldGoalsMade50Plus;
      stLongestFieldGoalMade = Math.max(stLongestFieldGoalMade, st.longestFieldGoalMade);
      stExtraPointAttempts += st.extraPointAttempts;
      stExtraPointsMade += st.extraPointsMade;
      stPunts += st.punts;
      stGrossPuntYards += st.grossPuntYards;
      stPuntReturnYardsAllowed += st.puntReturnYardsAllowed;
      stPuntTouchbacks += st.puntTouchbacks;
      stPuntsInside20 += st.puntsInside20;
      stKickoffs += st.kickoffs;
      stKickoffTouchbacks += st.kickoffTouchbacks;
      stPpaSum += st.ppaSum;
      stPpaPlays += st.ppaPlays;
    }
  }

  const pct = (made: number, attempts: number) => attempts ? round((made / attempts) * 100, 1) : null;
  const perGame = (value: number) => round(value / games, 1);
  const ncaaPasserRating = own.passAtt
    ? round((8.4 * own.netPassingYards + 330 * own.passingTouchdowns + 100 * own.comp - 200 * own.interceptions) / own.passAtt, 1)
    : null;
  const pressureEventsAllowed = own.sacks + opp.qbHurries;
  const pressureRateAllowed = pct(pressureEventsAllowed, own.passAtt + own.sacks);
  const defensivePressureEvents = opp.sacks + own.qbHurries;
  const defensivePressureRate = own.qbHurries > 0
    ? pct(defensivePressureEvents, opp.passAtt + opp.sacks)
    : null;

  const offense: any = {
    pointsPerGame: perGame(pointsFor),
    yardsPerGame: perGame(own.totalYards),
    passingYards: perGame(own.netPassingYards),
    passingYardsPerGame: perGame(own.netPassingYards),
    rushingYards: perGame(own.rushingYards),
    rushingYardsPerGame: perGame(own.rushingYards),
    turnovers: perGame(own.turnovers),
    turnoverRate: pct(own.turnovers, own.passAtt + own.rushingAttempts),
    firstDownsPerGame: perGame(own.firstDowns),
    firstDownRate: pct(own.firstDowns, own.passAtt + own.rushingAttempts),
    thirdDownPct: pct(own.thirdConv, own.thirdAtt),
    thirdDownConversionPct: pct(own.thirdConv, own.thirdAtt),
    fourthDownPct: pct(own.fourthConv, own.fourthAtt),
    fourthDownConversionPct: pct(own.fourthConv, own.fourthAtt),
    completionPct: pct(own.comp, own.passAtt),
    completionPercentage: pct(own.comp, own.passAtt),
    yardsPerPass: round(safeDiv(own.netPassingYards, own.passAtt), 2),
    yardsPerAttempt: round(safeDiv(own.netPassingYards, own.passAtt), 2),
    passYardsPerAttempt: round(safeDiv(own.netPassingYards, own.passAtt), 2),
    ypa: round(safeDiv(own.netPassingYards, own.passAtt), 2),
    netYardsPerAttempt: round(safeDiv(own.netPassingYards - own.sackYards, own.passAtt + own.sacks), 2),
    yardsPerRush: round(safeDiv(own.rushingYards, own.rushingAttempts), 2),
    yardsPerCarry: round(safeDiv(own.rushingYards, own.rushingAttempts), 2),
    rushYardsPerAttempt: round(safeDiv(own.rushingYards, own.rushingAttempts), 2),
    ypc: round(safeDiv(own.rushingYards, own.rushingAttempts), 2),
    passAttemptsPerGame: perGame(own.passAtt),
    passingAttemptsPerGame: perGame(own.passAtt),
    completionsPerGame: perGame(own.comp),
    passingTouchdownsPerGame: perGame(own.passingTouchdowns),
    passingTDsPerGame: perGame(own.passingTouchdowns),
    passingTouchdowns: perGame(own.passingTouchdowns),
    interceptionRate: pct(own.interceptions, own.passAtt),
    intRate: pct(own.interceptions, own.passAtt),
    rushAttemptsPerGame: perGame(own.rushingAttempts),
    rushingAttemptsPerGame: perGame(own.rushingAttempts),
    rushingTouchdownsPerGame: perGame(own.rushingTouchdowns),
    rushTDsPerGame: perGame(own.rushingTouchdowns),
    rushingTouchdowns: perGame(own.rushingTouchdowns),
    playsPerGame: perGame(own.passAtt + own.rushingAttempts),
    yardsPerPlay: round(safeDiv(own.totalYards, own.passAtt + own.rushingAttempts), 2),
    penaltiesPerGame: perGame(own.pens),
    penaltyYardsPerGame: perGame(own.penYards),
    possessionMinutesPerGame: round(own.possessionSeconds / games / 60, 1),
    possessionTime: round(own.possessionSeconds / games / 60, 1),
    timeOfPossession: round(own.possessionSeconds / games / 60, 1),
    sacksAllowedPerGame: perGame(own.sacks),
    sackRateAllowed: pct(own.sacks, own.passAtt + own.sacks),
    qbRating: ncaaPasserRating,
    passerRating: ncaaPasserRating,
    pressureRateAllowed,
    pressurePctAllowed: pressureRateAllowed,
    pressurePct: pressureRateAllowed,
    qbHurriesAllowedPerGame: perGame(opp.qbHurries),
    pressureAvoidancePct: pressureRateAllowed == null ? null : round(100 - pressureRateAllowed, 1),
  };

  // Only expose situational metrics when the underlying drive/play feed had coverage.
  // This prevents missing source data from becoming fake zeroes and fake #1 ranks.
  if (driveCoverageGames > 0) {
    offense.driveSuccessRate = pct(scoringDrives, drives);
    offense.pointsPerDrive = drives ? round(offensiveDrivePoints / drives, 2) : null;
    offense.tdsPerDrive = drives ? round(touchdownDrives / drives, 2) : null;
    offense.touchdownsPerDrive = offense.tdsPerDrive;
    offense.redZoneAttempts = redZoneTrips;
    offense.redZoneAttemptsPerGame = round(redZoneTrips / driveCoverageGames, 1);
    offense.redZoneTripsPerGame = round(redZoneTrips / driveCoverageGames, 1);
    offense.redZoneEfficiency = pct(redZoneScores, redZoneTrips);
    offense.redZoneScorePct = pct(redZoneScores, redZoneTrips);
    offense.redZoneTdPct = pct(redZoneTouchdowns, redZoneTrips);
    offense.redZoneTouchdownPct = pct(redZoneTouchdowns, redZoneTrips);
    offense.goalToGoTdPct = pct(goalToGoTouchdowns, goalToGoTrips);
    offense.goalToGoTouchdownPct = offense.goalToGoTdPct;
    offense.openingDriveScorePct = pct(openingDriveScores, driveCoverageGames);
    offense.openingDriveTdPct = pct(openingDriveTouchdowns, driveCoverageGames);
    offense.secondsPerPlay = drivePlays ? round(driveElapsedSeconds / drivePlays, 1) : null;
  }
  if (playCoverageGames > 0) {
    offense.epaPerPlay = scrimmagePpaPlays ? round(scrimmagePpaSum / scrimmagePpaPlays, 3) : null;
    offense.offensiveEpaPerPlay = offense.epaPerPlay;
    offense.successRate = pct(successfulScrimmagePlays, scrimmagePlays);
    offense.offensiveSuccessRate = offense.successRate;
    offense.passEpaPerPlay = passPpaPlays ? round(passPpaSum / passPpaPlays, 3) : null;
    offense.passingEpaPerPlay = offense.passEpaPerPlay;
    offense.passSuccessRate = pct(successfulPassPlays, passLikePlays);
    offense.passingSuccessRate = offense.passSuccessRate;
    offense.rushEpaPerPlay = rushPpaPlays ? round(rushPpaSum / rushPpaPlays, 3) : null;
    offense.rushingEpaPerPlay = offense.rushEpaPerPlay;
    offense.rushSuccessRate = pct(successfulRushAttempts, situationalRushAttempts);
    offense.rushingSuccessRate = offense.rushSuccessRate;
    offense.goalToGoSuccessRate = pct(goalToGoSuccesses, goalToGoPlays);
    offense.thirdDownEpa = thirdDownPpaPlays ? round(thirdDownPpaSum / thirdDownPpaPlays, 3) : null;
    offense.thirdDownEpaPerPlay = offense.thirdDownEpa;
    offense.thirdDownPpa = offense.thirdDownEpa;
    offense.fourthDownAttemptsPerGame = round(fourthDownAttempts / playCoverageGames, 1);
    offense.explosivePassRate = pct(explosivePasses, situationalPassAttempts);
    offense.explosivePassPct = offense.explosivePassRate;
    offense.explosiveRunRate = pct(explosiveRushes, situationalRushAttempts);
    offense.explosiveRushRate = offense.explosiveRunRate;
    offense.runSuccessRate = pct(successfulRushAttempts, situationalRushAttempts);
    offense.rushSuccessRate = offense.runSuccessRate;
    offense.shortYardageSuccess = pct(shortYardageRushConversions, shortYardageRushAttempts);
    offense.shortYardageSuccessRate = offense.shortYardageSuccess;
    offense.earlyDownPassRate = pct(earlyDownPassPlays, earlyDownScrimmagePlays);
    offense.twoMinuteOffensePpa = twoMinutePpaPlays ? round(twoMinutePpaSum / twoMinutePpaPlays, 3) : null;
    offense.twoMinuteOffenseEpa = offense.twoMinuteOffensePpa;
  }
  if (lineScoreGames > 0) {
    offense.firstHalfPoints = round(firstHalfPoints / lineScoreGames, 1);
    offense.secondHalfPoints = round(secondHalfPoints / lineScoreGames, 1);
    offense.fourthQuarterPoints = round(fourthQuarterPoints / lineScoreGames, 1);
  }
  if (passingAirYardsAttempts > 0) {
    offense.averageDepthOfTarget = round(passingTotalAirYards / passingAirYardsAttempts, 1);
    offense.aDOT = offense.averageDepthOfTarget;
    offense.adot = offense.averageDepthOfTarget;
  }
  if (passingPpaAttempts > 0) {
    offense.passPpaTotal = round(passingTotalPpa, 2);
    offense.totalPassPpa = offense.passPpaTotal;
    offense.expectedPointsGenerated = offense.passPpaTotal;
  }

  const defense: any = {
    pointsAllowedPerGame: perGame(pointsAgainst),
    yardsAllowedPerGame: perGame(opp.totalYards),
    playsFacedPerGame: perGame(opp.passAtt + opp.rushingAttempts),
    yardsPerPlayAllowed: round(safeDiv(opp.totalYards, opp.passAtt + opp.rushingAttempts), 2),
    passingYardsAllowed: perGame(opp.netPassingYards),
    passingYardsAllowedPerGame: perGame(opp.netPassingYards),
    rushingYardsAllowed: perGame(opp.rushingYards),
    rushingYardsAllowedPerGame: perGame(opp.rushingYards),
    turnoversForced: perGame(opp.turnovers),
    takeawayRate: pct(opp.turnovers, opp.passAtt + opp.rushingAttempts),
    interceptions: perGame(opp.interceptions),
    forcedInterceptionsPerGame: perGame(opp.interceptions),
    fumblesForced: perGame(own.forcedFumbles || opp.fumblesLost),
    forcedFumbles: perGame(own.forcedFumbles || opp.fumblesLost),
    forcedFumblesPerGame: perGame(own.forcedFumbles || opp.fumblesLost),
    tacklesForLoss: perGame(own.tacklesForLoss),
    tfl: perGame(own.tacklesForLoss),
    qbHurriesPerGame: perGame(own.qbHurries),
    passesDeflectedPerGame: perGame(own.passesDeflected),
    firstDownsAllowedPerGame: perGame(opp.firstDowns),
    thirdDownPctAllowed: pct(opp.thirdConv, opp.thirdAtt),
    thirdDownConversionPctAllowed: pct(opp.thirdConv, opp.thirdAtt),
    fourthDownPctAllowed: pct(opp.fourthConv, opp.fourthAtt),
    fourthDownConversionPctAllowed: pct(opp.fourthConv, opp.fourthAtt),
    completionPctAllowed: pct(opp.comp, opp.passAtt),
    completionPercentageAllowed: pct(opp.comp, opp.passAtt),
    passingTouchdownsAllowed: perGame(opp.passingTouchdowns),
    passingTDsAllowed: perGame(opp.passingTouchdowns),
    passingTouchdownsAllowedPerGame: perGame(opp.passingTouchdowns),
    yardsPerPassAllowed: round(safeDiv(opp.netPassingYards, opp.passAtt), 2),
    yardsPerAttemptAllowed: round(safeDiv(opp.netPassingYards, opp.passAtt), 2),
    passYardsPerAttemptAllowed: round(safeDiv(opp.netPassingYards, opp.passAtt), 2),
    ypaAllowed: round(safeDiv(opp.netPassingYards, opp.passAtt), 2),
    yardsPerRushAllowed: round(safeDiv(opp.rushingYards, opp.rushingAttempts), 2),
    yardsPerCarryAllowed: round(safeDiv(opp.rushingYards, opp.rushingAttempts), 2),
    rushYardsPerAttemptAllowed: round(safeDiv(opp.rushingYards, opp.rushingAttempts), 2),
    ypcAllowed: round(safeDiv(opp.rushingYards, opp.rushingAttempts), 2),
    rushAttemptsFaced: perGame(opp.rushingAttempts),
    rushingAttemptsFaced: perGame(opp.rushingAttempts),
    sacksPerGame: perGame(opp.sacks),
    sackRate: pct(opp.sacks, opp.passAtt + opp.sacks),
    pressureRate: defensivePressureRate,
    defensivePressureRate,
    tackleForLossPct: pct(own.tacklesForLoss, opp.passAtt + opp.rushingAttempts),
    tflPct: pct(own.tacklesForLoss, opp.passAtt + opp.rushingAttempts),
    penaltiesPerGame: perGame(own.pens),
    penaltyYardsPerGame: perGame(own.penYards),
  };

  if (defensiveDriveCoverageGames > 0) {
    defense.pointsAllowedPerDrive = defensiveDrives ? round(defensiveDrivePoints / defensiveDrives, 2) : null;
    defense.redZoneEfficiencyAllowed = pct(defensiveRedZoneScores, defensiveRedZoneTrips);
    defense.redZoneScorePctAllowed = defense.redZoneEfficiencyAllowed;
    defense.redZoneTdPctAllowed = pct(defensiveRedZoneTouchdowns, defensiveRedZoneTrips);
    defense.redZoneTouchdownPctAllowed = defense.redZoneTdPctAllowed;
    defense.goalToGoTdPctAllowed = pct(defensiveGoalToGoTouchdowns, defensiveGoalToGoTrips);
    defense.goalToGoTouchdownPctAllowed = defense.goalToGoTdPctAllowed;
    defense.openingDriveScorePctAllowed = pct(defensiveOpeningDriveScores, defensiveDriveCoverageGames);
    defense.openingDriveScoringPctAllowed = defense.openingDriveScorePctAllowed;
  }
  if (defensivePlayCoverageGames > 0) {
    const opponentScrimmagePpaSum = log.reduce((sum, game) => sum + (game.oppSituational?.scrimmagePpaSum || 0), 0);
    const opponentScrimmagePpaPlays = log.reduce((sum, game) => sum + (game.oppSituational?.scrimmagePpaPlays || 0), 0);
    const opponentSuccessfulScrimmagePlays = log.reduce((sum, game) => sum + (game.oppSituational?.successfulScrimmagePlays || 0), 0);
    const opponentPassPpaSum = log.reduce((sum, game) => sum + (game.oppSituational?.passPpaSum || 0), 0);
    const opponentPassPpaPlays = log.reduce((sum, game) => sum + (game.oppSituational?.passPpaPlays || 0), 0);
    const opponentSuccessfulPassPlays = log.reduce((sum, game) => sum + (game.oppSituational?.successfulPassPlays || 0), 0);
    const opponentRushPpaSum = log.reduce((sum, game) => sum + (game.oppSituational?.rushPpaSum || 0), 0);
    const opponentRushPpaPlays = log.reduce((sum, game) => sum + (game.oppSituational?.rushPpaPlays || 0), 0);
    const opponentSuccessfulRushPlays = log.reduce((sum, game) => sum + (game.oppSituational?.successfulRushAttempts || 0), 0);
    defense.defensiveEpaPerPlay = opponentScrimmagePpaPlays ? round(opponentScrimmagePpaSum / opponentScrimmagePpaPlays, 3) : null;
    defense.epaAllowedPerPlay = defense.defensiveEpaPerPlay;
    const opponentScrimmagePlays = log.reduce((sum, game) => sum + (game.oppSituational?.scrimmagePlays || 0), 0);
    const opponentPassLikePlays = log.reduce((sum, game) => sum + (game.oppSituational?.passLikePlays || 0), 0);
    defense.defensiveSuccessRate = pct(opponentSuccessfulScrimmagePlays, opponentScrimmagePlays);
    defense.successRateAllowed = defense.defensiveSuccessRate;
    defense.passEpaAllowedPerPlay = opponentPassPpaPlays ? round(opponentPassPpaSum / opponentPassPpaPlays, 3) : null;
    defense.passEpaAllowed = defense.passEpaAllowedPerPlay;
    defense.passSuccessRateAllowed = pct(opponentSuccessfulPassPlays, opponentPassLikePlays);
    defense.rushEpaAllowedPerPlay = opponentRushPpaPlays ? round(opponentRushPpaSum / opponentRushPpaPlays, 3) : null;
    defense.rushEpaAllowed = defense.rushEpaAllowedPerPlay;
    defense.rushSuccessRateAllowed = pct(opponentSuccessfulRushPlays, defensiveRushAttempts);
    defense.explosivePassRateAllowed = pct(defensiveExplosivePasses, defensivePassAttempts);
    defense.explosivePassPctAllowed = defense.explosivePassRateAllowed;
    defense.explosiveRunRateAllowed = pct(defensiveExplosiveRushes, defensiveRushAttempts);
    defense.explosiveRushRateAllowed = defense.explosiveRunRateAllowed;
    defense.runStopRate = pct(defensiveRushAttempts - defensiveSuccessfulRushAttempts, defensiveRushAttempts);
    defense.shortYardageStopPct = pct(
      defensiveShortYardageRushAttempts - defensiveShortYardageRushConversions,
      defensiveShortYardageRushAttempts,
    );
    defense.shortYardageDefense = defense.shortYardageStopPct;
    defense.twoMinuteDefensePpa = twoMinuteDefensePpaPlays ? round(twoMinuteDefensePpaSum / twoMinuteDefensePpaPlays, 3) : null;
    defense.twoMinuteDefenseEpa = defense.twoMinuteDefensePpa;
    defense.twoMinuteEpaAllowed = defense.twoMinuteDefensePpa;
  }
  if (opponentLineScoreGames > 0) {
    defense.firstHalfPointsAllowed = round(firstHalfPointsAllowed / opponentLineScoreGames, 1);
    defense.firstHalfPointsAllowedPerGame = defense.firstHalfPointsAllowed;
    defense.secondHalfPointsAllowed = round(secondHalfPointsAllowed / opponentLineScoreGames, 1);
    defense.secondHalfPointsAllowedPerGame = defense.secondHalfPointsAllowed;
    defense.fourthQuarterPointsAllowed = round(fourthQuarterPointsAllowed / opponentLineScoreGames, 1);
    defense.fourthQuarterPointsAllowedPerGame = defense.fourthQuarterPointsAllowed;
  }
  if (opponentPassingAirYardsAttempts > 0) {
    defense.averageDepthOfTargetAllowed = round(opponentPassingTotalAirYards / opponentPassingAirYardsAttempts, 1);
    defense.aDOTAllowed = defense.averageDepthOfTargetAllowed;
    defense.adotAllowed = defense.averageDepthOfTargetAllowed;
    defense.airYardsAllowedPerGame = round(opponentPassingTotalAirYards / games, 1);
  }

  const special_teams: any = {
    fieldGoalPct: pct(own.fieldGoalsMade, own.fieldGoalsAttempted),
    extraPointPct: pct(own.extraPointsMade, own.extraPointsAttempted),
    fieldGoalsMadePerGame: perGame(own.fieldGoalsMade),
    fieldGoalsMadeFieldGoalsAttempted: own.fieldGoalsAttempted ? `${own.fieldGoalsMade}-${own.fieldGoalsAttempted}` : null,
    fieldGoals: own.fieldGoalsAttempted ? `${own.fieldGoalsMade}-${own.fieldGoalsAttempted}` : null,
    extraPointsMadeExtraPointsAttempted: own.extraPointsAttempted ? `${own.extraPointsMade}-${own.extraPointsAttempted}` : null,
    extraPoints: own.extraPointsAttempted ? `${own.extraPointsMade}-${own.extraPointsAttempted}` : null,
    kickingPointsPerGame: perGame(own.fieldGoalsMade * 3 + own.extraPointsMade),
    punts: own.punts ? perGame(own.punts) : null,
    puntYards: own.punts ? perGame(own.puntYards) : null,
    grossAvgPuntYards: own.punts ? round(safeDiv(own.puntYards, own.punts), 1) : null,
    netAvgPuntYards: own.punts ? round(safeDiv(own.netPuntYards || (own.puntYards - opp.puntReturnYards), own.punts), 1) : null,
    inside20Pct: own.punts ? pct(own.puntsInside20, own.punts) : null,
    puntInside20Pct: own.punts ? pct(own.puntsInside20, own.punts) : null,
    puntTouchbackPct: own.punts ? pct(own.puntTouchbacks, own.punts) : null,
    touchbackPct: own.punts ? pct(own.puntTouchbacks, own.punts) : null,
    kickoffTouchbackPct: own.kickoffs ? pct(own.kickoffTouchbacks, own.kickoffs) : null,
    kickReturns: own.kickReturns ? perGame(own.kickReturns) : null,
    kickReturnYards: own.kickReturns ? perGame(own.kickReturnYards) : null,
    kickReturnAverage: own.kickReturns ? round(safeDiv(own.kickReturnYards, own.kickReturns), 1) : null,
    kickReturnTouchdowns: own.kickReturns ? perGame(own.kickReturnTouchdowns) : null,
    puntReturns: own.puntReturns ? perGame(own.puntReturns) : null,
    puntReturnYards: own.puntReturns ? perGame(own.puntReturnYards) : null,
    puntReturnAverage: own.puntReturns ? round(safeDiv(own.puntReturnYards, own.puntReturns), 1) : null,
    puntReturnTouchdowns: own.puntReturns ? perGame(own.puntReturnTouchdowns) : null,
    puntReturnYardsAllowed: perGame(opp.puntReturnYards),
    returnYardsAllowed: perGame(opp.puntReturnYards + opp.kickReturnYards),
  };

  if (specialTeamsCoverageGames > 0) {
    special_teams.fieldGoalPct = pct(stFieldGoalsMade, stFieldGoalAttempts);
    special_teams.fieldGoalsMadePerGame = round(stFieldGoalsMade / specialTeamsCoverageGames, 1);
    special_teams.fieldGoalsMadeFieldGoalsAttempted = `${stFieldGoalsMade}-${stFieldGoalAttempts}`;
    special_teams.fieldGoals = special_teams.fieldGoalsMadeFieldGoalsAttempted;
    special_teams.fieldGoalsMade40Plus = stFieldGoalsMade40Plus;
    special_teams.fgMade40Plus = stFieldGoalsMade40Plus;
    special_teams.fieldGoalsMade50Plus = stFieldGoalsMade50Plus;
    special_teams.fgMade50Plus = stFieldGoalsMade50Plus;
    special_teams.fieldGoalPct40Plus = pct(stFieldGoalsMade40Plus, stFieldGoalAttempts40Plus);
    special_teams.fgPct40Plus = special_teams.fieldGoalPct40Plus;
    special_teams.fieldGoalPct50Plus = pct(stFieldGoalsMade50Plus, stFieldGoalAttempts50Plus);
    special_teams.fgPct50Plus = special_teams.fieldGoalPct50Plus;
    special_teams.longFieldGoalMade = stLongestFieldGoalMade > 0 ? stLongestFieldGoalMade : null;
    special_teams.longestFieldGoal = special_teams.longFieldGoalMade;
    special_teams.extraPointPct = pct(xpMadeFromGames, xpAttemptsFromGames);
    special_teams.extraPointsMadeExtraPointsAttempted = `${xpMadeFromGames}-${xpAttemptsFromGames}`;
    special_teams.extraPoints = special_teams.extraPointsMadeExtraPointsAttempted;
    special_teams.kickingPointsPerGame = round((stFieldGoalsMade * 3 + stExtraPointsMade) / specialTeamsCoverageGames, 1);

    special_teams.punts = round(stPunts / specialTeamsCoverageGames, 1);
    special_teams.puntYards = round(stGrossPuntYards / specialTeamsCoverageGames, 1);
    special_teams.grossAvgPuntYards = stPunts ? round(stGrossPuntYards / stPunts, 1) : null;
    special_teams.netAvgPuntYards = stPunts
      ? round((stGrossPuntYards - stPuntReturnYardsAllowed - stPuntTouchbacks * 20) / stPunts, 1)
      : null;
    special_teams.inside20Pct = pct(stPuntsInside20, stPunts);
    special_teams.puntInside20Pct = special_teams.inside20Pct;
    special_teams.puntTouchbackPct = pct(stPuntTouchbacks, stPunts);
    special_teams.touchbackPct = special_teams.puntTouchbackPct;
    special_teams.kickoffTouchbackPct = pct(stKickoffTouchbacks, stKickoffs);
    special_teams.specialTeamsPpaPerPlay = stPpaPlays ? round(stPpaSum / stPpaPlays, 3) : null;
    special_teams.specialTeamsEPA = special_teams.specialTeamsPpaPerPlay;
    special_teams.stEPA = special_teams.specialTeamsPpaPerPlay;
  }

  return { games, offense, defense, special_teams };
}


function mergeAdvancedStats(stats: any, advanced: any) {
  if (!stats || !advanced) return stats;
  const offense = advanced?.offense || {};
  const defense = advanced?.defense || {};
  const offPass = offense?.passingPlays || {};
  const offRush = offense?.rushingPlays || {};
  const defPass = defense?.passingPlays || {};
  const defRush = defense?.rushingPlays || {};

  Object.assign(stats.offense, {
    epaPerPlay: finiteOrNull(offense?.ppa),
    offensiveEpaPerPlay: finiteOrNull(offense?.ppa),
    successRate: asPct(offense?.successRate),
    offensiveSuccessRate: asPct(offense?.successRate),
    passEpaPerPlay: finiteOrNull(offPass?.ppa),
    passingEpaPerPlay: finiteOrNull(offPass?.ppa),
    passSuccessRate: asPct(offPass?.successRate),
    passingSuccessRate: asPct(offPass?.successRate),
    rushEpaPerPlay: finiteOrNull(offRush?.ppa),
    rushingEpaPerPlay: finiteOrNull(offRush?.ppa),
    rushSuccessRate: asPct(offRush?.successRate),
    rushingSuccessRate: asPct(offRush?.successRate),
    passRate: asPct(offPass?.rate),
    passingPlayRate: asPct(offPass?.rate),
    rushRate: asPct(offRush?.rate),
    rushingPlayRate: asPct(offRush?.rate),
    stuffRate: asPct(offense?.stuffRate),
    // CFBD's offense stuff rate is the share of the team's rushes stopped at
    // or behind the line; expose the alias used by the CFB matchup panels.
    stuffRateAllowed: asPct(offense?.stuffRate),
    powerSuccessRate: asPct(offense?.powerSuccess),
    adjustedLineYards: finiteOrNull(offense?.lineYards, 2),
    lineYardsPerRush: finiteOrNull(offense?.lineYards, 2),
    explosiveness: finiteOrNull(offense?.explosiveness),
    rushingExplosiveness: finiteOrNull(offRush?.explosiveness),
    passingExplosiveness: finiteOrNull(offPass?.explosiveness),
    secondLevelYards: finiteOrNull(offense?.secondLevelYards, 2),
    secondLevelYardsPerRush: finiteOrNull(offense?.secondLevelYards, 2),
    openFieldYards: finiteOrNull(offense?.openFieldYards, 2),
    openFieldYardsPerRush: finiteOrNull(offense?.openFieldYards, 2),
    pointsPerOpportunity: finiteOrNull(offense?.pointsPerOpportunity, 2),
    scoringOpportunities: finiteOrNull(offense?.totalOpportunies ?? offense?.totalOpportunities, 0),
  });

  // Do not overwrite drive-derived metrics with play success rate. The previous
  // implementation made Drive Success Rate identical to Success Rate. Use the
  // season-advanced drive count only as a fallback when drive history was not
  // available for the selected window.
  if (stats.offense.pointsPerDrive == null && Number(offense?.drives) > 0) {
    stats.offense.pointsPerDrive = round((stats.offense.pointsPerGame || 0) * stats.games / Number(offense.drives), 2);
  }
  const advancedPassTotalPpa = finiteOrNull(offPass?.totalPPA ?? offPass?.totalPpa, 2);
  if (stats.offense.passPpaTotal == null && advancedPassTotalPpa != null) {
    stats.offense.passPpaTotal = advancedPassTotalPpa;
    stats.offense.totalPassPpa = advancedPassTotalPpa;
  }

  const offenseStart = finiteOrNull(offense?.fieldPosition?.averageStart, 1);
  const defenseStart = finiteOrNull(defense?.fieldPosition?.averageStart, 1);
  if (offenseStart != null) stats.special_teams.avgStartingFieldPosition = offenseStart;
  if (defenseStart != null) stats.special_teams.oppAvgStartingFieldPosition = defenseStart;
  if (offenseStart != null && defenseStart != null) {
    stats.special_teams.netFieldPosition = round(offenseStart - defenseStart, 1);
  }

  Object.assign(stats.defense, {
    defensiveEpaPerPlay: finiteOrNull(defense?.ppa),
    epaAllowedPerPlay: finiteOrNull(defense?.ppa),
    defensiveSuccessRate: asPct(defense?.successRate),
    successRateAllowed: asPct(defense?.successRate),
    passEpaAllowed: finiteOrNull(defPass?.ppa),
    passEpaAllowedPerPlay: finiteOrNull(defPass?.ppa),
    passingEpaAllowed: finiteOrNull(defPass?.ppa),
    passSuccessRateAllowed: asPct(defPass?.successRate),
    passingSuccessRateAllowed: asPct(defPass?.successRate),
    rushEpaAllowed: finiteOrNull(defRush?.ppa),
    rushEpaAllowedPerPlay: finiteOrNull(defRush?.ppa),
    rushingEpaAllowed: finiteOrNull(defRush?.ppa),
    rushSuccessRateAllowed: asPct(defRush?.successRate),
    rushingSuccessRateAllowed: asPct(defRush?.successRate),
    stuffRate: asPct(defense?.stuffRate),
    defStuffRate: asPct(defense?.stuffRate),
    adjustedLineYardsAllowed: finiteOrNull(defense?.lineYards, 2),
    explosivenessAllowed: finiteOrNull(defense?.explosiveness),
    rushingExplosivenessAllowed: finiteOrNull(defRush?.explosiveness),
    passingExplosivenessAllowed: finiteOrNull(defPass?.explosiveness),
    havocRate: asPct(defense?.havoc?.total ?? defense?.havoc),
    frontSevenHavocRate: asPct(defense?.havoc?.frontSeven),
    dbHavocRate: asPct(defense?.havoc?.db),
    pointsAllowedPerOpportunity: finiteOrNull(defense?.pointsPerOpportunity, 2),
    scoringOpportunitiesAllowed: finiteOrNull(defense?.totalOpportunies ?? defense?.totalOpportunities, 0),
  });

  // Prefer the actual opponent-drive aggregation from /drives. Advanced season
  // stats are only a fallback when the selected window does not have drive
  // coverage, so a real drive-derived number is never overwritten.
  if (stats.defense.pointsAllowedPerDrive == null && Number(defense?.drives) > 0) {
    stats.defense.pointsAllowedPerDrive = round((stats.defense.pointsAllowedPerGame || 0) * stats.games / Number(defense.drives), 2);
  }

  // The CFB panel expects the same defense alias used by the matchup table.
  // CFBD publishes this as defense.stuffRate.
  if (stats.defense.defStuffRate == null) stats.defense.defStuffRate = asPct(defense?.stuffRate);

  return stats;
}

function advancedByTeam(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows || []) {
    const key = teamKey(row?.team);
    if (key) map.set(key, row);
  }
  return map;
}

function standardByTeam(rows: any[]): Map<string, Record<string, any>> {
  const map = new Map<string, Record<string, any>>();
  for (const row of rows || []) {
    const key = teamKey(row?.team || row?.school);
    const statKey = normalizeCategory(row?.statName || row?.stat || row?.name || row?.category);
    if (!key || !statKey) continue;
    if (!map.has(key)) map.set(key, {});
    map.get(key)![statKey] = row?.statValue ?? row?.value ?? row?.total;
  }
  return map;
}

function standardValue(raw: Record<string, any> | undefined, aliases: string[]): number | null {
  for (const alias of aliases) {
    const value = raw?.[normalizeCategory(alias)];
    const parsed = n(value, NaN);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function standardPair(raw: Record<string, any> | undefined, aliases: string[]): [number, number] | null {
  for (const alias of aliases) {
    const value = raw?.[normalizeCategory(alias)];
    if (value == null || value === '') continue;
    const pair = parsePair(value);
    if (pair[0] || pair[1] || /[-/]/.test(String(value))) return pair;
  }
  return null;
}

function mergeStandardStats(stats: any, raw: Record<string, any> | undefined) {
  if (!stats || !raw) return stats;
  const games = Math.max(1, Number(stats.games || 1));
  const perGame = (value: number | null) => value == null ? null : round(value / games, 1);
  const percent = (made: number | null, attempts: number | null) => made != null && attempts ? round((made / attempts) * 100, 1) : null;

  const rzAttempts = standardValue(raw, ['redZoneAttempts', 'redZoneAtt']);
  const rzScores = standardValue(raw, ['redZoneScores', 'redZoneScoring']);
  const rzTds = standardValue(raw, ['redZoneTouchdowns', 'redZoneTDs']);
  if (rzAttempts != null) {
    stats.offense.redZoneAttempts = rzAttempts;
    stats.offense.redZoneAttemptsPerGame = perGame(rzAttempts);
    stats.offense.redZoneTripsPerGame = perGame(rzAttempts);
    if (rzScores != null) {
      stats.offense.redZoneEfficiency = percent(rzScores, rzAttempts);
      stats.offense.redZoneScorePct = percent(rzScores, rzAttempts);
    }
    if (rzTds != null) {
      stats.offense.redZoneTdPct = percent(rzTds, rzAttempts);
      stats.offense.redZoneTouchdownPct = percent(rzTds, rzAttempts);
    }
  }

  const passAttempts = standardValue(raw, ['attempts', 'passingAttempts', 'passAttempts']);
  const completions = standardValue(raw, ['completions']);
  const passYards = standardValue(raw, ['netPassingYards', 'passingYards']);
  const passTds = standardValue(raw, ['passingTDs', 'passingTouchdowns']);
  const interceptionsThrown = standardValue(raw, ['interceptionsThrown', 'passingInterceptions']);
  const rushAttempts = standardValue(raw, ['rushingAttempts', 'rushAttempts']);
  const rushYards = standardValue(raw, ['rushingYards']);
  const rushTds = standardValue(raw, ['rushingTDs', 'rushingTouchdowns']);
  const firstDowns = standardValue(raw, ['firstDowns']);
  const plays = standardValue(raw, ['plays']);
  if (passAttempts != null) {
    stats.offense.passingAttemptsPerGame = perGame(passAttempts);
    stats.offense.passAttemptsPerGame = perGame(passAttempts);
  }
  if (completions != null) stats.offense.completionsPerGame = perGame(completions);
  if (passAttempts && completions != null) {
    stats.offense.completionPct = percent(completions, passAttempts);
    stats.offense.completionPercentage = percent(completions, passAttempts);
  }
  if (passYards != null) {
    stats.offense.passingYards = perGame(passYards);
    stats.offense.passingYardsPerGame = perGame(passYards);
  }
  if (passAttempts && passYards != null) {
    const ypa = round(passYards / passAttempts, 2);
    stats.offense.yardsPerPass = ypa; stats.offense.yardsPerAttempt = ypa;
    stats.offense.passYardsPerAttempt = ypa; stats.offense.ypa = ypa;
  }
  if (passTds != null) {
    stats.offense.passingTouchdownsPerGame = perGame(passTds);
    stats.offense.passingTDsPerGame = perGame(passTds);
    stats.offense.passingTouchdowns = perGame(passTds);
  }
  if (interceptionsThrown != null && passAttempts) {
    stats.offense.interceptionRate = percent(interceptionsThrown, passAttempts);
    stats.offense.intRate = percent(interceptionsThrown, passAttempts);
  }
  if (rushAttempts != null) {
    stats.offense.rushingAttemptsPerGame = perGame(rushAttempts);
    stats.offense.rushAttemptsPerGame = perGame(rushAttempts);
  }
  if (rushYards != null) {
    stats.offense.rushingYards = perGame(rushYards);
    stats.offense.rushingYardsPerGame = perGame(rushYards);
  }
  if (rushAttempts && rushYards != null) {
    const ypc = round(rushYards / rushAttempts, 2);
    stats.offense.yardsPerRush = ypc; stats.offense.yardsPerCarry = ypc;
    stats.offense.rushYardsPerAttempt = ypc; stats.offense.ypc = ypc;
  }
  if (rushTds != null) {
    stats.offense.rushingTouchdownsPerGame = perGame(rushTds);
    stats.offense.rushTDsPerGame = perGame(rushTds);
    stats.offense.rushingTouchdowns = perGame(rushTds);
  }
  if (firstDowns != null) stats.offense.firstDownsPerGame = perGame(firstDowns);
  if (firstDowns != null && plays) stats.offense.firstDownRate = percent(firstDowns, plays);

  const tfl = standardValue(raw, ['tacklesForLoss', 'tfl']);
  const sacks = standardValue(raw, ['sacks']);
  const qbHurries = standardValue(raw, ['qbHurries', 'quarterbackHurries']);
  const forcedFumbles = standardValue(raw, ['fumblesForced', 'forcedFumbles']);
  const passesDeflected = standardValue(raw, ['passesDeflected', 'passBreakups']);
  if (tfl != null) { stats.defense.tacklesForLoss = perGame(tfl); stats.defense.tfl = perGame(tfl); }
  if (sacks != null) stats.defense.sacksPerGame = perGame(sacks);
  if (forcedFumbles != null) {
    stats.defense.fumblesForced = perGame(forcedFumbles);
    stats.defense.forcedFumbles = perGame(forcedFumbles);
    stats.defense.forcedFumblesPerGame = perGame(forcedFumbles);
  }
  if (qbHurries != null) stats.defense.qbHurriesPerGame = perGame(qbHurries);
  if (passesDeflected != null) stats.defense.passesDeflectedPerGame = perGame(passesDeflected);

  const fgPair = standardPair(raw, ['fieldGoals', 'fieldGoalsMadeFieldGoalsAttempted']);
  const fgMade = standardValue(raw, ['fieldGoalsMade', 'fgMade']) ?? fgPair?.[0] ?? null;
  const fgAtt = standardValue(raw, ['fieldGoalsAttempted', 'fieldGoalAttempts', 'fgAttempts']) ?? fgPair?.[1] ?? null;
  const xpPair = standardPair(raw, ['extraPoints', 'extraPointsMadeExtraPointsAttempted', 'pointAfterTouchdown', 'PAT']);
  const xpMade = standardValue(raw, ['extraPointsMade', 'xpMade', 'xpm', 'patMade', 'pointAfterTouchdownMade']) ?? xpPair?.[0] ?? null;
  const xpAtt = standardValue(raw, ['extraPointsAttempted', 'extraPointAttempts', 'xpAttempts', 'xpa', 'patAttempts', 'pointAfterTouchdownAttempts']) ?? xpPair?.[1] ?? null;
  if (fgMade != null) stats.special_teams.fieldGoalsMadePerGame = perGame(fgMade);
  if (fgMade != null && fgAtt != null) {
    stats.special_teams.fieldGoalPct = percent(fgMade, fgAtt);
    stats.special_teams.fieldGoals = `${fgMade}-${fgAtt}`;
    stats.special_teams.fieldGoalsMadeFieldGoalsAttempted = `${fgMade}-${fgAtt}`;
  }
  if (xpMade != null && xpAtt != null) {
    stats.special_teams.extraPointPct = percent(xpMade, xpAtt);
    stats.special_teams.extraPoints = `${xpMade}-${xpAtt}`;
    stats.special_teams.extraPointsMadeExtraPointsAttempted = `${xpMade}-${xpAtt}`;
  }

  const copyCount = (target: string, aliases: string[]) => {
    const value = standardValue(raw, aliases);
    if (value != null) stats.special_teams[target] = perGame(value);
    return value;
  };
  const punts = copyCount('punts', ['punts']);
  const puntYards = copyCount('puntYards', ['puntYards', 'puntingYards']);
  if (punts && puntYards != null) stats.special_teams.grossAvgPuntYards = round(puntYards / punts, 1);
  const kr = copyCount('kickReturns', ['kickReturns']);
  const kry = copyCount('kickReturnYards', ['kickReturnYards']);
  if (kr && kry != null) stats.special_teams.kickReturnAverage = round(kry / kr, 1);
  copyCount('kickReturnTouchdowns', ['kickReturnTouchdowns', 'kickReturnTDs']);
  const pr = copyCount('puntReturns', ['puntReturns']);
  const pry = copyCount('puntReturnYards', ['puntReturnYards']);
  if (pr && pry != null) stats.special_teams.puntReturnAverage = round(pry / pr, 1);
  copyCount('puntReturnTouchdowns', ['puntReturnTouchdowns', 'puntReturnTDs']);
  const ko = standardValue(raw, ['kickoffs', 'kickoffAttempts']);
  const kotb = standardValue(raw, ['kickoffTouchbacks']);
  if (ko && kotb != null) stats.special_teams.kickoffTouchbackPct = percent(kotb, ko);
  const inside20 = standardValue(raw, ['puntsInside20', 'inside20']);
  if (punts && inside20 != null) {
    stats.special_teams.inside20Pct = percent(inside20, punts);
    stats.special_teams.puntInside20Pct = percent(inside20, punts);
  }
  const puntTb = standardValue(raw, ['puntTouchbacks', 'puntsTouchbacks']);
  if (punts && puntTb != null) {
    stats.special_teams.puntTouchbackPct = percent(puntTb, punts);
    stats.special_teams.touchbackPct = percent(puntTb, punts);
  }
  return stats;
}

function fillMissingStats(stats: any, supplemental: any): any {
  if (!stats || !supplemental) return stats;
  for (const [key, value] of Object.entries(supplemental)) {
    if (stats[key] == null && value != null) {
      stats[key] = value;
    } else if (
      stats[key] && value && typeof stats[key] === 'object' && typeof value === 'object' &&
      !Array.isArray(stats[key]) && !Array.isArray(value)
    ) {
      fillMissingStats(stats[key], value);
    }
  }
  return stats;
}

function supplementMissingStats(stats: any, standard: Record<string, any> | undefined, advanced: any) {
  if (!stats) return stats;
  const supplemental = {
    ...stats,
    offense: { ...stats.offense },
    defense: { ...stats.defense },
    special_teams: { ...stats.special_teams },
  };
  mergeStandardStats(supplemental, standard);
  mergeAdvancedStats(supplemental, advanced);
  return fillMissingStats(stats, supplemental);
}

function rankLeague(statsByTeam: Map<string, any>) {
  const sides = ['offense', 'defense', 'special_teams'] as const;
  const ranks: Record<string, Record<string, Record<string, number>>> = {
    offense: {}, defense: {}, special_teams: {},
  };

  for (const side of sides) {
    const byStat = new Map<string, Array<{ team: string; value: number }>>();
    for (const [team, stats] of statsByTeam.entries()) {
      for (const [key, value] of Object.entries(stats?.[side] || {})) {
        const valueNum = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(valueNum)) continue;
        if (!byStat.has(key)) byStat.set(key, []);
        byStat.get(key)!.push({ team, value: valueNum });
      }
    }

    for (const [key, rows] of byStat.entries()) {
      // Match the NFL cache's default (higher is better) and its explicit
      // lower-is-better stat map. `stuffRate` is the one shared key whose
      // direction changes by side: lower for offense, higher for defense.
      const higherIsBetter = side === 'defense' && key === 'stuffRate'
        ? true
        : !INVERSE_STAT_KEYS.has(key);
      rows.sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
      const rankMap: Record<string, number> = {};
      let rank = 1;
      rows.forEach((row, index) => {
        if (index > 0 && row.value !== rows[index - 1].value) rank = index + 1;
        rankMap[row.team] = rank;
      });
      ranks[side][key] = rankMap;
    }
  }
  return ranks;
}

// Fetch the previous season's game-level logs for rolling windows. Season
// summaries cannot be blended here: L5/L10/L15 must take each team's actual
// most recent games, including games played before the season boundary.
async function fetchPriorSeasonLogs(season: number, apiKey: string) {
  const fbsTeamKeys = await fetchFbsTeamKeys(season, apiKey);
  const schedule = await cfbdGet('/games', {
    year: season,
    seasonType: 'regular',
    classification: 'fbs',
  }, apiKey);
  const completed = schedule.filter((game: any) => game?.completed === true && game?.homePoints != null && game?.awayPoints != null);
  const weeks = [...new Set(completed.map((game: any) => n(game?.week, 0)).filter((week: number) => week > 0))]
    .sort((a: number, b: number) => a - b);
  const boxGames: any[] = [];
  const driveRows: any[] = [];
  const playRows: any[] = [];
  const passingRows: any[] = [];
  for (const week of weeks) {
    const params = { year: season, week, seasonType: 'regular', classification: 'fbs' };
    boxGames.push(...await cfbdGet('/games/teams', params, apiKey));
    await pause(250);
    driveRows.push(...await cfbdGet('/drives', params, apiKey).catch(() => []));
    await pause(250);
    playRows.push(...await cfbdGet('/plays', params, apiKey).catch(() => []));
    await pause(250);
    passingRows.push(...await cfbdGet('/passing/teams/games', params, apiKey).catch(() => []));
    await pause(250);
  }

  const situational = situationalByGameTeam(driveRows, playRows);
  const passing = passingGameByTeam(passingRows);
  const specialTeams = specialTeamsByGameTeam(playRows);
  const scheduleById = new Map(completed.map((game: any) => [String(game.id), game]));
  const logs = new Map<string, TeamGame[]>();
  const names = new Map<string, string>();
  for (const game of boxGames) {
    const scheduled: any = scheduleById.get(String(game?.id));
    const teams = Array.isArray(game?.teams) ? game.teams : [];
    if (!scheduled || teams.length < 2) continue;
    const home = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'home') || teams[0];
    const away = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'away') || teams[1];
    if (!home || !away) continue;
    const homeKey = teamKey(home.team || scheduled.homeTeam);
    const awayKey = teamKey(away.team || scheduled.awayTeam);
    if (!homeKey || !awayKey) continue;
    names.set(homeKey, String(home.team || scheduled.homeTeam || homeKey));
    names.set(awayKey, String(away.team || scheduled.awayTeam || awayKey));

    const id = String(game.id);
    const gameDate = String(scheduled.startDate || '').slice(0, 10);
    const gameWeek = n(scheduled.week, 0);
    const homePoints = n(home.points ?? scheduled.homePoints, 0);
    const awayPoints = n(away.points ?? scheduled.awayPoints, 0);
    const homeTotals = teamBoxTotals(home);
    const awayTotals = teamBoxTotals(away);
    const homeLog: TeamGame = {
      gameId: id, date: gameDate, week: gameWeek, pointsFor: homePoints, pointsAgainst: awayPoints,
      lineScores: Array.isArray(scheduled?.homeLineScores) ? scheduled.homeLineScores : [],
      opponentLineScores: Array.isArray(scheduled?.awayLineScores) ? scheduled.awayLineScores : [],
      own: homeTotals, opp: awayTotals,
      situational: situational.get(`${id}|${homeKey}`), oppSituational: situational.get(`${id}|${awayKey}`),
      passing: passing.get(`${id}|${homeKey}`), oppPassing: passing.get(`${id}|${awayKey}`),
      specialTeams: specialTeams.get(`${id}|${homeKey}`), oppSpecialTeams: specialTeams.get(`${id}|${awayKey}`),
    };
    const awayLog: TeamGame = {
      gameId: id, date: gameDate, week: gameWeek, pointsFor: awayPoints, pointsAgainst: homePoints,
      lineScores: Array.isArray(scheduled?.awayLineScores) ? scheduled.awayLineScores : [],
      opponentLineScores: Array.isArray(scheduled?.homeLineScores) ? scheduled.homeLineScores : [],
      own: awayTotals, opp: homeTotals,
      situational: situational.get(`${id}|${awayKey}`), oppSituational: situational.get(`${id}|${homeKey}`),
      passing: passing.get(`${id}|${awayKey}`), oppPassing: passing.get(`${id}|${homeKey}`),
      specialTeams: specialTeams.get(`${id}|${awayKey}`), oppSpecialTeams: specialTeams.get(`${id}|${homeKey}`),
    };
    if (!logs.has(homeKey)) logs.set(homeKey, []);
    if (!logs.has(awayKey)) logs.set(awayKey, []);
    logs.get(homeKey)!.push(homeLog);
    logs.get(awayKey)!.push(awayLog);
  }
  const fcsSupplement = await fetchSupportedFcsLogs(season, fbsTeamKeys, apiKey);
  for (const [key, name] of fcsSupplement.names) names.set(key, name);
  for (const [key, games] of fcsSupplement.logs) {
    if (!logs.has(key)) logs.set(key, []);
    const existingIds = new Set(logs.get(key)!.map((game) => String(game.gameId)));
    logs.get(key)!.push(...games.filter((game) => !existingIds.has(String(game.gameId))));
  }
  for (const teamLogs of logs.values()) teamLogs.sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));
  const teamKeys = [...new Set([...fbsTeamKeys, ...logs.keys()])].filter((key) => {
    if (!(logs.get(key)?.length)) return false;
    if (fbsTeamKeys.has(key)) return true;
    const canonical = canonicalCfbTeam(names.get(key) || '');
    return Boolean(canonical && teamKey(canonical.abbr) === key);
  });
  return { logs, names, teamKeys };
}

async function fetchFbsTeamKeys(season: number, apiKey: string): Promise<Set<string>> {
  const teams = await cfbdGet('/teams/fbs', { year: season }, apiKey);
  const keys = new Set(teams.map((team: any) => teamKey(team?.school || team?.name || team?.abbreviation)).filter(Boolean));
  if (keys.size < 120) throw new Error(`CFBD returned only ${keys.size} FBS teams for ${season}; refusing to publish an incomplete team frame.`);
  return keys;
}

// The FBS schedule endpoint omits FCS-vs-FCS games. Fetch those games for
// schools supported by the app so their season and rolling leaderboard rows
// use their complete schedule, not only FBS crossover games.
async function fetchSupportedFcsLogs(season: number, fbsTeamKeys: Set<string>, apiKey: string) {
  const supportedKeys = new Set(CFB_TEAMS.map((team) => teamKey(team.abbr)).filter(Boolean));
  const schedule = await cfbdGet('/games', { year: season, seasonType: 'regular', classification: 'fcs' }, apiKey);
  const completed = schedule.filter((game: any) => {
    if (game?.completed !== true || game?.homePoints == null || game?.awayPoints == null) return false;
    const homeKey = teamKey(game?.homeTeam);
    const awayKey = teamKey(game?.awayTeam);
    const fcsHome = Boolean(homeKey && supportedKeys.has(homeKey) && !fbsTeamKeys.has(homeKey));
    const fcsAway = Boolean(awayKey && supportedKeys.has(awayKey) && !fbsTeamKeys.has(awayKey));
    // FBS/FCS crossover games already come through the FBS schedule feed.
    return (fcsHome || fcsAway) && !fbsTeamKeys.has(homeKey) && !fbsTeamKeys.has(awayKey);
  });
  const weeks = [...new Set(completed.map((game: any) => n(game?.week, 0)).filter((week: number) => week > 0))]
    .sort((a: number, b: number) => a - b);
  const gameIds = new Set(completed.map((game: any) => String(game.id)));
  const scheduleById = new Map(completed.map((game: any) => [String(game.id), game]));
  const boxGames: any[] = [];
  const driveRows: any[] = [];
  const playRows: any[] = [];
  const passingRows: any[] = [];

  for (const week of weeks) {
    const params = { year: season, week, seasonType: 'regular', classification: 'fcs' };
    const boxes = await cfbdGet('/games/teams', params, apiKey);
    boxGames.push(...boxes.filter((row: any) => gameIds.has(String(row?.id))));
    await pause(250);
    driveRows.push(...await cfbdGet('/drives', params, apiKey).catch(() => []));
    await pause(250);
    playRows.push(...await cfbdGet('/plays', params, apiKey).catch(() => []));
    await pause(250);
    passingRows.push(...await cfbdGet('/passing/teams/games', params, apiKey).catch(() => []));
    await pause(250);
  }

  const situational = situationalByGameTeam(driveRows, playRows);
  const passing = passingGameByTeam(passingRows);
  const specialTeams = specialTeamsByGameTeam(playRows);
  const logs = new Map<string, TeamGame[]>();
  const names = new Map<string, string>();
  for (const game of boxGames) {
    const scheduled: any = scheduleById.get(String(game?.id));
    const teams = Array.isArray(game?.teams) ? game.teams : [];
    if (!scheduled || teams.length < 2) continue;
    const home = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'home') || teams[0];
    const away = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'away') || teams[1];
    if (!home || !away) continue;
    const homeKey = teamKey(home.team || scheduled.homeTeam);
    const awayKey = teamKey(away.team || scheduled.awayTeam);
    if (!homeKey || !awayKey) continue;
    names.set(homeKey, String(home.team || scheduled.homeTeam || homeKey));
    names.set(awayKey, String(away.team || scheduled.awayTeam || awayKey));
    const id = String(game.id);
    const date = String(scheduled.startDate || '').slice(0, 10);
    const week = n(scheduled.week, 0);
    const homePoints = n(home.points ?? scheduled.homePoints, 0);
    const awayPoints = n(away.points ?? scheduled.awayPoints, 0);
    const homeTotals = teamBoxTotals(home);
    const awayTotals = teamBoxTotals(away);
    const homeLog: TeamGame = {
      gameId: id, date, week, pointsFor: homePoints, pointsAgainst: awayPoints,
      lineScores: Array.isArray(scheduled?.homeLineScores) ? scheduled.homeLineScores : [],
      opponentLineScores: Array.isArray(scheduled?.awayLineScores) ? scheduled.awayLineScores : [],
      own: homeTotals, opp: awayTotals,
      situational: situational.get(`${id}|${homeKey}`), oppSituational: situational.get(`${id}|${awayKey}`),
      passing: passing.get(`${id}|${homeKey}`), oppPassing: passing.get(`${id}|${awayKey}`),
      specialTeams: specialTeams.get(`${id}|${homeKey}`), oppSpecialTeams: specialTeams.get(`${id}|${awayKey}`),
    };
    const awayLog: TeamGame = {
      gameId: id, date, week, pointsFor: awayPoints, pointsAgainst: homePoints,
      lineScores: Array.isArray(scheduled?.awayLineScores) ? scheduled.awayLineScores : [],
      opponentLineScores: Array.isArray(scheduled?.homeLineScores) ? scheduled.homeLineScores : [],
      own: awayTotals, opp: homeTotals,
      situational: situational.get(`${id}|${awayKey}`), oppSituational: situational.get(`${id}|${homeKey}`),
      passing: passing.get(`${id}|${awayKey}`), oppPassing: passing.get(`${id}|${homeKey}`),
      specialTeams: specialTeams.get(`${id}|${awayKey}`), oppSpecialTeams: specialTeams.get(`${id}|${homeKey}`),
    };
    if (!logs.has(homeKey)) logs.set(homeKey, []);
    if (!logs.has(awayKey)) logs.set(awayKey, []);
    logs.get(homeKey)!.push(homeLog);
    logs.get(awayKey)!.push(awayLog);
  }
  return { completed, weeks, logs, names };
}

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let cfbdRequestCount = 0;

async function cfbdGet(path: string, params: Record<string, any>, apiKey: string): Promise<any[]> {
  const url = new URL(`${CFBD_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const requestId = ++cfbdRequestCount;
  const startedAt = Date.now();
  console.info(`[CFB v22] CFBD request #${requestId} started: ${path}?${url.searchParams.toString()}`);
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error: any) {
      const detail = error?.message || String(error);
      console.error(`[CFB v22] CFBD request #${requestId} failed after ${Date.now() - startedAt}ms: ${detail}`);
      throw new Error(`CFBD ${path} request #${requestId} failed or timed out after 45 seconds: ${detail}`);
    }
    if (response.ok) {
      const json = await response.json().catch(() => []);
      const rows = Array.isArray(json) ? json : [];
      console.info(`[CFB v22] CFBD request #${requestId} completed in ${Date.now() - startedAt}ms: ${path} (${rows.length} rows)`);
      return rows;
    }
    last = `${response.status} ${await response.text().catch(() => '')}`.slice(0, 300);
    console.warn(`[CFB v22] CFBD request #${requestId} attempt ${attempt}/3 returned HTTP ${response.status} after ${Date.now() - startedAt}ms`);
    if (![429, 502, 503, 504].includes(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 900));
  }
  throw new Error(`CFBD ${path} failed: ${last || 'unknown error'}`);
}

async function upsert(base44: any, record: any) {
  const existing = await base44.asServiceRole.entities.CFBGameDetailTeamStatsCache.filter({ cache_key: record.cache_key });
  if (existing?.length) await base44.asServiceRole.entities.CFBGameDetailTeamStatsCache.update(existing[0].id, record);
  else await base44.asServiceRole.entities.CFBGameDetailTeamStatsCache.create(record);
}

// Season-wide source payloads (all FBS team game logs) can exceed the entity
// field size limit, so oversized payloads are split across chunk rows and
// reassembled on read. The main row stores a small chunk manifest.
// Entity string fields cap out at 20,000 characters — stay safely under it.
const SOURCE_PAYLOAD_CHUNK_BYTES = 18_000;

async function readSourceCache(base44: any, cacheKey: string, maxAgeMs = Infinity) {
  const rows = await base44.asServiceRole.entities.CFBGameDetailSourceCache.filter({ cache_key: cacheKey });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || Number(row?.cache_version || 0) !== CACHE_VERSION || String(row?.status || '') !== 'ready') return null;
  if (Number.isFinite(maxAgeMs)) {
    const refreshedMs = new Date(row?.scraped_at || 0).getTime();
    if (!Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs) return null;
  }
  let payload: any;
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { return null; }
  if (payload && Array.isArray(payload.__chunks)) {
    const chunkRows = await base44.asServiceRole.entities.CFBGameDetailSourceCache.filter({
      cache_key: { $in: payload.__chunks },
    });
    const chunkByKey = new Map<string, string>();
    for (const chunkRow of chunkRows || []) {
      if (String(chunkRow?.status || '') === 'ready') chunkByKey.set(String(chunkRow?.cache_key || ''), String(chunkRow?.payload || ''));
    }
    let joined = '';
    for (const chunkKey of payload.__chunks) {
      const piece = chunkByKey.get(chunkKey);
      if (piece == null) return null;
      joined += piece;
    }
    try { payload = JSON.parse(joined); } catch { return null; }
  }
  return payload;
}

async function writeSourceCache(base44: any, record: any) {
  const payloadJson = typeof record.payload === 'string' ? record.payload : JSON.stringify(record.payload ?? null);
  const chunkCount = payloadJson.length > SOURCE_PAYLOAD_CHUNK_BYTES ? Math.ceil(payloadJson.length / SOURCE_PAYLOAD_CHUNK_BYTES) : 0;
  const chunkKeys = Array.from({ length: chunkCount }, (_, i) => `${record.cache_key}__c${i + 1}`);
  // One batched lookup for the manifest row and every chunk row.
  const existing = await base44.asServiceRole.entities.CFBGameDetailSourceCache.filter({
    cache_key: { $in: [record.cache_key, ...chunkKeys] },
  });
  const existingByKey = new Map<string, any>();
  for (const row of existing || []) existingByKey.set(String(row?.cache_key || ''), row);
  const mainExisting = existingByKey.get(record.cache_key) || null;

  // Drop chunks left over from a previous larger split (listed in the old manifest)
  if (mainExisting) {
    try {
      const oldManifest = JSON.parse(String(mainExisting.payload || '{}'));
      const oldKeys = (Array.isArray(oldManifest?.__chunks) ? oldManifest.__chunks : []).filter((k: any) => typeof k === 'string');
      const staleKeys = oldKeys.filter((k: string) => !chunkKeys.includes(k));
      if (staleKeys.length) {
        await base44.asServiceRole.entities.CFBGameDetailSourceCache.deleteMany({ cache_key: { $in: staleKeys } }).catch(() => {});
      }
    } catch { /* no previous manifest to clean */ }
  }

  if (chunkCount > 0) {
    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    for (let i = 1; i <= chunkCount; i++) {
      const chunkRecord = {
        ...record,
        cache_key: chunkKeys[i - 1],
        source_type: 'chunk',
        payload: payloadJson.slice((i - 1) * SOURCE_PAYLOAD_CHUNK_BYTES, i * SOURCE_PAYLOAD_CHUNK_BYTES),
      };
      const prev = existingByKey.get(chunkKeys[i - 1]);
      if (prev) toUpdate.push({ id: prev.id, ...chunkRecord });
      else toCreate.push(chunkRecord);
    }
    // Bulk writes in modest batches keep the request small and avoid throttling
    for (let i = 0; i < toCreate.length; i += 20) {
      await base44.asServiceRole.entities.CFBGameDetailSourceCache.bulkCreate(toCreate.slice(i, i + 20));
    }
    for (let i = 0; i < toUpdate.length; i += 20) {
      await base44.asServiceRole.entities.CFBGameDetailSourceCache.bulkUpdate(toUpdate.slice(i, i + 20));
    }
    const manifest = { ...record, payload: JSON.stringify({ __chunks: chunkKeys, __bytes: payloadJson.length }) };
    if (mainExisting) await base44.asServiceRole.entities.CFBGameDetailSourceCache.update(mainExisting.id, manifest);
    else await base44.asServiceRole.entities.CFBGameDetailSourceCache.create(manifest);
    return;
  }

  if (mainExisting) await base44.asServiceRole.entities.CFBGameDetailSourceCache.update(mainExisting.id, record);
  else await base44.asServiceRole.entities.CFBGameDetailSourceCache.create(record);
}


export async function handleCFBTeamStatsRefresh(req: Request, injectedBase44: any = null): Promise<Response> {
  try {
    // The GitHub publisher injects file-backed entity adapters. Load the
    // Base44 SDK only for normal function invocations so Deno Actions never
    // needs to resolve the app's npm package.
    let base44 = injectedBase44;
    if (!base44) {
      const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.39');
      base44 = createClientFromRequest(req);
    }
    const body = req.method === 'GET' ? {} : safeJsonParse(await req.text().catch(() => '{}'));
    const currentStatsSeasonForRequest = resolveStatsSeason(undefined);
    const season = body?.previousSeason === true
      ? currentStatsSeasonForRequest - 1
      : resolveStatsSeason(body?.season);
    const requestedTimeframes = Array.isArray(body?.timeframes) && body.timeframes.length
      ? body.timeframes.map(normalizeRequestedTimeframe).filter(Boolean)
      : DEFAULT_TIMEFRAMES;
    const timeframes = [...new Set(requestedTimeframes)] as string[];
    if (!timeframes.length) {
      return Response.json({ ok: false, error: 'timeframes must be season, L5, L10, or L15' }, { status: 400 });
    }

    // Lightweight verification mode used after deployments. It proves which
    // cache versions/timeframes are actually present without touching CFBD.
    if (String(body?.mode || '').toLowerCase() === 'inspect') {
      const byTimeframe: Record<string, any> = {};
      for (const timeframe of timeframes) {
        const rows = await base44.asServiceRole.entities.CFBGameDetailTeamStatsCache.filter(
          { season, timeframe }, '-scraped_at', 500
        );
        const canonicalRows = (rows || []).filter((row: any) => !row?.side || row.side === 'team');
        const versions: Record<string, number> = {};
        const teams = new Set<string>();
        let parseErrors = 0;
        for (const row of canonicalRows) {
          let payload: any = null;
          try { payload = typeof row?.payload === 'string' ? JSON.parse(row.payload) : row?.payload; } catch { parseErrors += 1; }
          const version = String(payload?.cacheVersion ?? 'unknown');
          versions[version] = (versions[version] || 0) + 1;
          const key = teamKey(payload?.teamKey || row?.team_abbr || payload?.team || '');
          if (key) teams.add(key);
        }
        byTimeframe[timeframe] = {
          rows: canonicalRows.length,
          uniqueTeams: teams.size,
          versions,
          parseErrors,
          newest: canonicalRows[0]?.scraped_at || null,
        };
      }
      return Response.json({ ok: true, mode: 'inspect', cacheVersion: CACHE_VERSION, season, timeframes, byTimeframe });
    }

    const apiKey = Deno.env.get('CFBD_API_KEY') || '';
    if (!apiKey) return Response.json({ ok: false, error: 'CFBD_API_KEY not set' }, { status: 500 });
    const fbsTeamKeys = await fetchFbsTeamKeys(season, apiKey);
    const limit = Math.max(1, Math.min(n(body?.limit, 30), MAX_TEAMS_PER_RUN));
    const offset = Math.max(0, n(body?.offset, 0));
    const requestedTeams = Array.isArray(body?.teams)
      ? body.teams.map((value: any) => teamKey(value)).filter(Boolean)
      : [];

    const cacheDate = todayCentral();
    const force = body?.force === true;

    const currentStatsSeason = resolveStatsSeason(undefined);
    const historicalSeason = season < currentStatsSeason;
    const sourceMaxAgeMs = historicalSeason ? HISTORICAL_SOURCE_MAX_AGE_MS : CURRENT_SOURCE_MAX_AGE_MS;
    const boxSourceKey = `cfb_game_detail_source_v${CACHE_VERSION}_box_${season}_${cacheDate}`;
    let boxSource: any = !force ? await readSourceCache(base44, boxSourceKey, sourceMaxAgeMs) : null;
    let completedWeeks: number[] = [];
    let logs = new Map<string, TeamGame[]>();
    let teamNames = new Map<string, string>();
    let allTeamKeys: string[] = [];
    let completedGameCount = 0;
    let boxGameCount = 0;

    if (boxSource?.logs && Array.isArray(boxSource?.completedWeeks)) {
      completedWeeks = boxSource.completedWeeks.map((week: any) => n(week, 0)).filter((week: number) => week > 0);
      logs = new Map(Object.entries(boxSource.logs || {}) as Array<[string, TeamGame[]]>);
      teamNames = new Map(Object.entries(boxSource.teamNames || {}) as Array<[string, string]>);
      allTeamKeys = Array.isArray(boxSource.allTeamKeys) ? boxSource.allTeamKeys : [...logs.keys()].sort();
      completedGameCount = n(boxSource.completedGameCount, 0);
      boxGameCount = n(boxSource.boxGameCount, 0);
    } else {
      const schedule = await cfbdGet('/games', {
        year: season,
        seasonType: 'regular',
        classification: 'fbs',
      }, apiKey);

      const completed = schedule.filter((game: any) => game?.completed === true && game?.homePoints != null && game?.awayPoints != null);
      if (!completed.length) throw new Error(`No completed FBS games returned by CFBD for ${season}`);
      // The FBS schedule can contain FCS opponents and may omit a side's
      // classification. Use CFBD's season-specific FBS directory as the
      // authoritative team set so FCS rows cannot crowd real FBS teams out.

      completedWeeks = [...new Set(completed.map((game: any) => n(game?.week, 0)).filter((week) => week > 0))].sort((a: number, b: number) => a - b);
      const boxGames: any[] = [];
      const driveRows: any[] = [];
      const playRows: any[] = [];
      const passingGameRows: any[] = [];
      const sourceWarnings: string[] = [];
      console.info(`[CFB v22] Season ${season}: loaded ${completed.length} completed FBS games across ${completedWeeks.length} weeks; fetching weekly team data.`);
      for (let weekIndex = 0; weekIndex < completedWeeks.length; weekIndex++) {
        const week = completedWeeks[weekIndex];
        console.info(`[CFB v22] Season ${season}: starting week ${week} (${weekIndex + 1}/${completedWeeks.length}).`);
        const params = { year: season, week, seasonType: 'regular', classification: 'fbs' };

        // These are large endpoints, especially /plays. Stagger them instead of
        // firing four concurrent requests per week, which can trigger upstream
        // throttling and make the entire Base44 refresh much less reliable.
        const boxWeek = await cfbdGet('/games/teams', params, apiKey);
        let drivesWeek: any[] = [];
        let playsWeek: any[] = [];
        let passingWeek: any[] = [];

        // Previous-season buttons only need a stable historical snapshot. Skip
        // the enormous drive/play feeds there; standard + advanced season data
        // and game box scores still populate the core Offense/Defense/Special
        // Teams views while keeping a historical rebuild practical.
        if (!historicalSeason) {
          await pause(450);
          drivesWeek = await cfbdGet('/drives', params, apiKey).catch((error: any) => {
            sourceWarnings.push(`drives week ${week}: ${error?.message || String(error)}`);
            return [];
          });
          await pause(450);
          playsWeek = await cfbdGet('/plays', params, apiKey).catch((error: any) => {
            sourceWarnings.push(`plays week ${week}: ${error?.message || String(error)}`);
            return [];
          });
          await pause(450);
          passingWeek = await cfbdGet('/passing/teams/games', params, apiKey).catch((error: any) => {
            sourceWarnings.push(`passing teams/games week ${week}: ${error?.message || String(error)}`);
            return [];
          });
        } else {
          await pause(150);
        }

        boxGames.push(...boxWeek);
        driveRows.push(...drivesWeek);
        playRows.push(...playsWeek);
        passingGameRows.push(...passingWeek);
      }

      const situationalMap = situationalByGameTeam(driveRows, playRows);
      const passingMap = passingGameByTeam(passingGameRows);
      const specialTeamsMap = specialTeamsByGameTeam(playRows);
      const scheduleById = new Map(completed.map((game: any) => [String(game.id), game]));
      for (const game of boxGames) {
        const scheduleGame: any = scheduleById.get(String(game?.id));
        if (!scheduleGame) continue;
        const teams = Array.isArray(game?.teams) ? game.teams : [];
        if (teams.length < 2) continue;
        const home = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'home') || teams[0];
        const away = teams.find((team: any) => String(team?.homeAway || '').toLowerCase() === 'away') || teams[1];
        if (!home || !away) continue;

        const homeKey = teamKey(home.team || scheduleGame.homeTeam);
        const awayKey = teamKey(away.team || scheduleGame.awayTeam);
        if (!homeKey || !awayKey) continue;
        teamNames.set(homeKey, String(home.team || scheduleGame.homeTeam || homeKey));
        teamNames.set(awayKey, String(away.team || scheduleGame.awayTeam || awayKey));

        const gameDate = String(scheduleGame.startDate || '').slice(0, 10);
        const week = n(scheduleGame.week, 0);
        const homePoints = n(home.points ?? scheduleGame.homePoints, 0);
        const awayPoints = n(away.points ?? scheduleGame.awayPoints, 0);
        const homeTotals = teamBoxTotals(home);
        const awayTotals = teamBoxTotals(away);

        const homeLog: TeamGame = {
          gameId: String(game.id), date: gameDate, week, pointsFor: homePoints, pointsAgainst: awayPoints,
          lineScores: Array.isArray(scheduleGame?.homeLineScores) ? scheduleGame.homeLineScores : [],
          opponentLineScores: Array.isArray(scheduleGame?.awayLineScores) ? scheduleGame.awayLineScores : [],
          own: homeTotals, opp: awayTotals,
          situational: situationalMap.get(`${String(game.id)}|${homeKey}`),
          oppSituational: situationalMap.get(`${String(game.id)}|${awayKey}`),
          passing: passingMap.get(`${String(game.id)}|${homeKey}`),
          oppPassing: passingMap.get(`${String(game.id)}|${awayKey}`),
          specialTeams: specialTeamsMap.get(`${String(game.id)}|${homeKey}`),
          oppSpecialTeams: specialTeamsMap.get(`${String(game.id)}|${awayKey}`),
        };
        const awayLog: TeamGame = {
          gameId: String(game.id), date: gameDate, week, pointsFor: awayPoints, pointsAgainst: homePoints,
          lineScores: Array.isArray(scheduleGame?.awayLineScores) ? scheduleGame.awayLineScores : [],
          opponentLineScores: Array.isArray(scheduleGame?.homeLineScores) ? scheduleGame.homeLineScores : [],
          own: awayTotals, opp: homeTotals,
          situational: situationalMap.get(`${String(game.id)}|${awayKey}`),
          oppSituational: situationalMap.get(`${String(game.id)}|${homeKey}`),
          passing: passingMap.get(`${String(game.id)}|${awayKey}`),
          oppPassing: passingMap.get(`${String(game.id)}|${homeKey}`),
          specialTeams: specialTeamsMap.get(`${String(game.id)}|${awayKey}`),
          oppSpecialTeams: specialTeamsMap.get(`${String(game.id)}|${homeKey}`),
        };
        if (!logs.has(homeKey)) logs.set(homeKey, []);
        if (!logs.has(awayKey)) logs.set(awayKey, []);
        logs.get(homeKey)!.push(homeLog);
        logs.get(awayKey)!.push(awayLog);
      }

      for (const log of logs.values()) log.sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));
      allTeamKeys = [...fbsTeamKeys].filter((key) => (logs.get(key)?.length || 0) > 0).sort();
      completedGameCount = completed.length;
      boxGameCount = boxGames.length;

      boxSource = {
        completedWeeks,
        completedGameCount,
        boxGameCount,
        allTeamKeys,
        teamNames: Object.fromEntries(teamNames),
        logs: Object.fromEntries(logs),
        sourceWarnings,
      };
      await writeSourceCache(base44, {
        cache_key: boxSourceKey,
        cache_date: cacheDate,
        season,
        source_type: 'box',
        start_week: Math.min(...completedWeeks),
        end_week: Math.max(...completedWeeks),
        scraped_at: new Date().toISOString(),
        status: 'ready',
        cache_version: CACHE_VERSION,
        payload: JSON.stringify(boxSource),
        source: 'cfbd-games+games-teams+drives+plays+passing-teams-games',
        last_error: sourceWarnings.join(' | '),
      });
    }

    // FBS/FCS crossover logs come from the FBS feed; add the supported FCS
    // schools' FCS-vs-FCS schedules as well so their season averages and ranks
    // are based on all completed games.
    const fcsSupplement = await fetchSupportedFcsLogs(season, fbsTeamKeys, apiKey);
    completedWeeks = [...new Set([...completedWeeks, ...fcsSupplement.weeks])].sort((a, b) => a - b);
    for (const [key, name] of fcsSupplement.names) teamNames.set(key, name);
    for (const [key, games] of fcsSupplement.logs) {
      if (!logs.has(key)) logs.set(key, []);
      const existingIds = new Set(logs.get(key)!.map((game) => String(game.gameId)));
      logs.get(key)!.push(...games.filter((game) => !existingIds.has(String(game.gameId))));
    }
    for (const teamLogs of logs.values()) teamLogs.sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId));

    // Only accept non-FBS keys when the source display name resolves back to
    // that exact canonical team key, avoiding abbreviation collisions.
    const fbsKeysWithLogs = new Set(allTeamKeys);
    const observedKeys = [...new Set([...allTeamKeys, ...logs.keys()])];
    allTeamKeys = observedKeys.filter((key) => {
      if (!(logs.get(key)?.length)) return false;
      if (fbsKeysWithLogs.has(key)) return true;
      const canonical = canonicalCfbTeam(teamNames.get(key) || '');
      return Boolean(canonical && teamKey(canonical.abbr) === key);
    }).sort();

    if (!completedWeeks.length || !allTeamKeys.length) throw new Error(`CFB source cache contains no completed team data for ${season}`);

    const warnings: string[] = [];
    if (boxSource?.sourceWarnings && Array.isArray(boxSource.sourceWarnings)) warnings.push(...boxSource.sourceWarnings);
    // The rolling windows are game-based, not season-based. Pull the preceding
    // season's game logs once and merge them with this season before taking each
    // team's last N games. Keep the season timeframe isolated to this season.
    let priorSeasonLogs = new Map<string, TeamGame[]>();
    let priorSeasonNames = new Map<string, string>();
    if (timeframes.some((timeframe: string) => String(timeframe).toUpperCase() !== 'SEASON')) {
      const suppliedPrior = body?.priorSeasonLogs;
      if (suppliedPrior?.teams && typeof suppliedPrior.teams === 'object') {
        for (const [key, value] of Object.entries(suppliedPrior.teams as Record<string, any>)) {
          if (Array.isArray(value?.games)) priorSeasonLogs.set(key, value.games);
          if (value?.team) priorSeasonNames.set(key, String(value.team));
        }
      } else {
        try {
          const prior = await fetchPriorSeasonLogs(season - 1, apiKey);
          priorSeasonLogs = prior.logs;
          priorSeasonNames = prior.names;
        } catch (error: any) {
          warnings.push(`previous-season logs ${season - 1}: ${error?.message || String(error)}`);
        }
      }
      for (const key of priorSeasonLogs.keys()) {
        const canonical = canonicalCfbTeam(priorSeasonNames.get(key) || teamNames.get(key) || '');
        const isKnownTeam = Boolean(canonical && teamKey(canonical.abbr) === key);
        if ((fbsKeysWithLogs.has(key) || isKnownTeam) && !allTeamKeys.includes(key)) allTeamKeys.push(key);
        if (!teamNames.has(key) && priorSeasonNames.has(key)) teamNames.set(key, priorSeasonNames.get(key)!);
      }
      allTeamKeys.sort();
    }

    const sliceKeys = requestedTeams.length
      ? requestedTeams.filter((key: string) => allTeamKeys.includes(key))
      : allTeamKeys.slice(offset, offset + limit);

    const scrapedAt = new Date().toISOString();
    const results: any[] = [];
    const errors: string[] = [];
    const advancedWindowCache = new Map<string, Map<string, any>>();
    const standardWindowCache = new Map<string, Map<string, Record<string, any>>>();
    const maxCompletedWeek = Math.max(...completedWeeks);

    for (const timeframe of timeframes) {
      console.info(`[CFB v22] Season ${season}: calculating ${timeframe} team stats for ${allTeamKeys.length} teams.`);
      const upper = String(timeframe).toUpperCase();
      const windowSize = upper === 'SEASON' ? 0 : n(upper.replace(/^L/, ''), 0);
      const startWeek = windowSize ? Math.max(1, maxCompletedWeek - windowSize + 1) : 1;
      const advancedWindowKey = `${startWeek}-${maxCompletedWeek}`;
      let advancedMap = advancedWindowCache.get(advancedWindowKey);
      if (!advancedMap) {
        const advancedSourceKey = `cfb_game_detail_source_v${CACHE_VERSION}_advanced_${season}_${startWeek}_${maxCompletedWeek}_${cacheDate}`;
        const cachedAdvanced = !force ? await readSourceCache(base44, advancedSourceKey, sourceMaxAgeMs) : null;
        if (cachedAdvanced?.teams) {
          advancedMap = new Map(Object.entries(cachedAdvanced.teams));
        } else {
          try {
            const advancedRows = await cfbdGet('/stats/season/advanced', {
              year: season,
              startWeek,
              endWeek: maxCompletedWeek,
              classification: 'fbs',
            }, apiKey);
            advancedMap = advancedByTeam(advancedRows);
            await writeSourceCache(base44, {
              cache_key: advancedSourceKey,
              cache_date: cacheDate,
              season,
              source_type: 'advanced',
              start_week: startWeek,
              end_week: maxCompletedWeek,
              scraped_at: new Date().toISOString(),
              status: 'ready',
              cache_version: CACHE_VERSION,
              payload: JSON.stringify({ teams: Object.fromEntries(advancedMap) }),
              source: 'cfbd-stats-season-advanced',
              last_error: '',
            });
          } catch (error: any) {
            advancedMap = new Map();
            warnings.push(`advanced ${timeframe}: ${error?.message || String(error)}`);
          }
        }
        advancedWindowCache.set(advancedWindowKey, advancedMap);
      }

      let standardMap = standardWindowCache.get(advancedWindowKey);
      if (!standardMap) {
        const standardSourceKey = `cfb_game_detail_source_v${CACHE_VERSION}_standard_${season}_${startWeek}_${maxCompletedWeek}_${cacheDate}`;
        const cachedStandard = !force ? await readSourceCache(base44, standardSourceKey, sourceMaxAgeMs) : null;
        if (cachedStandard?.teams) {
          standardMap = new Map(Object.entries(cachedStandard.teams));
        } else {
          try {
            const standardRows = await cfbdGet('/stats/season', {
              year: season, startWeek, endWeek: maxCompletedWeek, classification: 'fbs',
            }, apiKey);
            standardMap = standardByTeam(standardRows);
            await writeSourceCache(base44, {
              cache_key: standardSourceKey, cache_date: cacheDate, season, source_type: 'standard',
              start_week: startWeek, end_week: maxCompletedWeek, scraped_at: new Date().toISOString(),
              status: 'ready', cache_version: CACHE_VERSION,
              payload: JSON.stringify({ teams: Object.fromEntries(standardMap) }),
              source: 'cfbd-stats-season', last_error: '',
            });
          } catch (error: any) {
            standardMap = new Map();
            warnings.push(`standard ${timeframe}: ${error?.message || String(error)}`);
          }
        }
        standardWindowCache.set(advancedWindowKey, standardMap);
      }

      const statsByTeam = new Map<string, any>();
      for (const key of allTeamKeys) {
        const currentSeasonGames = logs.get(key) || [];
        const previousSeasonGames = priorSeasonLogs.get(key) || [];
        const allGames = windowSize
          ? [...previousSeasonGames, ...currentSeasonGames].sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId))
          : currentSeasonGames;
        const selected = windowSize ? allGames.slice(-windowSize) : allGames;
        const stats = computeStats(selected);
        if (stats) {
          // Standard and advanced season endpoints are aggregated by week,
          // not by each team's last N games. Applying them to L5/L10/L15
          // overwrites the exact game-log window and can make multiple rolling
          // timeframes identical (especially early in a season). Preserve the
          // exact selected-game calculations and borrow aggregate values only
          // for stats unavailable in game logs (for example advanced EPA).
          // Season totals continue to use the source's season endpoints.
          statsByTeam.set(key, windowSize > 0
            ? supplementMissingStats(stats, standardMap?.get(key), advancedMap?.get(key))
            : mergeAdvancedStats(mergeStandardStats(stats, standardMap?.get(key)), advancedMap?.get(key)));
        }
      }
      const ranks = rankLeague(statsByTeam);

      for (const key of sliceKeys) {
        const stats = statsByTeam.get(key);
        if (!stats) continue;
        const teamName = teamNames.get(key) || cfbDisplayName(key);
        const rankPayload: any = { offense: {}, defense: {}, special_teams: {} };
        for (const side of ['offense', 'defense', 'special_teams'] as const) {
          for (const [stat, map] of Object.entries(ranks[side])) rankPayload[side][stat] = (map as any)[key] ?? null;
        }

        const payload = {
          cacheVersion: CACHE_VERSION,
          team: teamName,
          teamKey: key,
          season,
          timeframe,
          games: stats.games,
          stats: {
            offense: stats.offense,
            defense: stats.defense,
            special_teams: stats.special_teams,
          },
          ranks: rankPayload,
          teamsRanked: statsByTeam.size,
        };
        const record = {
          cache_key: `cfb_team_v${CACHE_VERSION}_${season}_${timeframe}_${key}`,
          cache_date: cacheDate,
          scraped_at: scrapedAt,
          season,
          week: maxCompletedWeek,
          timeframe,
          game_id: '',
          team_abbr: key,
          opponent_abbr: '',
          side: 'team',
          payload: JSON.stringify(payload),
          source: `cfbd-games-teams+drives+plays+passing+season-standard+advanced-v${CACHE_VERSION}`,
        };
        try {
          await upsert(base44, record);
          results.push({ team: teamName, key, timeframe, games: stats.games });
        } catch (error: any) {
          errors.push(`${key} ${timeframe}: ${error?.message || String(error)}`);
        }
      }
    }

    const response: Record<string, any> = {
      ok: errors.length === 0,
      cacheVersion: CACHE_VERSION,
      source: 'cfbd-games+games-teams+drives+plays+passing-teams-games+season-standard+season-advanced',
      season,
      completedWeeks,
      completedGameCount,
      boxGameCount,
      fbsTeamCount: fbsTeamKeys.size,
      fcsTeamCount: allTeamKeys.filter((key) => !fbsTeamKeys.has(key)).length,
      teamCount: allTeamKeys.length,
      requestedTeamCount: requestedTeams.length || sliceKeys.length,
      materializedTeamCount: sliceKeys.length,
      cachedRecords: results.length,
      results,
      errors,
      warnings,
      scrapedAt,
    };
    if (body?.includeGameLogs === true) {
      response.gameLogs = {
        season,
        teams: Object.fromEntries([...logs.entries()].map(([key, games]) => [key, {
          team: teamNames.get(key) || cfbDisplayName(key),
          games,
        }])),
      };
    }
    return Response.json(response);
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

export default function (req: Request): Promise<Response> {
  return handleCFBTeamStatsRefresh(req);
}
