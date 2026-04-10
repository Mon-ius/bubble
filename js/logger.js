'use strict';

/* =====================================================================
   logger.js — Append-only trace + snapshot store.

   Three streams of data are recorded:
     * traces    — one record per agent decision (see trace shape below)
     * snapshots — one record per tick holding the minimal state needed
                   to reconstruct the UI at that moment. Market-level
                   append-only arrays (trades, priceHistory, traces) are
                   *not* copied; the snapshot just records their current
                   length so Replay can slice them.
     * events    — dividend payments, period transitions, etc.

   Trace shape:
   {
     timestamp: tick,
     period,
     agentId, agentName, agentType,
     state:     { cash, inventory, estimatedValue, observedPrice },
     decision:  { type, price, quantity },
     reasoning: { ruleUsed, expectedProfit, triggerCondition },
     filled:    quantity actually executed at submission time
   }
   ===================================================================== */

class Logger {
  constructor() {
    this.traces    = [];
    this.snapshots = [];   // index by tick: snapshots[tick] = {...}
    this.events    = [];
  }

  logTrace(trace) { this.traces.push(trace); }
  logEvent(event) { this.events.push(event); }
  snapshot(s)     { this.snapshots[s.tick] = s; }

  clear() {
    this.traces    = [];
    this.snapshots = [];
    this.events    = [];
  }

  /** Nearest snapshot at or before the requested tick. */
  getSnapshot(tick) {
    for (let t = tick; t >= 0; t--) if (this.snapshots[t]) return this.snapshots[t];
    return null;
  }

  /** All decisions filed at exactly this tick. */
  tracesAt(tick) {
    return this.traces.filter(t => t.timestamp === tick);
  }
}
