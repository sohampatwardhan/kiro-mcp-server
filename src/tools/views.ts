import type { AttachedSession } from "../sessions.js";

const BUNDLED = new Set(["bundled", "builtin", "built-in"]);

export function modesOf(session: AttachedSession) {
  return session.modes.map((m) => {
    const source = m._meta?.kiro?.source;
    return {
      id: m.id,
      ...(m.name !== undefined ? { name: m.name } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(source !== undefined ? { source } : {}),
      custom: source !== undefined && !BUNDLED.has(source),
    };
  });
}

export function configOptionsOf(session: AttachedSession) {
  return session.configOptions.map((o) => ({
    id: o.id,
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.category !== undefined ? { category: o.category } : {}),
    current_value: o.currentValue ?? null,
    values: (o.options ?? []).map((v) => v.value),
  }));
}

export function commandsOf(session: AttachedSession) {
  const byType: Record<string, number> = {};
  for (const c of session.commands) {
    const type = c._meta?.kiro?.type ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return { total: session.commands.length, by_type: byType };
}

export function contextUsageOf(session: AttachedSession) {
  const usage = session.contextUsage;
  if (usage === null) return null;
  return {
    usage_percentage: typeof usage.usagePercentage === "number" ? usage.usagePercentage : null,
    summarization_threshold: typeof usage.summarizationThreshold === "number" ? usage.summarizationThreshold : null,
  };
}

export function currentValue(session: AttachedSession, id: string): unknown {
  return session.configOptions.find((o) => o.id === id)?.currentValue;
}
