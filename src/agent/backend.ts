// The one interface all intelligence flows through. Backends spawn the user's
// own locally-installed agent CLI headless; no API key is required, though
// ANTHROPIC_API_KEY is honored by the claude CLI if the user prefers it.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appHome } from "../store.js";

export type Tier = "triage" | "synthesis";

export interface AgentRequest {
  /** The task prompt (sent on stdin for claude; positional for codex). */
  prompt: string;
  system?: string;
  /** JSON Schema the response must satisfy. */
  schema: object;
  tier: Tier;
  timeoutMs?: number;
}

export interface AgentResult<T> {
  data: T;
  costUsd?: number;
  durationMs: number;
  backend: string;
  model?: string;
}

export type BackendId = "claude" | "codex";

export interface AgentBackend {
  id: BackendId;
  detect(): Promise<{ version: string } | null>;
  runAgent<T>(req: AgentRequest): Promise<AgentResult<T>>;
}

/** Empty, app-owned cwd so no project CLAUDE.md / hooks / .mcp.json leak in. */
function agentCwd(): string {
  const dir = join(appHome(), "agent-cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  // When the desktop app runs this CLI on Electron's embedded Node it sets
  // ELECTRON_RUN_AS_NODE; that must not leak into the agent CLI's process.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${err.message}\nstderr: ${stderr.slice(0, 2000)}`));
        else resolve({ stdout, stderr });
      },
    );
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

// --- Claude Code ------------------------------------------------------------

export class ClaudeBackend implements AgentBackend {
  readonly id = "claude" as const;

  async detect(): Promise<{ version: string } | null> {
    try {
      const { stdout } = await run("claude", ["--version"], { timeoutMs: 15000, cwd: agentCwd() });
      return { version: stdout.trim() };
    } catch {
      return null;
    }
  }

  async runAgent<T>(req: AgentRequest): Promise<AgentResult<T>> {
    const started = Date.now();
    const model = req.tier === "triage" ? "haiku" : undefined;
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(req.schema),
      "--permission-mode", "dontAsk",
      // A wildcard deny also blocks the internal StructuredOutput tool that
      // --json-schema relies on, so deny the real-world tools by name.
      "--disallowed-tools",
      "Bash", "Edit", "Write", "Read", "Glob", "Grep",
      "WebFetch", "WebSearch", "Task", "NotebookEdit",
    ];
    if (model) args.push("--model", model);
    if (req.system) args.push("--append-system-prompt", req.system);

    // The CLI occasionally emits corrupted stdout (trailing fragments,
    // duplicated documents — observed in ~40% of benchmark invocations).
    // Parse defensively and retry the whole call once before failing.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await run("claude", args, {
          stdin: req.prompt,
          timeoutMs: req.timeoutMs ?? 300_000,
          cwd: agentCwd(),
        });
        const payload = parseClaudeJson(stdout);
        if (payload.is_error) {
          throw new Error(`claude returned an error: ${JSON.stringify(payload.result ?? payload).slice(0, 500)}`);
        }
        const data = extractStructured<T>(payload);
        return {
          data,
          costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : undefined,
          durationMs: Date.now() - started,
          backend: this.id,
          model,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

interface ClaudePayload {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
}

function parseClaudeJson(stdout: string): ClaudePayload {
  try {
    return JSON.parse(stdout) as ClaudePayload;
  } catch {
    // Corrupted stdout: warnings before the payload, or trailing fragments /
    // duplicated documents after it. Take the FIRST parseable document line.
    for (const line of stdout.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      try {
        return JSON.parse(line) as ClaudePayload;
      } catch { /* fragment — keep scanning */ }
    }
    throw new Error(`claude produced no parseable JSON payload: ${stdout.slice(0, 500)}`);
  }
}

function extractStructured<T>(payload: ClaudePayload): T {
  if (payload.structured_output !== undefined) return payload.structured_output as T;
  // Fallback for CLI versions without structured_output: result text as JSON.
  if (typeof payload.result === "string") {
    const text = payload.result.trim().replace(/^```(json)?\n?|```$/g, "");
    return JSON.parse(text) as T;
  }
  throw new Error("claude payload had neither structured_output nor parseable result");
}

// --- Codex ------------------------------------------------------------------

export class CodexBackend implements AgentBackend {
  readonly id = "codex" as const;

  async detect(): Promise<{ version: string } | null> {
    try {
      const { stdout } = await run("codex", ["--version"], { timeoutMs: 15000, cwd: agentCwd() });
      return { version: stdout.trim() };
    } catch {
      return null;
    }
  }

  async runAgent<T>(req: AgentRequest): Promise<AgentResult<T>> {
    const started = Date.now();
    const stamp = `${process.pid}-${started}`;
    const schemaFile = join(tmpdir(), `burn-brief-schema-${stamp}.json`);
    const outFile = join(tmpdir(), `burn-brief-out-${stamp}.json`);
    try {
      writeFileSync(schemaFile, JSON.stringify(req.schema), { mode: 0o600 });
      writeFileSync(outFile, "", { mode: 0o600 });
      const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
      const args = [
        "exec",
        "--json",
        "--output-schema", schemaFile,
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "-o", outFile,
        "-", // read the prompt from stdin
      ];
      await run("codex", args, {
        stdin: prompt,
        timeoutMs: req.timeoutMs ?? 300_000,
        cwd: agentCwd(),
      });
      const { readFileSync } = await import("node:fs");
      const data = JSON.parse(readFileSync(outFile, "utf8")) as T;
      return { data, durationMs: Date.now() - started, backend: this.id };
    } finally {
      // Structured outputs can contain private message summaries. Do not leave
      // them behind in the shared temp directory after Codex exits.
      rmSync(schemaFile, { force: true });
      rmSync(outFile, { force: true });
    }
  }
}

// --- selection --------------------------------------------------------------

export async function detectBackends(): Promise<
  { backend: AgentBackend; version: string }[]
> {
  const candidates: AgentBackend[] = [new ClaudeBackend(), new CodexBackend()];
  const out: { backend: AgentBackend; version: string }[] = [];
  for (const b of candidates) {
    const d = await b.detect();
    if (d) out.push({ backend: b, version: d.version });
  }
  return out;
}

export async function pickBackend(preferred?: string): Promise<AgentBackend> {
  const found = await detectBackends();
  if (found.length === 0) {
    throw new Error(
      "No agent CLI found. Install Claude Code (https://claude.com/claude-code) or Codex, then re-run.",
    );
  }
  if (preferred) {
    if (preferred !== "claude" && preferred !== "codex") {
      throw new Error(`Unknown agent CLI "${preferred}". Choose auto, claude or codex.`);
    }
    const match = found.find((f) => f.backend.id === preferred);
    if (match) return match.backend;
    throw new Error(
      `${preferred} is selected but its CLI is not installed or logged in. ` +
      `Run "node dist/cli.js backend set auto" to use any available agent CLI.`,
    );
  }
  return found[0].backend;
}
