import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  findLegacyEntries,
  buildNoticeText,
  buildSessionStartPayload,
  main
} from "../scripts/old-marketplace-notice.mjs";

const RETIRED_REPO = "8hats/plugins";

function githubEntry(repo) {
  return { source: { source: "github", repo }, autoUpdate: true };
}

async function makeConfigDir(t, { registry, settings } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "old-mp-notice-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  if (registry !== undefined) {
    await fs.mkdir(path.join(dir, "plugins"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugins", "known_marketplaces.json"),
      typeof registry === "string" ? registry : JSON.stringify(registry),
      "utf8"
    );
  }
  if (settings !== undefined) {
    await fs.writeFile(
      path.join(dir, "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
      "utf8"
    );
  }
  return dir;
}

function collectStdout() {
  const chunks = [];
  return {
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    text: () => chunks.join("")
  };
}

// --- detection -------------------------------------------------------------

test("finds a marketplace registered from the retired public repo", () => {
  const entries = findLegacyEntries({
    registry: {
      "8hats": githubEntry(RETIRED_REPO),
      "8hats-plugins": githubEntry("8hats/8hats-plugins")
    }
  });

  assert.deepEqual(entries, [{ key: "8hats", hijacked: false }]);
});

test("stays silent when nothing points at the retired repo", () => {
  const entries = findLegacyEntries({
    registry: {
      "8hats": githubEntry("8hats/marketplace"),
      "8hats-plugins": githubEntry("8hats/8hats-plugins"),
      "agent-university": { source: { source: "directory", path: "/somewhere" } }
    }
  });

  assert.deepEqual(entries, []);
});

test("flags the hijack: the internal key retargeted at the public repo", () => {
  const entries = findLegacyEntries({
    registry: { "8hats-plugins": githubEntry(RETIRED_REPO) }
  });

  assert.deepEqual(entries, [{ key: "8hats-plugins", hijacked: true }]);
});

test("also inspects extraKnownMarketplaces in settings", () => {
  const entries = findLegacyEntries({
    registry: {},
    settings: { extraKnownMarketplaces: { "8hats": githubEntry(RETIRED_REPO) } }
  });

  assert.deepEqual(entries, [{ key: "8hats", hijacked: false }]);
});

test("reports each affected key once, even when both files carry it", () => {
  const entries = findLegacyEntries({
    registry: { "8hats": githubEntry(RETIRED_REPO) },
    settings: { extraKnownMarketplaces: { "8hats": githubEntry(RETIRED_REPO) } }
  });

  assert.deepEqual(entries, [{ key: "8hats", hijacked: false }]);
});

test("tolerates absent, null and malformed inputs", () => {
  assert.deepEqual(findLegacyEntries({}), []);
  assert.deepEqual(findLegacyEntries({ registry: null, settings: null }), []);
  assert.deepEqual(findLegacyEntries({ registry: "not an object" }), []);
  assert.deepEqual(findLegacyEntries({ registry: { broken: {} } }), []);
});

// --- wording ---------------------------------------------------------------

test("the notice names the move, the new repo and the affected key", () => {
  const text = buildNoticeText([{ key: "8hats", hijacked: false }]);

  assert.match(text, /8hats\/marketplace/);
  assert.match(text, /8hats\/plugins/);
  assert.match(text, /`8hats`/);
  assert.match(text, /marketplace add 8hats\/marketplace/);
  assert.match(text, /marketplace remove 8hats\b/);
});

test("the notice tells the agent to surface it to the user", () => {
  const text = buildNoticeText([{ key: "8hats", hijacked: false }]);
  assert.match(text, /tell the user/i);
});

test("the hijack case never advises removing the entry", () => {
  const text = buildNoticeText([{ key: "8hats-plugins", hijacked: true }]);

  assert.doesNotMatch(text, /marketplace remove/);
  assert.match(text, /8hats\/8hats-plugins/);
  assert.match(text, /internal/i);
});

test("payload is a valid SessionStart hook response", () => {
  const payload = buildSessionStartPayload("hello");

  assert.deepEqual(payload, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "hello"
    }
  });
});

// --- the hook end to end ---------------------------------------------------

test("main emits the notice when the retired repo is registered", async (t) => {
  const configDir = await makeConfigDir(t, {
    registry: { "8hats": githubEntry(RETIRED_REPO) }
  });
  const out = collectStdout();

  const code = await main({ configDir, stdout: out.stream });

  assert.equal(code, 0);
  const payload = JSON.parse(out.text());
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /8hats\/marketplace/);
});

test("main writes nothing once the machine has migrated", async (t) => {
  const configDir = await makeConfigDir(t, {
    registry: { "8hats": githubEntry("8hats/marketplace") }
  });
  const out = collectStdout();

  const code = await main({ configDir, stdout: out.stream });

  assert.equal(code, 0);
  assert.equal(out.text(), "");
});

test("main stays silent and succeeds when the config files are missing", async (t) => {
  const configDir = await makeConfigDir(t, {});
  const out = collectStdout();

  const code = await main({ configDir, stdout: out.stream });

  assert.equal(code, 0);
  assert.equal(out.text(), "");
});

test("main stays silent and succeeds on malformed JSON", async (t) => {
  const configDir = await makeConfigDir(t, {
    registry: "{ this is not json",
    settings: "}}}"
  });
  const out = collectStdout();

  const code = await main({ configDir, stdout: out.stream });

  assert.equal(code, 0);
  assert.equal(out.text(), "");
});
