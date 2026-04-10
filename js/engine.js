'use strict';

/* =====================================================================
   engine.js — Simulation loop + seeded RNG.

   Each tick the engine:
     1. Increments tick.
     2. Shuffles agent order (so fairness isn't dependent on array order).
     3. Asks every agent for a decision and logs a trace record.
     4. Submits bid/ask orders to the market, matches, settles trades.
     5. Records price history and captures a snapshot for replay.
     6. At the last tick of a period: draws the dividend, credits holders,
        logs a dividend event, advances the period and clears the book.

   The loop is driven by setTimeout with a configurable interval so the
   user can speed up or slow down the simulation in real time. A pause
   simply cancels the pending timeout; a resume starts it again.

   The RNG is a seeded mulberry32 so a given (population, seed) pair is
   fully reproducible — critical for research-grade inspection.
   ===================================================================== */

/** Seedable 32-bit PRNG — reproducible across runs. */
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Engine {
  constructor(market, agents, logger, config, rng, ctx = null) {
    this.market  = market;
    this.agents  = agents;
    this.logger  = logger;
    this.config  = config;
    this._rng    = rng || Math.random;
    // ctx carries the message bus, trust tracker, and extended-config
    // flags used by UtilityAgents. Legacy agents ignore it entirely.
    this.ctx     = ctx || {};
    this.running = false;
    this._timer  = null;
    this.onTick  = null;     // callback after each step
    this.onEnd   = null;
  }

  get tickInterval() { return this.config.tickInterval; }

  start() {
    if (this.running || this.isFinished()) return;
    this.running = true;
    this._loop();
  }
  pause() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
  _loop() {
    if (!this.running) return;
    this.step();
    if (this.onTick) this.onTick();
    if (this.isFinished()) {
      this.running = false;
      if (this.onEnd) this.onEnd();
      return;
    }
    this._timer = setTimeout(() => this._loop(), this.tickInterval);
  }

  /** Run one tick of the simulation. */
  step() {
    const m = this.market;
    m.tick++;

    // Fisher-Yates shuffle of agent ids → fairness within a tick.
    const ids = Object.keys(this.agents);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    for (const id of ids) {
      const agent    = this.agents[id];
      const decision = agent.decide(m, this._rng, this.ctx);

      // Build the trace record BEFORE submission so we capture the
      // agent's state at decision time, then fill in `filled` after
      // matching tells us what actually executed.
      const trace = {
        timestamp: m.tick,
        period:    m.period,
        agentId:   agent.id,
        agentName: agent.displayName,
        agentType: agent.type,
        state: {
          cash:           Math.round(agent.cash * 100) / 100,
          inventory:      agent.inventory,
          estimatedValue: decision.reasoning?.estimatedValue ?? null,
          observedPrice:  m.lastPrice,
        },
        decision: {
          type:     decision.type,
          price:    decision.price    ?? null,
          quantity: decision.quantity ?? null,
        },
        reasoning: {
          ruleUsed:         decision.reasoning?.ruleUsed         ?? 'unknown',
          expectedProfit:   decision.reasoning?.expectedProfit   ?? null,
          triggerCondition: decision.reasoning?.triggerCondition ?? '',
          utility:          decision.reasoning?.utility          ?? null,
          beliefMode:       decision.reasoning?.beliefMode       ?? null,
          receivedMsgs:     decision.reasoning?.receivedMsgs     ?? null,
        },
        filled: 0,
      };
      this.logger.logTrace(trace);

      // Extended logging for utility agents: valuation, wealth/utility,
      // and the full EU candidate table. Each stream is append-only;
      // the snapshot records its current length so replay slices cleanly.
      const u = decision.reasoning && decision.reasoning.utility;
      if (u) {
        this.logger.logValuation({
          tick:      m.tick,
          period:    m.period,
          agentId:   agent.id,
          agentName: agent.displayName,
          trueV:     u.trueValuation,
          subjV:     u.subjectiveValue,
          reportedV: agent.reportedValuation != null ? agent.reportedValuation : null,
        });
        this.logger.logUtility({
          tick:      m.tick,
          period:    m.period,
          agentId:   agent.id,
          wealth:    u.wealth0,
          utility:   u.U0,
          riskPref:  u.riskPref,
        });
        this.logger.logEvaluation({
          tick:       m.tick,
          period:     m.period,
          agentId:    agent.id,
          candidates: u.candidates,
          chosen:     u.chosen,
        });
      }

      if (decision.type === 'bid' || decision.type === 'ask') {
        const order = new Order(
          agent.id,
          decision.type,
          decision.price,
          decision.quantity || 1,
          m.tick,
          m.period,
        );
        const fills = m.submitOrder(order, agent);
        if (fills && fills.length) {
          m.applyTrades(fills, this.agents);
          trace.filled = fills.reduce((s, t) => s + t.quantity, 0);
        }
        agent.lastAction = decision.type;
      } else {
        agent.lastAction = 'hold';
      }
    }

    m.recordTick();
    this.logger.snapshot(this._captureSnapshot());

    // Period boundary: dividend + comms round + period advance + book reset.
    if (m.tick % this.config.ticksPerPeriod === 0) {
      const d = m.payDividend(this.agents, this._rng);
      this.logger.logEvent({ tick: m.tick, type: 'dividend', period: m.period, value: d });
      // Communication + trust update (no-op unless extended mode + comms on).
      this._communicationRound();
      if (m.period < this.config.periods) {
        m.period++;
        m.book.clear();
        this.logger.logEvent({ tick: m.tick, type: 'period_start', period: m.period });
      }
    }
  }

  /**
   * End-of-period communication + trust update. Every utility agent
   * broadcasts one message (respecting its deceptionMode). If the
   * global deception toggle is off, every message is forced honest.
   * Then the trust tracker re-scores each sender against that period's
   * volume-weighted mean trade price.
   */
  _communicationRound() {
    const bus   = this.ctx.messageBus;
    const trust = this.ctx.trustTracker;
    const ext   = this.ctx.extended;
    if (!bus || !ext || !ext.communication) return;
    const period = this.market.period;
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      if (typeof a.communicate !== 'function') continue;
      const msg = a.communicate(this.market, this._rng);
      if (!msg) continue;
      if (!ext.deception) {
        // Global deception toggle off — collapse every claim to truth.
        msg.claimedValuation = msg.trueValuation;
        msg.deceptionMode    = 'honest';
        msg.deceptive        = false;
      }
      bus.post(msg);
      this.logger.logMessage(msg);
    }
    if (trust) {
      trust.update(bus, this.market, period);
      trust.snapshot(this.market.tick);
      this.logger.logTrust({ tick: this.market.tick, period, trust: trust.copy() });
    }
  }

  isFinished() {
    return this.market.tick >= this.config.periods * this.config.ticksPerPeriod;
  }

  /**
   * Capture a snapshot sufficient to re-render the UI for this tick.
   * The live arrays on market/logger aren't copied — we record their
   * lengths so replay can slice into them, which keeps memory O(ticks).
   */
  _captureSnapshot() {
    const m = this.market;
    const agentState = {};
    for (const [id, a] of Object.entries(this.agents)) {
      agentState[id] = {
        id:         a.id,
        type:       a.type,
        name:       a.displayName,
        cash:       Math.round(a.cash * 100) / 100,
        inventory:  a.inventory,
        lastAction: a.lastAction,
        // Extended fields (undefined for legacy agents — harmless).
        riskPref:            a.riskPref,
        trueValuation:       a.trueValuation,
        subjectiveValuation: a.subjectiveValuation,
        reportedValuation:   a.reportedValuation,
        deceptionMode:       a.deceptionMode,
        beliefMode:          a.beliefMode,
        initialWealth:       a.initialWealth,
      };
    }
    return {
      tick:               m.tick,
      period:             m.period,
      lastPrice:          m.lastPrice,
      fv:                 m.fundamentalValue(),
      bids: m.book.bids.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      asks: m.book.asks.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      agents:             agentState,
      tradeCount:         m.trades.length,
      priceHistoryLength: m.priceHistory.length,
      traceLength:        this.logger.traces.length,
      eventLength:        this.logger.events.length,
      volumeByPeriod:     m.volumeByPeriod.slice(),
      // Extended snapshot fields:
      messageLength:      this.logger.messages.length,
      valuationLength:    this.logger.valuationHistory.length,
      utilityLength:      this.logger.utilityHistory.length,
      evaluationLength:   this.logger.decisionEvaluations.length,
      trustLength:        this.logger.trustHistory.length,
      trust:              this.ctx.trustTracker ? this.ctx.trustTracker.copy() : null,
    };
  }
}
