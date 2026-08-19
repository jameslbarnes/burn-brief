// Goal compilation: one synthesis-tier call turns a natural-language goal into
// deterministic pre-filter hints plus a classification rubric. The compiled
// artifact is shown to the user for approval — the system stays legible.

import type { AgentBackend } from "./agent/backend.js";
import type { Store } from "./store.js";
import type { CompiledGoal } from "./types.js";

const COMPILE_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array", items: { type: "string" },
      description: "15-40 lowercase substrings likely to appear in matching messages: place names, streets, synonyms, price forms, role titles. Used for cheap substring pre-filtering.",
    },
    negativeKeywords: {
      type: "array", items: { type: "string" },
      description: "Lowercase substrings that indicate a NON-match (e.g. 'looking for' when the goal wants offers).",
    },
    constraints: {
      type: "object", additionalProperties: { type: "string" },
      description: "Named hard constraints, e.g. maxPrice, dateRange, unitType.",
    },
    rubric: {
      type: "string",
      description: "One paragraph, second person, telling a classifier exactly what counts as a match and what to extract. Include the constraints.",
    },
    clarifyingQuestions: {
      type: "array", items: { type: "string" }, maxItems: 2,
      description: "Up to 2 questions if the goal is ambiguous in a way that materially changes matching. Empty if unambiguous.",
    },
  },
  required: ["keywords", "negativeKeywords", "constraints", "rubric", "clarifyingQuestions"],
  additionalProperties: false,
};

const COMPILE_SYSTEM = `You compile a user's personal goal into search artifacts for a local WhatsApp-group monitoring app.
The app scans group-chat messages: keywords feed a cheap substring pre-filter (recall matters more than precision — include misspellings, abbreviations, and synonyms), and the rubric instructs an LLM classifier (precision matters — spell out what disqualifies a message).
Messages are informal chat text: short, abbreviated, emoji-laden.`;

export async function compileGoal(
  backend: AgentBackend,
  store: Store,
  goalId: number,
  description: string,
): Promise<CompiledGoal> {
  const started = Date.now();
  const res = await backend.runAgent<CompiledGoal>({
    prompt: `Compile this goal:\n\n"${description}"`,
    system: COMPILE_SYSTEM,
    schema: COMPILE_SCHEMA,
    tier: "synthesis",
  });
  store.logPrompt({
    backend: res.backend, model: res.model, purpose: "compile_goal",
    promptChars: description.length, costUsd: res.costUsd,
    durationMs: Date.now() - started,
  });
  const compiled: CompiledGoal = {
    keywords: res.data.keywords.map((k) => k.toLowerCase()),
    negativeKeywords: res.data.negativeKeywords.map((k) => k.toLowerCase()),
    constraints: res.data.constraints,
    rubric: res.data.rubric,
    clarifyingQuestions: res.data.clarifyingQuestions,
  };
  store.setCompiled(goalId, compiled);
  return compiled;
}
