'use strict';

/* =====================================================================
   utility.js — Agent utility functions over wealth.

   Three risk preferences, each implemented as a monotonic transform of
   wealth, normalized so that U(w0) = 1 at the agent's initial wealth.
   Normalization makes utility comparable across agents that use
   different transforms: every agent starts at 1.0 and a run's welfare
   can be read as a sum of dimensionless "utility units".

   Wealth is always computed as:
       wealth = cash + inventory × subjectiveValuation

   Families:
       averse   U(w) = sqrt(w / w0)      strictly concave  (diminishing)
       neutral  U(w) = w / w0            linear            (indifferent)
       loving   U(w) = (w / w0)^2        strictly convex   (increasing)

   Marginal utility (the slope of U at w) drives behavior under
   uncertainty. The expected-utility decision engine in UtilityAgent
   uses these functions to rank candidate trades under deterministic
   (hit/lift) and probabilistic (passive post) outcomes.

   Wealth is clamped at 0 to avoid NaNs from the sqrt branch on the
   unlikely path where a settlement pushes an agent briefly negative.
   ===================================================================== */

const Utility = {
  averse: {
    label:  'Risk-averse',
    symbol: '√',
    color:  '#4fa3ff',
    compute(w, w0) {
      const r = Math.max(0, w) / Math.max(1, w0);
      return Math.sqrt(r);
    },
  },
  neutral: {
    label:  'Risk-neutral',
    symbol: '=',
    color:  '#b0b8c9',
    compute(w, w0) {
      return Math.max(0, w) / Math.max(1, w0);
    },
  },
  loving: {
    label:  'Risk-loving',
    symbol: '²',
    color:  '#ff5e78',
    compute(w, w0) {
      const r = Math.max(0, w) / Math.max(1, w0);
      return r * r;
    },
  },
};

function computeUtility(riskPref, wealth, initialWealth) {
  const fn = Utility[riskPref] || Utility.neutral;
  return fn.compute(wealth, initialWealth);
}

function wealthOf(agent, subjectiveValuation) {
  return agent.cash + agent.inventory * subjectiveValuation;
}
