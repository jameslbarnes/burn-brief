// Electron main process: tray lifecycle, scheduler, and a thin bridge to the
// engine. All data work happens by spawning the CLI (node dist/cli.js --json)
// in a child process — the UI and the CLI are guaranteed to be the same engine,
// and Electron never loads native modules itself (no ABI rebuild needed).

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// getAppPath() is the project root in dev and Contents/Resources/app when
// packaged, so the same expression finds the built CLI in both.
const CLI = join(app.getAppPath(), "dist", "cli.js");
app.setName("burn/brief");

// Finder launches apps with a minimal PATH (/usr/bin:/bin:...), which would
// hide the user's claude/codex CLI from the engine. Append the places agent
// CLIs and node version managers actually install to.
function widenPath() {
  const home = homedir();
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".local", "bin"),        // Claude Code native installer
    join(home, ".claude", "local"),     // Claude Code npm-local installer
    join(home, ".codex", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
  ];
  try {
    const nvmNode = join(home, ".nvm", "versions", "node");
    for (const v of readdirSync(nvmNode)) extra.push(join(nvmNode, v, "bin"));
  } catch { /* no nvm */ }
  const seen = new Set((process.env.PATH ?? "").split(":").filter(Boolean));
  const additions = extra.filter((p) => !seen.has(p) && existsSync(p));
  process.env.PATH = [...seen, ...additions].join(":");
}
widenPath();

const INGEST_EVERY_MS = 60_000;
const CLASSIFY_EVERY_MS = 15 * 60_000;

let win = null;
let tray = null;
let quitting = false;
let lastRun = { at: null, detail: "not yet run" };

const BRC_POINT_URL = "https://api.weather.gov/points/40.7864,-119.2065";
const WEATHER_TTL_MS = 15 * 60_000;
const WEATHER_STALE_LIMIT_MS = 6 * 60 * 60_000;
let brcForecastUrl = null;
let brcForecastUrlExpiresAt = 0;
let brcWeatherCache = null;
let brcWeatherCacheLoaded = false;
let brcWeatherInflight = null;

function localDataHome() {
  const override = process.env.BURN_BRIEF_HOME ?? process.env.WHATSAPP_ATTACHE_HOME;
  if (override) return override;
  const current = join(homedir(), ".burn-brief");
  const legacy = join(homedir(), ".whatsapp-attache");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

async function nwsJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/geo+json",
        "User-Agent": "burn-brief/0.1 (local desktop app; local@localhost)",
      },
    });
    if (!res.ok) throw new Error(`NWS ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function weatherCachePath() {
  return join(app.getPath("userData"), "brc-weather-cache.json");
}

function loadBrcWeatherCache() {
  if (brcWeatherCacheLoaded) return;
  brcWeatherCacheLoaded = true;
  try { brcWeatherCache = JSON.parse(readFileSync(weatherCachePath(), "utf8")); } catch { /* first run */ }
}

async function getBrcWeather() {
  loadBrcWeatherCache();
  const now = Date.now();
  if (brcWeatherCache && now - brcWeatherCache.fetchedAt < WEATHER_TTL_MS) return brcWeatherCache;
  if (brcWeatherInflight) return brcWeatherInflight;
  brcWeatherInflight = (async () => {
    try {
      if (!brcForecastUrl || now >= brcForecastUrlExpiresAt) {
        const point = await nwsJson(BRC_POINT_URL);
        brcForecastUrl = point?.properties?.forecastHourly ?? null;
        brcForecastUrlExpiresAt = now + 12 * 60 * 60_000;
      }
      if (!brcForecastUrl) throw new Error("NWS point has no hourly forecast");
      const forecast = await nwsJson(brcForecastUrl);
      const periods = forecast?.properties?.periods ?? [];
      const period = periods.find((p) => Date.parse(p.startTime) <= now && Date.parse(p.endTime) > now)
        ?? periods.find((p) => Date.parse(p.startTime) > now)
        ?? periods[0];
      if (!period) throw new Error("NWS hourly forecast is empty");
      brcWeatherCache = {
        temperature: period.temperature,
        temperatureUnit: period.temperatureUnit,
        windSpeed: period.windSpeed,
        windDirection: period.windDirection,
        shortForecast: period.shortForecast,
        precipitationChance: period.probabilityOfPrecipitation?.value ?? null,
        validFrom: period.startTime,
        fetchedAt: Date.now(),
        stale: false,
        source: "National Weather Service",
      };
      try { writeFileSync(weatherCachePath(), JSON.stringify(brcWeatherCache)); } catch { /* cache is optional */ }
      return brcWeatherCache;
    } catch {
      if (brcWeatherCache && now - brcWeatherCache.fetchedAt <= WEATHER_STALE_LIMIT_MS) {
        return { ...brcWeatherCache, stale: true };
      }
      return null;
    } finally {
      brcWeatherInflight = null;
    }
  })();
  return brcWeatherInflight;
}

function engine(args, { timeoutMs = 600_000 } = {}) {
  // The CLI runs on Electron's own embedded Node, so a packaged app needs no
  // system Node installed at all. ELECTRON_RUN_AS_NODE turns this same binary
  // into a plain Node runtime for the child.
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args, "--json"],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`engine ${args[0]}: ${err.message}\n${String(stderr).slice(0, 500)}`));
        const line = String(stdout).split("\n").find((l) => l.trimStart().startsWith("{") || l.trimStart().startsWith("["));
        if (!line) return resolve(null);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      },
    );
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    title: "burn/brief",
    frame: false,
    backgroundColor: "#050d19",
    webPreferences: { preload: join(__dirname, "preload.cjs") },
  });
  win.loadFile(join(__dirname, "renderer", "index.html"));
  // The renderer is a single local file; it must never navigate. Any
  // navigation attempt is converted to an external open (or denied).
  win.webContents.on("will-navigate", (e, url) => { e.preventDefault(); openExternalChecked(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalChecked(url); return { action: "deny" }; });
  win.on("close", (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  // Emoji title instead of an icon asset: native on macOS menu bars.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("🕴");
  tray.setToolTip("burn/brief");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Inbox", click: () => { win?.show(); win?.focus(); } },
    { label: "Run now", click: () => runTick(true) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => { win?.show(); win?.focus(); });
}

async function runTick(classify) {
  try {
    if (classify) {
      // min-priority 0: nothing is filtered by default — priority only orders
      // the queue, so focus/watched material classifies first but everything
      // classifies eventually within the bounded batch budget.
      const res = await engine(["run", "--max-batches", "5", "--min-priority", "0"]);
      lastRun = { at: Date.now(), detail: `+${res?.ingest?.inserted ?? 0} msgs, +${res?.classify?.itemsCreated ?? 0} items` };
      notifyNewItems();
      maybeDailyDigest();
    } else {
      const res = await engine(["ingest"]);
      lastRun = { at: Date.now(), detail: res ? `+${res.inserted ?? 0} msgs` : "ingested" };
    }
  } catch (err) {
    lastRun = { at: Date.now(), detail: `error: ${String(err.message ?? err).slice(0, 200)}` };
  }
  win?.webContents.send("burnbrief:refreshed", lastRun);
}

async function notifyNewItems() {
  // Crunch firing rules: direct asks at the user, plus cutoffs closing
  // within 48h. High confidence, capped at 3 per tick.
  const [asks, cutoffs] = await Promise.all([
    engine(["items", "--status", "new", "--type", "for_you", "--limit", "3"]).catch(() => []),
    engine(["items", "--status", "new", "--type", "cutoff", "--limit", "10"]).catch(() => []),
  ]);
  const soon = Date.now() + 48 * 3600 * 1000;
  const urgent = (cutoffs ?? []).filter((it) => {
    const dl = it.fields && it.fields.deadline_iso ? Date.parse(it.fields.deadline_iso) : NaN;
    return !Number.isNaN(dl) && dl <= soon && dl >= Date.now() - 12 * 3600 * 1000;
  });
  let fired = 0;
  for (const it of [...(asks ?? []), ...urgent]) {
    if (fired >= 3) break;
    if (it.confidence < 0.7) continue;
    const title = it.type === "cutoff" ? `Closes soon — ${it.chatName}` : `Needs you — ${it.chatName}`;
    new Notification({ title, body: it.title }).show();
    await engine(["item-status", String(it.id), "seen"]).catch(() => {});
    fired += 1;
  }
}

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let digestRunning = false;
async function maybeDailyDigest() {
  // Once per local day, after 8am, following a classify tick.
  if (digestRunning || new Date().getHours() < 8) return;
  const latest = await engine(["digest", "show"]).catch(() => null);
  if (latest && latest.day === localDay()) return;
  digestRunning = true;
  try {
    const digest = await engine(["digest", "run"]);
    if (digest) {
      new Notification({ title: "Your daily briefing is ready", body: digest.headline }).show();
      win?.webContents.send("burnbrief:refreshed", lastRun);
      // Optional iMessage-to-self delivery; the preference is off by default.
      await engine(["digest", "send", "--if-enabled"]).catch(() => {});
    }
  } catch { /* next tick retries */ } finally {
    digestRunning = false;
  }
}

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

function openExternalChecked(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return false;
  shell.openExternal(u.toString());
  return true;
}

const INVITE_RE = /^\/[A-Za-z0-9]{10,}\/?$/;
function isWhatsAppInvite(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" && u.hostname === "chat.whatsapp.com" && INVITE_RE.test(u.pathname);
  } catch { return false; }
}

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function exportIcs(item) {
  // Events export their start; obligations export their deadline.
  const start = String(item.fields?.start_iso ?? item.fields?.deadline_iso ?? "");
  if (!start) throw new Error("item has no resolvable date");
  const dt = start.replace(/[-:]/g, "").slice(0, 15);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const allDay = dt.length <= 8;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//burn-brief//EN",
    "BEGIN:VEVENT",
    `UID:burn-brief-${item.id}@local`,
    `DTSTAMP:${stamp}`,
    allDay ? `DTSTART;VALUE=DATE:${dt.slice(0, 8)}` : `DTSTART:${dt}`,
    `SUMMARY:${icsEscape(item.fields?.title ?? item.title)}`,
    item.fields?.location ? `LOCATION:${icsEscape(item.fields.location)}` : null,
    `DESCRIPTION:${icsEscape(`${item.summary} (from WhatsApp group: ${item.chatName})`)}`,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  const path = join(homedir(), "Downloads", `burn-brief-event-${item.id}.ics`);
  writeFileSync(path, lines.join("\r\n"));
  shell.showItemInFolder(path);
  return path;
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (process.platform === "darwin") app.dock?.show();

  ipcMain.handle("burnbrief:status", () => engine(["status"]));
  ipcMain.handle("burnbrief:profile", () => engine(["profile", "show"]));
  ipcMain.handle("burnbrief:setProfile", (_e, text, aliases) =>
    engine(["profile", "set", "--text", text ?? "", "--aliases", aliases ?? ""]));
  ipcMain.handle("burnbrief:profileInfer", () => engine(["profile", "infer"], { timeoutMs: 420_000 }));
  ipcMain.handle("burnbrief:goalAdd", (_e, desc) => engine(["goal", "add", desc], { timeoutMs: 300_000 }));
  ipcMain.handle("burnbrief:goalStatus", (_e, id, action) => engine(["goal", action, String(id)]));
  ipcMain.handle("burnbrief:reprioritize", () => engine(["reprioritize"]));
  ipcMain.handle("burnbrief:digest", (_e, day) => engine(day ? ["digest", "show", "--day", day] : ["digest", "show"]));
  ipcMain.handle("burnbrief:loopDone", (_e, id) => engine(["loops", "done", String(id)]));
  ipcMain.handle("burnbrief:loopReopen", (_e, id) => engine(["loops", "reopen", String(id)]));
  ipcMain.handle("burnbrief:loops", () => engine(["loops"]));
  ipcMain.handle("burnbrief:brcWeather", () => getBrcWeather());
  // Backdrop: user-supplied playa photos rotate daily; null -> drawn scene.
  ipcMain.handle("burnbrief:backdrop", () => {
    try {
      const dir = join(localDataHome(), "backdrops");
      const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
      if (files.length === 0) return null;
      const idx = Math.floor(Date.now() / 86400000) % files.length;
      return "file://" + encodeURI(join(dir, files[idx]));
    } catch { return null; }
  });
  ipcMain.handle("burnbrief:digestRun", () => engine(["digest", "run"], { timeoutMs: 300_000 }));
  ipcMain.handle("burnbrief:backendSet", (_e, backend) => engine(["backend", "set", String(backend)]));
  ipcMain.handle("burnbrief:digestAutosend", (_e, enabled) => engine(["digest", "autosend", enabled ? "on" : "off"]));
  ipcMain.handle("burnbrief:exportIcs", (_e, item) => exportIcs(item));
  ipcMain.handle("burnbrief:items", (_e, opts) => {
    const args = ["items", "--limit", String(opts?.limit ?? 100)];
    if (opts?.type) args.push("--type", opts.type);
    if (opts?.status) args.push("--status", opts.status);
    if (opts?.excludeDismissed) args.push("--exclude-dismissed");
    if (opts?.day) args.push("--day", opts.day);
    return engine(args);
  });
  ipcMain.handle("burnbrief:itemStatus", (_e, id, status) => engine(["item-status", String(id), status]));
  // Open any http(s) URL from item text. Returns true if opened.
  ipcMain.handle("burnbrief:openUrl", (_e, url) => openExternalChecked(url));

  // Join a WhatsApp group: strictly validated invite URL only.
  ipcMain.handle("burnbrief:joinGroup", (_e, url) => {
    if (!isWhatsAppInvite(url)) return false;
    shell.openExternal(String(url));
    return true;
  });

  // Launch WhatsApp Desktop; fall back to WhatsApp Web if the scheme is unregistered.
  ipcMain.handle("burnbrief:openWhatsApp", async () => {
    try { await shell.openExternal("whatsapp://"); return { opened: "app" }; }
    catch { await shell.openExternal("https://web.whatsapp.com/"); return { opened: "web" }; }
  });

  ipcMain.handle("burnbrief:runNow", () => runTick(true));
  ipcMain.handle("burnbrief:lastRun", () => lastRun);

  setInterval(() => runTick(false), INGEST_EVERY_MS);
  setInterval(() => runTick(true), CLASSIFY_EVERY_MS);
  runTick(false);
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* stay resident in the tray */ });
app.on("activate", () => { win ? win.show() : createWindow(); });
