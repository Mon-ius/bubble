# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Browser-based replication of the Dufwenberg, Lindqvist & Moore (2005) continuous
double auction experimental market, extended with a "Utility" agent type that
supports inter-agent messaging, trust, and optional deception. Pure HTML + CSS +
vanilla JavaScript, no frameworks, no build step, no dependencies. Open
`index.html` directly in a browser to run.

## Architecture

The runtime is organized as a pipeline from simulation core → logging → view
construction → rendering. Each layer only talks to the one below it.

```
main.js       App state, control wiring, render scheduling (rAF-coalesced)
  │
engine.js     Simulation loop + seeded mulberry32 PRNG, dividend draws
  │
market.js    ─ Order, Trade, OrderBook (price-time priority), Market
agents.js    ─ Agent base + Fundamentalist/Trend/Random/Experienced/Utility +
                population presets. Decisions return order objects with a
                reasoning trace attached.
messaging.js ─ Message bus + trust tracker (only used by UtilityAgent)
utility.js   ─ UtilityAgent belief/valuation model + UTILITY_DEFAULTS
logger.js    ─ Append-only trace, snapshot, and event stores
  │
replay.js     Build "view" objects from Market + Logger state, either live
              (buildLiveView) or at a historical tick (buildViewAt)
  │
viz.js        HiDPI canvas drawing primitives
ui.js         DOM + canvas rendering; consumes views only, never touches
              Market/Engine/Agent directly — so live and replay rendering
              go through identical code paths
```

Invariants that the replay system relies on:

- History arrays on `Market` (`priceHistory`, `trades`, `volumeByPeriod`,
  `dividendHistory`) and on `Logger` are **append-only**. Never mutate or
  remove entries — `Replay.buildViewAt(tick)` reconstructs a past state by
  slicing to a recorded length.
- All randomness flows through the seeded RNG passed into `Engine`. Do not
  call `Math.random()` from agent or market code, or reproducibility by
  `(population, seed)` pair breaks.
- `ui.js` must never reach into `Market`/`Engine`/`Agent` state directly;
  always go through a view object from `replay.js`.

## Parameters panel and tunables

Every numeric constant that shapes the sim is exposed in the Parameters panel
in `index.html` and mirrored into `App.tunables` in `main.js`. Market-level
knobs mirror `App.config`; the rest mirror `UTILITY_DEFAULTS` in `js/agents.js`.
The engine and agents read from `ctx.tunables` when present and fall back to
`UTILITY_DEFAULTS` via the `tunable()` helper when a key is missing — so
tunables that aren't exposed as sliders still have a safe default.

The **Risk preferences** subsection uses three linked sliders
(α<sub>L</sub>/α<sub>N</sub>/α<sub>A</sub>) that always sum to 100 and drive
a composition bar (`#comp-bar`) above them. `App.riskMix` holds the current
split and is read by the sampling stage; `distributeRiskPrefs` in
`agents.js` turns those percentages into a per-slot `riskPref` override
(loving/neutral/averse), so the sliders directly control how many utility
agents of each risk type are instantiated without disturbing the
bias/deception/belief variety in the strategy cube.

## Sampling stage (names + endowments)

Before the simulation starts, `sampleAgents(mix, rng, options)` in
`agents.js` draws a flat list of per-agent specs from the current `mix`.
Each spec carries:

- `id`, `slot`, `type`, `typeLabel` (F1, U3, …)
- `name` — a random personal name drawn without replacement from
  `AGENT_NAMES`
- `cash`, `inventory` — drawn from `ENDOWMENT_DEFAULT` (uniform
  [800, 1200] cash, uniform {2,3,4} inventory)
- strategy fields for utility agents (`riskPref`, `biasMode`, …)

`App.agentSpecs` caches the current draw. The **Agents** panel shows the
spec list as editable cards before `tick === 0`; editing cash/inventory
commits through `App.updateEndowment(id, field, value)` which mutates the
spec in place and calls `reset()` without re-sampling. Structural changes
(mix counts, risk shares, seed, preset, defaults) call `App.resample()`
instead, which nulls the spec cache so `reset()` re-draws against a fresh
sample RNG. The **Resample** button (agents panel header) is a manual
shortcut to the same path.

The sample RNG is derived from `seed ^ 0xA5A5A5A5` and is intentionally
independent of the engine RNG (`makeRNG(seed)`), so endowment edits +
reset produce the same per-tick trading sequence as a seed-matched run
without an edit.

When adding a new tunable:
1. Add the slider row in `index.html` with a `data-tip` explanation.
2. Add the default to `App.tunables` in `main.js`.
3. Wire read/write in the parameter-panel setup in `main.js`.
4. Read it from `ctx.tunables` in the consuming agent/engine code with a
   fallback to the hard-coded default so legacy callers still work.

The "Total agents (N)" slider proportionally rescales the population mix
rather than editing individual counts.

## Populations

| Preset        | Composition                       | Expected outcome        |
|---------------|-----------------------------------|-------------------------|
| Inexperienced | 2 Trend · 2 Random · 1 F · 1 E    | Classic bubble + crash  |
| Experienced   | 3 Experienced · 2 Fund · 1 Trend  | Tight convergence to FV |
| Mixed         | 2 Fund · 2 Exp · 1 Trend · 1 Rand | Closest tracking of FV  |
| Utility       | 6 Utility                         | Default on first load   |

Fundamental value at the start of period *t* is `FV_t = dividendMean × (T − t + 1)`
(default: starts at 100, declines by 10 per period over 10 periods).

## Working in this repo

- No build, no tests, no package manager. Verify changes by opening
  `index.html` in a browser and exercising the sliders and Start/Pause/Reset.
- Live site is served via GitHub Pages (`CNAME` in repo root).
- Prefer editing existing modules over adding new ones — the module boundaries
  above are load-bearing for the replay system.
- Keep the code framework-free and dependency-free. No npm, no bundler, no
  transpilation. All JS files use `'use strict'` and are loaded as plain
  `<script>` tags from `index.html`.
- Match the existing commenting style: module header block explaining the
  role of the file, short inline comments only where the *why* is non-obvious.
