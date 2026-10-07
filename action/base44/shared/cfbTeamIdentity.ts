// base44/shared/cfbTeamIdentity.ts
// Canonical SportsEdgeAI college football team identity.
// College football has 130+ FBS schools plus frequent FCS opponents and many
// name collisions (Miami FL/OH, USC/South Carolina, UTSA/UTEP, Louisiana
// variants...). All CFB backend functions resolve schools through this module
// so every source (SportsDataverse, ESPN, CFBD, ScoresAndOdds) joins on one
// canonical key instead of loose substring matching.
import { canonicalCfbTeam } from './cfbOddsTeams.ts';

export function normalizeCFBSchool(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // Use the same complete team crosswalk as PropLine/ScoresAndOdds first.
  // This makes every registered abbreviation, school name, and mascot name
  // resolve to one key (including FCS schools such as Samford).
  const canonical = canonicalCfbTeam(raw);
  if (canonical?.abbr) return normalizeCFBTeamKey(canonical.abbr);
  const lower = raw.toLowerCase();
  // Disambiguate before stripping parentheses so "Miami (FL)" and
  // "Miami (OH)" never collapse into one team.
  if (lower.includes('miami')) {
    if (/\(oh|ohio|redhawk/i.test(lower)) return 'miamioh';
    return 'miamifl';
  }
  return normalizeCFBTeamKey(raw);
}

export function normalizeCFBTeamKey(value: unknown): string {
  const key = String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  return CFB_KEY_ALIASES[key] || key;
}

// Canonical alias crosswalk. Keys are fully normalized (lowercase, no
// punctuation). Values are the canonical SportsEdgeAI CFB team key.
export const CFB_KEY_ALIASES: Record<string, string> = {
  // Ambiguous / frequently confused schools
  'usc': 'usc',
  'southerncalifornia': 'usc',
  'southerncal': 'usc',
  'universityofsoutherncalifornia': 'usc',
  'southcarolina': 'southcarolina',
  'miamihurricanes': 'miamifl',
  'miamiflorida': 'miamifl',
  'miamiredhawks': 'miamioh',
  'miamiohio': 'miamioh',
  'olemiss': 'olemiss',
  'mississippi': 'olemiss',
  'universityofmississippi': 'olemiss',
  // Name collisions and short forms
  'ncstate': 'ncstate',
  'northcarolinastate': 'ncstate',
  'northcarolina': 'northcarolina',
  'pittsburgh': 'pitt',
  'pitt': 'pitt',
  'universityofpittsburgh': 'pitt',
  'pennst': 'pennstate',
  'pennstate': 'pennstate',
  'ohiost': 'ohiostate',
  'ohiostate': 'ohiostate',
  'ohiouniversity': 'ohio',
  'ohioubobcats': 'ohio',
  'wazzu': 'washingtonstate',
  'washingtonstate': 'washingtonstate',
  'washingtonhuskies': 'washington',
  'uw': 'washington',
  'vatech': 'virginiatech',
  'vt': 'virginiatech',
  'virginiatech': 'virginiatech',
  'westvirginia': 'westvirginia',
  'kstate': 'kansasstate',
  'kansasstate': 'kansasstate',
  'michst': 'michiganstate',
  'michiganstate': 'michiganstate',
  // Texas schools
  'ut': 'texas',
  'utexas': 'texas',
  'universityoftexas': 'texas',
  'tamu': 'texasam',
  'texasam': 'texasam',
  'texasaggies': 'texasam',
  'texasatsanantonio': 'utsa',
  'utsa': 'utsa',
  'sanantonio': 'utsa',
  'texasatelpaso': 'utep',
  'utep': 'utep',
  'elpaso': 'utep',
  'texaschristian': 'tcu',
  'tcu': 'tcu',
  'southernmethodist': 'smu',
  'smu': 'smu',
  'universityofhouston': 'houston',
  'houston': 'houston',
  'texastech': 'texastech',
  // Louisiana schools
  'louisianastate': 'lsu',
  'lsu': 'lsu',
  'louisianalafayette': 'louisiana',
  'ul': 'louisiana',
  'ull': 'louisiana',
  'ulafayette': 'louisiana',
  'louisiana': 'louisiana',
  'louisianamonroe': 'ulm',
  'ulm': 'ulm',
  'ulmonroe': 'ulm',
  'louisianawarhawks': 'ulm',
  // Florida schools
  'fsu': 'floridastate',
  'floridastate': 'floridastate',
  'ucf': 'ucf',
  'centralflorida': 'ucf',
  'usf': 'usf',
  'southflorida': 'usf',
  'fiu': 'fiu',
  'floridainternational': 'fiu',
  'fau': 'fau',
  'floridaatlantic': 'fau',
  'floridaam': 'floridaam',
  // Other common aliases
  'uconn': 'connecticut',
  'connecticut': 'connecticut',
  'umass': 'umass',
  'massachusetts': 'umass',
  'byu': 'byu',
  'brighamyoung': 'byu',
  'unlv': 'unlv',
  'nevadalasvegas': 'unlv',
  'lasvegas': 'unlv',
  'middletennesseestate': 'mtsu',
  'mtsu': 'mtsu',
  'middletennessee': 'mtsu',
  'appalachianst': 'appstate',
  'appalachianstate': 'appstate',
  'appstate': 'appstate',
  'georgiatech': 'georgiatech',
  'ga tech': 'georgiatech',
  'bama': 'alabama',
  'tenn': 'tennessee',
  'vandy': 'vanderbilt',
  'ou': 'oklahoma',
  'okst': 'oklahomastate',
  'okestate': 'oklahomastate',
  'orst': 'oregonstate',
  'cal': 'california',
  'california': 'california',
  'calbears': 'california',
  'asu': 'arizonastate',
  'nd': 'notredame',
  'fightingirish': 'notredame',
  'notredame': 'notredame',
  'wake': 'wakeforest',
  'wakeforest': 'wakeforest',
  'cuse': 'syracuse',
  'syracuse': 'syracuse',
  'bostoncol': 'bostoncollege',
  'bostoncollege': 'bostoncollege',
  'airforce': 'airforce',
  'army': 'army',
  'westpoint': 'army',
  'navy': 'navy',
  'niu': 'northernillinois',
  'northernillinois': 'northernillinois',
  'wmu': 'westernmichigan',
  'westernmichigan': 'westernmichigan',
  'cmu': 'centralmichigan',
  'centralmichigan': 'centralmichigan',
  'emu': 'easternmichigan',
  'easternmichigan': 'easternmichigan',
  'nmsu': 'newmexicostate',
  'newmexicostate': 'newmexicostate',
  'unm': 'newmexico',
  'newmexico': 'newmexico',
  'sjsu': 'sanjosestate',
  'sanjosestate': 'sanjosestate',
  'bsu': 'boisestate',
  'boisestate': 'boisestate',
  'unt': 'northtexas',
  'northtexas': 'northtexas',
  'odu': 'olddominion',
  'olddominion': 'olddominion',
  'jmu': 'jamesmadison',
  'jamesmadison': 'jamesmadison',
  'wku': 'westernkentucky',
  'westernkentucky': 'westernkentucky',
  'southernmiss': 'southernmiss',
  'uga': 'georgia',
  'georgiasouthern': 'georgiasouthern',
  'georgiastate': 'georgiastate',
  'middletennesseestate university': 'mtsu',
  'utknoxville': 'tennessee',
  'utk': 'tennessee',
};

export function sameCFBTeam(a: unknown, b: unknown): boolean {
  const keyA = normalizeCFBSchool(a);
  const keyB = normalizeCFBSchool(b);
  return Boolean(keyA) && keyA === keyB;
}

export function cfbDisplayName(school: unknown): string {
  return String(school ?? '').replace(/\s+/g, ' ').trim();
}
