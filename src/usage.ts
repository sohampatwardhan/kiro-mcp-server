/**
 * Plan usage from `_kiro/account/getUsage` (Requirement 3): normalization,
 * credit totals, a short cache shared by every caller, and the operator's
 * `KIRO_MCP_USAGE_STOP_PERCENT` guard on new work. Reading usage never starts
 * a model turn.
 */

import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";

export interface UsageBreakdown {
  resource_type: string | null;
  display_name: string | null;
  used: number | null;
  limit: number | null;
  percentage: number | null;
}

export interface Usage {
  plan: string | null;
  reset_date: string | null;
  breakdowns: UsageBreakdown[];
  bonus_credits: unknown[];
  add_on_credits: unknown[];
  overages_enabled: boolean | null;
  /** Credits left across plan, bonus, and add-on pools; null when no pool carries numbers. */
  remaining_total: number | null;
  /** Credits used over the credit limit across the same pools, 0 to 100; null when no pool has a limit. */
  percent_used: number | null;
}

export interface UsageReading extends Usage {
  checked_at: string;
  cached: boolean;
  stop_percent: number | null;
  blocked_by: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Turn a getUsage answer into tool fields. `success: false` is KIRO_REFUSED. */
export function normalizeUsage(result: unknown): Usage {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.success === false) throw new ToolError("KIRO_REFUSED", typeof r.message === "string" ? r.message : "Kiro refused the usage request");
  const data = ((r.data ?? r) ?? {}) as Record<string, unknown>;
  const breakdowns = list(data.usageBreakdowns).map((b) => {
    const x = (b ?? {}) as Record<string, unknown>;
    return { resource_type: str(x.resourceType), display_name: str(x.displayName), used: num(x.used), limit: num(x.limit), percentage: num(x.percentage) };
  });
  const bonus = list(data.bonusCredits);
  const addOn = list(data.addOnCredits);

  // Pools of [used, limit]: plan credit breakdowns, then bonus and add-on grants.
  const pools: [number, number][] = [];
  for (const b of breakdowns) {
    const isCredit = b.resource_type === null || b.resource_type.toUpperCase() === "CREDIT";
    if (isCredit && b.used !== null && b.limit !== null) pools.push([b.used, b.limit]);
  }
  for (const g of [...bonus, ...addOn]) {
    const x = (g ?? {}) as Record<string, unknown>;
    const used = num(x.used);
    const total = num(x.total) ?? num(x.limit);
    if (used !== null && total !== null) pools.push([used, total]);
  }
  // Overdrawn pools (overages) count as fully used, so percent_used and remaining_total agree.
  const used = pools.reduce((sum, [u, l]) => sum + Math.min(u, l), 0);
  const limit = pools.reduce((sum, [, l]) => sum + l, 0);
  return {
    plan: str(data.planName),
    reset_date: str(data.billingCycleReset),
    breakdowns,
    bonus_credits: bonus,
    add_on_credits: addOn,
    overages_enabled: typeof data.overagesEnabled === "boolean" ? data.overagesEnabled : null,
    remaining_total: pools.length === 0 ? null : round2(pools.reduce((sum, [u, l]) => sum + Math.max(0, l - u), 0)),
    percent_used: limit > 0 ? round2(Math.min(100, (used / limit) * 100)) : null,
  };
}

export interface UsageReaderOptions {
  /** `KIRO_MCP_USAGE_STOP_PERCENT`, or null when unset. */
  stopPercent: number | null;
  now?: () => number;
  /** How long the guard waits for a reading before letting work go ahead. */
  guardTimeoutMs?: number;
}

/** Cached, shared reads of the plan's usage, and the guard on new work (Requirement 3.5, 3.6). */
export class UsageReader {
  private cache: { usage: Usage; at: number } | null = null;
  private inflight: Promise<{ usage: Usage; at: number }> | null = null;
  /** Until this time the guard skips reading after a failure, so unreadable usage costs one wait, not one per call. */
  private guardSkipUntil = 0;
  private readonly now: () => number;

  constructor(
    private readonly fetchUsage: () => Promise<unknown>,
    private readonly opts: UsageReaderOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** A reading no older than the cache window, unless `refresh` asks for a new one. */
  async read(o: { refresh?: boolean } = {}): Promise<UsageReading> {
    const hit = this.cache;
    if (o.refresh !== true && hit !== null && this.now() - hit.at <= LIMITS.usageCacheMs) return this.reading(hit, true);
    return this.reading(await this.fetchShared(), false);
  }

  /**
   * Throw USAGE_LIMIT_NEAR when the threshold is reached. Usage that cannot be
   * read within the guard timeout lets work go ahead, and the guard then skips
   * reading for the failure window. `kiro_usage` calls still retry at once.
   */
  async guard(): Promise<void> {
    if (this.opts.stopPercent === null || this.now() < this.guardSkipUntil) return;
    let reading: UsageReading;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("usage read timed out")), this.opts.guardTimeoutMs ?? LIMITS.usageGuardTimeoutMs);
        timer.unref();
      });
      reading = await Promise.race([this.read(), timeout]);
    } catch {
      this.guardSkipUntil = this.now() + LIMITS.usageGuardFailureMs;
      return;
    } finally {
      clearTimeout(timer);
    }
    if (reading.blocked_by !== null) {
      throw new ToolError("USAGE_LIMIT_NEAR", reading.blocked_by, {
        percent_used: reading.percent_used,
        stop_percent: reading.stop_percent,
        remaining_total: reading.remaining_total,
        reset_date: reading.reset_date,
      });
    }
  }

  private fetchShared(): Promise<{ usage: Usage; at: number }> {
    if (this.inflight === null) {
      this.inflight = this.fetchUsage()
        .then((result) => {
          const entry = { usage: normalizeUsage(result), at: this.now() };
          this.cache = entry;
          return entry;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private reading(entry: { usage: Usage; at: number }, cached: boolean): UsageReading {
    const stop = this.opts.stopPercent;
    const pct = entry.usage.percent_used;
    let blockedBy: string | null = null;
    if (stop !== null && pct !== null && pct >= stop) {
      const left = entry.usage.remaining_total;
      const reset = entry.usage.reset_date;
      blockedBy =
        `${pct}% of credits used, at or above KIRO_MCP_USAGE_STOP_PERCENT=${stop}` +
        (left !== null ? `; ${left} credits left` : "") +
        (reset !== null ? `; the plan resets ${reset}` : "");
    }
    return { ...entry.usage, checked_at: new Date(entry.at).toISOString(), cached, stop_percent: stop, blocked_by: blockedBy };
  }
}
