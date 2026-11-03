import { ToolError } from "./errors.js";

export interface TangentNode {
  sessionId: string;
  name: string | null;
  parentSessionId: string | null;
  rootSessionId: string;
  children: TangentNode[];
}

/**
 * Tangent branches, held in memory only (Requirement 16.8): the forked
 * sessions stay in Kiro's store, but this tree does not survive a restart.
 */
export class TangentTree {
  private readonly nodes = new Map<string, TangentNode>();
  private readonly counters = new Map<string, number>();

  private node(sessionId: string): TangentNode {
    let node = this.nodes.get(sessionId);
    if (node === undefined) {
      node = { sessionId, name: null, parentSessionId: null, rootSessionId: sessionId, children: [] };
      this.nodes.set(sessionId, node);
    }
    return node;
  }

  has(sessionId: string): boolean {
    return this.nodes.has(sessionId);
  }

  branch(parentId: string, childId: string, name?: string): TangentNode {
    const parent = this.node(parentId);
    const root = parent.rootSessionId;
    const taken = new Set([...this.nodes.values()].filter((n) => n.rootSessionId === root).map((n) => n.name));
    let chosen = name;
    if (chosen === undefined) {
      do {
        const next = (this.counters.get(root) ?? 0) + 1;
        this.counters.set(root, next);
        chosen = `tangent-${next}`;
      } while (taken.has(chosen));
    } else if (taken.has(chosen)) {
      let i = 2;
      while (taken.has(`${name}-${i}`)) i++;
      chosen = `${name}-${i}`;
    }
    const child: TangentNode = { sessionId: childId, name: chosen, parentSessionId: parentId, rootSessionId: root, children: [] };
    this.nodes.set(childId, child);
    parent.children.push(child);
    return child;
  }

  /** The session a merge from `sessionId` goes to: `parent`, `root`, or a tangent name in the same tree. */
  resolve(sessionId: string, destination: string): string {
    const node = this.nodes.get(sessionId);
    if (node === undefined) throw new ToolError("TANGENT_NOT_FOUND", `${sessionId} is not part of a tangent tree on this server`);
    let target: string | null;
    if (destination === "parent") target = node.parentSessionId;
    else if (destination === "root") target = node.rootSessionId;
    else {
      const named = [...this.nodes.values()].find((n) => n.rootSessionId === node.rootSessionId && n.name === destination);
      if (named === undefined) throw new ToolError("TANGENT_NOT_FOUND", `no tangent named ${JSON.stringify(destination)} in this tree`);
      target = named.sessionId;
    }
    if (target === null || target === sessionId) throw new ToolError("INVALID_MERGE_TARGET", `merge destination ${JSON.stringify(destination)} resolves to the tangent itself or to nothing`);
    return target;
  }

  /** The whole tree that contains `sessionId`, from its root. */
  tree(sessionId: string): TangentNode {
    const node = this.nodes.get(sessionId);
    return this.node(node?.rootSessionId ?? sessionId);
  }
}

export function treeView(node: TangentNode): Record<string, unknown> {
  return {
    session_id: node.sessionId,
    name: node.name,
    parent_session_id: node.parentSessionId,
    children: node.children.map(treeView),
  };
}
