// Core domain types. Everything downstream of a Source is source-agnostic.

/** A message normalized out of whatever backend produced it. */
export interface NormalizedMessage {
  /** Stable id: `${sourceId}:${nativePk}` */
  id: string;
  sourceId: string;
  /** Monotonic cursor value within the source (Z_PK for mac-sqlite). */
  cursor: number;
  chatJid: string;
  chatName: string;
  senderJid: string | null;
  senderName: string | null;
  isFromMe: boolean;
  /** Unix epoch seconds. */
  ts: number;
  text: string | null;
  /** Source-native message type (0 = text on mac-sqlite). */
  msgType: number;
}

export interface ChatMeta {
  jid: string;
  name: string;
  /** 'group' | 'dm' | 'other' */
  kind: "group" | "dm" | "other";
  messageCount: number;
}

export interface InviteLink {
  url: string;
  chatJid: string | null;
  senderJid: string | null;
  ts: number | null;
  title: string | null;
  summary: string | null;
  messagePk: number | null;
}

export interface SourceProbe {
  ok: boolean;
  detail: string;
  /** Present when ok. */
  ownJid?: string | null;
  maxCursor?: number;
}

/**
 * A pluggable message backend. v1 ships MacSqliteSource; a linked-device
 * protocol source (Baileys) can implement the same surface later.
 */
export interface Source {
  id: string;
  probe(): SourceProbe;
  /** Group chats only for v1 — DMs are excluded by design. */
  listGroupChats(): ChatMeta[];
  /** Messages with cursor > afterCursor, ascending, capped at limit. */
  fetchNewGroupMessages(afterCursor: number, limit: number): NormalizedMessage[];
  /** Pre-extracted chat.whatsapp.com invite links, if the source has them. */
  fetchInviteLinks(): InviteLink[];
  /** The account owner's JID, if derivable. */
  ownJid(): string | null;
  maxCursor(): number;
  close(): void;
}

// Burn-native taxonomy (the `burn` fork). Legacy rows with old types
// (assignment/event/opportunity/obligation) may exist in the store; the UI
// shows them under "All" only.
export type ItemType =
  | "cutoff"      // any deadline: dues, forms, calls, pack days, transfer windows
  | "ride"        // transport offer/ask
  | "ticket"      // ticket / vehicle pass / EA offer or ask
  | "shift"       // claimable slot
  | "gear"        // borrow / lend / buy
  | "decision"    // camp announcement that changes the plan
  | "arrival"     // who lands when
  | "for_you"     // direct @-ask at the user
  | "group_join"  // chat.whatsapp.com invite
  | "assignment" | "event" | "opportunity" | "obligation" | "connection"; // legacy

export type ItemStatus = "new" | "seen" | "saved" | "snoozed" | "done" | "dismissed";

export interface Item {
  id: number;
  type: ItemType;
  title: string;
  summary: string;
  confidence: number;
  score: number;
  goalId: number | null;
  chatJid: string;
  chatName: string;
  sourceMsgIds: string[];
  /** Type-specific extracted fields (due date, price, invite url, ...). */
  fields: Record<string, unknown>;
  status: ItemStatus;
  createdAt: number;
}

export interface CompiledGoal {
  /** Deterministic pre-filter hints. */
  keywords: string[];
  negativeKeywords: string[];
  /** Free-form constraints the rubric references (price caps, dates, ...). */
  constraints: Record<string, string>;
  /** Natural-language paragraph injected into the classification prompt. */
  rubric: string;
  clarifyingQuestions: string[];
}

export interface Goal {
  id: number;
  description: string;
  status: "active" | "paused" | "achieved";
  compiled: CompiledGoal | null;
  createdAt: number;
}

export interface UserIdentity {
  ownJid: string | null;
  /** Phone digits extracted from the JID, for @-mention matching. */
  ownPhone: string | null;
  /** Names/aliases the user answers to, confirmed at onboarding. */
  aliases: string[];
}
