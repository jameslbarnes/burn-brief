// Deterministic, free signal extraction. Gates PRIORITY and batch ordering,
// never existence — every text message still reaches the classifier eventually
// unless the budget setting says otherwise.

import type { Goal, NormalizedMessage, UserIdentity } from "./types.js";

export interface PrefilterResult {
  priority: number;
  signals: string[];
}

const INVITE_RE = /chat\.whatsapp\.com\/[A-Za-z0-9]+/;
const URL_RE = /https?:\/\/\S+/;
const MONEY_RE = /(\$\s?\d[\d,.]*)|(\d[\d,.]*\s?(usd|dollars|bucks))|(\d+k\b)/i;
const DATE_RE = new RegExp(
  [
    "\\b(mon|tues?|wed(nes)?|thurs?|fri|sat(ur)?|sun)(day)?\\b",
    "\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b",
    "\\b\\d{1,2}[/.-]\\d{1,2}\\b",
    "\\b\\d{1,2}(:\\d{2})?\\s?(am|pm)\\b",
    "\\b(today|tonight|tomorrow|this week(end)?|next week)\\b",
    "\\brsvp\\b",
  ].join("|"),
  "i",
);
const QUESTION_RE = /\?\s*$|\banyone\b|\bdoes anyone\b|\bany recs\b|\brecommendation/i;

export function prefilter(
  msg: NormalizedMessage,
  identity: UserIdentity,
  activeGoals: Goal[],
  focusKeywords: string[] = [],
): PrefilterResult {
  const signals: string[] = [];
  let priority = 0;
  const text = msg.text ?? "";

  if (!text || msg.isFromMe) return { priority: 0, signals };
  if (text.length < 15) return { priority: 0, signals: ["short"] };

  if (INVITE_RE.test(text)) { signals.push("invite_link"); priority += 3; }

  // @-mention of the user's own number: highest-precision "assigned to me" anchor.
  if (identity.ownPhone && text.includes(`@${identity.ownPhone}`)) {
    signals.push("mention_me_jid");
    priority += 5;
  }
  // Name/alias match: weaker signal (common names misfire), inbox-only downstream.
  for (const alias of identity.aliases) {
    if (alias.length >= 3 && new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(text)) {
      signals.push("mention_me_name");
      priority += 2;
      break;
    }
  }

  // Focus vocabulary (compiled from the user's stated focus, e.g. burn
  // logistics terms) — the tier-2 gate: outside watched chats, only messages
  // carrying a focus signal reach the classifier.
  if (focusKeywords.length > 0) {
    const lower = text.toLowerCase();
    if (focusKeywords.some((k) => lower.includes(k))) {
      signals.push("focus");
      priority += 1.5;
    }
  }
  if (DATE_RE.test(text)) { signals.push("date"); priority += 1; }
  if (MONEY_RE.test(text)) { signals.push("money"); priority += 1; }
  if (URL_RE.test(text)) { signals.push("url"); priority += 0.5; }
  if (QUESTION_RE.test(text)) { signals.push("question"); priority += 0.5; }

  for (const goal of activeGoals) {
    if (!goal.compiled) continue;
    const lower = text.toLowerCase();
    const negHit = goal.compiled.negativeKeywords.some((k) => lower.includes(k.toLowerCase()));
    const hits = goal.compiled.keywords.filter((k) => lower.includes(k.toLowerCase()));
    if (hits.length > 0) {
      signals.push(`goal_${goal.id}:${hits.length}`);
      priority += Math.min(hits.length, 3) + (negHit ? -1 : 1);
    }
  }

  if (text.length > 120) priority += 0.5; // substantive messages over one-liners

  return { priority, signals };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
