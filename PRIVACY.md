# burn/brief privacy and data flow

burn/brief is local-first, not offline-only. This document says exactly where
data goes.

## Data read from your Mac

- WhatsApp Desktop's local message database, opened read-only
- Your burn/brief profile, goals, task ledger and generated briefings
- Messages history, read-only and only when verifying optional iMessage
  delivery to yourself
- Optional photographs placed manually in the local `backdrops` folder

## Data stored locally

App state is stored in `~/.burn-brief/app.db`. It includes normalized message
text, classification results, goals, prompt accounting, tasks and briefings.
Existing pre-rename users may continue using `~/.whatsapp-attache/app.db`.

Do not share this database. It can contain private message content.

## Data sent to model providers

Classification and briefing prompts pass through the Claude Code or Codex CLI
installed and authenticated on your Mac. Relevant message text, chat names,
your profile, goals and task history may therefore be processed by Anthropic or
OpenAI according to the account and CLI you selected.

burn/brief has no separate API key, cloud account, analytics endpoint or relay
server. Choosing a different backend changes the model provider for future
runs; it does not migrate your local database.

## Other network requests

The desktop app fetches the public National Weather Service forecast for Black
Rock City. That request contains fixed playa coordinates and no personal data
or message content.

## Message delivery

burn/brief never writes to WhatsApp and never automates the WhatsApp client.

Optional daily delivery uses macOS Messages to send the generated briefing to
the user's own iMessage identity. It is disabled by default, cannot target an
arbitrary recipient and may require a macOS Automation permission on first use.

## Removing local data

Quit burn/brief first. Move `~/.burn-brief` to the Trash to reset a new install.
For an older install, the directory may be `~/.whatsapp-attache`. Never delete
WhatsApp's own database.
