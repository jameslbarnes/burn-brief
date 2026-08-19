#!/usr/bin/env node
import("../dist/cli.js").catch(() => {
  console.error("Build missing — run `npm run build` first (or use `npm run cli` in dev).");
  process.exit(1);
});
