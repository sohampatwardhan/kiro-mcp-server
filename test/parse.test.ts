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
