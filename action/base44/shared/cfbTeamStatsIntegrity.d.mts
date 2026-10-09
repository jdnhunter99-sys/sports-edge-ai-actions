export function validateCFBTeamOffense(
  stats: any,
  context?: { team?: string; timeframe?: string; gameIds?: Array<string | number> | null },
): { ok: boolean; team: string; timeframe: string; games: number | null; checks: string[]; errors: string[] };

export function validateCFBTeamDefense(
  stats: any,
  context?: {
    team?: string;
    timeframe?: string;
    gameIds?: Array<string | number> | null;
    totals?: Record<string, number | null | undefined>;
  },
): { ok: boolean; team: string; timeframe: string; games: number | null; checks: string[]; unavailable: string[]; errors: string[] };

export function validateCFBGameCoverage(
  expectedGameIds: Array<string | number>,
  actualGameIds: Array<string | number>,
): { ok: boolean; expected: number; actual: number; missing: string[]; unexpected: string[]; duplicates: string[] };

export function rankCFBRows(
  rows: Array<{ team: string; value: number | string | null }>,
  options?: { higherIsBetter?: boolean },
): Record<string, number>;
