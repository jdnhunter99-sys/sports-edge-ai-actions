type MovementRow = Record<string, any>;

type MarketQuote = {
  line: number;
  odds: number | null;
  side?: 'over' | 'under';
};

type SpreadPair = {
  awaySpread: number;
  homeSpread: number;
  awayOdds: number | null;
  homeOdds: number | null;
};

type TotalPair = {
  total: number;
  overOdds: number | null;
  underOdds: number | null;
};

/**
 * ScoresAndOdds' historical movement table records only the price for the
 * displayed side. Its live sportsbook table has paired prices, so use those
 * when a matching line exists. For older line snapshots where no paired quote
 * remains, estimate the opposite side using a standard -110/-110 market hold
 * and label that value as estimated in the published row.
 */
export function pairMissingMovementOdds(html: string, rows: MovementRow[], gameId: string): MovementRow[] {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  const id = String(gameId || '').replace(/[^0-9]/g, '');
  const spreadPairs = readSpreadPairs(html, id);
  const totalPairs = readTotalPairs(html, id);

  return rows.map((sourceRow, index) => {
    const row = { ...sourceRow };
    const isCurrentPoint = index === rows.length - 1;
    fillSpreadOdds(row, spreadPairs, isCurrentPoint);
    fillTotalOdds(row, totalPairs, isCurrentPoint);
    return row;
  });
}

function fillSpreadOdds(row: MovementRow, pairs: SpreadPair[], isCurrentPoint: boolean) {
  if (row.awaySpread == null && row.homeSpread == null) return;

  const needsAway = row.awaySpreadOdds == null;
  const needsHome = row.homeSpreadOdds == null;
  if (!needsAway && !needsHome) return;

  const pair = choosePair(pairs.filter((candidate) => (
    sameLine(candidate.awaySpread, row.awaySpread) && sameLine(candidate.homeSpread, row.homeSpread)
  )), row.awaySpreadOdds, row.homeSpreadOdds, 'awayOdds', 'homeOdds');
  const matchedRecordedPrice = Boolean(pair && (
    (row.awaySpreadOdds != null && Number(pair.awayOdds) === Number(row.awaySpreadOdds)) ||
    (row.homeSpreadOdds != null && Number(pair.homeOdds) === Number(row.homeSpreadOdds))
  ));

  if (pair) {
    if (needsAway && pair.awayOdds != null) {
      row.awaySpreadOdds = pair.awayOdds;
      row.awaySpreadOddsEstimated = !(isCurrentPoint && matchedRecordedPrice);
      row.awaySpreadOddsSource = row.awaySpreadOddsEstimated ? 'scoresandodds-live-paired-quote' : 'scoresandodds-history';
    }
    if (needsHome && pair.homeOdds != null) {
      row.homeSpreadOdds = pair.homeOdds;
      row.homeSpreadOddsEstimated = !(isCurrentPoint && matchedRecordedPrice);
      row.homeSpreadOddsSource = row.homeSpreadOddsEstimated ? 'scoresandodds-live-paired-quote' : 'scoresandodds-history';
    }
  }

  if (row.awaySpreadOdds == null && row.homeSpreadOdds != null) {
    row.awaySpreadOdds = estimateOppositeOdds(row.homeSpreadOdds);
    row.awaySpreadOddsEstimated = row.awaySpreadOdds != null;
    row.awaySpreadOddsSource = 'balanced-market-estimate';
  }
  if (row.homeSpreadOdds == null && row.awaySpreadOdds != null) {
    row.homeSpreadOdds = estimateOppositeOdds(row.awaySpreadOdds);
    row.homeSpreadOddsEstimated = row.homeSpreadOdds != null;
    row.homeSpreadOddsSource = 'balanced-market-estimate';
  }
}

function fillTotalOdds(row: MovementRow, pairs: TotalPair[], isCurrentPoint: boolean) {
  if (row.total == null) return;

  const needsOver = row.overOdds == null;
  const needsUnder = row.underOdds == null;
  if (!needsOver && !needsUnder) return;

  const pair = choosePair(pairs.filter((candidate) => sameLine(candidate.total, row.total)), row.overOdds, row.underOdds, 'overOdds', 'underOdds');
  const matchedRecordedPrice = Boolean(pair && (
    (row.overOdds != null && Number(pair.overOdds) === Number(row.overOdds)) ||
    (row.underOdds != null && Number(pair.underOdds) === Number(row.underOdds))
  ));
  if (pair) {
    if (needsOver && pair.overOdds != null) {
      row.overOdds = pair.overOdds;
      row.overOddsEstimated = !(isCurrentPoint && matchedRecordedPrice);
      row.overOddsSource = row.overOddsEstimated ? 'scoresandodds-live-paired-quote' : 'scoresandodds-history';
    }
    if (needsUnder && pair.underOdds != null) {
      row.underOdds = pair.underOdds;
      row.underOddsEstimated = !(isCurrentPoint && matchedRecordedPrice);
      row.underOddsSource = row.underOddsEstimated ? 'scoresandodds-live-paired-quote' : 'scoresandodds-history';
    }
  }

  if (row.overOdds == null && row.underOdds != null) {
    row.overOdds = estimateOppositeOdds(row.underOdds);
    row.overOddsEstimated = row.overOdds != null;
    row.overOddsSource = 'balanced-market-estimate';
  }
  if (row.underOdds == null && row.overOdds != null) {
    row.underOdds = estimateOppositeOdds(row.overOdds);
    row.underOddsEstimated = row.underOdds != null;
    row.underOddsSource = 'balanced-market-estimate';
  }
}

function choosePair<T extends Record<string, any>>(
  candidates: T[],
  firstKnown: number | null,
  secondKnown: number | null,
  firstKey: string,
  secondKey: string,
): T | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => pairScore(a, firstKnown, secondKnown, firstKey, secondKey) - pairScore(b, firstKnown, secondKnown, firstKey, secondKey))[0];
}

function pairScore(pair: Record<string, any>, firstKnown: number | null, secondKnown: number | null, firstKey: string, secondKey: string) {
  let score = 0;
  if (pair[firstKey] == null) score += 100000;
  else if (firstKnown != null) score += Math.abs(Number(pair[firstKey]) - Number(firstKnown));
  if (pair[secondKey] == null) score += 100000;
  else if (secondKnown != null) score += Math.abs(Number(pair[secondKey]) - Number(secondKnown));
  return score;
}

function readSpreadPairs(html: string, id: string): SpreadPair[] {
  const marketRows = readMarketRows(html, id, 'spread');
  if (marketRows.length < 2) return [];
  const awayQuotes = marketRows[0];
  const homeQuotes = marketRows[1];
  const pairs: SpreadPair[] = [];

  for (let index = 0; index < Math.min(awayQuotes.length, homeQuotes.length); index++) {
    const first = awayQuotes[index];
    const second = homeQuotes[index];
    if (!first || !second || !sameLine(first.line, -second.line)) continue;
    pairs.push({ awaySpread: first.line, homeSpread: second.line, awayOdds: first.odds, homeOdds: second.odds });
    pairs.push({ awaySpread: second.line, homeSpread: first.line, awayOdds: second.odds, homeOdds: first.odds });
  }
  return pairs;
}

function readTotalPairs(html: string, id: string): TotalPair[] {
  const marketRows = readMarketRows(html, id, 'total');
  if (marketRows.length < 2) return [];
  const overQuotes = marketRows[0];
  const underQuotes = marketRows[1];
  const pairs: TotalPair[] = [];

  for (let index = 0; index < Math.min(overQuotes.length, underQuotes.length); index++) {
    const first = overQuotes[index];
    const second = underQuotes[index];
    if (!first || !second || first.side === second.side) continue;
    const over = first.side === 'over' ? first : second;
    const under = first.side === 'under' ? first : second;
    if (!sameLine(over.line, under.line)) continue;
    pairs.push({ total: over.line, overOdds: over.odds, underOdds: under.odds });
  }
  return pairs;
}

function readMarketRows(html: string, id: string, market: 'spread' | 'total'): Array<Array<MarketQuote | null>> {
  if (!id) return [];
  const bodyPattern = new RegExp(`<tbody[^>]*id=["']odds-table-${market}--${id}["'][^>]*>([\\s\\S]*?)<\\/tbody>`, 'i');
  const body = bodyPattern.exec(String(html || ''))?.[1];
  if (!body) return [];

  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
    const row = rowMatch[1];
    return [...row.matchAll(/<td[^>]*class=["'][^"']*game-odds[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)].map((cellMatch) => {
      const cell = cellMatch[1];
      const value = decodeText(/<span[^>]*class=["'][^"']*data-value[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(cell)?.[1] || '');
      const oddsText = decodeText(/<small[^>]*class=["'][^"']*data-odds[^"']*["'][^>]*>([\s\S]*?)<\/small>/i.exec(cell)?.[1] || '');
      const odds = parseOdds(oddsText);

      if (market === 'spread') {
        const line = parseLine(value);
        return line == null ? null : { line, odds };
      }

      const leadingSide = /^(o|u|over|under)\s*(\d+(?:\.\d+)?)/i.exec(value);
      const trailingSide = /^(\d+(?:\.\d+)?)\s*(o|u|over|under)$/i.exec(value);
      const line = leadingSide ? Number(leadingSide[2]) : trailingSide ? Number(trailingSide[1]) : NaN;
      const sideToken = (leadingSide?.[1] || trailingSide?.[2] || '').toLowerCase();
      if (!Number.isFinite(line) || !sideToken) return null;
      return { line, odds, side: sideToken === 'o' || sideToken === 'over' ? 'over' : 'under' };
    });
  });
}

function parseLine(value: string): number | null {
  const raw = value.trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'PK' || raw === 'PICK') return 0;
  const line = Number(raw.replace(/,/g, ''));
  return Number.isFinite(line) ? line : null;
}

function parseOdds(value: string): number | null {
  const raw = value.trim().toUpperCase().replace(/,/g, '');
  if (!raw) return null;
  if (raw === 'EV' || raw === 'EVEN') return 100;
  const odds = Number(raw);
  return Number.isFinite(odds) ? odds : null;
}

function estimateOppositeOdds(value: number): number | null {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;

  // Most standard spread/total pairs fall on a symmetric -110 scale. Keeping
  // that familiar 10-cent pairing gives the exact counterpart for common
  // prices such as -108/-112, -115/-105, and -118/-102.
  if (odds < 0 && Math.abs(odds) <= 120) return -(220 - Math.abs(odds));

  const implied = odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  const oppositeImplied = 1.046 - implied;
  if (oppositeImplied <= 0 || oppositeImplied >= 1) return null;
  return oppositeImplied >= 0.5
    ? -Math.round(100 * oppositeImplied / (1 - oppositeImplied))
    : Math.round(100 * (1 - oppositeImplied) / oppositeImplied);
}

function sameLine(first: unknown, second: unknown): boolean {
  if (first == null || second == null) return false;
  const a = Number(first);
  const b = Number(second);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
}

function decodeText(value: string): string {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}
