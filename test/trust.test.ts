import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { trustInstruction, workspaceRootsFile, workspaceTrust } from "../src/trust.js";
import { tempDir } from "./helpers.js";

const home = tempDir("kiro-mcp-trust-");
after(() => rmSync(home, { recursive: true, force: true }));

function write(root: string, text: string): string {
  const file = workspaceRootsFile(root, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("workspaceTrust", () => {
  it("keys the file by the first 16 hex of sha256(real path)", () => {
    // Matches the directory kiro-cli 2.37.1 created for this layout during the design probe.
    assert.equal(workspaceRootsFile("/Users/soham/GitRepos/kiro-mcp-server", "/h"), "/h/.kiro/workspace-roots/21d90d273fe6fe39/permissions.yaml");
  });

  it("reads saved trust", async () => {
    write("/work/trusted", "rules: []\nworkspaceTrusted: true\n");
    assert.equal(await workspaceTrust("/work/trusted", home), true);
  });

  it("reports false for a missing file or no saved flag", async () => {
    assert.equal(await workspaceTrust("/work/never-opened", home), false);
    write("/work/rules-only", "rules:\n  - capability: web_fetch\n    effect: allow\n");
    assert.equal(await workspaceTrust("/work/rules-only", home), false);
  });

  it("reports null when the file cannot be read", { skip: process.getuid?.() === 0 }, async () => {
    const file = write("/work/locked", "workspaceTrusted: true\n");
    chmodSync(file, 0o000);
    try {
      assert.equal(await workspaceTrust("/work/locked", home), null);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("always reports false for the home directory", async () => {
    write(home, "workspaceTrusted: true\n");
    assert.equal(await workspaceTrust(home, home), false);
  });

  it("explains how to trust a folder", () => {
    assert.match(trustInstruction("/w"), /kiro-cli --v3/);
  });
});
