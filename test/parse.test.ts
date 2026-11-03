import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTasks } from "../src/specs.js";

const TASKS = `# Implementation Plan

## Task graph

\`\`\`mermaid
flowchart TB
  t1["- [ ] 9. not a task, inside a fence"]
\`\`\`

## Tasks

- [x] 1. Set up CI
  - Gates every later task
- [ ] 2. Foundation
- [x] 2.1 Scaffold
  - _Requirements: 1.1, 1.2_
- [ ] 2.2 Roots (optional)
  - _Requirements: 4.1_
- [X] 3. Upper-case check
`;

describe("parseTasks", () => {
  it("parses numbered checkboxes outside code fences with requirement ids", () => {
    const { tasks, checked, unchecked } = parseTasks(TASKS);
    assert.deepEqual(
      tasks.map((t) => [t.number, t.checked, t.optional]),
      [
        ["1", true, false],
        ["2", false, false],
        ["2.1", true, false],
        ["2.2", false, true],
        ["3", true, false],
      ],
    );
    assert.deepEqual(tasks[2]?.requirements, ["1.1", "1.2"]);
    assert.equal(tasks[3]?.title, "Roots (optional)");
    assert.equal(checked, 3);
    assert.equal(unchecked, 2);
  });
});

describe("text parsers", () => {
  it("parses mcp list text with ANSI codes, scopes, and disabled markers", async () => {
    const { parseMcpList } = await import("../src/parse.js");
    const text =
      "\u001b[1m📄 Global:\u001b[0m /home/dev/.kiro/settings/mcp.json\n  • docs         https://docs.example.dev/mcp\n  • fetch        uvx mcp-server-fetch\n\n" +
      "\u001b[1m📄 Workspace:\u001b[0m /work/.kiro/settings/mcp.json\n  • local-tools  http://localhost:7000/mcp (disabled)\n";
    assert.deepEqual(parseMcpList(text), [
      { name: "docs", target: "https://docs.example.dev/mcp", scope: "global", disabled: false },
      { name: "fetch", target: "uvx mcp-server-fetch", scope: "global", disabled: false },
      { name: "local-tools", target: "http://localhost:7000/mcp", scope: "workspace", disabled: true },
    ]);
  });

  it("parses key-value status text and settings JSON in both shapes", async () => {
    const { parseKeyValues, parseSettings } = await import("../src/parse.js");
    assert.deepEqual(parseKeyValues("\u001b[1mdocs\u001b[0m\nScope: global\nURL: https://x\n"), { scope: "global", url: "https://x" });
    assert.deepEqual(parseSettings('{"a":1}'), { a: 1 });
    assert.deepEqual(parseSettings('[{"key":"b","value":true}]'), { b: true });
    assert.throws(() => parseSettings("nope"));
  });
});
