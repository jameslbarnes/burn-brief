# Contributing to burn/brief

Issues and pull requests are welcome. Please keep the product's privacy model
and narrow attention hierarchy intact.

## Before opening a pull request

```sh
npm install
npm run release:check
```

Never include a real WhatsApp database, message fixture, generated briefing,
phone number, local path or screenshot containing personal content. Use clearly
fictional names and conversations in tests and documentation.

Changes that touch WhatsApp ingestion must preserve read-only database access
and the schema probe. Changes that invoke an agent must remain bounded and use
the selected Claude/Codex backend. burn/brief must never automate or send through
WhatsApp.
