'use strict';

/* =====================================================================
   replay.js — View builders.

   These functions convert "live state" (Market + Logger + agent
   objects) or "past state" (snapshot from Logger) into a flat view
   object that UI.render consumes. Because live and replay modes
   produce identical view shapes, the UI has one rendering path.

   View shape:
   {
     tick, period, lastPrice, fv,
     bids[], asks[],                      // [{price, remaining, agentId}]
     agents,                              // full per-agent state, inc. util
     trades[],                            // shared array slice
     priceHistory[],                      // shared array slice
     volumeByPeriod[],                    // plain array
     traces[],                            // shared array slice
     events[],                            // shared array slice

     // Extended (utility-experiment) streams — empty arrays in legacy:
     messages[],                          // inter-agent broadcasts
     valuationHistory[],                  // per-tick true/subj/reported V
     utilityHistory[],                    // per-tick wealth + utility
     decisionEvaluations[],               // per-decision EU candidate set
     trust,                               // {r: {s: v}} or null

     isReplay: bool,
   }
   ===================================================================== */

const Replay = {
  buildLiveView(market, logger, agents, ctx = {}) {
    const agentState = {};
    for (const [id, a] of Object.entries(agents)) {
      agentState[id] = {
        id:         a.id,
        type:       a.type,
        typeLabel:  a.typeLabel,
        name:       a.displayName,
        cash:       a.cash,
        inventory:  a.inventory,
        lastAction: a.lastAction,
        // Extended fields (undefined for legacy agents).
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
      tick:           market.tick,
      period:         market.period,
      lastPrice:      market.lastPrice,
      fv:             market.fundamentalValue(),
      bids: market.book.bids.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      asks: market.book.asks.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      agents:              agentState,
      trades:              market.trades,
      priceHistory:        market.priceHistory,
      volumeByPeriod:      market.volumeByPeriod,
      traces:              logger.traces,
      events:              logger.events,
      messages:            logger.messages,
      valuationHistory:    logger.valuationHistory,
      utilityHistory:      logger.utilityHistory,
      decisionEvaluations: logger.decisionEvaluations,
      trust:               ctx && ctx.trustTracker ? ctx.trustTracker.copy() : null,
      isReplay:            false,
    };
  },

  buildViewAt(market, logger, tick, ctx = {}) {
    const snap = logger.getSnapshot(tick);
    if (!snap) {
      return {
        tick:                0,
        period:              1,
        lastPrice:           null,
        fv:                  market.fundamentalValue(1),
        bids:                [],
        asks:                [],
        agents:              {},
        trades:              [],
        priceHistory:        [],
        volumeByPeriod:      new Array(market.config.periods + 2).fill(0),
        traces:              [],
        events:              [],
        messages:            [],
        valuationHistory:    [],
        utilityHistory:      [],
        decisionEvaluations: [],
        trust:               null,
        isReplay:            true,
      };
    }
    return {
      tick:                snap.tick,
      period:              snap.period,
      lastPrice:            snap.lastPrice,
      fv:                   snap.fv,
      bids:                 snap.bids,
      asks:                 snap.asks,
      agents:               snap.agents,
      trades:               market.trades.slice(0, snap.tradeCount),
      priceHistory:         market.priceHistory.slice(0, snap.priceHistoryLength),
      volumeByPeriod:       snap.volumeByPeriod,
      traces:               logger.traces.slice(0, snap.traceLength),
      events:               logger.events.slice(0, snap.eventLength),
      messages:             logger.messages.slice(0, snap.messageLength || 0),
      valuationHistory:     logger.valuationHistory.slice(0, snap.valuationLength || 0),
      utilityHistory:       logger.utilityHistory.slice(0, snap.utilityLength || 0),
      decisionEvaluations:  logger.decisionEvaluations.slice(0, snap.evaluationLength || 0),
      trust:                snap.trust || null,
      isReplay:             true,
    };
  },
};
