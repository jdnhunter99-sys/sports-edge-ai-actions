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

/**
 * Normalize team labels from source feeds without allowing the crosswalk's
 * fuzzy substring fallback to collapse distinct schools (for example,
 * Delaware State into Delaware). Exact aliases still use the shared FBS
 * crosswalk; unrecognized labels keep their own normalized identity.
 */
export function normalizeCFBSourceTeam(value: unknown): string {
  const candidates = value && typeof value === 'object'
    ? [
      (value as any).school,
      (value as any).name,
      (value as any).displayName,
      (value as any).shortDisplayName,
      (value as any).shortName,
      (value as any).abbr,
      (value as any).abbreviation,
    ]
    : [value];

  const normalizeLabel = (label: unknown) => String(label ?? '')
    .trim()
    .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim();
    if (!raw) continue;
    const canonical = canonicalCfbTeam(raw);
    if (!canonical?.abbr) continue;
    const rawLabel = normalizeLabel(raw);
    const exactLabels = [canonical.abbr, canonical.name, ...canonical.aliases];
    if (exactLabels.some((label) => normalizeLabel(label) === rawLabel)) {
      return normalizeCFBSchool(canonical.abbr);
    }
  }

  const fallback = candidates.find((candidate) => String(candidate ?? '').trim());
  return normalizeCFBTeamKey(fallback ?? '');
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
  'wag': 'wagner',
  'wagner': 'wagner',
  'wagnerseahawks': 'wagner',
  'wagnercollege': 'wagner',
  'wagnercollegeseahawks': 'wagner',
  'vmi': 'vmi',
  'vmikeydets': 'vmi',
  'virginiamilitaryinstitute': 'vmi',
  'virginiamilitaryinstitutekeydets': 'vmi',
  'keydets': 'vmi',
  'wm': 'williammary',
  'wandm': 'williammary',
  'williammary': 'williammary',
  'williamandmary': 'williammary',
  'williammarytribe': 'williammary',
  'williamandmarytribe': 'williammary',
  'williammarycollege': 'williammary',
  'collegeofwilliammary': 'williammary',
  'tribe': 'williammary',
  'delawarestate': 'delawarestate',
  'delawarestatehornets': 'delawarestate',
  'delst': 'delawarestate',
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
  'txst': 'txst',
  'txstate': 'txst',
  'texasst': 'txst',
  'texasstate': 'txst',
  'texasstatebobcats': 'txst',
  'texasstateuniversity': 'txst',
  'texasstateuniversitybobcats': 'txst',
  'apsu': 'austinpeay',
  'austinpeay': 'austinpeay',
  'austinpeaygovernors': 'austinpeay',
  'austinpeaystate': 'austinpeay',
  'austinpeaystategovernors': 'austinpeay',
  'austinpeaystateuniversity': 'austinpeay',
  'porst': 'portlandstate',
  'portlandst': 'portlandstate',
  'portlandstvikings': 'portlandstate',
  'portlandstate': 'portlandstate',
  'portlandstatevikings': 'portlandstate',
  'portlandstateuniversity': 'portlandstate',
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
  'fauowls': 'fau',
  'fatl': 'fau',
  'flaatl': 'fau',
  'floridaatlantic': 'fau',
  'floridaatlanticowls': 'fau',
  'floridaatlanticuniversity': 'fau',
  'floridaatlanticuniversityowls': 'fau',
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
  // PropLine / ESPN use TLSA while team-stat caches use the school key.
  // Normalize every Tulsa spelling to the same key used by the frontend.
  'tul': 'tulsa',
  'tlsa': 'tulsa',
  'tulsa': 'tulsa',
  'tulsagoldenhurricane': 'tulsa',
  'tulsauniversity': 'tulsa',
  'universityoftulsa': 'tulsa',
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
  'sdst': 'southdakotastate',
  'sdakotast': 'southdakotastate',
  'southdakotast': 'southdakotastate',
  'southdakotastate': 'southdakotastate',
  'southdakotastatejackrabbits': 'southdakotastate',
  'southdakotastateuniversity': 'southdakotastate',
  'camp': 'campbell',
  'campbell': 'campbell',
  'campbellfightingcamels': 'campbell',
  'campbelluniversity': 'campbell',
  'fightingcamels': 'campbell',
  'camels': 'campbell',
  'tow': 'towson',
  'towson': 'towson',
  'towsontigers': 'towson',
  'towsonuniversity': 'towson',
  'stbk': 'stonybrook',
  'sbu': 'stonybrook',
  'stonybrook': 'stonybrook',
  'stonybrookseawolves': 'stonybrook',
  'stonybrookuniversity': 'stonybrook',
  'sunystonybrook': 'stonybrook',
  'buck': 'bucknell',
  'bucknell': 'bucknell',
  'bucknellbison': 'bucknell',
  'bucknelluniversity': 'bucknell',
  'bcu': 'bethunecookman',
  'bethunecookman': 'bethunecookman',
  'bethunecookmanwildcats': 'bethunecookman',
  'bethunecookmanuniversity': 'bethunecookman',
  'how': 'howard',
  'howard': 'howard',
  'howardbison': 'howard',
  'howarduniversity': 'howard',
  'iow': 'iowa',
  'iowa': 'iowa',
  'iowahawkeye': 'iowa',
  'iowahawkeyes': 'iowa',
  'hawkeyes': 'iowa',
  'universityofiowa': 'iowa',
  'rich': 'richmond',
  'richmond': 'richmond',
  'richmondspiders': 'richmond',
  'universityofrichmond': 'richmond',
  'utm': 'utmartin',
  'utmartin': 'utmartin',
  'tennesseemartin': 'utmartin',
  'universityoftennesseeatmartin': 'utmartin',
  'utmartinskyhawks': 'utmartin',
  'utu': 'utahtech',
  'utahtech': 'utahtech',
  'utahtechtrailblazers': 'utahtech',
  'utahtechuniversity': 'utahtech',
  'dixiestate': 'utahtech',
  'dixiestatetrailblazers': 'utahtech',
  'cp': 'calpoly',
  'calpoly': 'calpoly',
  'calpolymustangs': 'calpoly',
  'calpolyslo': 'calpoly',
  'calpolysanluisobispo': 'calpoly',
  'californiapolytechnic': 'calpoly',
  'californiapolytechnicstateuniversity': 'calpoly',
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
  'eku': 'easternkentucky',
  'easternkentucky': 'easternkentucky',
  'easternkentuckycolonels': 'easternkentucky',
  'easternkentuckyuniversity': 'easternkentucky',
  'sac': 'sacramentostate',
  'sacst': 'sacramentostate',
  'csus': 'sacramentostate',
  'sacramentost': 'sacramentostate',
  'sacramentostate': 'sacramentostate',
  'sacramentostatehornets': 'sacramentostate',
  'ndsu': 'northdakotastate',
  'northdakotastate': 'northdakotastate',
  'northdakotastatebison': 'northdakotastate',
  'northdakotastateuniversity': 'northdakotastate',
  'nich': 'nicholls',
  'nicholls': 'nicholls',
  'nichollscolonels': 'nicholls',
  'nichollsstate': 'nicholls',
  'nichollsstatecolonels': 'nicholls',
  'nichollsstateuniversity': 'nicholls',
  'nichollsstateuniversitycolonels': 'nicholls',
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
