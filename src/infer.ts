// Profile inference: draft the "about you" lens from the user's own footprint —
// which groups they're in, where they're active, and what they've said.
// The draft is a starting point the user edits; inference proposes, the user
// approves. Only the user's OWN sent messages are quoted to the model.

import type { AgentBackend } from "./agent/backend.js";
import type { Store } from "./store.js";

const INFER_SCHEMA = {
  type: "object",
  properties: {
    profile: {
      type: "string",
      description: "150-300 words, first person, as if the user wrote it themselves: who they are, where they're based, what they do, their communities and interests, what they're currently focused on. Only claims grounded in the data. Plain prose, no headers.",
    },
    uncertainties: {
      type: "array", items: { type: "string" }, maxItems: 5,
      description: "Things you guessed at or couldn't tell, phrased as short prompts the user can answer by editing ('I guessed you work in tech — correct?')",
    },
  },
  required: ["profile", "uncertainties"],
  additionalProperties: false,
};

const INFER_SYSTEM = `You draft a self-profile for the user of a WhatsApp-group assistant app, inferred from their own data. The profile becomes the relevance lens for everything the app surfaces, and the user will review and edit it before saving — so write it in their voice, first person, and keep every claim grounded in the evidence. Weight what they SAY and where they're ACTIVE over mere group membership (people lurk in groups they don't care about). Note recurring themes: place names they mention, what they organize or offer, what they ask for, communities they participate in. Do not moralize, flatter, or pad.`;

export interface InferredProfile {
  profile: string;
  uncertainties: string[];
}

export async function inferProfile(
  backend: AgentBackend,
  store: Store,
): Promise<InferredProfile> {
  // Group footprint: size, name, and how active the user is in each.
  const groups = store.db
    .prepare(
      `SELECT chat_name AS name, COUNT(*) AS total, SUM(is_from_me) AS mine,
              MAX(ts) AS last_ts
       FROM messages GROUP BY chat_jid
       ORDER BY mine DESC, total DESC LIMIT 80`,
    )
    .all() as { name: string; total: number; mine: number; last_ts: number }[];

  // The user's own words: an even sample across their whole history.
  const sent = store.db
    .prepare(
      `SELECT text, ts, chat_name FROM messages
       WHERE is_from_me = 1 AND text IS NOT NULL AND length(text) > 10
       ORDER BY ts ASC`,
    )
    .all() as { text: string; ts: number; chat_name: string }[];
  const SAMPLE = 250;
  const step = Math.max(1, Math.floor(sent.length / SAMPLE));
  const sample = sent.filter((_, i) => i % step === 0).slice(0, SAMPLE);

  const groupLines = groups
    .map((g) => `- ${g.name} (${g.total} msgs, ${g.mine} from user, last active ${new Date(g.last_ts * 1000).toISOString().slice(0, 10)})`)
    .join("\n");
  const msgLines = sample
    .map((m) => `[${new Date(m.ts * 1000).toISOString().slice(0, 10)} in ${m.chat_name}] ${m.text.replace(/\s+/g, " ").slice(0, 240)}`)
    .join("\n");

  const prompt = `Draft this user's profile.

THEIR GROUPS (name, size, how much they post there):
${groupLines}

A SAMPLE OF THEIR OWN MESSAGES (${sample.length} of ${sent.length} total, evenly spread over time):
${msgLines}`;

  const started = Date.now();
  const res = await backend.runAgent<InferredProfile>({
    prompt,
    system: INFER_SYSTEM,
    schema: INFER_SCHEMA,
    tier: "synthesis",
    timeoutMs: 420_000,
  });
  store.logPrompt({
    backend: res.backend, model: res.model, purpose: "infer_profile",
    promptChars: prompt.length + INFER_SYSTEM.length, messageCount: sample.length,
    costUsd: res.costUsd, durationMs: Date.now() - started,
  });
  return res.data;
}
