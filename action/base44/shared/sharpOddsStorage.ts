// Batched SharpOddsDatabase snapshot writer.
//
// A full NFL/NCAAF refresh produces dozens of snapshot documents that together
// reach tens of MB. Submitting every record in a single bulkCreate payload
// exceeds the worker's request/memory limits, and submitting one small call per
// game generates so many API calls that the platform rate-limits the refresh.
// Records are therefore buffered into size-capped bulk batches (aggregated
// across games), with a per-record fallback once a bulk call fails.
//
// Every snapshot is written on every poll. Before storage, records pass through
// compactNulls(): a LOSSLESS compaction that drops object keys whose value is
// null/undefined. Absent keys and null-valued keys are identical to every
// reader (both yield undefined), so no market, line, price, availability flag,
// or raw metadata is lost — it only trims the write traffic the raw observation
// payloads spend on null metadata fields, keeping the 10-minute refresh cadence
// within the app entity write traffic budget.

import { AnyObject } from './sharpOddsCommon.ts';

const MAX_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_BATCH_RECORDS = 16;

// Drop null/undefined object keys (recursively). Array elements keep their
// positions — nulls inside arrays are preserved because positions carry meaning.
function compactNulls(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => (item === null || item === undefined ? item : compactNulls(item)));
  }
  if (value && typeof value === 'object') {
    const out: AnyObject = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === null || val === undefined) continue;
      out[key] = typeof val === 'object' ? compactNulls(val) : val;
    }
    return out;
  }
  return value;
}

type Writer = {
  add: (records: AnyObject[]) => Promise<void>;
  flush: () => Promise<void>;
};

export function createSharpSnapshotWriter(base44: any): Writer {
  let pending: AnyObject[] = [];
  let pendingBytes = 0;
  let bulkFailed = false;

  const writeBatch = async (batch: AnyObject[]) => {
    if (!batch.length) return;
    if (!bulkFailed) {
      try {
        if (typeof base44.asServiceRole.entities.SharpOddsDatabase.bulkCreate === 'function') {
          await base44.asServiceRole.entities.SharpOddsDatabase.bulkCreate(batch);
          return;
        }
      } catch (_bulkError) {
        bulkFailed = true;
      }
    }
    for (const record of batch) {
      await base44.asServiceRole.entities.SharpOddsDatabase.create(record);
    }
  };

  const flush = async () => {
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    await writeBatch(batch);
  };

  const add = async (records: AnyObject[]) => {
    if (!Array.isArray(records) || !records.length) return;
    for (const rawRecord of records) {
      const record = compactNulls(rawRecord);
      const size = Number(record?.snapshot_payload_bytes_estimate) || 0;
      if (pending.length && (pendingBytes + size > MAX_BATCH_BYTES || pending.length >= MAX_BATCH_RECORDS)) {
        await flush();
      }
      pending.push(record);
      pendingBytes += size;
    }
  };

  return { add, flush };
}

export async function createSharpSnapshots(base44: any, records: AnyObject[]) {
  if (!records.length) return;
  const writer = createSharpSnapshotWriter(base44);
  await writer.add(records);
  await writer.flush();
}