// Small primitives for calling third-party sites from edge functions.
//
// mapWithConcurrency: same results and order as Promise.all(items.map(worker)),
// but never more than `limit` workers in flight. A slate-sized fan-out against
// ScoresAndOdds (130 CFB games) was previously 130 simultaneous requests.
//
// fetchWithTimeout: fetch that aborts after `timeoutMs`. None of the odds
// scrapers bounded their upstream requests, so a stalled page could hang the
// whole function (and the scheduled job behind it) indefinitely.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  async function runLane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: lanes }, runLane));
  return results;
}

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
