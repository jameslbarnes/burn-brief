// Orchestration: ingest -> prefilter -> classify -> items.

import type { AgentBackend } from "./agent/backend.js";
import { classifyBatch, dedupeKey, makeBatches, type Candidate } from "./classify.js";
import { prefilter } from "./prefilter.js";
import type { Store, StoredMessage } from "./store.js";
import type { Item, Source } from "./types.js";

const INGEST_PAGE = 5000;

export interface IngestStats {
  scanned: number;
  inserted: number;
  newWatermark: number;
}

export function ingest(source: Source, store: Store): IngestStats {
  const identity = store.getIdentity();
  const goals = store.goals(true);
  const watched = new Set(store.getWatchedJids());
  const focusKeywords = store.getFocus().keywords;
  let watermark = store.getWatermark(source.id);
  let scanned = 0;
  let inserted = 0;
  for (;;) {
    const page = source.fetchNewGroupMessages(watermark, INGEST_PAGE);
    if (page.length === 0) break;
    scanned += page.length;
    const enriched = page.map((m) => {
      const pf = prefilter(m, identity, goals, focusKeywords);
      // Watched burn chats classify first and in full.
      const isWatched = watched.has(m.chatJid);
      return {
        ...m,
        priority: pf.priority + (isWatched ? 2 : 0),
        signals: isWatched ? [...pf.signals, "watched"] : pf.signals,
      };
    });
    inserted += store.insertMessages(enriched);
    watermark = page[page.length - 1].cursor;
    store.setWatermark(source.id, watermark);
  }
  // Nothing is filtered out by default: a flood (like burn comms) buries the
  // rest of life, so EVERYTHING gets classified eventually. Watched chats and
  // focus signals only affect priority — they classify first, never alone.
  return { scanned, inserted, newWatermark: watermark };
}

export interface ClassifyStats {
  batches: number;
  messages: number;
  candidates: number;
  itemsCreated: number;
  merged: number;
  costUsd: number;
  errors: number;
}

export interface ClassifyProgress {
  kind: "start" | "done";
  messagesDone: number;
  messagesTotal: number;
  itemsCreated: number;
  /** Titles of items created by the batch that just finished. */
  titles: string[];
  /** Batches currently in flight — lets the UI show life between completions. */
  inFlight?: number;
  /** Chat the batch belongs to, for "now reading" display. */
  chat?: string;
}

export async function classifyPending(
  backend: AgentBackend,
  store: Store,
  opts: {
    maxBatches?: number; batchSize?: number; minPriority?: number;
    /** Concurrent agent calls. Batches are disjoint, so order never matters;
        this trades idle subscription time for wall-clock. */
    concurrency?: number;
    onProgress?: (ev: ClassifyProgress) => void;
  } = {},
): Promise<ClassifyStats> {
  const batchSize = opts.batchSize ?? 50;
  const maxBatches = opts.maxBatches ?? 20;
  const minPriority = opts.minPriority ?? 0;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const identity = store.getIdentity();
  const goals = store.goals(true);

  const pending = store.pendingMessages(batchSize * maxBatches, minPriority);
  const batches = makeBatches(pending, batchSize).slice(0, maxBatches);

  const stats: ClassifyStats = {
    batches: 0, messages: 0, candidates: 0, itemsCreated: 0, merged: 0, costUsd: 0, errors: 0,
  };
  const messagesTotal = batches.reduce((n, b) => n + b.length, 0);
  let messagesDone = 0;
  opts.onProgress?.({ kind: "start", messagesDone, messagesTotal, itemsCreated: 0, titles: [] });

  let nextBatch = 0;
  let inFlight = 0;
  let lastErr: unknown = null;
  const retryQueue: StoredMessage[][] = [];
  const retried = new Set<StoredMessage[]>();
  const worker = async () => {
    for (;;) {
      // Three hard failures stop the run; anything unclassified stays pending
      // and a later tick retries it. Each batch gets one same-run requeue
      // first, so a transient rate-limit burst degrades to slower, not dead.
      if (stats.errors >= 3) return;
      const i = nextBatch++;
      const batch = i < batches.length ? batches[i] : retryQueue.shift();
      if (!batch) return;
      inFlight += 1;
      opts.onProgress?.({ kind: "start", messagesDone, messagesTotal, itemsCreated: stats.itemsCreated, titles: [], inFlight, chat: batch[0].chat_name });
      try {
        const candidates = await classifyBatch(backend, store, batch, identity, goals);
        stats.candidates += candidates.length;
        const titles: string[] = [];
        for (const c of candidates) {
          const created = storeCandidate(store, c, batch);
          if (created === null) stats.merged += 1;
          else { stats.itemsCreated += 1; titles.push(c.title.slice(0, 100)); }
        }
        store.markClassified(batch.map((m) => m.id));
        stats.batches += 1;
        stats.messages += batch.length;
        messagesDone += batch.length;
        inFlight -= 1;
        opts.onProgress?.({ kind: "done", messagesDone, messagesTotal, itemsCreated: stats.itemsCreated, titles, inFlight, chat: batch[0].chat_name });
      } catch (err) {
        inFlight -= 1;
        opts.onProgress?.({ kind: "done", messagesDone, messagesTotal, itemsCreated: stats.itemsCreated, titles: [], inFlight, chat: batch[0].chat_name });
        if (!retried.has(batch)) {
          retried.add(batch);
          retryQueue.push(batch);
          console.error(`batch failed, requeued (${batch[0].chat_name}): ${String(err).slice(0, 200)}`);
        } else {
          stats.errors += 1;
          lastErr = err;
          console.error(`batch failed twice (${batch[0].chat_name}): ${String(err).slice(0, 300)}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(batches.length, 1)) }, worker));
  if (stats.errors >= 3 && lastErr) throw lastErr;
  return stats;
}

function storeCandidate(
  store: Store,
  c: Candidate,
  batch: StoredMessage[],
): number | null {
  const first = batch.find((m) => c.source_msg_ids.includes(m.id)) ?? batch[0];
  const ageDays = (Date.now() / 1000 - first.ts) / 86400;
  // Marketplace-ish types (rides, tickets, gear) go stale fast in crunch;
  // cutoffs instead score UP as their deadline approaches.
  let freshness = 1;
  if (c.type === "ride" || c.type === "ticket" || c.type === "gear") {
    freshness = Math.pow(0.5, ageDays / 3);
  } else if (c.type === "cutoff" && typeof c.fields?.deadline_iso === "string") {
    const dl = Date.parse(c.fields.deadline_iso as string);
    if (!Number.isNaN(dl)) {
      const daysLeft = (dl - Date.now()) / 86400000;
      freshness = daysLeft < 0 ? 0.2 : daysLeft <= 1 ? 1.5 : daysLeft <= 3 ? 1.25 : 1;
    }
  }
  const item: Omit<Item, "id" | "createdAt"> & { dedupeKey?: string | null } = {
    type: c.type,
    title: c.title.slice(0, 120),
    summary: c.summary,
    confidence: c.confidence,
    score: c.confidence * freshness,
    goalId: c.goal_id ?? null,
    chatJid: first.chat_jid,
    chatName: first.chat_name,
    sourceMsgIds: c.source_msg_ids,
    fields: c.fields ?? {},
    status: "new",
    dedupeKey: dedupeKey(c),
  };
  return store.insertItem(item);
}
