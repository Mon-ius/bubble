'use strict';

/* =====================================================================
   replay.js — View builders.

   These functions convert "live state" (Market + Logger + agent objects)
   or "past state" (snapshot from Logger) into a flat view object that
   UI.render consumes. Because live and replay modes produce identical
   view shapes, the UI has one rendering path.

   View shape:
   {
     tick, period, lastPrice, fv,
     bids[], asks[],                        // [{price, remaining, agentId}]
     agents,                                // { id: { name, type, cash, inventory, lastAction } }
     trades[],                              // shared array slice
     priceHistory[],                        // shared array slice
     volumeByPeriod[],                      // plain array
     traces[],                              // shared array slice
     events[],                              // shared array slice
     isReplay: bool,
   }
   ===================================================================== */

const Replay = {
  buildLiveView(market, logger, agents) {
    const agentState = {};
    for (const [id, a] of Object.entries(agents)) {
      agentState[id] = {
        id:         a.id,
        type:       a.type,
        name:       a.displayName,
        cash:       a.cash,
        inventory:  a.inventory,
        lastAction: a.lastAction,
      };
    }
    return {
      tick:           market.tick,
      period:         market.period,
      lastPrice:      market.lastPrice,
      fv:             market.fundamentalValue(),
      bids: market.book.bids.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      asks: market.book.asks.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      agents:         agentState,
      trades:         market.trades,
      priceHistory:   market.priceHistory,
      volumeByPeriod: market.volumeByPeriod,
      traces:         logger.traces,
      events:         logger.events,
      isReplay:       false,
    };
  },

  buildViewAt(market, logger, tick) {
    const snap = logger.getSnapshot(tick);
    if (!snap) {
      // Before the first tick — return a clean initial view.
      return {
        tick:           0,
        period:         1,
        lastPrice:      null,
        fv:             market.fundamentalValue(1),
        bids:           [],
        asks:           [],
        agents:         {},
        trades:         [],
        priceHistory:   [],
        volumeByPeriod: new Array(market.config.periods + 2).fill(0),
        traces:         [],
        events:         [],
        isReplay:       true,
      };
    }
    return {
      tick:           snap.tick,
      period:         snap.period,
      lastPrice:      snap.lastPrice,
      fv:             snap.fv,
      bids:           snap.bids,
      asks:           snap.asks,
      agents:         snap.agents,
      trades:         market.trades.slice(0, snap.tradeCount),
      priceHistory:   market.priceHistory.slice(0, snap.priceHistoryLength),
      volumeByPeriod: snap.volumeByPeriod,
      traces:         logger.traces.slice(0, snap.traceLength),
      events:         logger.events.slice(0, snap.eventLength),
      isReplay:       true,
    };
  },
};
