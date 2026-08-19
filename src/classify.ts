// Batched classification: ~50 messages per CLI call, grouped by chat, with the
// item taxonomy, user identity, and compiled goal rubrics in the system prompt.

import { createHash } from "node:crypto";
import type { AgentBackend } from "./agent/backend.js";
import type { Store, StoredMessage } from "./store.js";
import type { Goal, ItemType, UserIdentity } from "./types.js";

export const PROMPT_VERSION = "v6-open";

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

function buildSystem(identity: UserIdentity, _goals: Goal[], _profile: string | null, focus?: { text: string | null; anchorDate: string | null; anchorLabel: string }): string {
  const focusBlock = focus?.text
    ? `THE USER'S CURRENT FOCUS: ${focus.text}${focus.anchorDate ? ` The anchor date is ${focus.anchorDate} ("${focus.anchorLabel}") — deadlines relative to it matter most.` : ""} Use this focus as the lens for every category: extract what serves it, with domain vocabulary read accordingly.`
    : `The user has no special focus set — classify anything genuinely useful from their group traffic.`;
  return `You classify WhatsApp messages for an app that organizes a busy person's group-chat traffic into useful posts. Logistics, not vibes.

THE USER: ${identity.aliases.join(" / ") || "unknown name"}${identity.ownPhone ? `, phone ${identity.ownPhone} (an "@${identity.ownPhone}" in a message is an @-mention of the user)` : ""}.

${focusBlock}

CATEGORIES:
- cutoff: ANYTHING with a deadline — payments owed, forms to fill, calls/meetings, pack/load days, transfer windows, order cutoffs, RSVPs. Resolve relative dates against the message timestamp into deadline_iso. Extract amount and any payment/form link as action_url. THIS IS THE MASTER TYPE: a silently missed deadline is the one unforgivable failure, so if something MIGHT be a deadline but you're unsure, emit it at low confidence (0.3-0.5) rather than staying silent — the app renders low-confidence cutoffs as "possible deadline, check thread".
- event: a gathering with a resolvable date/time. Extract title, start_iso, location. No resolvable date -> confidence <= 0.4.
- ride: transport offers or asks — seats, vehicle shares, hauling space, driver-wanted, convoys. Set offer_or_ask; extract origin/destination/dates/seats and whether a vehicle pass/permit is involved.
- ticket: ticket or pass offers and asks. Extract kind, price, and whether it reads as face value. Populate red_flags for scam signals ONLY (wire/gift-card/crypto payment, "print-at-home" claims, urgency pressure, price far over face, unknown seller pushing DMs). NEVER assess an offer as safe — only flag risks or leave red_flags empty.
- shift: claimable volunteer/work slots. Extract role, slot_time, slots_open.
- gear: borrow/lend/buy/sell of equipment relevant to the user's groups or focus. Set offer_or_ask, item, price.
- decision: a group announcement that changes the plan — schedules, locations, policies, latest word from organizers. Extract topic and latest_state (the NEW state of the world, not the discussion). Corrections supersede: if a later message changes an earlier decision, emit the latest state.
- arrival: someone declaring travel/arrival/departure timing relevant to a shared plan. Extract person, date_iso, notes.
- for_you: the user is @-mentioned or named WITH an actionable request directed at them. Greetings/thanks naming the user are NOT for_you.
- group_join: a chat.whatsapp.com invite link; describe the group in fields.topic — always capture these.

PRECISION RULES: for everything EXCEPT cutoff, return only items that clearly match — false positives destroy trust. Ambient hype, confirmations ("Paid", "Done", thank-yous), and social chatter are never items. A message can yield at most one item unless it genuinely contains several distinct asks.

SCOPE: nothing is out of scope by topic. The user's focus ranks items (focus-relevant items deserve higher confidence and richer fields) but a clearly useful post from any chat — a deadline, an event, an offer, a direct ask — is an item regardless of whether it touches the focus. When a flood of focus traffic coexists with quieter personal threads, the quiet threads matter MORE, not less: they are what the flood buries. A 1:1 DM chat is named after the other person — treat its content as between the user and that person.

Each message is prefixed by its id. Cite source_msg_ids exactly as given. Messages marked [ctx] are context only — never cite them as sources.`;
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
  return res.data.items;
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
