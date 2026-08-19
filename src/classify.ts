// Batched classification: ~50 messages per CLI call, grouped by chat, with the
// item taxonomy, user identity, and compiled goal rubrics in the system prompt.

import { createHash } from "node:crypto";
import type { AgentBackend } from "./agent/backend.js";
import type { Store, StoredMessage } from "./store.js";
import type { Goal, ItemType, UserIdentity } from "./types.js";

// v7-lean: benchmark-driven rewrite. A 5-strategy A/B on real batches showed
// the verbose v6 prompt bought nothing (byte-identical outputs) while causing
// the worst trust failure (classifieds typed as fake deadlines). The lean
// variant plus targeted rules below scored highest of all haiku strategies.
export const PROMPT_VERSION = "v7-lean";

export interface Candidate {
  type: ItemType;
  source_msg_ids: string[];
  title: string;
  summary: string;
  confidence: number;
  goal_id?: number | null;
  fields?: Record<string, unknown>;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["cutoff", "event", "ride", "ticket", "shift", "gear", "decision", "arrival", "for_you", "group_join"],
          },
          source_msg_ids: { type: "array", items: { type: "string" }, minItems: 1 },
          title: { type: "string", description: "Short card title, <= 70 chars" },
          summary: { type: "string", description: "1-2 sentences: what it is and why it matters to the user" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          goal_id: { type: ["integer", "null"], description: "Matching goal id for opportunity items, else null" },
          fields: {
            type: "object", additionalProperties: true,
            description: "Type-specific. cutoff {kind: payment|form|call|pack|signup|transfer|other, deadline_iso, amount, action_url}; event {title, start_iso, location}; ride {offer_or_ask, origin, destination, dates, seats, vehicle_pass}; ticket {offer_or_ask, kind: GA|VP|EA, price, face_value: bool, red_flags: [..]}; shift {role, slot_time, slots_open}; gear {offer_or_ask, item, price}; decision {topic, latest_state}; arrival {person, date_iso, notes}; for_you {task, requester, due_hint}; group_join {invite_url, topic}",
          },
        },
        required: ["type", "source_msg_ids", "title", "summary", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export function buildSystem(identity: UserIdentity, _goals: Goal[], _profile: string | null, focus?: { text: string | null; anchorDate: string | null; anchorLabel: string }): string {
  const focusBlock = focus?.text
    ? `THE USER'S CURRENT FOCUS: ${focus.text}${focus.anchorDate ? ` Anchor date ${focus.anchorDate} ("${focus.anchorLabel}") — deadlines relative to it matter most.` : ""}`
    : `No special focus set — classify anything genuinely useful.`;
  return `You classify WhatsApp messages for an app that organizes a busy person's group-chat traffic into useful posts. Logistics, not vibes.

THE USER: ${identity.aliases.join(" / ") || "unknown name"}${identity.ownPhone ? `, phone ${identity.ownPhone} ("@${identity.ownPhone}" is an @-mention of the user)` : ""}.
${focusBlock}

CATEGORIES:
- cutoff: a dated deadline that applies to the user — payment due, form closing, RSVP, order/transfer window, pack day. Resolve relative dates against the message timestamp into deadline_iso. A silently missed deadline is the one unforgivable failure: if something MIGHT be a real deadline, emit it at confidence 0.3-0.5 rather than staying silent.
- event: a gathering with a resolvable date/time (no resolvable date -> confidence <= 0.4). An event link someone shares or says they're attending IS an event — a fundraiser, party, or gathering invitation is never mere chatter, unlike commercial listings.
- ride: transport offer or ask — seats, hauling, convoys. Set offer_or_ask.
- ticket: event admission/passes only, offers and asks. A request for help, a vehicle, or a resource is not a ticket. Flag scam signals in red_flags; never assess an offer as safe.
- shift: claimable volunteer/work slots.
- gear: borrow/lend/buy/sell of equipment, and directives to bring/supply things (a bring-this directive with no stated date is gear, NOT cutoff).
- decision: an announcement changing the plan. latest_state = the NEW state of the world. When later messages retract or reverse an earlier statement, report only the final state and cite the retracting message.
- arrival: someone declaring travel/arrival/departure timing relevant to a shared plan.
- for_you: the user is @-mentioned or named WITH an actionable request. Greetings/thanks are not for_you.
- group_join: a chat.whatsapp.com invite link — always capture, describe in fields.topic.

RULES:
- Marketplace and broadcast listings (sublets, apartments, for-sale/ISO posts, referral links) addressed to no one in particular are never items of ANY type — a listing's date range is a listing term, not a deadline. A batch of pure classifieds returns an empty items array.
- A message that @-mentions or names a specific person with a request ("can you send the photos", "does anyone have X for me") is actionable even in an otherwise social chat.
- One item per person or plan; never merge different people's arrivals, asks, or logistics into one item.
- For everything except cutoff, return only clear matches — false positives destroy trust. Chatter, hype, and confirmations ("Paid", "Done") are never items.
- Confidence: an explicit organizer directive or direct ask warrants >= 0.7; reserve 0.3-0.5 for genuinely ambiguous mentions.
- A 1:1 DM chat is named after the other person — its content is between the user and that person, and direct asks there matter.
- Copy source_msg_ids exactly as given, e.g. "mac-sqlite:61854", never "61854". Messages marked [ctx] are context only — never cite them.`;
}

function renderMessage(m: StoredMessage, ctx = false): string {
  const date = new Date(m.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  const sender = m.sender_name ?? m.sender_jid ?? "?";
  const text = (m.text ?? "").replace(/\s+/g, " ").slice(0, 600);
  return `${ctx ? "[ctx] " : ""}${m.id} | ${date} | ${m.chat_name} | ${sender}: ${text}`;
}

/** Group pending messages into per-chat batches of ~batchSize. */
export function makeBatches(msgs: StoredMessage[], batchSize: number): StoredMessage[][] {
  const byChat = new Map<string, StoredMessage[]>();
  for (const m of msgs) {
    const arr = byChat.get(m.chat_jid) ?? [];
    arr.push(m);
    byChat.set(m.chat_jid, arr);
  }
  const batches: StoredMessage[][] = [];
  for (const arr of byChat.values()) {
    arr.sort((a, b) => a.cursor - b.cursor);
    for (let i = 0; i < arr.length; i += batchSize) {
      batches.push(arr.slice(i, i + batchSize));
    }
  }
  return batches;
}

export async function classifyBatch(
  backend: AgentBackend,
  store: Store,
  batch: StoredMessage[],
  identity: UserIdentity,
  goals: Goal[],
): Promise<Candidate[]> {
  const system = buildSystem(identity, goals, store.getProfile(), store.getFocus());
  const lines: string[] = [];
  // 3 messages of preceding context for the first message of the batch.
  const ctx = store.contextBefore(batch[0].chat_jid, batch[0].cursor, 3);
  for (const c of ctx) lines.push(renderMessage(c, true));
  for (const m of batch) lines.push(renderMessage(m));
  const prompt = `Classify these messages from the group "${batch[0].chat_name}":\n\n${lines.join("\n")}`;

  const cacheKey = createHash("sha256")
    .update(PROMPT_VERSION + system + prompt)
    .digest("hex");
  const cached = store.cacheGet(cacheKey);
  if (cached) return (JSON.parse(cached) as { items: Candidate[] }).items;

  const started = Date.now();
  const res = await backend.runAgent<{ items: Candidate[] }>({
    prompt,
    system,
    schema: CLASSIFY_SCHEMA,
    tier: "triage",
  });
  store.logPrompt({
    backend: res.backend, model: res.model, purpose: "classify",
    promptChars: prompt.length + system.length, messageCount: batch.length,
    costUsd: res.costUsd, durationMs: Date.now() - started,
  });
  store.cacheSet(cacheKey, JSON.stringify(res.data));
  return normalizeCitations(res.data.items, batch);
}

/**
 * Models reliably drop the "mac-sqlite:" prefix from cited ids (9 of 9 runs
 * in benchmarking) while never inventing ids. Re-attach the prefix instead of
 * fighting it in the prompt; drop only ids foreign even after normalization,
 * and drop items left with no valid source.
 */
function normalizeCitations(items: Candidate[], batch: StoredMessage[]): Candidate[] {
  const valid = new Set(batch.map((m) => m.id));
  const prefix = batch[0]?.id.includes(":") ? batch[0].id.slice(0, batch[0].id.indexOf(":") + 1) : "";
  const out: Candidate[] = [];
  for (const c of items) {
    const ids = (c.source_msg_ids ?? [])
      .map((id) => (valid.has(id) ? id : valid.has(prefix + id) ? prefix + id : null))
      .filter((id): id is string => id !== null);
    if (ids.length > 0) out.push({ ...c, source_msg_ids: ids });
  }
  return out;
}

/** Stable key so the same ask cross-posted to camp + hub + scene makes one card. */
export function dedupeKey(c: Candidate): string | null {
  const f = c.fields ?? {};
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, "");
  if (c.type === "group_join" && typeof f.invite_url === "string") {
    return `group_join:${f.invite_url}`;
  }
  if (c.type === "event" && typeof f.start_iso === "string") {
    return `event:${norm(f.title ?? c.title).slice(0, 40)}:${f.start_iso.slice(0, 13)}`;
  }
  if (c.type === "cutoff" && typeof f.deadline_iso === "string") {
    return `cutoff:${norm(f.kind)}:${f.deadline_iso.slice(0, 10)}:${norm(f.amount)}`;
  }
  if (c.type === "ride") {
    return `ride:${norm(f.offer_or_ask)}:${norm(f.origin)}:${norm(f.destination)}:${norm(f.dates)}`;
  }
  if (c.type === "ticket") {
    return `ticket:${norm(f.offer_or_ask)}:${norm(f.kind)}:${norm(f.price)}`;
  }
  if (c.type === "shift" && (f.role || f.slot_time)) {
    return `shift:${norm(f.role)}:${norm(f.slot_time)}`;
  }
  if (c.type === "arrival" && (f.person || f.date_iso)) {
    return `arrival:${norm(f.person)}:${String(f.date_iso ?? "").slice(0, 10)}`;
  }
  if (c.type === "gear" && f.item) {
    return `gear:${norm(f.offer_or_ask)}:${norm(f.item)}`;
  }
  return null;
}
