import { DurableObject } from "cloudflare:workers";

const WINDOW_SECONDS = 600;
const PER_IP_BUDGET = 5;
const GLOBAL_BUDGET = 20;

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * Read a window counter and apply lazy fixed-window expiry: if `nowMs` has
 * reached `windowStart + 600s`, the window has tumbled and the counter resets to
 * a fresh window anchored at `nowMs`.
 */
function readWindow(
  existing: WindowState | undefined,
  nowMs: number,
): WindowState {
  if (existing && nowMs < existing.windowStart + WINDOW_SECONDS * 1000) {
    return existing;
  }
  return { windowStart: nowMs, count: 0 };
}

/**
 * Durable Object enforcing fail-safe-closed failure budgets: a per-IP ceiling
 * and a global ceiling, each over a fixed 10-minute tumbling window. The ceiling
 * is enforced by an explicit atomic `blockConcurrencyWhile` read-modify-write in
 * `checkAndConsume` — NOT merely by input-gate serialization, which does not
 * reliably hold across that method's multiple storage awaits, letting two
 * concurrent calls read the same pre-increment count and leak the ceiling.
 *
 * Bounded key space: this is a single, unsharded global instance whose `ip:`
 * keys are keyed by the caller-supplied `ip` — in the real consent flow
 * that is `CF-Connecting-IP`, populated by the Cloudflare edge and not
 * client-spoofable — so the realistic key space is bounded by genuine source
 * IPs, not attacker-controlled input. Lazy expiry (no alarms) is a deliberate
 * plan decision: expired windows reset their `count` on read but the key is not
 * deleted, so keys persist. Each holds only a tiny fixed-size
 * `{ windowStart, count }` record, and a real deployment can add a periodic
 * sweep later if the operator IP set ever grows large. This is an accepted,
 * documented trade-off, not an oversight.
 */
export class RateLimiter extends DurableObject<CloudflareBindings> {
  /** Injectable clock (ms). Overridden in tests to control window boundaries. */
  now: () => number = Date.now;

  /**
   * Reserve one failure against the per-IP and global budgets, consuming the
   * reservation at check time (fail-safe-closed: a caller that never reports an
   * outcome still counts). Returns `{ allowed: false, reason }` when either
   * budget is exhausted, without consuming when denied.
   */
  async checkAndConsume(
    ip: string,
  ): Promise<{ allowed: boolean; reason?: "per_ip" | "global" }> {
    const nowMs = this.now();
    const ipKey = `ip:${ip}`;

    // The whole read → decide → increment → put runs inside one
    // blockConcurrencyWhile so no other event is processed until it completes:
    // two concurrent calls cannot both observe the same pre-increment count.
    // Local-storage-only (no external I/O), the case where this is appropriate.
    return this.ctx.blockConcurrencyWhile(async () => {
      const ipWindow = readWindow(
        await this.ctx.storage.get<WindowState>(ipKey),
        nowMs,
      );
      if (ipWindow.count >= PER_IP_BUDGET) {
        return { allowed: false, reason: "per_ip" };
      }

      const globalWindow = readWindow(
        await this.ctx.storage.get<WindowState>("global"),
        nowMs,
      );
      if (globalWindow.count >= GLOBAL_BUDGET) {
        return { allowed: false, reason: "global" };
      }

      ipWindow.count += 1;
      globalWindow.count += 1;
      // Single multi-key put is one atomic transaction, so a mid-method
      // eviction/error can never persist one counter without the other.
      await this.ctx.storage.put({ [ipKey]: ipWindow, global: globalWindow });
      return { allowed: true };
    });
  }

  /**
   * Report a successful outcome for `ip`, resetting only its per-IP window; the
   * global budget is deliberately left intact so bursts of successes cannot
   * rewind the shared ceiling.
   */
  async recordSuccess(ip: string): Promise<void> {
    await this.ctx.storage.delete(`ip:${ip}`);
  }
}
