// Read-only source over WhatsApp Desktop for macOS's ChatStorage.sqlite.
// This schema is undocumented and can change with any WhatsApp update, so the
// probe verifies every table/column we rely on before any query runs.

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatMeta,
  InviteLink,
  NormalizedMessage,
  Source,
  SourceProbe,
} from "../types.js";

export const DEFAULT_DB_PATH = join(
  homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
);

/** Apple Core Data epoch offset: unix = ZMESSAGEDATE + 978307200 */
const APPLE_EPOCH = 978307200;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  ZWAMESSAGE: [
    "Z_PK", "ZCHATSESSION", "ZISFROMME", "ZMESSAGEDATE", "ZMESSAGETYPE",
    "ZFROMJID", "ZTOJID", "ZPUSHNAME", "ZTEXT",
  ],
  ZWACHATSESSION: ["Z_PK", "ZSESSIONTYPE", "ZCONTACTJID", "ZPARTNERNAME"],
  ZWAMESSAGEDATAITEM: ["ZMATCHEDTEXT", "ZCHATJID", "ZSENDERJID", "ZTITLE", "ZSUMMARY", "ZDATE", "ZMESSAGE"],
  ZWAPROFILEPUSHNAME: ["ZJID", "ZPUSHNAME"],
};

export class MacSqliteSource implements Source {
  readonly id = "mac-sqlite";
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.db = this.open();
  }

  private open(): Database.Database {
    try {
      return new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      // Lock contention or torn WAL state: fall back to a snapshot copy.
      return this.openSnapshot(err);
    }
  }

  private openSnapshot(cause: unknown): Database.Database {
    const snapDir = join(tmpdir(), "burn-brief-snap");
    mkdirSync(snapDir, { recursive: true });
    const snap = join(snapDir, "ChatStorage.sqlite");
    try {
      copyFileSync(this.dbPath, snap);
      for (const ext of ["-wal", "-shm"]) {
        if (existsSync(this.dbPath + ext)) copyFileSync(this.dbPath + ext, snap + ext);
      }
      return new Database(snap, { readonly: true, fileMustExist: true });
    } catch {
      throw new Error(
        `Cannot open WhatsApp database at ${this.dbPath}. ` +
          `Is WhatsApp Desktop installed and does this process have Full Disk Access? ` +
          `Original error: ${String(cause)}`,
      );
    }
  }

  probe(): SourceProbe {
    try {
      for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
        const found = this.db
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table) as { name: string }[];
        if (found.length === 0) return { ok: false, detail: `missing table ${table}` };
        const names = new Set(found.map((c) => c.name));
        const missing = cols.filter((c) => !names.has(c));
        if (missing.length > 0) {
          return { ok: false, detail: `table ${table} missing columns: ${missing.join(", ")}` };
        }
      }
      return {
        ok: true,
        detail: `schema ok at ${this.dbPath}`,
        ownJid: this.ownJid(),
        maxCursor: this.maxCursor(),
      };
    } catch (err) {
      return { ok: false, detail: `probe failed: ${String(err)}` };
    }
  }

  ownJid(): string | null {
    // Incoming DM messages carry the account owner's JID in ZTOJID.
    const row = this.db
      .prepare(
        `SELECT m.ZTOJID AS jid, COUNT(*) AS c
         FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
         WHERE s.ZSESSIONTYPE = 0 AND m.ZISFROMME = 0
           AND m.ZTOJID LIKE '%@s.whatsapp.net'
         GROUP BY 1 ORDER BY c DESC LIMIT 1`,
      )
      .get() as { jid: string } | undefined;
    return row?.jid ?? null;
  }

  maxCursor(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(Z_PK), 0) AS pk FROM ZWAMESSAGE`)
      .get() as { pk: number };
    return row.pk;
  }

  listGroupChats(): ChatMeta[] {
    const rows = this.db
      .prepare(
        `SELECT s.ZCONTACTJID AS jid, s.ZPARTNERNAME AS name,
                (SELECT COUNT(*) FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = s.Z_PK) AS n
         FROM ZWACHATSESSION s WHERE s.ZSESSIONTYPE = 1
         ORDER BY n DESC`,
      )
      .all() as { jid: string | null; name: string | null; n: number }[];
    return rows
      .filter((r) => r.jid)
      .map((r) => ({
        jid: r.jid!,
        name: r.name ?? r.jid!,
        kind: "group" as const,
        messageCount: r.n,
      }));
  }

  fetchNewGroupMessages(afterCursor: number, limit: number): NormalizedMessage[] {
    // Groups AND 1:1 DMs — crunch logistics migrate to DMs. Downstream tiers
    // decide what reaches the classifier; ingestion is comprehensive.
    const rows = this.db
      .prepare(
        `SELECT m.Z_PK AS pk, m.ZMESSAGEDATE AS date, m.ZISFROMME AS fromMe,
                m.ZFROMJID AS fromJid, m.ZPUSHNAME AS pushName, m.ZTEXT AS text,
                m.ZMESSAGETYPE AS msgType,
                s.ZCONTACTJID AS chatJid, s.ZPARTNERNAME AS chatName
         FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
         WHERE s.ZSESSIONTYPE IN (0, 1) AND m.Z_PK > ?
         ORDER BY m.Z_PK ASC LIMIT ?`,
      )
      .all(afterCursor, limit) as {
      pk: number; date: number; fromMe: number; fromJid: string | null;
      pushName: string | null; text: string | null; msgType: number;
      chatJid: string | null; chatName: string | null;
    }[];
    return rows
      .filter((r) => r.chatJid)
      .map((r) => ({
        id: `${this.id}:${r.pk}`,
        sourceId: this.id,
        cursor: r.pk,
        chatJid: r.chatJid!,
        chatName: r.chatName ?? r.chatJid!,
        senderJid: r.fromMe ? null : r.fromJid,
        senderName: r.fromMe ? "me" : r.pushName,
        isFromMe: !!r.fromMe,
        ts: r.date + APPLE_EPOCH,
        text: r.text,
        msgType: r.msgType,
      }));
  }

  /** One-time backfill: 1:1 messages already below the watermark. */
  fetchRecentDirectMessages(sinceUnix: number): NormalizedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.Z_PK AS pk, m.ZMESSAGEDATE AS date, m.ZISFROMME AS fromMe,
                m.ZFROMJID AS fromJid, m.ZPUSHNAME AS pushName, m.ZTEXT AS text,
                m.ZMESSAGETYPE AS msgType,
                s.ZCONTACTJID AS chatJid, s.ZPARTNERNAME AS chatName
         FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
         WHERE s.ZSESSIONTYPE = 0 AND m.ZMESSAGEDATE + ${APPLE_EPOCH} > ?
         ORDER BY m.Z_PK ASC`,
      )
      .all(sinceUnix) as {
      pk: number; date: number; fromMe: number; fromJid: string | null;
      pushName: string | null; text: string | null; msgType: number;
      chatJid: string | null; chatName: string | null;
    }[];
    return rows
      .filter((r) => r.chatJid)
      .map((r) => ({
        id: `${this.id}:${r.pk}`,
        sourceId: this.id,
        cursor: r.pk,
        chatJid: r.chatJid!,
        chatName: r.chatName ?? r.chatJid!,
        senderJid: r.fromMe ? null : r.fromJid,
        senderName: r.fromMe ? "me" : r.pushName,
        isFromMe: !!r.fromMe,
        ts: r.date + APPLE_EPOCH,
        text: r.text,
        msgType: r.msgType,
      }));
  }

  fetchInviteLinks(): InviteLink[] {
    const rows = this.db
      .prepare(
        `SELECT d.ZMATCHEDTEXT AS url, d.ZCHATJID AS chatJid, d.ZSENDERJID AS senderJid,
                d.ZDATE AS date, d.ZTITLE AS title, d.ZSUMMARY AS summary, d.ZMESSAGE AS msgPk
         FROM ZWAMESSAGEDATAITEM d
         WHERE d.ZMATCHEDTEXT LIKE '%chat.whatsapp.com%'
         ORDER BY d.ZDATE DESC`,
      )
      .all() as {
      url: string; chatJid: string | null; senderJid: string | null;
      date: number | null; title: string | null; summary: string | null; msgPk: number | null;
    }[];
    return rows.map((r) => ({
      url: r.url,
      chatJid: r.chatJid,
      senderJid: r.senderJid,
      ts: r.date != null ? r.date + APPLE_EPOCH : null,
      title: r.title,
      summary: r.summary,
      messagePk: r.msgPk,
    }));
  }

  /** JID -> self-set display name map, for rendering senders. */
  pushNames(): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME WHERE ZJID IS NOT NULL AND ZPUSHNAME IS NOT NULL`)
      .all() as { jid: string; name: string }[];
    return new Map(rows.map((r) => [r.jid, r.name]));
  }

  close(): void {
    this.db.close();
  }
}
