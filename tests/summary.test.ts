import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentBackend, AgentRequest, AgentResult } from "../src/agent/backend.js";
import { Store } from "../src/store.js";
import { conciseGoalLabel, generateDigest, type Digest } from "../src/summary.js";

class RecordingClaude implements AgentBackend {
  readonly id = "claude" as const;
  readonly calls: AgentRequest[] = [];

  async detect(): Promise<{ version: string }> {
    return { version: "test" };
  }

  async runAgent<T>(req: AgentRequest): Promise<AgentResult<T>> {
    this.calls.push(req);
    const data = req.tier === "synthesis"
      ? {
          headline: "The camp plan settles into place",
          narrative: "The first editorial paragraph leads with today's news.\n\nThe second carries useful context.\n\nThe third leaves room for a quieter thread.",
          followUps: [],
          resolvedLoops: [],
          principle_reflection: "",
          playa_tip: "",
        }
      : {
          goalUpdates: [{
            goal_id: 1,
            status: "progress",
            update: "A new ride lead surfaced in today's thread.",
          }],
        };
    return {
      data: data as T,
      durationMs: 1,
      backend: this.id,
      model: req.tier === "triage" ? "haiku" : undefined,
    };
  }
}

test("keeps goal compliance out of Claude's editorial pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "burn-brief-summary-"));
  const store = new Store(dir);
  try {
    store.setIdentity({ aliases: ["Alex"] });
    const goalId = store.addGoal("Find a ride into the burn");
    store.setCompiled(goalId, {
      keywords: ["ride"],
      negativeKeywords: [],
      constraints: { timing: "Saturday before the Man burns" },
      rubric: "Count only a concrete ride lead for the requested Saturday timing.",
      clarifyingQuestions: [],
    });
    store.insertLoop("Confirm shade structure", "The camp needs a final answer", "2026-08-16");
    const closedId = store.insertLoop("Buy dust masks", "Packing list", "2026-08-15");
    store.closeLoop(closedId, "done", "Bought");
    store.db.prepare(
      `INSERT INTO messages
       (id, source_id, cursor, chat_jid, chat_name, sender_name, is_from_me, ts,
        text, msg_type, priority, llm_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "m1", "test", 1, "camp@g.us", "Camp", "Rae", 0,
      Math.floor(Date.now() / 1000), "I may have a seat for Saturday.", 0, 1, "classified",
    );

    const previous: Digest = {
      day: "2026-08-17",
      headline: "Yesterday's headline",
      narrative: "Yesterday's useful editorial context.\n\nGoal — Find a ride into the burn: No progress surfaced in today's messages.",
      goalUpdates: [{
        goalId: 1,
        description: "Find a ride into the burn",
        status: "no_progress",
        text: "No progress surfaced in today's messages.",
      }],
      followUps: [],
      stats: { newItems: 0, messagesScanned24h: 0, liveCutoffs: 0, openAsks: 0 },
    };
    store.saveDigest(previous.day, JSON.stringify(previous));

    const backend = new RecordingClaude();
    const digest = await generateDigest(backend, store, "2026-08-18");

    assert.equal(backend.calls.length, 2);
    const [editorial, goalAudit] = backend.calls;
    assert.equal(editorial.tier, "synthesis");
    assert.match(editorial.system ?? "", /Write 3-5 short paragraphs/);
    assert.match(editorial.prompt, /Yesterday's useful editorial context/);
    assert.match(editorial.prompt, /Confirm shade structure/);
    assert.match(editorial.prompt, /Buy dust masks/);
    assert.doesNotMatch(editorial.prompt, /ACTIVE GOALS/);
    assert.doesNotMatch(editorial.prompt, /Goal — Find a ride/);
    assert.doesNotMatch(JSON.stringify(editorial.schema), /goalUpdates/);

    assert.equal(goalAudit.tier, "triage");
    assert.match(goalAudit.prompt, /ACTIVE GOALS/);
    assert.match(goalAudit.prompt, /Find a ride into the burn/);
    assert.match(goalAudit.prompt, /Count only a concrete ride lead/);
    assert.match(goalAudit.prompt, /I may have a seat for Saturday/);
    assert.match(goalAudit.prompt, /PREVIOUS GOAL UPDATES/);

    assert.equal(digest.headline, "The camp plan settles into place");
    assert.match(digest.narrative, /^The first editorial paragraph/);
    assert.match(digest.narrative, /Goal — Find a ride into the burn: A new ride lead surfaced/);
    assert.deepEqual(digest.goalUpdates, [{
      goalId: 1,
      description: "Find a ride into the burn",
      status: "progress",
      text: "A new ride lead surfaced in today's thread.",
    }]);

    const promptLog = store.db
      .prepare(`SELECT backend, model, purpose FROM prompt_log ORDER BY id`)
      .all() as { backend: string; model: string | null; purpose: string }[];
    assert.deepEqual(promptLog, [
      { backend: "claude", model: null, purpose: "daily_digest" },
      { backend: "claude", model: "haiku", purpose: "goal_audit" },
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses a compact display label without discarding the stored goal", () => {
  const description = "I coordinate spaces at The Dust School, a community building near downtown. Available: art studios, classrooms and offices for people who need workspace.";
  assert.equal(conciseGoalLabel(description), "I coordinate spaces at The Dust School");
});
