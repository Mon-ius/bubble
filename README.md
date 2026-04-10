# Bubble Market Lab

A fully self-contained, browser-based replication of the continuous double
auction experimental market from **Dufwenberg, Lindqvist & Moore, "Bubbles and
Experience: An Experiment" (AER 2005)** — implemented in pure HTML, CSS, and
vanilla JavaScript with no frameworks and no external libraries.

## Live demo

Open `index.html` in any modern browser, or visit the GitHub Pages site for
this repository.

## What it does

- Simulates a continuous double auction with **6 agents** trading a finite-life
  asset over **10 periods**.
- Dividend per period is **0 or 20** with equal probability, so the fundamental
  value at the start of period *t* is `FV_t = 10 × (T − t + 1)` — starting at
  100 and declining by 10 each period.
- Four agent strategies (fundamentalist, trend follower, Zero-Intelligence,
  experienced) with real decision logic and per-decision reasoning traces.
- Three population presets that visibly reproduce the paper's core result:
  bubbles form under inexperienced traders and disappear with experienced
  traders.

## Features

- **Price-time priority order book** with self-match prevention.
- **Seedable PRNG** (mulberry32) so every `(population, seed)` pair is
  reproducible.
- **Full decision-trace system**: every agent action is logged with the rule
  used, the trigger condition, the expected profit, and the agent's state at
  decision time.
- **Five custom Canvas visualizations**: price vs FV, bubble magnitude, per-
  period volume bars, agent × tick action timeline, and price × period trade-
  density heatmap.
- **Replay scrubber**: pause the simulation, drag the slider to any past tick,
  and inspect the exact market state and agent decisions at that moment.
- **No build step**, no bundler, no dependencies. Just open the file.

## File layout

```
index.html         HTML structure
styles.css         Grid layout + dark theme
js/market.js       Order, Trade, OrderBook, Market
js/agents.js       Agent base class + 4 strategies + 3 population presets
js/logger.js       Trace + snapshot + event store
js/viz.js          HiDPI canvas drawing primitives
js/engine.js       Simulation loop + seeded RNG
js/ui.js           DOM + canvas rendering from view objects
js/replay.js       Live and snapshot view builders
js/main.js         App state + control wiring
```

## Populations

| Preset          | Composition                       | Expected outcome           |
|-----------------|-----------------------------------|----------------------------|
| Inexperienced   | 2 Trend · 2 Random · 1 F · 1 E    | Classic bubble + crash     |
| Experienced     | 3 Experienced · 2 Fund · 1 Trend  | Tight convergence to FV    |
| Mixed           | 2 Fund · 2 Exp · 1 Trend · 1 Rand | Closest tracking of FV     |

Across 20 seeds the average mispricing `|P − FV|` is ~44 for the inexperienced
preset (peaks up to 103), ~3.6 for experienced, and ~2.9 for mixed.

## Reference

Dufwenberg, M., Lindqvist, T., & Moore, E. (2005). *Bubbles and Experience: An
Experiment.* American Economic Review, 95(5), 1731–1737.
