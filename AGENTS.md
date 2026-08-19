# Instructions for coding agents (Claude Code, Codex)

## Installing for a user

The user should not need technical knowledge. Narrate what you are doing in
plain language, but run these steps exactly and do not substitute another data
access method.

These steps are the from-source path. If a packaged DMG is available on the
GitHub Releases page, offer it first: it needs no npm, Node or Xcode — the
user drags the app to Applications, and steps 3–9 apply from the app's
Settings screen instead of the terminal.

1. Confirm this is macOS and that WhatsApp Desktop is signed in.
2. Run `npm install && npm run build`.
3. Run `node dist/cli.js doctor`.
   - If no agent backend is found, explain that burn/brief needs either the
     Claude Code or Codex CLI logged in, then stop for the user's choice.
   - If the WhatsApp source check fails, tell the user to grant Full Disk Access
     to the terminal or agent app in System Settings → Privacy & Security → Full
     Disk Access. The user must do this themselves. After they fully quit and
     reopen that app, rerun `doctor`.
4. Choose the backend matching the current agent:
   - Claude Code: `node dist/cli.js backend set claude`
   - Codex: `node dist/cli.js backend set codex`
   - If the user has both, ask which they prefer or use `auto`.
5. Ask for the user's first name and any aliases that appear in chats, then run
   `node dist/cli.js init --alias <name>` with one `--alias` per alias.
6. Ask what they want the briefing to prioritize. For a standard install, offer
   “Preparing for and attending Burning Man: camp logistics, build, tickets,
   rides, deadlines and people waiting on me.” Save their answer with
   `node dist/cli.js focus set "<answer>"` and optional `--date YYYY-MM-DD
   --label gate` if they provide an arrival or gate date.
7. Offer to add one concrete goal using `node dist/cli.js goal add "<goal>"`,
   then run `node dist/cli.js reprioritize`.
8. Ask whether they want each new morning edition sent to their own iMessage.
   It is off by default. If yes, run `node dist/cli.js digest autosend on` and
   explain that macOS may request permission to control Messages on first send.
9. Run `npm start`. Tell the user the window can be reopened from the menu-bar
   icon and that Settings contains agent, delivery, profile and goal controls.

## Invariants — never violate these

- Open the WhatsApp database **read-only**. Never write to it or suggest
  disabling its protections.
- Never send WhatsApp messages or automate the WhatsApp client. Links may open
  in WhatsApp, but burn/brief emits no keystrokes there.
- iMessage delivery is allowed only to the user's own identity, only after the
  user opts in. Never add arbitrary recipients.
- Never run `sudo`, modify Gatekeeper/SIP/TCC state or edit an agent CLI's own
  permission configuration.
- Classification uses the user's Claude/Codex subscription. Keep batches
  bounded (`--max-batches`); never loop classification unattended without an
  explicit request.
- Never commit databases, generated briefings, screenshots containing personal
  messages, phone numbers or local app data.

## Development notes

- TypeScript, ESM, Node 22.13+. `npm run release:check` is the release gate.
- SQLite access uses Node's built-in `node:sqlite` — there are no native
  modules. Do not add any: the packaged app must stay pure-JS so it needs no
  compiler, no Xcode and no ABI rebuilds.
- Electron runs the CLI on its own embedded Node via `ELECTRON_RUN_AS_NODE`
  (`process.execPath`), so the packaged app requires no system Node at all.
- `npm run dist:mac` builds the DMG with electron-builder; the app icon is
  regenerated with `node scripts/make-icon.mjs`.
- New app state lives in `~/.burn-brief/app.db` and can be overridden with
  `BURN_BRIEF_HOME`. Existing `~/.whatsapp-attache` state is reused when found.
- The WhatsApp schema is undocumented. `MacSqliteSource.probe()` verifies every
  table and column used; update the probe and queries after schema changes,
  never bypass it.
