// Daily digest: one synthesis-tier call over the day's items, through the lens
// of the user's profile and goals. Covers what happened, why it's relevant,
// and what's worth following up on.

import { createHash } from "node:crypto";
import type { AgentBackend } from "./agent/backend.js";
import type { Store } from "./store.js";
import type { Item } from "./types.js";

const CHATSUM_VERSION = "v1";

// The Ten Principles, paraphrased in our own words (the official texts are
// Burning Man Project's). One per day, rotating by date; shown only while
// the user's focus is burn-flavored.
const PRINCIPLES: { name: string; line: string }[] = [
  { name: "Radical Inclusion", line: "Anyone may belong here; there are no prerequisites for being part of this." },
  { name: "Gifting", line: "Give without expecting anything back — the value of a gift is unconditional." },
  { name: "Decommodification", line: "Keep this culture free of sponsorship, transaction and advertising; experience over consumption." },
  { name: "Radical Self-reliance", line: "Bring what you need, and draw on your own inner resources." },
  { name: "Radical Self-expression", line: "Offer what only you can make — the gift of yourself, respectfully given." },
  { name: "Communal Effort", line: "The city is built together; cooperation is the whole method." },
  { name: "Civic Responsibility", line: "Care for the people around you and take on the public's welfare as your own." },
  { name: "Leaving No Trace", line: "Leave every place better than you found it; whatever you bring, you carry out." },
  { name: "Participation", line: "No spectators — the world becomes real through work that opens the heart." },
  { name: "Immediacy", line: "Be here now; no idea can substitute for the experience itself." },
];

// The countdown decad: Aug 20-29 walks all ten principles once, sequenced to
// the real shape of the run-up — inclusion as the city forms, effort and
// responsibility through the logistics peak, self-reliance and decommodification
// for the packing days, gifting as gifts get finished, no-trace before
// departure, self-expression and participation for build week, and Immediacy
// on the eve of gate. On playa the brief holds Immediacy; after the burn it
// turns to Leaving No Trace for the pack-out and the year ahead.
const SCHEDULE: Record<string, number> = {
  "2026-08-18": 3, // Radical Self-reliance
  "2026-08-19": 1, // Gifting
  "2026-08-20": 0, // Radical Inclusion — the countdown begins
  "2026-08-21": 5, // Communal Effort
  "2026-08-22": 6, // Civic Responsibility
  "2026-08-23": 3, // Radical Self-reliance — packing weekend
  "2026-08-24": 2, // Decommodification
  "2026-08-25": 1, // Gifting
  "2026-08-26": 7, // Leaving No Trace — pack with the exodus in mind
  "2026-08-27": 4, // Radical Self-expression — build crew arrives
  "2026-08-28": 8, // Participation
  "2026-08-29": 9, // Immediacy — eve of gate
};

export function principleForDay(day: string): { name: string; line: string } {
  if (day in SCHEDULE) return PRINCIPLES[SCHEDULE[day]];
  if (day > "2026-09-06") return PRINCIPLES[7]; // after the burn: Leaving No Trace
  if (day >= "2026-08-30") return PRINCIPLES[9]; // on playa: Immediacy
  const dayNum = Math.floor(Date.parse(day + "T12:00:00") / 86400000);
  return PRINCIPLES[((dayNum % 10) + 10) % 10];
}

/** Run fn over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const CHAT_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "3-8 sentences: what happened in this thread, latest state of any decisions (corrections supersede earlier messages), who committed to what, and anything directed at the user.",
    },
    keyFacts: {
      type: "array", items: { type: "string" }, maxItems: 10,
      description: "Exact facts copied VERBATIM from messages: times/dates as written, full URLs, dollar amounts, names + commitments. Empty if none.",
    },
  },
  required: ["summary", "keyFacts"],
  additionalProperties: false,
};

export interface Digest {
  day: string;
  headline: string;
  narrative: string;
  goalUpdates: {
    goalId: number;
    description: string;
    status: "progress" | "no_progress";
    text: string;
  }[];
  followUps: { title: string; why: string; itemIds: number[]; loopId: number; firstDay: string }[];
  resolvedLoops?: { loopId: number; evidence: string }[];
  principle?: { name: string; line: string; reflection: string; tip: string };
  stats: {
    newItems: number;
    messagesScanned24h: number;
    liveCutoffs: number;
    openAsks: number;
  };
}

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence: the single most important thing today, addressed to the user" },
    narrative: {
      type: "string",
      description: "3-5 short paragraphs. Lead with what's HAPPENING in the user's communities — planning threads, decisions, discussions, reunions, asks — drawn from the group activity, weighted by the user's profile (their projects and communities first). Then events worth their time. Plain prose, second person, no headers.",
    },
    followUps: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Imperative, concrete: 'Reply to X about Y'" },
          why: { type: "string", description: "One sentence on why this is worth their time" },
          itemIds: { type: "array", items: { type: "integer" }, description: "Related item ids, empty if none" },
          loop_id: {
            type: ["integer", "null"],
            description: "If this follow-up is the SAME underlying to-do as one of the OPEN LOOPS provided, its id (wording may be refreshed). null if genuinely new.",
          },
        },
        required: ["title", "why", "itemIds", "loop_id"],
        additionalProperties: false,
      },
    },
    resolvedLoops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          loop_id: { type: "integer" },
          evidence: { type: "string", description: "One line quoting/citing the chat activity that shows it's settled" },
        },
        required: ["loop_id", "evidence"],
        additionalProperties: false,
      },
      description: "OPEN LOOPS that chat activity clearly shows are now completed/settled. High confidence only — wrongly closing an open loop is worse than leaving it open. Empty if none.",
    },
    principle_reflection: {
      type: "string",
      description: "When a PRINCIPLE OF THE DAY is given: 2-4 sentences of full-throated burner inspiration anchored in that principle. Draw on real Burning Man lore and history (Baker Beach 1986, the Temple, the trash fence, the gift economy, 'welcome home', exodus) and wider philosophy where it genuinely fits. Written to make the reader feel lucky to be a burner heading home. Grounded in true lore — never invent history. Empty string when no principle is given.",
    },
    playa_tip: {
      type: "string",
      description: "When a PRINCIPLE OF THE DAY is given: ONE concrete playa tip personalized to THIS user's situation as shown in the data (their arrival timing, their build/art project, their role, T-minus days) — practical desert wisdom they can act on this week. Empty string when no principle is given.",
    },
  },
  required: ["headline", "narrative", "followUps", "resolvedLoops", "principle_reflection", "playa_tip"],
  additionalProperties: false,
};

const GOAL_AUDIT_SCHEMA = {
  type: "object",
  properties: {
    goalUpdates: {
      type: "array",
      description: "Exactly one entry for every active goal supplied, in the same order.",
      items: {
        type: "object",
        properties: {
          goal_id: { type: "integer", description: "The exact id from ACTIVE GOALS" },
          status: { type: "string", enum: ["progress", "no_progress"] },
          update: {
            type: "string",
            description: "One or two grounded sentences about progress. For no_progress, use the exact fallback sentence supplied in the instructions.",
          },
        },
        required: ["goal_id", "status", "update"],
        additionalProperties: false,
      },
    },
  },
  required: ["goalUpdates"],
  additionalProperties: false,
};

type EditorialDigest = {
  headline: string;
  narrative: string;
  followUps: { title: string; why: string; itemIds: number[]; loop_id: number | null }[];
  resolvedLoops: { loop_id: number; evidence: string }[];
  principle_reflection: string;
  playa_tip: string;
};

type GoalAudit = {
  goalUpdates: { goal_id: number; status: "progress" | "no_progress"; update: string }[];
};

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function compactItem(it: Item): Record<string, unknown> {
  return {
    id: it.id, type: it.type, title: it.title, summary: it.summary,
    confidence: it.confidence, chat: it.chatName, status: it.status,
    goal_id: it.goalId, fields: it.fields,
  };
}

/** Goal appendices are rendered separately and must not steer tomorrow's lede. */
function editorialPreviousBriefing(digest: Digest | null): Record<string, unknown> | null {
  if (!digest) return null;
  const narrative = digest.narrative
    .split(/\n{2,}/)
    .filter((paragraph) => !paragraph.trimStart().startsWith("Goal — "))
    .join("\n\n");
  return {
    day: digest.day,
    headline: digest.headline,
    narrative,
    followUps: digest.followUps,
    resolvedLoops: digest.resolvedLoops ?? [],
    principle: digest.principle,
    stats: digest.stats,
  };
}

/** Human-scale label for the appendix; the full description stays in goalUpdates. */
export function conciseGoalLabel(description: string): string {
  const sentence = description.trim().split(/(?<=[.!?])\s+/)[0] ?? description.trim();
  const clause = description.length > 120 ? (sentence.split(",")[0] ?? sentence) : sentence;
  const clean = clause.replace(/[.!?]+$/, "").trim();
  if (clean.length <= 88) return clean;
  const clipped = clean.slice(0, 85).replace(/\s+\S*$/, "").trimEnd();
  return `${clipped || clean.slice(0, 85)}…`;
}

export async function generateDigest(
  backend: AgentBackend,
  store: Store,
  day: string = localDay(),
): Promise<Digest> {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAhead = new Date((now + 7 * 86400) * 1000).toISOString();
  const nowIso = new Date(now * 1000).toISOString();

  // Raw conversational activity: the digest must see what groups are TALKING
  // about, not just classified items — planning threads, decisions, reunions.
  const twoDaysAgo = now - 48 * 3600;
  // Map-reduce over group activity: every chat active in the window makes the
  // cut — low-volume threads are often the highest-signal (a quiet group
  // stirring back to life beats 100 messages of party promo). Small threads go
  // to the synthesis call verbatim and untruncated; big threads first get a
  // full-text summary on the cheap tier so no correction, link, or deadline is
  // lost to sampling. Summaries are cached by message-set hash.
  const identity = store.getIdentity();
  const VERBATIM_MAX = 12;
  // Every active chat is summary material — watched chats lead, but the
  // quiet threads a flood would bury are exactly what must not be dropped.
  const watched = store.getWatchedJids();
  const watchedSet = new Set(watched);
  const allActive = (store.db
    .prepare(
      `SELECT chat_jid AS jid, chat_name AS name, COUNT(*) AS n, SUM(is_from_me) AS mine
       FROM messages WHERE ts >= ? AND text IS NOT NULL
       GROUP BY chat_jid ORDER BY mine DESC, n DESC`,
    )
    .all(twoDaysAgo) as { jid: string; name: string; n: number; mine: number }[])
    .sort((a, b) => Number(watchedSet.has(b.jid)) - Number(watchedSet.has(a.jid)));
  const activeChats = allActive.slice(0, 30);
  const omittedChats = allActive.length - activeChats.length;

  const chatMessages = (jid: string) =>
    store.db
      .prepare(
        `SELECT sender_name, is_from_me, text, ts FROM messages
         WHERE chat_jid = ? AND ts >= ? AND text IS NOT NULL
         ORDER BY ts ASC LIMIT 400`,
      )
      .all(jid, twoDaysAgo) as { sender_name: string | null; is_from_me: number; text: string; ts: number }[];

  const renderMsgs = (msgs: ReturnType<typeof chatMessages>, maxChars: number) =>
    msgs
      .map((m) => `  ${m.is_from_me ? "THE USER" : (m.sender_name ?? "?")}: ${m.text.replace(/\s+/g, " ").slice(0, maxChars)}`)
      .join("\n");

  const activityBlocks = await mapLimit(activeChats, 3, async (c) => {
    const msgs = chatMessages(c.jid);
    if (msgs.length <= VERBATIM_MAX) {
      return `## ${c.name} (${c.n} messages, ${c.mine} from the user, verbatim)\n${renderMsgs(msgs, 500)}`;
    }
    const cacheKey = createHash("sha256")
      .update(CHATSUM_VERSION + c.jid + msgs.map((m) => `${m.ts}${m.text}`).join("\x1f"))
      .digest("hex");
    const cached = store.cacheGet(cacheKey);
    let sum: { summary: string; keyFacts: string[] };
    if (cached) {
      sum = JSON.parse(cached) as typeof sum;
    } else {
      try {
        const started = Date.now();
        const res = await backend.runAgent<typeof sum>({
          prompt: `Summarize this WhatsApp group thread ("${c.name}", last 48h, complete and in order):\n\n${renderMsgs(msgs, 1500)}`,
          system: `You summarize one WhatsApp group thread for a daily-briefing writer. The user of the app is ${identity.aliases.join(" / ") || "the account owner"}; their messages are marked THE USER. Report the LATEST state of anything that changed (a correction supersedes the original). Copy times, dates, URLs, and amounts verbatim into keyFacts — never paraphrase them. Flag anything directed at or waiting on the user.`,
          schema: CHAT_SUMMARY_SCHEMA,
          tier: "triage",
          timeoutMs: 240_000,
        });
        store.logPrompt({
          backend: res.backend, model: res.model, purpose: "chat_summary",
          promptChars: 0, messageCount: msgs.length, costUsd: res.costUsd,
          durationMs: Date.now() - started,
        });
        sum = res.data;
        store.cacheSet(cacheKey, JSON.stringify(sum));
      } catch {
        // Summarization failed: fall back to an even sample rather than dropping the chat.
        const step = Math.ceil(msgs.length / VERBATIM_MAX);
        const sample = msgs.filter((_, i) => i % step === 0 || i === msgs.length - 1);
        return `## ${c.name} (${c.n} messages, ${c.mine} from the user, SAMPLED — details may be incomplete)\n${renderMsgs(sample, 300)}`;
      }
    }
    const facts = sum.keyFacts.length ? `\nKey facts (verbatim): ${sum.keyFacts.map((f) => `"${f}"`).join(" · ")}` : "";
    return `## ${c.name} (${c.n} messages, ${c.mine} from the user, summarized from full text)\n${sum.summary}${facts}`;
  });
  if (omittedChats > 0) {
    activityBlocks.push(`(NOTE: ${omittedChats} additional active chats omitted this run — mention that coverage was partial if it matters.)`);
  }

  const newItems = store.items({ sinceTs: dayAgo, excludeDismissed: true, limit: 80 });
  const cutoffs = store
    .items({ type: "cutoff", excludeDismissed: true, limit: 60 })
    .filter((it) => {
      const dl = typeof it.fields.deadline_iso === "string" ? it.fields.deadline_iso : null;
      return dl === null || dl >= nowIso.slice(0, 10);
    });
  const forYou = store.items({ type: "for_you", status: "new", limit: 20 });
  // The synthesis call receives the complete task ledger. Nothing is silently
  // expired or truncated here: the user asked for full continuity.
  const openLoops = store.openLoops();
  const completedLoops = store.closedLoops();
  const previousDigestRecord = store.latestDigestOnOrBefore(day);
  const previousBriefing = previousDigestRecord
    ? JSON.parse(previousDigestRecord.json) as Digest
    : null;
  const previousEditorialBriefing = editorialPreviousBriefing(previousBriefing);
  const scanned24h = (store.db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ts >= ?`)
    .get(dayAgo) as { n: number }).n;

  const focus = store.getFocus();
  const anchor = focus.anchorDate;
  const tMinus = anchor ? Math.ceil((Date.parse(anchor) - Date.now()) / 86400000) : null;
  const focusLine = focus.text
    ? `THE USER'S FOCUS: ${focus.text}${anchor && tMinus !== null && tMinus > 0 ? ` — ${focus.anchorLabel} is ${anchor}, T-minus ${tMinus} days; deadlines before it matter most.` : ""}`
    : "The user has no special focus set.";

  const activeGoals = store.goals(true);

  const system = `You are the editorial writer of a concise, genuinely useful newsmagazine for a busy person's WhatsApp communities. ${focusLine} CONTINUITY: you receive the editorial body of the complete previous briefing and the user's full task ledger. Treat the previous briefing as prior state, not current evidence: today's messages and items override it. Preserve useful continuity, call out what changed and do not repeat old copy merely to fill space. ALL OPEN TASKS: use every open task to understand outstanding commitments and avoid duplicates. Select at most six that deserve emphasis today for followUps, carrying their loop_id; tasks not selected remain open automatically. ALL COMPLETED TASKS: never re-raise or duplicate any completed, resolved or expired task unless new chat activity clearly creates a genuinely new obligation. Mark an open task in resolvedLoops ONLY when current chat activity clearly confirms it is settled. New follow-ups get loop_id null. Write 3-5 short paragraphs in second person. Deadlines and anything needing action today come first, with dates and amounts; then what changed (decisions, new chats, plan updates — latest state wins); close with anything worth knowing but not urgent. When one topic floods the traffic, make room for the quieter personal threads it buries — a two-message thread in a close group can outrank a hundred messages of flood. Skip hype, thanks and social filler. If a possible deadline is uncertain, say "possible deadline — check thread", never silence. GROUNDING RULE: never state a time, date, amount or link unless it appears verbatim in the provided messages, summaries or key facts — say "check the thread" instead of guessing. Messages marked THE USER are their own — their unanswered commitments rank first. Be honest when a day is quiet. Do not discuss or evaluate the user's tracked goals; a separate audit handles them after your editorial work.

STYLE: AP style throughout. Times as "9:15 a.m. ET" (lowercase a.m./p.m. with periods, noon and midnight spelled out). Dates as "Aug. 16" (abbreviate Jan., Feb., Aug., Sept., Oct., Nov., Dec.; never ordinals). Spell out one through nine, numerals for 10 and up (but always numerals for money, ages and times). "$1,000" not "1000$". No Oxford comma. No ALL-CAPS words except the section labels; emphasis comes from placement, not capitals. The headline is an AP headline: sentence case, present tense, no ending period.

USER: ${identity.aliases.join(" / ") || "unknown"}.`;

  const prompt = `Today is ${day}.${anchor && tMinus !== null && tMinus > 0 ? ` T-minus ${tMinus} to ${focus.anchorLabel} (${anchor}).` : ""} Write the daily summary from this data:

BURN CHAT ACTIVITY (last 48h):
${activityBlocks.join("\n\n")}

NEW ITEMS (last 24h): ${JSON.stringify(newItems.map(compactItem))}

LIVE CUTOFFS (undismissed, not yet passed): ${JSON.stringify(cutoffs.map(compactItem))}

OPEN ASKS AT THE USER: ${JSON.stringify(forYou.map(compactItem))}

PREVIOUS BRIEFING (editorial continuity only; current evidence overrides it): ${JSON.stringify(previousEditorialBriefing)}

ALL OPEN TASKS (complete ledger, no truncation): ${JSON.stringify(
    openLoops.map((l) => ({
      id: l.id, title: l.title, why: l.why, status: l.status,
      first_day: l.first_day, last_day: l.last_day,
    })),
  )}

ALL COMPLETED TASKS (complete ledger, do not re-raise): ${JSON.stringify(
    completedLoops.map((l) => ({
      id: l.id, title: l.title, why: l.why, status: l.status,
      first_day: l.first_day, last_day: l.last_day,
      closed_at: l.closed_at, evidence: l.evidence,
    })),
  )}

ACTIVITY: ${scanned24h} messages scanned in the last 24h.${(() => {
    const burnFocus = /burn/i.test(focus.text ?? "");
    if (!burnFocus) return "";
    const p = principleForDay(day);
    return `\n\nPRINCIPLE OF THE DAY: ${p.name} — "${p.line}". Close the brief with a dispatch built on this principle (principle_reflection + playa_tip fields). This closing section is EXEMPT from the terseness and no-hype rules above: it should burn hot — stirring, second person, proud to be part of this strange citizenry. Anchor it in the principle, weave in real lore or philosophy when it fits, and let the playa_tip come straight out of this user's actual situation in the data above.`;
  })()}`;

  const started = Date.now();
  const res = await backend.runAgent<EditorialDigest>({
    prompt,
    system,
    schema: DIGEST_SCHEMA,
    tier: "synthesis",
  });
  store.logPrompt({
    backend: res.backend, model: res.model, purpose: "daily_digest",
    promptChars: prompt.length + system.length, costUsd: res.costUsd,
    durationMs: Date.now() - started,
  });

  // Goals are audited separately so mandatory coverage can never distort the
  // briefing's headline, lede or story selection. The same selected backend is
  // used for both passes (Claude stays Claude).
  let goalAudit: GoalAudit = { goalUpdates: [] };
  if (activeGoals.length) {
    const goalSystem = `You audit tracked goals against today's WhatsApp evidence. Return exactly one goalUpdates entry for every supplied goal id, in the same order. A goal has progress only when TODAY'S EVIDENCE shows a concrete new development toward that specific goal. Prior goal updates are continuity context, never proof of progress today. Do not let general busyness, related topics or an old task imply progress. If there is no concrete evidence, set status to no_progress and use exactly: "No progress surfaced in today's messages." Keep progress updates to one or two plain, grounded sentences. Do not write a headline or briefing.`;
    const goalPrompt = `Today is ${day}. Audit these goals:

ACTIVE GOALS: ${JSON.stringify(activeGoals.map((g) => ({
    id: g.id,
    description: g.description,
    rubric: g.compiled?.rubric ?? null,
    constraints: g.compiled?.constraints ?? {},
  })))}

TODAY'S EVIDENCE — CHAT ACTIVITY (last 48h):
${activityBlocks.join("\n\n")}

TODAY'S EVIDENCE — NEW ITEMS (last 24h): ${JSON.stringify(newItems.map(compactItem))}

An item's goal_id is only a retrieval lead, not proof of a match. Independently apply the supplied goal rubric and constraints to the underlying evidence.

PREVIOUS GOAL UPDATES (continuity only; not evidence of progress today): ${JSON.stringify(previousBriefing?.goalUpdates ?? [])}`;
    try {
      const goalStarted = Date.now();
      const goalRes = await backend.runAgent<GoalAudit>({
        prompt: goalPrompt,
        system: goalSystem,
        schema: GOAL_AUDIT_SCHEMA,
        tier: "triage",
        timeoutMs: 240_000,
      });
      store.logPrompt({
        backend: goalRes.backend, model: goalRes.model, purpose: "goal_audit",
        promptChars: goalPrompt.length + goalSystem.length, costUsd: goalRes.costUsd,
        durationMs: Date.now() - goalStarted,
      });
      goalAudit = goalRes.data;
    } catch {
      // Deterministic reconciliation below still supplies every goal as
      // no-progress, so an audit failure never produces an incomplete brief.
    }
  }

  // Reconcile the ledger: chat-confirmed resolutions close loops; each
  // follow-up either carries an existing loop forward or opens a new one.
  const openIds = new Set(openLoops.map((l) => l.id));
  const rawResolved = (res.data as unknown as { resolvedLoops?: { loop_id: number; evidence: string }[] }).resolvedLoops ?? [];
  const resolved: { loopId: number; evidence: string }[] = [];
  for (const r of rawResolved) {
    if (openIds.has(r.loop_id)) {
      store.closeLoop(r.loop_id, "resolved", r.evidence);
      openIds.delete(r.loop_id);
      resolved.push({ loopId: r.loop_id, evidence: r.evidence });
    }
  }
  const byId = new Map(openLoops.map((l) => [l.id, l]));
  const followUps = (res.data.followUps as unknown as {
    title: string; why: string; itemIds: number[]; loop_id: number | null;
  }[]).map((f) => {
    if (f.loop_id !== null && openIds.has(f.loop_id)) {
      store.touchLoop(f.loop_id, f.title, f.why, day);
      return { title: f.title, why: f.why, itemIds: f.itemIds, loopId: f.loop_id, firstDay: byId.get(f.loop_id)!.first_day };
    }
    const id = store.insertLoop(f.title, f.why, day);
    return { title: f.title, why: f.why, itemIds: f.itemIds, loopId: id, firstDay: day };
  });

  const burnFocus = /burn/i.test(focus.text ?? "");
  const extra = res.data as unknown as {
    principle_reflection?: string;
    playa_tip?: string;
  };
  const rawGoalUpdates = goalAudit.goalUpdates ?? [];
  const goalUpdates = activeGoals.map((goal) => {
    const raw = rawGoalUpdates.find((candidate) => candidate.goal_id === goal.id);
    const hasGroundedProgress = raw?.status === "progress" && Boolean(raw.update?.trim());
    return {
      goalId: goal.id,
      description: goal.description,
      status: hasGroundedProgress ? "progress" as const : "no_progress" as const,
      text: hasGroundedProgress ? raw.update.trim() : "No progress surfaced in today's messages.",
    };
  });
  const goalNarrative = goalUpdates
    .map((goal) => `Goal — ${conciseGoalLabel(goal.description)}: ${goal.text}`)
    .join("\n\n");
  const narrative = [res.data.narrative.trim(), goalNarrative].filter(Boolean).join("\n\n");
  const digest: Digest = {
    day,
    headline: res.data.headline,
    narrative,
    goalUpdates,
    followUps,
    resolvedLoops: resolved,
    ...(burnFocus ? { principle: { ...principleForDay(day), reflection: extra.principle_reflection ?? "", tip: extra.playa_tip ?? "" } } : {}),
    stats: {
      newItems: newItems.length,
      messagesScanned24h: scanned24h,
      liveCutoffs: cutoffs.length,
      openAsks: forYou.length,
    },
  };
  store.saveDigest(day, JSON.stringify(digest));
  return digest;
}
