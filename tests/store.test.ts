import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

test("persists agent choice and keeps iMessage delivery opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "burn-brief-store-"));
  const store = new Store(dir);
  try {
    assert.equal(store.getBackendPreference(), "auto");
    assert.equal(store.getDigestAutosend(), false);

    store.setBackendPreference("codex");
    store.setDigestAutosend(true);

    assert.equal(store.getBackendPreference(), "codex");
    assert.equal(store.getDigestAutosend(), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
