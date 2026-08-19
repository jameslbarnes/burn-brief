#!/usr/bin/env node
// burn/brief CLI: doctor, init, ingest, goal, classify, items and digests.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectBackends, pickBackend } from "./agent/backend.js";
import { compileGoal } from "./goals.js";
import { classifyPending, ingest } from "./pipeline.js";
import { MacSqliteSource } from "./sources/mac-sqlite.js";
import { Store, type BackendPreference, type StoredMessage } from "./store.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  }
  return out;
}

async function configuredBackend(store: Store, args: string[]) {
  const requested = flag(args, "backend") ?? store.getBackendPreference();
  return pickBackend(requested === "auto" ? undefined : requested);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "doctor": {
      const backends = await detectBackends();
      for (const b of backends) console.log(`backend: ${b.backend.id} (${b.version})`);
      if (backends.length === 0) console.log("backend: NONE — install Claude Code or Codex");
      let source: MacSqliteSource | null = null;
      try {
        source = new MacSqliteSource();
        const probe = source.probe();
        console.log(`source:  mac-sqlite ${probe.ok ? "OK" : "FAIL"} — ${probe.detail}`);
        if (probe.ok) {
          console.log(`         own JID: ${probe.ownJid ?? "not found"}, max cursor: ${probe.maxCursor}`);
          console.log(`         groups:  ${source.listGroupChats().length}`);
        }
      } catch (err) {
        console.log(`source:  mac-sqlite FAIL — ${String(err)}`);
        console.log("         Grant Full Disk Access to your terminal/app and retry.");
      } finally {
        source?.close();
      }
      const store = new Store();
      const counts = store.messageCount();
      const id = store.getIdentity();
      const preference = store.getBackendPreference();
      console.log(`store:   ${counts.total} messages ingested, ${counts.pending} pending classification`);
      console.log(`identity: jid=${id.ownJid ?? "unset"} aliases=[${id.aliases.join(", ")}]`);
      console.log(`agent:   ${preference}${preference === "auto" ? ` (${backends[0]?.backend.id ?? "none available"} will be used)` : ""}`);
      store.close();
      break;
    }

    case "init": {
      // First-time setup: capture identity, ingest history, skip old backlog.
      const backfillDays = Number(flag(args, "backfill-days") ?? 14);
      const aliases = flags(args, "alias");
      if (aliases.length === 0) throw new Error("init needs at least one --alias so burn/brief can recognize you in chats");
      const source = new MacSqliteSource();
      const probe = source.probe();
      if (!probe.ok) throw new Error(`source probe failed: ${probe.detail}`);
      const store = new Store();
      const backendFlag = flag(args, "backend") as BackendPreference | undefined;
      if (backendFlag) {
        if (!(["auto", "claude", "codex"] as string[]).includes(backendFlag)) {
          throw new Error("--backend must be auto, claude or codex");
        }
        if (backendFlag !== "auto") await pickBackend(backendFlag);
        store.setBackendPreference(backendFlag);
      }
      store.setIdentity({ ownJid: source.ownJid(), aliases });
      console.log(`identity: ${source.ownJid() ?? "jid not found"} aliases=[${aliases.join(", ")}]`);
      const stats = ingest(source, store);
      console.log(`ingested ${stats.inserted} messages (scanned ${stats.scanned})`);
      const cutoff = Math.floor(Date.now() / 1000) - backfillDays * 86400;
      const r = store.db
        .prepare(`UPDATE messages SET llm_status='skipped' WHERE llm_status='pending' AND ts < ?`)
        .run(cutoff);
      console.log(`marked ${r.changes} messages older than ${backfillDays}d as skipped (history stays searchable)`);
      source.close();
      store.close();
      break;
    }

    case "ingest": {
      const source = new MacSqliteSource();
      const store = new Store();
      const stats = ingest(source, store);
      if (args.includes("--json")) console.log(JSON.stringify(stats));
      else console.log(`ingested ${stats.inserted} new messages (watermark ${stats.newWatermark})`);
      source.close();
      store.close();
      break;
    }

    case "backend": {
      const sub = args[0] ?? "show";
      const store = new Store();
      const available = await detectBackends();
      if (sub === "set") {
        const value = args[1] as BackendPreference | undefined;
        if (!value || !(["auto", "claude", "codex"] as string[]).includes(value)) {
          throw new Error("usage: node dist/cli.js backend set auto|claude|codex");
        }
        if (value !== "auto" && !available.some((entry) => entry.backend.id === value)) {
          throw new Error(`${value} is not installed or logged in on this Mac`);
        }
        store.setBackendPreference(value);
      } else if (sub !== "show" && sub !== "list") {
        throw new Error("usage: node dist/cli.js backend show | list | set auto|claude|codex");
      }
      const preference = store.getBackendPreference();
      const out = {
        preference,
        selected: preference === "auto" ? (available[0]?.backend.id ?? null) : preference,
        available: available.map((entry) => ({ id: entry.backend.id, version: entry.version })),
      };
      console.log(args.includes("--json") ? JSON.stringify(out) : [
        `Agent CLI: ${out.selected ?? "none available"} (${preference})`,
        ...out.available.map((entry) => `  ${entry.id}: ${entry.version}`),
      ].join("\n"));
      store.close();
      break;
    }

    case "chats": {
      // Burn-chat scoping: detect, list, watch, unwatch.
      const sub = args[0];
      const store = new Store();
      if (sub === "detect") {
        const source = new MacSqliteSource();
        const all = source.listGroupChats().filter((c) => c.messageCount > 0);
        // Cheap name pass first; the LLM confirms against recent content
        // because names lie in both directions ("CAMP 2026" is a different
        // festival; burn traffic hides in generic scene chats).
        const NAME_RE = /burn|playa|brc|black rock|gaian|airship|art car|decompression|dust|gate|water team|alchemist|bazar|nasp/i;
        const cutoff = Math.floor(Date.now() / 1000) - 45 * 86400;
        const recent = all.filter((c) => {
          const row = store.db
            .prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND ts > ?`)
            .get(c.jid, cutoff) as { n: number };
          return row.n > 0 || NAME_RE.test(c.name);
        });
        const withSamples = recent.slice(0, 60).map((c) => {
          const rows = store.db
            .prepare(
              `SELECT text FROM messages WHERE chat_jid = ? AND text IS NOT NULL ORDER BY ts DESC LIMIT 3`,
            )
            .all(c.jid) as { text: string }[];
          return { jid: c.jid, name: c.name, sample: rows.map((r) => r.text.slice(0, 140)) };
        });
        source.close();
        const backend = await configuredBackend(store, args);
        const res = await backend.runAgent<{ burn_jids: string[] }>({
          prompt: `Which of these WhatsApp groups are about attending Burning Man 2026 (camp logistics, art cars, burner scene, tickets/rides to Black Rock City)? Groups about OTHER festivals or "alternatives to the burn" do NOT count. Return the jids.\n\n${withSamples
            .map((c) => `jid: ${c.jid}\nname: ${c.name}\nrecent: ${c.sample.join(" | ") || "(no recent text)"}`)
            .join("\n\n")}`,
          schema: {
            type: "object",
            properties: { burn_jids: { type: "array", items: { type: "string" } } },
            required: ["burn_jids"], additionalProperties: false,
          },
          tier: "triage",
        });
        const detected = withSamples.filter((c) => res.data.burn_jids.includes(c.jid));
        if (args.includes("--apply")) {
          store.setWatchedJids(detected.map((c) => c.jid));
          console.log(args.includes("--json")
            ? JSON.stringify({ watched: detected })
            : `watching ${detected.length} burn chats:\n` + detected.map((c) => `  ${c.name}`).join("\n"));
        } else {
          console.log(args.includes("--json")
            ? JSON.stringify({ detected })
            : `detected ${detected.length} burn chats (re-run with --apply to watch):\n` + detected.map((c) => `  ${c.name}  (${c.jid})`).join("\n"));
        }
      } else if (sub === "list") {
        const watched = new Set(store.getWatchedJids());
        const rows = store.db
          .prepare(`SELECT chat_jid AS jid, chat_name AS name, COUNT(*) AS n FROM messages GROUP BY chat_jid ORDER BY n DESC LIMIT 50`)
          .all() as { jid: string; name: string; n: number }[];
        for (const r of rows) console.log(`${watched.has(r.jid) ? "●" : " "} ${r.name} (${r.n})  ${r.jid}`);
        if (watched.size === 0) console.log("\n(no watched list set — all chats reach the classifier)");
      } else if (sub === "watch" || sub === "unwatch") {
        const jid = args[1];
        if (!jid) throw new Error(`usage: chats ${sub} <jid>`);
        const cur = new Set(store.getWatchedJids());
        if (sub === "watch") cur.add(jid); else cur.delete(jid);
        store.setWatchedJids([...cur]);
        console.log(JSON.stringify({ watched: [...cur] }));
      } else {
        console.log("usage: chats detect [--apply] | chats list | chats watch <jid> | chats unwatch <jid>");
      }
      store.close();
      break;
    }

    case "dms": {
      // One-time backfill of 1:1 threads (they predate the DM-inclusive ingest).
      if (args[0] !== "backfill") { console.log("usage: dms backfill [--days 14]"); break; }
      const days = Number(flag(args, "days") ?? 14);
      const source = new MacSqliteSource();
      const store = new Store();
      const { prefilter } = await import("./prefilter.js");
      const identity = store.getIdentity();
      const goals = store.goals(true);
      const focusKeywords = store.getFocus().keywords;
      const msgs = source.fetchRecentDirectMessages(Math.floor(Date.now() / 1000) - days * 86400);
      const enriched = msgs.map((m) => {
        const pf = prefilter(m, identity, goals, focusKeywords);
        return { ...m, priority: pf.priority, signals: pf.signals };
      });
      const inserted = store.insertMessages(enriched);
      const pending = (store.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE llm_status='pending'`)
        .get() as { n: number }).n;
      console.log(`backfilled ${inserted} DM messages (${msgs.length} scanned, last ${days}d); ${pending} now pending`);
      source.close();
      store.close();
      break;
    }

    case "resweep": {
      // Re-run the prefilter over recent unclassified messages and re-apply
      // the scrutiny gate — fixes anything skipped under an older policy.
      const days = Number(flag(args, "days") ?? 3);
      const { prefilter } = await import("./prefilter.js");
      const store = new Store();
      const identity = store.getIdentity();
      const goals = store.goals(true);
      const focusKeywords = store.getFocus().keywords;
      const watched = new Set(store.getWatchedJids());
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const rows = store.db
        .prepare(
          `SELECT * FROM messages WHERE ts > ? AND is_from_me = 0 AND text IS NOT NULL
             AND llm_status IN ('pending','skipped')`,
        )
        .all(cutoff) as StoredMessage[];
      const upd = store.db.prepare(
        `UPDATE messages SET priority = ?, signals = ?, llm_status = 'pending' WHERE id = ?`,
      );
      store.transaction(() => {
        for (const r of rows) {
          const pf = prefilter(
            {
              id: r.id, sourceId: r.source_id, cursor: r.cursor, chatJid: r.chat_jid,
              chatName: r.chat_name, senderJid: r.sender_jid, senderName: r.sender_name,
              isFromMe: false, ts: r.ts, text: r.text, msgType: r.msg_type,
            },
            identity, goals, focusKeywords,
          );
          const isWatched = watched.has(r.chat_jid);
          upd.run(
            pf.priority + (isWatched ? 2 : 0),
            JSON.stringify(isWatched ? [...pf.signals, "watched"] : pf.signals),
            r.id,
          );
        }
      });
      const pending = (store.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE llm_status='pending'`)
        .get() as { n: number }).n;
      console.log(`reswept ${rows.length} messages (last ${days}d); ${pending} now pending`);
      store.close();
      break;
    }

    case "loops": {
      const sub = args[0];
      const store = new Store();
      if (sub === "done" || sub === "reopen") {
        const id = Number(args[1]);
        if (!Number.isInteger(id)) throw new Error(`usage: loops ${sub} <id>`);
        if (sub === "done") store.closeLoop(id, "done");
        else store.reopenLoop(id);
        console.log(JSON.stringify({ ok: true, id, status: sub === "done" ? "done" : "open" }));
      } else {
        const open = store.openLoops(50);
        const recentlyClosed = store.closedLoopsSince(Math.floor(Date.now() / 1000) - 2 * 86400);
        const history = store.closedLoops(50);
        if (args.includes("--json")) console.log(JSON.stringify({ open, recentlyClosed, history }));
        else {
          for (const l of open) console.log(`[${l.id}] (since ${l.first_day}) ${l.title}`);
          if (open.length === 0) console.log("no open loops");
          for (const l of recentlyClosed) console.log(`[${l.id}] ✓ ${l.status}: ${l.title}`);
        }
      }
      store.close();
      break;
    }

    case "focus": {
      // The user's organizing lens: free text + optional anchor date, compiled
      // into gate vocabulary for tier-2 classification.
      const sub = args[0];
      const store = new Store();
      if (sub === "set") {
        const text = args[1];
        if (!text) throw new Error(`usage: focus set "description" [--date YYYY-MM-DD --label gate]`);
        const backend = await configuredBackend(store, args);
        const res = await backend.runAgent<{ keywords: string[] }>({
          prompt: `A WhatsApp-organizing app gates which messages get LLM classification using cheap substring matching. The user's focus: "${text}". Generate 25-50 lowercase substrings likely to appear in messages relevant to this focus — domain jargon, abbreviations, logistics words (payments, deadlines, transport, gear), place names, misspellings. Recall over precision.`,
          schema: {
            type: "object",
            properties: { keywords: { type: "array", items: { type: "string" } } },
            required: ["keywords"], additionalProperties: false,
          },
          tier: "triage",
        });
        store.setFocus({
          text,
          anchorDate: flag(args, "date") ?? null,
          anchorLabel: flag(args, "label") ?? "the day",
          keywords: res.data.keywords.map((k) => k.toLowerCase()),
        });
        const f = store.getFocus();
        console.log(args.includes("--json") ? JSON.stringify(f) : `focus set: ${f.text}\nanchor: ${f.anchorDate ?? "none"} (${f.anchorLabel})\nkeywords (${f.keywords.length}): ${f.keywords.join(", ")}`);
      } else {
        const f = store.getFocus();
        console.log(args.includes("--json") ? JSON.stringify(f) : (f.text ?? "(no focus set)"));
      }
      store.close();
      break;
    }

    case "profile": {
      const sub = args[0];
      const store = new Store();
      if (sub === "set") {
        const text = flag(args, "text");
        const aliases = flag(args, "aliases");
        if (text !== undefined) store.setProfile(text);
        if (aliases !== undefined) {
          store.setIdentity({ aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean) });
        }
        console.log(JSON.stringify({ ok: true }));
      } else if (sub === "infer") {
        const { inferProfile } = await import("./infer.js");
        const backend = await configuredBackend(store, args);
        const draft = await inferProfile(backend, store);
        if (args.includes("--apply")) store.setProfile(draft.profile);
        if (args.includes("--json")) console.log(JSON.stringify({ ...draft, applied: args.includes("--apply") }));
        else {
          console.log(draft.profile);
          if (draft.uncertainties.length > 0) {
            console.log("\nWorth confirming (edit the profile to answer):");
            draft.uncertainties.forEach((u) => console.log(`  ? ${u}`));
          }
          console.log(args.includes("--apply") ? "\n(applied — edit in Settings anytime)" : "\n(draft only — re-run with --apply to save)");
        }
      } else {
        const out = { profile: store.getProfile(), identity: store.getIdentity() };
        console.log(args.includes("--json") ? JSON.stringify(out) : (out.profile ?? "(no profile set)"));
      }
      store.close();
      break;
    }

    case "digest": {
      const sub = args[0];
      const store = new Store();
      const { generateDigest, localDay } = await import("./summary.js");
      if (sub === "send") {
        // Opt-in delivery to the user's own iMessage account. This uses
        // Messages.app's scripting API and never opens or automates WhatsApp.
        if (args.includes("--if-enabled")) {
          const on = store.getDigestAutosend();
          const sentDay = (store.db.prepare(`SELECT v FROM meta WHERE k='digest_sent_day'`).get() as { v: string } | undefined)?.v;
          if (!on || sentDay === localDay()) {
            console.log(JSON.stringify({ sent: false, reason: !on ? "autosend off" : "already sent today" }));
            store.close();
            break;
          }
        }
        const latest = store.latestDigest();
        if (!latest) throw new Error("no digest to send — run: digest run");
        const identity = store.getIdentity();
        if (!identity.ownPhone) throw new Error("own phone unknown — run init first");
        if (!/^\d{7,15}$/.test(identity.ownPhone)) throw new Error("own phone is not a valid numeric iMessage recipient");
        const d = JSON.parse(latest.json) as {
          day: string; headline: string; narrative: string;
          followUps: { title: string; why: string }[];
          principle?: { name: string; line: string; reflection: string; tip: string };
        };
        const focus = store.getFocus();
        const tMinus = focus.anchorDate ? Math.ceil((Date.parse(focus.anchorDate) - Date.now()) / 86400000) : null;
        const lines = [
          `burn/brief — ${d.day}${tMinus && tMinus > 0 ? ` · T−${tMinus} to ${focus.anchorLabel}` : ""}`,
          "",
          d.headline,
          "",
          d.narrative,
        ];
        if (d.followUps?.length) {
          lines.push("", "Follow up");
          d.followUps.forEach((followUp, index) => lines.push(`${index + 1}. ${followUp.title} — ${followUp.why}`));
        }
        if (d.principle) {
          lines.push("", `${d.principle.name} — ${d.principle.line}`);
          if (d.principle.reflection) lines.push("", d.principle.reflection);
          if (d.principle.tip) lines.push("", `Playa tip: ${d.principle.tip}`);
        }
        const { unlinkSync, writeFileSync } = await import("node:fs");
        const { execFileSync } = await import("node:child_process");
        const body = lines.join("\n");
        const tmp = join(tmpdir(), `burn-brief-digest-${process.pid}.txt`);
        writeFileSync(tmp, body, "utf8");
        const imsg = `
set msg to (read POSIX file "${tmp}" as «class utf8»)
tell application "Messages"
  set svc to 1st account whose service type = iMessage
  send msg to participant "+${identity.ownPhone}" of svc
end tell`;
        try {
          execFileSync("osascript", ["-e", imsg], { timeout: 30000 });
        } catch (err) {
          try { unlinkSync(tmp); } catch { /* best-effort private temp cleanup */ }
          throw new Error(
            `iMessage self-send failed: ${String(err instanceof Error ? err.message : err).slice(0, 300)}\n` +
              `First use requires approving burn/brief to control Messages. Messages.app must be signed into iMessage.`,
          );
        }
        let verified: boolean | null = null;
        try {
          const { DatabaseSync } = await import("node:sqlite");
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const messagesDb = new DatabaseSync(join(homedir(), "Library/Messages/chat.db"), { readOnly: true });
          const probe = body.slice(0, 20).replace(/'/g, "''");
          const row = messagesDb
            .prepare(
              `SELECT COUNT(*) AS n FROM message
               WHERE is_from_me = 1
                 AND (instr(CAST(attributedBody AS TEXT), '${probe}') > 0
                      OR text LIKE '${probe}%')
                 AND date/1000000000 + 978307200 >= ${Math.floor(Date.now() / 1000) - 120}`,
            )
            .get() as { n: number };
          messagesDb.close();
          verified = row.n > 0;
        } catch { /* Messages history may be unavailable; trust the API result. */ }
        try { unlinkSync(tmp); } catch { /* best-effort private temp cleanup */ }
        store.db.prepare(`INSERT INTO meta (k,v) VALUES ('digest_sent_day', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(localDay());
        console.log(JSON.stringify({ sent: true, channel: "imessage", verified, day: d.day, chars: body.length }));
      } else if (sub === "autosend") {
        const value = args[1];
        if (value === "on" || value === "off") {
          store.setDigestAutosend(value === "on");
        }
        const current = store.getDigestAutosend() ? "on" : "off";
        console.log(JSON.stringify({ autosend: current, channel: "imessage" }));
      } else if (sub === "run") {
        const backend = await configuredBackend(store, args);
        const digest = await generateDigest(backend, store, localDay());
        console.log(args.includes("--json") ? JSON.stringify(digest) : formatDigest(digest));
      } else {
        const dayFlag = flag(args, "day");
        const rec = dayFlag ? store.getDigest(dayFlag) : store.latestDigest();
        if (!rec) console.log(args.includes("--json") ? "null" : "no digest for that day");
        else console.log(args.includes("--json") ? rec.json : formatDigest(JSON.parse(rec.json)));
      }
      store.close();
      break;
    }

    case "goal": {
      const sub = args[0];
      const store = new Store();
      if (sub === "add") {
        const desc = args[1];
        if (!desc) throw new Error(`usage: goal add "description"`);
        const id = store.addGoal(desc);
        const json = args.includes("--json");
        if (!json) console.log(`goal ${id} added; compiling...`);
        const backend = await configuredBackend(store, args);
        const compiled = await compileGoal(backend, store, id, desc);
        if (json) { console.log(JSON.stringify({ id, compiled })); store.close(); break; }
        console.log(`\nrubric: ${compiled.rubric}`);
        console.log(`keywords (${compiled.keywords.length}): ${compiled.keywords.join(", ")}`);
        console.log(`negative: ${compiled.negativeKeywords.join(", ")}`);
        if (compiled.clarifyingQuestions.length > 0) {
          console.log(`\nclarifying questions — answer by editing the goal or re-adding with detail:`);
          compiled.clarifyingQuestions.forEach((q) => console.log(`  ? ${q}`));
        }
      } else if (sub === "list") {
        for (const g of store.goals()) {
          console.log(`[${g.id}] (${g.status}) ${g.description}${g.compiled ? "" : "  [not compiled]"}`);
        }
      } else if (sub === "pause" || sub === "achieve") {
        const id = Number(args[1]);
        store.setGoalStatus(id, sub === "pause" ? "paused" : "achieved");
        console.log(`goal ${id} ${sub}d`);
      } else {
        console.log(`usage: goal add "desc" | goal list | goal pause <id> | goal achieve <id>`);
      }
      store.close();
      break;
    }

    case "reprioritize": {
      // Re-run the prefilter over pending messages (after goal changes).
      const { prefilter } = await import("./prefilter.js");
      const store = new Store();
      const identity = store.getIdentity();
      const goals = store.goals(true);
      const focusKeywords = store.getFocus().keywords;
      const rows = store.db
        .prepare(`SELECT * FROM messages WHERE llm_status = 'pending'`)
        .all() as StoredMessage[];
      const upd = store.db.prepare(`UPDATE messages SET priority = ?, signals = ? WHERE id = ?`);
      store.transaction(() => {
        for (const r of rows) {
          const pf = prefilter(
            {
              id: r.id, sourceId: r.source_id, cursor: r.cursor, chatJid: r.chat_jid,
              chatName: r.chat_name, senderJid: r.sender_jid, senderName: r.sender_name,
              isFromMe: !!r.is_from_me, ts: r.ts, text: r.text, msgType: r.msg_type,
            },
            identity, goals, focusKeywords,
          );
          upd.run(pf.priority, JSON.stringify(pf.signals), r.id);
        }
      });
      console.log(`reprioritized ${rows.length} pending messages against ${goals.length} active goal(s)`);
      store.close();
      break;
    }

    case "classify": {
      const store = new Store();
      const backend = await configuredBackend(store, args);
      const stats = await classifyPending(backend, store, {
        maxBatches: Number(flag(args, "max-batches") ?? 10),
        batchSize: Number(flag(args, "batch-size") ?? 50),
        minPriority: Number(flag(args, "min-priority") ?? 0),
      });
      console.log(
        `classified ${stats.messages} messages in ${stats.batches} batches -> ` +
          `${stats.itemsCreated} items (+${stats.merged} merged into existing), ${stats.errors} errors`,
      );
      store.close();
      break;
    }

    case "run": {
      // One scheduler tick: ingest new messages, classify within budget.
      const source = new MacSqliteSource();
      const store = new Store();
      const ingestStats = ingest(source, store);
      source.close();
      const backend = await configuredBackend(store, args);
      const classifyStats = await classifyPending(backend, store, {
        maxBatches: Number(flag(args, "max-batches") ?? 5),
        minPriority: Number(flag(args, "min-priority") ?? 1),
      });
      // Retire stale low-priority backlog so pending can't grow unbounded;
      // 7 days is well past any digest/notification window.
      const staleCutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
      const swept = store.db
        .prepare(`UPDATE messages SET llm_status='skipped' WHERE llm_status='pending' AND ts < ?`)
        .run(staleCutoff).changes;
      const out = { ingest: ingestStats, classify: classifyStats, sweptStale: swept };
      console.log(args.includes("--json") ? JSON.stringify(out) : JSON.stringify(out, null, 2));
      store.close();
      break;
    }

    case "status": {
      const store = new Store();
      const counts = store.messageCount();
      const id = store.getIdentity();
      const backends = await detectBackends();
      const out = {
        messages: counts,
        identity: id,
        goals: store.goals(),
        backends: backends.map((b) => ({ id: b.backend.id, version: b.version })),
        backendPreference: store.getBackendPreference(),
        digestAutosend: store.getDigestAutosend(),
        focus: store.getFocus(),
        itemCounts: store.db
          .prepare(`SELECT type, COUNT(*) AS n FROM items WHERE status='new' GROUP BY type`)
          .all(),
      };
      console.log(args.includes("--json") ? JSON.stringify(out) : JSON.stringify(out, null, 2));
      store.close();
      break;
    }

    case "item-status": {
      const store = new Store();
      store.setItemStatus(Number(args[0]), args[1] as never);
      console.log(JSON.stringify({ ok: true }));
      store.close();
      break;
    }

    case "items": {
      const store = new Store();
      // --day YYYY-MM-DD: archive view — everything created that local day.
      const dayFlag = flag(args, "day");
      let sinceTs: number | undefined;
      let untilTs: number | undefined;
      if (dayFlag) {
        const [y, m, dd] = dayFlag.split("-").map(Number);
        sinceTs = Math.floor(new Date(y, m - 1, dd).getTime() / 1000);
        untilTs = sinceTs + 86400;
      }
      const list = store.items({
        type: flag(args, "type") as never,
        status: (flag(args, "status") as never) ?? undefined,
        limit: Number(flag(args, "limit") ?? 30),
        excludeDismissed: args.includes("--exclude-dismissed"),
        sinceTs, untilTs,
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(list));
        store.close();
        break;
      }
      for (const it of list) {
        console.log(`\n[${it.id}] ${it.type.toUpperCase()} (${(it.confidence * 100).toFixed(0)}%) ${it.title}`);
        console.log(`    ${it.summary}`);
        console.log(`    ${it.chatName} · sources: ${it.sourceMsgIds.join(", ")}`);
        if (Object.keys(it.fields).length > 0) console.log(`    ${JSON.stringify(it.fields)}`);
      }
      if (list.length === 0) console.log("no items");
      store.close();
      break;
    }

    default:
      console.log(`burn/brief — your private Black Rock City briefing

usage:
  doctor                         check source, backends, store
  init --alias <name> [...]      first-run: identity + full ingest (--backend auto|claude|codex)
  backend show | list            show the selected and available agent CLIs
  backend set auto|claude|codex  choose an agent CLI (auto uses any available)
  ingest                         pull new messages past the watermark
  goal add "<description>"       add + compile a goal
  goal list | pause <id> | achieve <id>
  classify [--max-batches 10]    classify pending messages into items
  items [--type X] [--limit 30]  show items
  digest run | show              generate or read the daily briefing
  digest send                    send the current edition to your own iMessage
  digest autosend on|off         control daily iMessage-to-self delivery`);
  }
}

/** Scrutiny tiers: watched chats classify in full; everything else needs a burn signal. */
function formatDigest(d: {
  day: string; headline: string; narrative: string;
  followUps: { title: string; why: string }[];
  stats?: Record<string, number>;
}): string {
  const lines = [
    `=== Daily briefing — ${d.day} ===`,
    "", d.headline, "", d.narrative,
  ];
  if (d.followUps.length > 0) {
    lines.push("", "Follow up:");
    for (const f of d.followUps) lines.push(`  • ${f.title} — ${f.why}`);
  }
  const principle = (d as { principle?: { name: string; line: string; reflection: string; tip: string } }).principle;
  if (principle) {
    lines.push("", `※ ${principle.name} — ${principle.line}`);
    if (principle.reflection) lines.push("", principle.reflection);
    if (principle.tip) lines.push("", `Playa tip: ${principle.tip}`);
  }
  if (d.stats) {
    lines.push("", `(${d.stats.newItems} new items, ${d.stats.messagesScanned24h} messages scanned, ${d.stats.liveCutoffs} live cutoffs, ${d.stats.openAsks} open asks)`);
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
