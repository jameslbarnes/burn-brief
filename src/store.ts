// App-owned state: ingested messages, watermarks, goals, items, LLM cache.
// New installs live at ~/.burn-brief/app.db. Existing installs keep using the
// legacy directory automatically so the product rename never loses local data.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CompiledGoal, Goal, Item, ItemStatus, ItemType, NormalizedMessage, UserIdentity,
} from "./types.js";

export function appHome(): string {
  const override = process.env.BURN_BRIEF_HOME ?? process.env.WHATSAPP_ATTACHE_HOME;
  if (override) return override;
  const current = join(homedir(), ".burn-brief");
  const legacy = join(homedir(), ".whatsapp-attache");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export type BackendPreference = "auto" | "claude" | "codex";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  chat_jid TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  is_from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT,
  msg_type INTEGER NOT NULL,
  content_hash TEXT,
  priority REAL NOT NULL DEFAULT 0,
  signals TEXT,                     -- JSON array of pre-filter signal names
  llm_status TEXT NOT NULL DEFAULT 'pending'  -- pending | skipped | classified
);
CREATE INDEX IF NOT EXISTS idx_messages_cursor ON messages(source_id, cursor);
CREATE INDEX IF NOT EXISTS idx_messages_llm ON messages(llm_status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, ts);

CREATE TABLE IF NOT EXISTS watermarks (
  source_id TEXT PRIMARY KEY,
  last_cursor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  compiled TEXT,                    -- JSON CompiledGoal
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL,
  score REAL NOT NULL,
  goal_id INTEGER,
  chat_jid TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  source_msg_ids TEXT NOT NULL,     -- JSON array
  fields TEXT NOT NULL,             -- JSON object
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_items_dedupe ON items(dedupe_key);

CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  message_count INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,         -- local YYYY-MM-DD
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  why TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | done | resolved | expired
  first_day TEXT NOT NULL,               -- local YYYY-MM-DD first surfaced
  last_day TEXT NOT NULL,                -- last day the brief surfaced it
  closed_at INTEGER,
  evidence TEXT                          -- chat evidence when auto-resolved
);
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dir: string = appHome()) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "app.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- watermarks -----------------------------------------------------------

  getWatermark(sourceId: string): number {
    const row = this.db
      .prepare(`SELECT last_cursor AS c FROM watermarks WHERE source_id = ?`)
      .get(sourceId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  setWatermark(sourceId: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO watermarks (source_id, last_cursor) VALUES (?, ?)
         ON CONFLICT(source_id) DO UPDATE SET last_cursor = excluded.last_cursor`,
      )
      .run(sourceId, cursor);
  }

  // --- messages -------------------------------------------------------------

  insertMessages(
    msgs: (NormalizedMessage & { priority: number; signals: string[] })[],
  ): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages
        (id, source_id, cursor, chat_jid, chat_name, sender_jid, sender_name,
         is_from_me, ts, text, msg_type, content_hash, priority, signals, llm_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    this.transaction(() => {
      for (const m of msgs) {
        const hash = m.text ? createHash("sha256").update(m.text).digest("hex").slice(0, 16) : null;
        const llmStatus = m.text && !m.isFromMe ? "pending" : "skipped";
        const r = stmt.run(
          m.id, m.sourceId, m.cursor, m.chatJid, m.chatName, m.senderJid,
          m.senderName, m.isFromMe ? 1 : 0, m.ts, m.text, m.msgType, hash,
          m.priority, JSON.stringify(m.signals), llmStatus,
        );
        n += Number(r.changes);
      }
    });
    return n;
  }

  pendingMessages(limit: number, minPriority = 0): StoredMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE llm_status = 'pending' AND text IS NOT NULL AND priority >= ?
         ORDER BY priority DESC, cursor ASC LIMIT ?`,
      )
      .all(minPriority, limit) as StoredMessage[];
  }

  contextBefore(chatJid: string, cursor: number, n: number): StoredMessage[] {
    return (this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_jid = ? AND cursor < ? AND text IS NOT NULL
         ORDER BY cursor DESC LIMIT ?`,
      )
      .all(chatJid, cursor, n) as StoredMessage[]).reverse();
  }

  markClassified(ids: string[]): void {
    const stmt = this.db.prepare(`UPDATE messages SET llm_status = 'classified' WHERE id = ?`);
    this.transaction(() => ids.forEach((id) => stmt.run(id)));
  }

  messageCount(): { total: number; pending: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
    const pending = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE llm_status = 'pending'`)
      .get() as { n: number }).n;
    return { total, pending };
  }

  // --- goals ----------------------------------------------------------------

  addGoal(description: string): number {
    const r = this.db
      .prepare(`INSERT INTO goals (description, created_at) VALUES (?, ?)`)
      .run(description, Math.floor(Date.now() / 1000));
    return Number(r.lastInsertRowid);
  }

  setCompiled(goalId: number, compiled: CompiledGoal): void {
    this.db
      .prepare(`UPDATE goals SET compiled = ? WHERE id = ?`)
      .run(JSON.stringify(compiled), goalId);
  }

  setGoalStatus(goalId: number, status: Goal["status"]): void {
    this.db.prepare(`UPDATE goals SET status = ? WHERE id = ?`).run(status, goalId);
  }

  goals(activeOnly = false): Goal[] {
    const rows = this.db
      .prepare(`SELECT * FROM goals ${activeOnly ? "WHERE status = 'active'" : ""} ORDER BY id`)
      .all() as { id: number; description: string; status: Goal["status"]; compiled: string | null; created_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      description: r.description,
      status: r.status,
      compiled: r.compiled ? (JSON.parse(r.compiled) as CompiledGoal) : null,
      createdAt: r.created_at,
    }));
  }

  // --- items ----------------------------------------------------------------

  insertItem(item: Omit<Item, "id" | "createdAt"> & { dedupeKey?: string | null }): number | null {
    if (item.dedupeKey) {
      const dup = this.db
        .prepare(`SELECT id FROM items WHERE dedupe_key = ? LIMIT 1`)
        .get(item.dedupeKey) as { id: number } | undefined;
      if (dup) {
        // Same item cross-posted: record the extra source, don't create a new card.
        const row = this.db.prepare(`SELECT source_msg_ids FROM items WHERE id = ?`).get(dup.id) as { source_msg_ids: string };
        const ids = new Set<string>(JSON.parse(row.source_msg_ids));
        item.sourceMsgIds.forEach((i) => ids.add(i));
        this.db
          .prepare(`UPDATE items SET source_msg_ids = ? WHERE id = ?`)
          .run(JSON.stringify([...ids]), dup.id);
        return null;
      }
    }
    const r = this.db
      .prepare(
        `INSERT INTO items (type, title, summary, confidence, score, goal_id, chat_jid,
           chat_name, source_msg_ids, fields, dedupe_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.type, item.title, item.summary, item.confidence, item.score,
        item.goalId, item.chatJid, item.chatName, JSON.stringify(item.sourceMsgIds),
        JSON.stringify(item.fields), item.dedupeKey ?? null, item.status,
        Math.floor(Date.now() / 1000),
      );
    return Number(r.lastInsertRowid);
  }

  items(opts: {
    type?: ItemType; status?: ItemStatus; limit?: number;
    excludeDismissed?: boolean; sinceTs?: number; untilTs?: number;
  } = {}): Item[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.type) { where.push("type = ?"); params.push(opts.type); }
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.excludeDismissed) where.push("status != 'dismissed'");
    if (opts.sinceTs) { where.push("created_at >= ?"); params.push(opts.sinceTs); }
    if (opts.untilTs) { where.push("created_at < ?"); params.push(opts.untilTs); }
    const rows = this.db
      .prepare(
        `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY score DESC, id DESC LIMIT ?`,
      )
      .all(...params, opts.limit ?? 100) as ItemRow[];
    return rows.map(rowToItem);
  }

  setItemStatus(id: number, status: ItemStatus): void {
    this.db.prepare(`UPDATE items SET status = ? WHERE id = ?`).run(status, id);
  }

  // --- open loops -----------------------------------------------------------

  openLoops(limit?: number): StoredLoop[] {
    const sql = `SELECT * FROM loops WHERE status = 'open' ORDER BY id`;
    return limit === undefined
      ? this.db.prepare(sql).all() as StoredLoop[]
      : this.db.prepare(`${sql} LIMIT ?`).all(limit) as StoredLoop[];
  }

  recentlyClosedLoops(sinceDay: string): StoredLoop[] {
    return this.db
      .prepare(`SELECT * FROM loops WHERE status != 'open' AND last_day >= ? ORDER BY id`)
      .all(sinceDay) as StoredLoop[];
  }

  /** Bounded action history for the optional completed-items view. */
  closedLoops(limit?: number): StoredLoop[] {
    const sql = `SELECT * FROM loops WHERE status != 'open' ORDER BY closed_at DESC, id DESC`;
    return limit === undefined
      ? this.db.prepare(sql).all() as StoredLoop[]
      : this.db.prepare(`${sql} LIMIT ?`).all(limit) as StoredLoop[];
  }

  insertLoop(title: string, why: string | null, day: string): number {
    const r = this.db
      .prepare(`INSERT INTO loops (title, why, first_day, last_day) VALUES (?, ?, ?, ?)`)
      .run(title, why, day, day);
    return Number(r.lastInsertRowid);
  }

  touchLoop(id: number, title: string, why: string | null, day: string): void {
    this.db
      .prepare(`UPDATE loops SET title = ?, why = ?, last_day = ? WHERE id = ? AND status = 'open'`)
      .run(title, why, day, id);
  }

  closeLoop(id: number, status: "done" | "resolved" | "expired", evidence?: string): void {
    this.db
      .prepare(`UPDATE loops SET status = ?, closed_at = ?, evidence = COALESCE(?, evidence) WHERE id = ?`)
      .run(status, Math.floor(Date.now() / 1000), evidence ?? null, id);
  }

  reopenLoop(id: number): void {
    this.db
      .prepare(`UPDATE loops SET status = 'open', closed_at = NULL, evidence = NULL WHERE id = ?`)
      .run(id);
  }

  /** Loops closed (any way) within the window — shown struck-through briefly. */
  closedLoopsSince(unixTs: number): StoredLoop[] {
    return this.db
      .prepare(`SELECT * FROM loops WHERE status != 'open' AND closed_at >= ? ORDER BY closed_at DESC`)
      .all(unixTs) as StoredLoop[];
  }

  /** Retire loops the brief hasn't surfaced in a while — zombies bloat the prompt. */
  expireStaleLoops(beforeDay: string): number {
    return Number(
      this.db
        .prepare(`UPDATE loops SET status = 'expired', closed_at = ? WHERE status = 'open' AND last_day < ?`)
        .run(Math.floor(Date.now() / 1000), beforeDay).changes,
    );
  }

  // --- llm cache / prompt log ----------------------------------------------

  cacheGet(key: string): string | null {
    const row = this.db.prepare(`SELECT result FROM llm_cache WHERE key = ?`).get(key) as { result: string } | undefined;
    return row?.result ?? null;
  }

  cacheSet(key: string, result: string): void {
    this.db
      .prepare(
        `INSERT INTO llm_cache (key, result, created_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET result = excluded.result`,
      )
      .run(key, result, Math.floor(Date.now() / 1000));
  }

  logPrompt(row: {
    backend: string; model?: string; purpose: string; promptChars: number;
    messageCount?: number; costUsd?: number; durationMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO prompt_log (backend, model, purpose, prompt_chars, message_count, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.backend, row.model ?? null, row.purpose, row.promptChars,
        row.messageCount ?? null, row.costUsd ?? null, row.durationMs ?? null,
        Math.floor(Date.now() / 1000),
      );
  }

  // --- burn config ----------------------------------------------------------

  private metaGet(k: string): string | null {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
    return row?.v ?? null;
  }

  private metaSet(k: string, v: string): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(k, v);
  }

  /** Watched burn-chat JIDs. Empty array = nothing configured yet (watch all). */
  getWatchedJids(): string[] {
    return JSON.parse(this.metaGet("watched_jids") ?? "[]") as string[];
  }

  setWatchedJids(jids: string[]): void {
    this.metaSet("watched_jids", JSON.stringify([...new Set(jids)]));
  }

  /** Gate date, ISO YYYY-MM-DD. */
  getGateDate(): string {
    return this.metaGet("gate_date") ?? "2026-08-30";
  }

  setGateDate(iso: string): void {
    this.metaSet("gate_date", iso);
  }

  /**
   * The user's current focus: what their WhatsApp attention is organized
   * around right now. Free text plus an optional anchor date the whole app
   * counts down to, plus compiled keywords that gate tier-2 classification.
   */
  getFocus(): {
    text: string | null;
    anchorDate: string | null;
    anchorLabel: string;
    keywords: string[];
  } {
    return {
      text: this.metaGet("focus_text"),
      anchorDate: this.metaGet("focus_anchor_date"),
      anchorLabel: this.metaGet("focus_anchor_label") ?? "the day",
      keywords: JSON.parse(this.metaGet("focus_keywords") ?? "[]") as string[],
    };
  }

  setFocus(f: { text?: string; anchorDate?: string | null; anchorLabel?: string; keywords?: string[] }): void {
    if (f.text !== undefined) this.metaSet("focus_text", f.text);
    if (f.anchorDate !== undefined && f.anchorDate !== null) this.metaSet("focus_anchor_date", f.anchorDate);
    if (f.anchorLabel !== undefined) this.metaSet("focus_anchor_label", f.anchorLabel);
    if (f.keywords !== undefined) this.metaSet("focus_keywords", JSON.stringify(f.keywords));
  }

  /** First-run consent: unix seconds when granted, or null. */
  getConsentAt(): number | null {
    const v = this.metaGet("consent_granted_at");
    return v ? Number(v) : null;
  }

  grantConsent(): void {
    if (!this.metaGet("consent_granted_at")) {
      this.metaSet("consent_granted_at", String(Math.floor(Date.now() / 1000)));
    }
  }

  getBackendPreference(): BackendPreference {
    const value = this.metaGet("agent_backend");
    return value === "claude" || value === "codex" ? value : "auto";
  }

  setBackendPreference(value: BackendPreference): void {
    this.metaSet("agent_backend", value);
  }

  getDigestAutosend(): boolean {
    return this.metaGet("digest_autosend") === "on";
  }

  setDigestAutosend(enabled: boolean): void {
    this.metaSet("digest_autosend", enabled ? "on" : "off");
  }

  // --- profile & digests ----------------------------------------------------

  getProfile(): string | null {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = 'profile_text'`).get() as { v: string } | undefined;
    return row?.v ?? null;
  }

  setProfile(text: string): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES ('profile_text', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(text);
  }

  saveDigest(day: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO digests (day, json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
      )
      .run(day, json, Math.floor(Date.now() / 1000));
  }

  getDigest(day: string): { day: string; json: string; createdAt: number } | null {
    const row = this.db
      .prepare(`SELECT day, json, created_at AS createdAt FROM digests WHERE day = ?`)
      .get(day) as { day: string; json: string; createdAt: number } | undefined;
    return row ?? null;
  }

  latestDigest(): { day: string; json: string; createdAt: number } | null {
    const row = this.db
      .prepare(`SELECT day, json, created_at AS createdAt FROM digests ORDER BY day DESC LIMIT 1`)
      .get() as { day: string; json: string; createdAt: number } | undefined;
    return row ?? null;
  }

  /** Current saved edition when regenerating a day, otherwise the nearest earlier edition. */
  latestDigestOnOrBefore(day: string): { day: string; json: string; createdAt: number } | null {
    const row = this.db
      .prepare(`SELECT day, json, created_at AS createdAt FROM digests WHERE day <= ? ORDER BY day DESC LIMIT 1`)
      .get(day) as { day: string; json: string; createdAt: number } | undefined;
    return row ?? null;
  }

  // --- identity -------------------------------------------------------------

  getIdentity(): UserIdentity {
    const get = (k: string) => {
      const row = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
      return row?.v ?? null;
    };
    const jid = get("own_jid");
    return {
      ownJid: jid,
      ownPhone: jid ? jid.split("@")[0] : null,
      aliases: JSON.parse(get("aliases") ?? "[]") as string[],
    };
  }

  setIdentity(id: Partial<UserIdentity>): void {
    const set = this.db.prepare(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    );
    if (id.ownJid !== undefined && id.ownJid !== null) set.run("own_jid", id.ownJid);
    if (id.aliases !== undefined) set.run("aliases", JSON.stringify(id.aliases));
  }

  close(): void {
    this.db.close();
  }
}

export type StoredLoop = {
  id: number;
  title: string;
  why: string | null;
  status: "open" | "done" | "resolved" | "expired";
  first_day: string;
  last_day: string;
  closed_at: number | null;
  evidence: string | null;
};

export type StoredMessage = {
  id: string;
  source_id: string;
  cursor: number;
  chat_jid: string;
  chat_name: string;
  sender_jid: string | null;
  sender_name: string | null;
  is_from_me: number;
  ts: number;
  text: string | null;
  msg_type: number;
  content_hash: string | null;
  priority: number;
  signals: string | null;
  llm_status: string;
};

type ItemRow = {
  id: number; type: ItemType; title: string; summary: string; confidence: number;
  score: number; goal_id: number | null; chat_jid: string; chat_name: string;
  source_msg_ids: string; fields: string; dedupe_key: string | null;
  status: ItemStatus; created_at: number;
};

function rowToItem(r: ItemRow): Item {
  return {
    id: r.id, type: r.type, title: r.title, summary: r.summary,
    confidence: r.confidence, score: r.score, goalId: r.goal_id,
    chatJid: r.chat_jid, chatName: r.chat_name,
    sourceMsgIds: JSON.parse(r.source_msg_ids) as string[],
    fields: JSON.parse(r.fields) as Record<string, unknown>,
    status: r.status, createdAt: r.created_at,
  };
}
