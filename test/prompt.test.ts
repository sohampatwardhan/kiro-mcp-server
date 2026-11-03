import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { Roots } from "../src/paths.js";
import { buildPromptBlocks, closestNames, sniffImage } from "../src/prompt.js";
import { tempDir } from "./helpers.js";

const tmp = tempDir("kiro-mcp-prompt-");
after(() => rmSync(tmp, { recursive: true, force: true }));
const work = join(tmp, "work");
mkdirSync(work);
writeFileSync(join(work, "notes.md"), "# Notes\nhello\n");
writeFileSync(join(work, "big.txt"), "x".repeat(256 * 1024 + 1));
writeFileSync(join(work, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
writeFileSync(join(work, "shot.png"), PNG);
writeFileSync(join(work, "fake.png"), "not an image");
writeFileSync(join(tmp, "secret.txt"), "secret");
symlinkSync(join(tmp, "secret.txt"), join(work, "link.txt"));

const roots = new Roots([work]);
const commands = [
  { name: "code-review", _meta: { kiro: { type: "skill" } } },
  { name: "context-gatherer", _meta: { kiro: { type: "custom-agent" } } },
  { name: "fetch", _meta: { kiro: { type: "prompt" } } },
];
const ctx = { roots, cwd: work, promptCapabilities: { image: true, embeddedContext: true }, commands };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
};

describe("buildPromptBlocks", () => {
  it("sends text, and passes @prompt text through unchanged", async () => {
    assert.deepEqual(await buildPromptBlocks({ text: "hello" }, ctx), [{ type: "text", text: "hello" }]);
    assert.deepEqual(await buildPromptBlocks({ text: "@release-notes v2" }, ctx), [{ type: "text", text: "@release-notes v2" }]);
  });

  it("links files by default and embeds UTF-8 text on request", async () => {
    const blocks = await buildPromptBlocks({ text: "see", files: [{ path: "notes.md" }, { path: "notes.md", embed: true }] }, ctx);
    const uri = pathToFileURL(join(work, "notes.md")).href;
    assert.deepEqual(blocks[1], { type: "resource_link", uri, name: "notes.md", size: 14 });
    assert.deepEqual(blocks[2], { type: "resource", resource: { uri, text: "# Notes\nhello\n", mimeType: "text/markdown" } });
  });

  it("refuses embedding large or non-UTF-8 files and paths outside the roots", async () => {
    assert.equal(await code(buildPromptBlocks({ text: "x", files: [{ path: "big.txt", embed: true }] }, ctx)), "CONTENT_TOO_LARGE");
    assert.equal(await code(buildPromptBlocks({ text: "x", files: [{ path: "binary.bin", embed: true }] }, ctx)), "CONTENT_TOO_LARGE");
    assert.equal(await code(buildPromptBlocks({ text: "x", files: [{ path: "link.txt" }] }, ctx)), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(buildPromptBlocks({ text: "x", files: [{ path: join(tmp, "secret.txt") }] }, ctx)), "PATH_OUTSIDE_ROOTS");
  });

  it("adds images from a path or base64 and checks the type", async () => {
    const blocks = await buildPromptBlocks({ text: "look", images: [{ path: "shot.png" }, { data: PNG.toString("base64"), mime_type: "image/png" }] }, ctx);
    assert.deepEqual(blocks[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png", uri: pathToFileURL(join(work, "shot.png")).href });
    assert.deepEqual(blocks[2], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    assert.equal(await code(buildPromptBlocks({ text: "x", images: [{ path: "fake.png" }] }, ctx)), "CONTENT_TOO_LARGE");
    assert.equal(await code(buildPromptBlocks({ text: "x", images: [{ data: PNG.toString("base64"), mime_type: "image/jpeg" }] }, ctx)), "CONTENT_TOO_LARGE");
  });

  it("refuses images when the host does not advertise them", async () => {
    const noImages = { ...ctx, promptCapabilities: { image: false, embeddedContext: true } };
    assert.equal(await code(buildPromptBlocks({ text: "x", images: [{ path: "shot.png" }] }, noImages)), "UNSUPPORTED_BY_KIRO");
  });

  it("sends an advertised command as /<name> <input>", async () => {
    assert.deepEqual(await buildPromptBlocks({ command: { name: "code-review", input: "src/a.ts" } }, ctx), [{ type: "text", text: "/code-review src/a.ts" }]);
    assert.deepEqual(await buildPromptBlocks({ command: { name: "context-gatherer" }, text: "where is auth?" }, ctx), [{ type: "text", text: "/context-gatherer where is auth?" }]);
  });

  it("refuses an unadvertised command and lists the closest names", async () => {
    await assert.rejects(buildPromptBlocks({ command: { name: "code-reviw" } }, ctx), (err: unknown) => {
      return err instanceof ToolError && err.code === "VALUE_NOT_ADVERTISED" && (err.details.closest as string[])[0] === "code-review";
    });
  });

  it("needs text or a command", async () => {
    await assert.rejects(buildPromptBlocks({ files: [{ path: "notes.md" }] }, ctx), /text or a command/);
  });
});

describe("helpers", () => {
  it("sniffs image types by magic bytes", () => {
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
    assert.equal(sniffImage(Buffer.from("hello")), null);
  });

  it("ranks the closest names", () => {
    assert.deepEqual(closestNames("fech", ["fetch", "code-review", "fork"]).slice(0, 2), ["fetch", "fork"]);
  });
});
