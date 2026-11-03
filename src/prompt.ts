import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

import type { CommandInfo, ContentBlock, PromptCapabilities } from "./acp/types.js";
import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";
import type { Roots } from "./paths.js";

export interface PromptInput {
  text?: string;
  files?: { path: string; embed?: boolean }[];
  images?: ({ path: string } | { data: string; mime_type: string })[];
  command?: { name: string; input?: string };
}

export interface PromptContext {
  roots: Roots;
  /** Relative paths resolve against the session's cwd. */
  cwd: string;
  promptCapabilities: PromptCapabilities;
  commands: CommandInfo[];
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/** PNG, JPEG, GIF, or WebP by magic bytes, else null. */
export function sniffImage(bytes: Buffer): (typeof IMAGE_TYPES)[number] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] ?? 0;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length] ?? 0;
}

/** Up to five names nearest to `name` by edit distance. */
export function closestNames(name: string, names: string[]): string[] {
  return [...new Set(names)]
    .map((n) => ({ n, d: distance(name.toLowerCase(), n.toLowerCase()) - (n.startsWith(name) || name.startsWith(n) ? 2 : 0) }))
    .sort((x, y) => x.d - y.d || x.n.localeCompare(y.n))
    .slice(0, 5)
    .map((x) => x.n);
}

/**
 * ACP prompt content blocks for a kiro_prompt call (Requirement 9.2–9.5, 9.8).
 * Text starting with `@name` passes through unchanged.
 */
export async function buildPromptBlocks(input: PromptInput, ctx: PromptContext): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (input.command !== undefined) {
    const names = ctx.commands.map((c) => c.name);
    if (!names.includes(input.command.name)) {
      throw new ToolError("VALUE_NOT_ADVERTISED", `command ${JSON.stringify(input.command.name)} is not in the session's advertised catalog; nothing was sent`, {
        closest: closestNames(input.command.name, names),
      });
    }
    const rest = input.command.input ?? input.text ?? "";
    blocks.push({ type: "text", text: `/${input.command.name}${rest !== "" ? ` ${rest}` : ""}` });
  } else if (input.text !== undefined && input.text.trim() !== "") {
    blocks.push({ type: "text", text: input.text });
  } else {
    throw new Error("kiro_prompt needs text or a command");
  }

  const files = input.files ?? [];
  if (files.length > LIMITS.maxFiles) throw new ToolError("CONTENT_TOO_LARGE", `at most ${LIMITS.maxFiles} files per prompt`);
  for (const file of files) {
    const path = await ctx.roots.resolveInside(file.path, ctx.cwd);
    const info = await stat(path);
    if (!info.isFile()) throw new ToolError("CONTENT_TOO_LARGE", `${file.path} is not a regular file`);
    const uri = pathToFileURL(path).href;
    if (file.embed !== true) {
      blocks.push({ type: "resource_link", uri, name: basename(path), size: info.size });
      continue;
    }
    if (ctx.promptCapabilities.embeddedContext === false) throw new ToolError("UNSUPPORTED_BY_KIRO", "this Kiro host does not accept embedded file content");
    if (info.size > LIMITS.embedBytes) throw new ToolError("CONTENT_TOO_LARGE", `${file.path} is ${info.size} bytes; embedding is capped at ${LIMITS.embedBytes}`, { path: file.path, bytes: info.size });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch {
      throw new ToolError("CONTENT_TOO_LARGE", `${file.path} is not UTF-8 text; send it as a link instead`, { path: file.path });
    }
    blocks.push({ type: "resource", resource: { uri, text, mimeType: TEXT_MIME[extname(path).toLowerCase()] ?? "text/plain" } });
  }

  const images = input.images ?? [];
  if (images.length > 0 && ctx.promptCapabilities.image !== true) throw new ToolError("UNSUPPORTED_BY_KIRO", "this Kiro host does not accept images");
  if (images.length > LIMITS.maxImages) throw new ToolError("CONTENT_TOO_LARGE", `at most ${LIMITS.maxImages} images per prompt`);
  for (const image of images) {
    let bytes: Buffer;
    let uri: string | undefined;
    let declared: string | undefined;
    if ("path" in image) {
      const path = await ctx.roots.resolveInside(image.path, ctx.cwd);
      const info = await stat(path);
      if (info.size > LIMITS.imageBytes) throw new ToolError("CONTENT_TOO_LARGE", `${image.path} is over the ${LIMITS.imageBytes}-byte image cap`);
      bytes = await readFile(path);
      uri = pathToFileURL(path).href;
    } else {
      if (image.data.length > Math.ceil((LIMITS.imageBytes * 4) / 3) + 4) throw new ToolError("CONTENT_TOO_LARGE", `image data is over the ${LIMITS.imageBytes}-byte cap`);
      bytes = Buffer.from(image.data, "base64");
      declared = image.mime_type;
    }
    if (bytes.length > LIMITS.imageBytes) throw new ToolError("CONTENT_TOO_LARGE", `image is over the ${LIMITS.imageBytes}-byte cap`);
    const sniffed = sniffImage(bytes);
    if (sniffed === null) throw new ToolError("CONTENT_TOO_LARGE", "images must be PNG, JPEG, GIF, or WebP");
    if (declared !== undefined && declared !== sniffed) throw new ToolError("CONTENT_TOO_LARGE", `mime_type ${declared} does not match the image data (${sniffed})`);
    blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: sniffed, ...(uri !== undefined ? { uri } : {}) });
  }
  return blocks;
}
