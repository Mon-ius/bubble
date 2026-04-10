'use strict';

/* =====================================================================
   agents.js — Four trading strategies + population presets.

   How bubbles emerge in this model:

     * Trend followers buy *because* the price is rising. Their aggression
       pushes the price further up, which brings more trend followers in.
       This positive feedback loop is what inflates the bubble.

     * Fundamentalists provide a rational counterforce — they sell when
       the price runs above FV and buy when it falls below. But with few
       of them and many trend followers, they get overwhelmed during the
       inflation phase.

     * Random (ZI-style) agents add noise and liquidity. They have no view
       and, like real retail, they can be the marginal buyer or seller
       at any time.

     * Experienced agents expect the bubble. They anchor their belief
       below FV (pricing in bubble risk), refuse to chase into the peak,
       and aggressively liquidate in the final three periods because they
       know the asset is decaying toward zero. When they dominate the
       population the bubble never really forms.

   Try running the "inexperienced" preset and then "experienced" — the
   price chart should visibly bubble in the first and hug FV in the second.
   ===================================================================== */

class Agent {
  constructor(id, type, cash, inventory, displayName) {
    this.id               = id;
    this.type             = type;
    this.displayName      = displayName;
    this.cash             = cash;
    this.inventory        = inventory;
    this.initialCash      = cash;
    this.initialInventory = inventory;
    this.lastAction       = 'hold';
  }
  decide(_market, _rng) { return { type: 'hold', reasoning: { ruleUsed: 'noop' } }; }
}

/* ---------- Fundamentalist -------------------------------------------- */
/*
 * Belief ≈ FV with small noise.
 * Crosses the book when mispricing exceeds ±2%; otherwise posts passive
 * quotes inside a narrow band around FV. This is the rational anchor.
 */
class Fundamentalist extends Agent {
  constructor(id, name) { super(id, 'fundamentalist', 1000, 3, name); }

  decide(market, rng) {
    const fv     = market.fundamentalValue();
    const belief = fv * (1 + (rng() - 0.5) * 0.04);
    const bid    = market.book.bestBid();
    const ask    = market.book.bestAsk();

    if (ask && ask.price < belief * 0.98 && this.cash >= ask.price) {
      return order('bid', ask.price, 1, {
        ruleUsed:         'buy_undervalued_vs_fv',
        estimatedValue:   belief,
        expectedProfit:   belief - ask.price,
        triggerCondition: `ask ${ask.price.toFixed(2)} < 0.98 × belief ${belief.toFixed(2)}`,
      });
    }
    if (bid && bid.price > belief * 1.02 && this.inventory > 0) {
      return order('ask', bid.price, 1, {
        ruleUsed:         'sell_overvalued_vs_fv',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `bid ${bid.price.toFixed(2)} > 1.02 × belief ${belief.toFixed(2)}`,
      });
    }

    // Passive quoting around belief. The bid and ask ranges overlap
    // slightly at belief so two fundamentalists can cross each other
    // without needing a liquidity provider.
    if (rng() < 0.45) {
      if (rng() < 0.5 && this.cash >= belief) {
        const p = round2(belief * (0.97 + rng() * 0.035));    // [0.970, 1.005]
        return order('bid', p, 1, {
          ruleUsed:         'passive_bid_near_fv',
          estimatedValue:   belief,
          expectedProfit:   belief - p,
          triggerCondition: 'probing at 97–100.5% of belief',
        });
      } else if (this.inventory > 0) {
        const p = round2(belief * (0.995 + rng() * 0.035));   // [0.995, 1.030]
        return order('ask', p, 1, {
          ruleUsed:         'passive_ask_near_fv',
          estimatedValue:   belief,
          expectedProfit:   p - belief,
          triggerCondition: 'probing at 99.5–103% of belief',
        });
      }
    }
    return hold({
      ruleUsed:         'fundamentalist_wait',
      estimatedValue:   belief,
      triggerCondition: 'market roughly at FV',
    });
  }
}

/* ---------- Trend follower -------------------------------------------- */
/*
 * Uses a short-window slope (6 last recorded prices) to detect momentum.
 *   - positive slope → chase (aggressive bid above recent)
 *   - negative slope → flee  (aggressive ask below recent)
 *   - flat slope + excess inventory → profit-take passively
 *   - out of cash + accumulated inventory → liquidate at market
 *
 * The profit-take and cash-exhausted branches are what produces the
 * classic Smith-Suchanek-Williams crash. Without them, trend followers
 * hoard inventory at the bubble peak and prices simply plateau instead
 * of collapsing.
 */
class TrendFollower extends Agent {
  constructor(id, name) { super(id, 'trend', 1000, 3, name); }

  decide(market, rng) {
    const hist = market.priceHistory.filter(h => h.price !== null).slice(-6);
    const fv   = market.fundamentalValue();
    const bid  = market.book.bestBid();

    if (hist.length < 2) {
      if (this.cash >= fv && rng() < 0.5) {
        const p = round2(fv * (0.95 + rng() * 0.05));
        return order('bid', p, 1, {
          ruleUsed:         'trend_bootstrap_bid',
          estimatedValue:   fv,
          expectedProfit:   0,
          triggerCondition: 'no price history yet',
        });
      }
      return hold({ ruleUsed: 'trend_insufficient_history', estimatedValue: fv, triggerCondition: 'need 2+ prior ticks' });
    }

    const recent = hist[hist.length - 1].price;
    const past   = hist[0].price;
    const slope  = (recent - past) / Math.max(1, hist.length - 1);
    const target = recent + slope * 3;

    // Cash exhausted: the bubble has consumed this agent's buying power.
    // Start dumping accumulated inventory at whatever bid exists.
    if (this.cash < recent && this.inventory > this.initialInventory) {
      const sellPrice = bid ? bid.price : round2(recent * (0.96 + rng() * 0.03));
      return order('ask', sellPrice, 1, {
        ruleUsed:         'trend_cash_exhausted',
        estimatedValue:   target,
        expectedProfit:   sellPrice - recent * 0.9,
        triggerCondition: `cash ${this.cash.toFixed(0)} < recent ${recent.toFixed(0)}, excess inv ${this.inventory - this.initialInventory}`,
      });
    }

    if (slope > 0 && this.cash >= recent) {
      const p = round2(recent * (1 + 0.015 + rng() * 0.03));
      return order('bid', p, 1, {
        ruleUsed:         'chase_uptrend',
        estimatedValue:   target,
        expectedProfit:   target - p,
        triggerCondition: `slope +${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }
    if (slope < 0 && this.inventory > 0) {
      const p = round2(recent * (1 - 0.015 - rng() * 0.03));
      return order('ask', p, 1, {
        ruleUsed:         'flee_downtrend',
        estimatedValue:   target,
        expectedProfit:   p - target,
        triggerCondition: `slope ${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }

    // Flat slope with accumulated inventory: take profit. When a bid
    // exists, sell at it (aggressive take); otherwise post passively
    // inside recent price. Sell probability scales with excess
    // inventory — the more shares hoarded, the more eager to unload.
    if (this.inventory > this.initialInventory) {
      const excess     = this.inventory - this.initialInventory;
      const excessRate = excess / Math.max(1, this.initialInventory);
      const sellProb   = Math.min(0.85, 0.3 + excessRate * 0.25);
      if (rng() < sellProb) {
        const sellPrice = bid ? bid.price : round2(recent * (0.97 + rng() * 0.025));
        return order('ask', sellPrice, 1, {
          ruleUsed:         'trend_flat_profit_take',
          estimatedValue:   target,
          expectedProfit:   sellPrice - recent * 0.9,
          triggerCondition: `flat slope + excess inv ${excess}/${this.initialInventory}`,
        });
      }
    }

    return hold({
      ruleUsed:         'trend_flat',
      estimatedValue:   target,
      triggerCondition: `|slope| ${Math.abs(slope).toFixed(2)} ≈ 0`,
    });
  }
}

/* ---------- Random (Zero-Intelligence) -------------------------------- */
/*
 * Gode-Sunder style. Uniform draws bounded by the agent's redemption
 * value, which here is the fundamental value. Anchoring on FV rather
 * than lastPrice means random agents do NOT reinforce a runaway bubble —
 * they provide a price-discovery floor/ceiling pinned to fundamentals.
 */
class RandomAgent extends Agent {
  constructor(id, name) { super(id, 'random', 1000, 3, name); }

  decide(market, rng) {
    const fv   = market.fundamentalValue();
    const side = rng() < 0.5 ? 'bid' : 'ask';

    if (side === 'bid') {
      // Bid drawn uniformly in [0.7·FV, 1.1·FV]
      const price = Math.max(1, fv * (0.7 + rng() * 0.4));
      if (this.cash < price) {
        return hold({
          ruleUsed:         'zi_insufficient_cash',
          estimatedValue:   fv,
          triggerCondition: `drew ${price.toFixed(2)}, cash ${this.cash.toFixed(2)}`,
        });
      }
      return order('bid', round2(price), 1, {
        ruleUsed:         'zi_uniform_bid',
        estimatedValue:   fv,
        expectedProfit:   fv - price,
        triggerCondition: `bid ∈ [0.7·FV, 1.1·FV] → ${price.toFixed(2)}`,
      });
    }
    if (this.inventory <= 0) {
      return hold({ ruleUsed: 'zi_no_inventory', estimatedValue: fv, triggerCondition: 'zero shares' });
    }
    // Ask drawn uniformly in [0.9·FV, 1.3·FV]
    const price = Math.max(1, fv * (0.9 + rng() * 0.4));
    return order('ask', round2(price), 1, {
      ruleUsed:         'zi_uniform_ask',
      estimatedValue:   fv,
      expectedProfit:   price - fv,
      triggerCondition: `ask ∈ [0.9·FV, 1.3·FV] → ${price.toFixed(2)}`,
    });
  }
}

/* ---------- Experienced ----------------------------------------------- */
/*
 * Knows the asset decays to zero. Discounts belief by remaining-horizon
 * fraction. Aggressively liquidates inventory in the final 3 periods and
 * refuses to buy at inflated prices late in the game. When these agents
 * dominate the population, the bubble never really forms.
 */
class ExperiencedAgent extends Agent {
  constructor(id, name) { super(id, 'experienced', 1000, 3, name); }

  decide(market, rng) {
    const fv                = market.fundamentalValue();
    const remaining         = market.config.periods - market.period + 1;
    const horizonFraction   = remaining / market.config.periods;
    const belief            = fv * (0.92 + horizonFraction * 0.06);
    const bid               = market.book.bestBid();
    const ask               = market.book.bestAsk();

    if (remaining <= 3 && this.inventory > 0 && bid) {
      return order('ask', round2(bid.price), 1, {
        ruleUsed:         'liquidate_end_of_horizon',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `remaining=${remaining} ≤ 3; dumping into bid`,
      });
    }
    if (remaining <= 4 && ask && ask.price > belief * 0.9) {
      return hold({
        ruleUsed:         'avoid_overpaying_late',
        estimatedValue:   belief,
        triggerCondition: `remaining=${remaining}, ask ${ask.price.toFixed(2)} > 0.9×belief ${belief.toFixed(2)}`,
      });
    }
    if (ask && ask.price < belief * 0.92 && this.cash >= ask.price) {
      return order('bid', round2(ask.price), 1, {
        ruleUsed:         'experienced_buy_deep_discount',
        estimatedValue:   belief,
        expectedProfit:   belief - ask.price,
        triggerCondition: `ask ${ask.price.toFixed(2)} < 0.92 × belief ${belief.toFixed(2)}`,
      });
    }
    if (bid && bid.price > belief * 1.05 && this.inventory > 0) {
      return order('ask', round2(bid.price), 1, {
        ruleUsed:         'experienced_sell_premium',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `bid ${bid.price.toFixed(2)} > 1.05 × belief ${belief.toFixed(2)}`,
      });
    }
    // Passive probe so the book has quotes even in an experienced-only
    // market. Ranges overlap at belief so two experienced agents can
    // cross each other.
    if (rng() < 0.35) {
      if (rng() < 0.5 && this.cash >= belief) {
        const p = round2(belief * (0.96 + rng() * 0.045));    // [0.960, 1.005]
        return order('bid', p, 1, {
          ruleUsed:         'experienced_passive_bid',
          estimatedValue:   belief,
          expectedProfit:   belief - p,
          triggerCondition: 'probing 96–100.5% of belief',
        });
      } else if (this.inventory > 0) {
        const p = round2(belief * (0.995 + rng() * 0.045));   // [0.995, 1.040]
        return order('ask', p, 1, {
          ruleUsed:         'experienced_passive_ask',
          estimatedValue:   belief,
          expectedProfit:   p - belief,
          triggerCondition: 'probing 99.5–104% of belief',
        });
      }
    }
    return hold({ ruleUsed: 'experienced_wait', estimatedValue: belief, triggerCondition: 'no clear edge' });
  }
}

/* ---------- Helpers + populations ------------------------------------- */

function order(type, price, quantity, reasoning) {
  return { type, price, quantity, reasoning };
}
function hold(reasoning) {
  return { type: 'hold', reasoning };
}
function round2(x) { return Math.round(x * 100) / 100; }

const POPULATIONS = {
  inexperienced: [
    { cls: Fundamentalist,   name: 'F1' },
    { cls: TrendFollower,    name: 'T1' },
    { cls: TrendFollower,    name: 'T2' },
    { cls: RandomAgent,      name: 'R1' },
    { cls: RandomAgent,      name: 'R2' },
    { cls: ExperiencedAgent, name: 'E1' },
  ],
  experienced: [
    { cls: Fundamentalist,   name: 'F1' },
    { cls: Fundamentalist,   name: 'F2' },
    { cls: TrendFollower,    name: 'T1' },
    { cls: ExperiencedAgent, name: 'E1' },
    { cls: ExperiencedAgent, name: 'E2' },
    { cls: ExperiencedAgent, name: 'E3' },
  ],
  mixed: [
    { cls: Fundamentalist,   name: 'F1' },
    { cls: Fundamentalist,   name: 'F2' },
    { cls: TrendFollower,    name: 'T1' },
    { cls: RandomAgent,      name: 'R1' },
    { cls: ExperiencedAgent, name: 'E1' },
    { cls: ExperiencedAgent, name: 'E2' },
  ],
};

function buildAgents(populationKey) {
  const spec = POPULATIONS[populationKey] || POPULATIONS.inexperienced;
  const out = {};
  spec.forEach((s, i) => {
    const id = i + 1;
    out[id] = new s.cls(id, s.name);
  });
  return out;
}
