'use strict';

/* =====================================================================
   main.js — Application bootstrap + control wiring.

   Responsibilities:
     * Own the application state (config, engine, market, logger, agents).
     * Wire up every control in the header and replay panel.
     * Drive render scheduling (coalesced via requestAnimationFrame so
       multiple ticks in one animation frame produce one repaint).
     * Switch between live and replay rendering modes.
   ===================================================================== */

const App = {
  config: {
    periods:        10,
    ticksPerPeriod: 18,
    dividendMean:   10,    // FV_t = 10 × remaining periods → max FV = 100
    tickInterval:   340,
  },

  // Population composition — driven by the Parameters panel sliders.
  // The sampling stage in agents.js turns this into per-agent specs
  // (names + endowments). Default to the Utility preset so the
  // extended panels are visible on first load.
  mix: { F: 0, T: 0, R: 0, E: 0, U: 6 },

  // Every invented numeric constant exposed by the Parameters panel.
  // Market-level knobs mirror App.config; the rest mirror UTILITY_DEFAULTS
  // in agents.js. The engine and agents read from ctx.tunables when
  // present, so changing a slider + reset re-seeds the whole run with
  // the new values. Tunables that aren't present here fall back to
  // UTILITY_DEFAULTS via the tunable() helper in agents.js.
  tunables: {
    periods:              10,
    ticksPerPeriod:       18,
    dividendMean:         10,
    naivePriorWeight:     0.6,
    skepticalPriorWeight: 0.9,
    adaptiveWeightCap:    0.5,
    passiveFillProb:      0.3,
    trustAlpha:           0.30,
    valuationNoise:       0.03,
    biasAmount:           0.15,
  },

  // Risk-preference composition for utility agents — three linked
  // shares summing to 100. Drives which risk profile each U slot is
  // instantiated with in the sampling stage.
  riskMix: { loving: 33, neutral: 34, averse: 33 },

  // Extended-mode flags consulted by the engine's communication round
  // and by the utility-agent message-listener. Kept as constants now
  // that the old Communication & deception toggles are gone — the
  // messaging + deception path stays live whenever mix.U > 0.
  extendedConfig: {
    communication: true,
    deception:     true,
  },

  seed: 42,

  // Per-agent spec list produced by the sampling stage (names +
  // endowments + strategy fields). Nulled whenever the population
  // structure changes (mix, riskMix, seed, preset, defaults) so that
  // the next reset() re-samples; kept intact when the user edits an
  // individual endowment so the run replays from the same draws.
  agentSpecs: null,

  agents:       {},
  market:       null,
  logger:       null,
  engine:       null,
  messageBus:   null,
  trustTracker: null,
  ctx:          null,
  _rng:         null,

  replayMode: false,
  replayTick: 0,
  rafPending: false,

  init() {
    UI.init();
    this._wireControls();
    this.reset();
  },

  /* -------- Control wiring -------- */

  _wireControls() {
    document.getElementById('btn-start').addEventListener('click', () => this.start());
    document.getElementById('btn-pause').addEventListener('click', () => this.pause());
    document.getElementById('btn-reset').addEventListener('click', () => this.reset());

    document.getElementById('seed').addEventListener('change', e => {
      this.seed = Number(e.target.value) || 1;
      this.resample();
    });
    document.getElementById('speed').addEventListener('input', e => {
      // speed 1 → ~953ms, speed 20 → ~60ms
      const s = Number(e.target.value);
      this.config.tickInterval = Math.max(40, Math.round(1000 - s * 47));
    });

    this._wireParamsPanel();

    const slider = document.getElementById('replay-slider');
    slider.addEventListener('input', e => this.enterReplayAt(Number(e.target.value)));

    document.getElementById('btn-live').addEventListener('click', () => this.exitReplay());
    document.getElementById('btn-step-back').addEventListener('click', () => {
      const currentT = this.replayMode ? this.replayTick : this.market.tick;
      this.enterReplayAt(Math.max(0, currentT - 1));
    });
    document.getElementById('btn-step-fwd').addEventListener('click', () => {
      const maxT = this.market.tick;
      if (!this.replayMode) return;
      this.enterReplayAt(Math.min(maxT, this.replayTick + 1));
    });
  },

  /* -------- Parameters panel -------- */

  /**
   * Map of every slider → the Tunables/mix key it drives. Each entry
   * specifies how to format the readout and whether the value is an
   * integer. The loop below wires change events uniformly so adding
   * a new slider only requires extending this map and the HTML.
   */
  _paramMap: {
    // Market
    'p-periods':     { target: 'tunables.periods',              out: 'v-periods',     fmt: v => String(v | 0), int: true },
    'p-ticks':       { target: 'tunables.ticksPerPeriod',       out: 'v-ticks',       fmt: v => String(v | 0), int: true },
    'p-divmean':     { target: 'tunables.dividendMean',         out: 'v-divmean',     fmt: v => String(v | 0), int: true },
    // Population mix
    'p-mix-F':       { target: 'mix.F',                         out: 'v-mix-F',       fmt: v => String(v | 0), int: true },
    'p-mix-T':       { target: 'mix.T',                         out: 'v-mix-T',       fmt: v => String(v | 0), int: true },
    'p-mix-R':       { target: 'mix.R',                         out: 'v-mix-R',       fmt: v => String(v | 0), int: true },
    'p-mix-E':       { target: 'mix.E',                         out: 'v-mix-E',       fmt: v => String(v | 0), int: true },
    'p-mix-U':       { target: 'mix.U',                         out: 'v-mix-U',       fmt: v => String(v | 0), int: true },
    // Risk preferences — three linked shares summing to 100
    'p-risk-loving': { target: 'riskMix.loving',                out: 'v-risk-loving', fmt: v => v + '%', int: true },
    'p-risk-neutral':{ target: 'riskMix.neutral',               out: 'v-risk-neutral',fmt: v => v + '%', int: true },
    'p-risk-averse': { target: 'riskMix.averse',                out: 'v-risk-averse', fmt: v => v + '%', int: true },
    // Belief update
    'p-naive-w':     { target: 'tunables.naivePriorWeight',     out: 'v-naive-w',     fmt: v => v.toFixed(2) },
    'p-skep-w':      { target: 'tunables.skepticalPriorWeight', out: 'v-skep-w',      fmt: v => v.toFixed(2) },
    'p-adapt-cap':   { target: 'tunables.adaptiveWeightCap',    out: 'v-adapt-cap',   fmt: v => v.toFixed(2) },
    // Trust & evaluation
    'p-trust-alpha': { target: 'tunables.trustAlpha',           out: 'v-trust-alpha', fmt: v => v.toFixed(2) },
    'p-pfill':       { target: 'tunables.passiveFillProb',      out: 'v-pfill',       fmt: v => v.toFixed(2) },
    'p-val-noise':   { target: 'tunables.valuationNoise',       out: 'v-val-noise',   fmt: v => v.toFixed(3) },
    'p-bias-amt':    { target: 'tunables.biasAmount',           out: 'v-bias-amt',    fmt: v => v.toFixed(2) },
  },

  _wireParamsPanel() {
    // Push the initial tunables/mix values into the sliders so the
    // controls reflect App state on first paint regardless of the
    // values baked into the HTML defaults.
    this._pushStateToSliders();
    this._refreshMixTotal();

    // Uniform wiring for every slider in the param map. Sliders that
    // change the population *structure* (mix counts, risk shares) call
    // resample() on release so the sampling stage re-draws names and
    // endowments from the sample RNG; everything else just calls
    // reset() and keeps the cached specs intact.
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const structural =
        spec.target.startsWith('mix.') ||
        spec.target.startsWith('riskMix.');
      input.addEventListener('input', e => {
        const raw = Number(e.target.value);
        const val = spec.int ? (raw | 0) : raw;
        this._setByPath(spec.target, val);
        const out = document.getElementById(spec.out);
        if (out) out.textContent = spec.fmt(val);
        if (spec.target.startsWith('mix.'))     this._refreshMixTotal();
        if (spec.target.startsWith('riskMix.')) this._constrainRiskMix(inputId);
      });
      input.addEventListener('change', () => {
        if (structural) this.resample();
        else            this.reset();
      });
    }
    this._updateCompBar();

    // Total-agents slider — proportionally rescales the per-type
    // counts when the user moves it, then triggers a population
    // rebuild on release. Wired separately because it doesn't map
    // to a single mix/tunables key.
    const totalSlider = document.getElementById('p-total');
    if (totalSlider) {
      totalSlider.addEventListener('input', e => {
        const newTotal = Number(e.target.value) | 0;
        this._rescaleMixToTotal(newTotal);
        this._pushStateToSliders();
        this._refreshMixTotal();
      });
      totalSlider.addEventListener('change', () => this.resample());
    }

    // Foldable panel header — click anywhere on the strip to toggle
    // the body visibility. Mirrors the pattern used by the lying
    // project's side panels.
    const head = document.getElementById('panel-params-head');
    const panel = document.getElementById('panel-params');
    if (head && panel) {
      head.addEventListener('click', () => panel.classList.toggle('collapsed'));
    }
  },

  /**
   * Linked-slider constraint for the three risk-preference shares.
   * When one slider moves to cv, the remaining (100 − cv) is split
   * between the other two in proportion to their previous values,
   * with the residual absorbed by the first of the two. If both
   * others are zero, split the remainder 50/50. After rebalancing,
   * App.riskMix, the readouts, and the comp-bar are all refreshed.
   */
  _constrainRiskMix(changedId) {
    const ids  = ['p-risk-loving', 'p-risk-neutral', 'p-risk-averse'];
    const keys = ['loving',        'neutral',        'averse'];
    const ci = ids.indexOf(changedId);
    if (ci < 0) return;
    const els = ids.map(id => document.getElementById(id));
    const cv  = Number(els[ci].value) | 0;
    const oi  = [0, 1, 2].filter(i => i !== ci);
    const prev0 = Number(els[oi[0]].value) | 0;
    const prev1 = Number(els[oi[1]].value) | 0;
    const sumOthers = prev0 + prev1;
    const remaining = Math.max(0, 100 - cv);
    let r0, r1;
    if (sumOthers > 0) {
      r0 = Math.round(prev0 / sumOthers * remaining);
      r1 = remaining - r0;
    } else {
      r0 = Math.floor(remaining / 2);
      r1 = remaining - r0;
    }
    els[oi[0]].value = String(r0);
    els[oi[1]].value = String(r1);
    this.riskMix[keys[ci]]    = cv;
    this.riskMix[keys[oi[0]]] = r0;
    this.riskMix[keys[oi[1]]] = r1;
    document.getElementById('v-risk-loving').textContent  = this.riskMix.loving  + '%';
    document.getElementById('v-risk-neutral').textContent = this.riskMix.neutral + '%';
    document.getElementById('v-risk-averse').textContent  = this.riskMix.averse  + '%';
    this._updateCompBar();
  },

  _updateCompBar() {
    const bar = document.getElementById('comp-bar');
    if (!bar) return;
    const { loving, neutral, averse } = this.riskMix;
    // A 0% segment still needs a nonzero flex or flexbox collapses it
    // asymmetrically; 0.001 keeps it out of sight without side effects.
    bar.children[0].style.flex = loving  || 0.001;
    bar.children[1].style.flex = neutral || 0.001;
    bar.children[2].style.flex = averse  || 0.001;
    bar.children[0].querySelector('span').textContent = loving  + '%';
    bar.children[1].querySelector('span').textContent = neutral + '%';
    bar.children[2].querySelector('span').textContent = averse  + '%';
  },

  _pushStateToSliders() {
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const val = this._getByPath(spec.target);
      if (val == null) continue;
      input.value = String(val);
      const out = document.getElementById(spec.out);
      if (out) out.textContent = spec.fmt(val);
    }
  },

  _refreshMixTotal() {
    const m = this.mix;
    const total = (m.F | 0) + (m.T | 0) + (m.R | 0) + (m.E | 0) + (m.U | 0);
    const el = document.getElementById('mix-total');
    if (el) el.textContent = `(total ${total})`;
    // Keep the Total agents slider and its readout in sync with the
    // sum of the per-type sliders so editing either side stays
    // consistent. Clamped to the slider's max so a manual sum that
    // exceeds the cap still leaves the slider at its rail.
    const totalSlider  = document.getElementById('p-total');
    const totalReadout = document.getElementById('v-total');
    if (totalSlider) {
      const max = Number(totalSlider.max) || total;
      totalSlider.value = String(Math.min(total, max));
    }
    if (totalReadout) totalReadout.textContent = String(total);
  },

  /**
   * Proportionally rescale the mix to a new total. Each type's share
   * of the new total is its old share multiplied by the new size, with
   * largest-remainder rounding so the integer counts sum exactly to
   * newTotal. If every slot is currently zero, the new agents land in
   * U so the extended panels become reachable from a blank slate.
   */
  _rescaleMixToTotal(newTotal) {
    const keys = ['F', 'T', 'R', 'E', 'U'];
    const m = this.mix;
    const oldTotal = keys.reduce((s, k) => s + (m[k] | 0), 0);

    if (newTotal <= 0) {
      this.mix = { F: 0, T: 0, R: 0, E: 0, U: 0 };
      return;
    }
    if (oldTotal === 0) {
      this.mix = { F: 0, T: 0, R: 0, E: 0, U: newTotal };
      return;
    }

    const scale = newTotal / oldTotal;
    const next  = { F: 0, T: 0, R: 0, E: 0, U: 0 };
    const fracs = [];
    let assigned = 0;
    for (const k of keys) {
      const raw  = m[k] * scale;
      const base = Math.floor(raw);
      next[k]    = base;
      assigned  += base;
      fracs.push({ k, frac: raw - base });
    }
    let remainder = newTotal - assigned;
    fracs.sort((a, b) => b.frac - a.frac);
    let idx = 0;
    while (remainder > 0) {
      next[fracs[idx % fracs.length].k]++;
      remainder--;
      idx++;
    }
    this.mix = next;
  },

  _getByPath(path) {
    const [root, key] = path.split('.');
    return this[root] ? this[root][key] : undefined;
  },

  _setByPath(path, val) {
    const [root, key] = path.split('.');
    if (this[root]) this[root][key] = val;
  },

  /* -------- Lifecycle -------- */

  reset() {
    if (this.engine) this.engine.pause();
    Order.nextId = 1;
    Trade.nextId = 1;

    // Fold the market-level sliders back into App.config so the
    // Market constructor and fundamental-value formula see the
    // latest values. tickInterval is controlled separately by the
    // Speed slider and is intentionally preserved here.
    this.config.periods        = this.tunables.periods;
    this.config.ticksPerPeriod = this.tunables.ticksPerPeriod;
    this.config.dividendMean   = this.tunables.dividendMean;

    this._rng = makeRNG(this.seed);

    // Sampling RNG is intentionally independent of the engine RNG, so
    // that editing endowments (which skips the resample path) leaves
    // the engine's tick-level draws unchanged from a seed-matched run.
    const totalN =
      (this.mix.F | 0) + (this.mix.T | 0) + (this.mix.R | 0) +
      (this.mix.E | 0) + (this.mix.U | 0);
    if (!this.agentSpecs || this.agentSpecs.length !== totalN) {
      const sampleRng = makeRNG((this.seed ^ 0xA5A5A5A5) >>> 0);
      this.agentSpecs = sampleAgents(this.mix, sampleRng, {
        riskMix: this.riskMix,
      });
    }
    this.agents = buildAgentsFromSpecs(this.agentSpecs, {
      biasAmount:     this.tunables.biasAmount,
      valuationNoise: this.tunables.valuationNoise,
    });
    this.market = new Market(this.config);
    this.logger = new Logger();
    // Message bus + trust tracker live for every run. With a mix that
    // has no utility agents they simply stay empty because no agent
    // implements communicate() and the engine's comms round returns early.
    this.messageBus   = new MessageBus();
    const agentIds    = Object.keys(this.agents).map(Number);
    this.trustTracker = new TrustTracker(agentIds);
    this.ctx = {
      messageBus:   this.messageBus,
      trustTracker: this.trustTracker,
      extended:     this.extendedConfig,
      tunables:     this.tunables,
    };
    this.engine = new Engine(this.market, this.agents, this.logger, this.config, this._rng, this.ctx);
    this.engine.onTick = () => this.requestRender();
    this.engine.onEnd  = () => this.requestRender();
    this.replayMode = false;
    this.replayTick = 0;
    // Toggle the extended-panel visibility class whenever any utility
    // agents are present, then re-measure canvases that were previously
    // display:none.
    document.body.classList.toggle('extended', (this.mix.U | 0) > 0);
    UI.resizeCanvases();
    this.requestRender();
  },

  /**
   * Drop the cached agentSpecs and rebuild — used whenever the
   * population *structure* changes (mix counts, riskMix, seed,
   * preset, defaults). Downstream reset() will notice the null
   * cache and re-run sampleAgents against a fresh sample RNG.
   */
  resample() {
    this.agentSpecs = null;
    this.reset();
  },

  /**
   * Apply a user edit to one agent's endowment and rebuild the
   * market without re-sampling. Called from the per-agent editable
   * inputs in ui.js. Field is 'cash' or 'inventory'; non-finite or
   * negative values are ignored.
   */
  updateEndowment(id, field, value) {
    if (!this.agentSpecs) return;
    const spec = this.agentSpecs.find(s => s.id === id);
    if (!spec) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    spec[field] = field === 'inventory' ? (v | 0) : Math.round(v);
    this.reset();
  },

  start() {
    if (this.replayMode) this.exitReplay();
    this.engine.start();
  },

  pause() {
    this.engine.pause();
    this.requestRender();
  },

  enterReplayAt(tick) {
    this.replayMode = true;
    this.replayTick = tick;
    if (this.engine.running) this.engine.pause();
    this.requestRender();
  },

  exitReplay() {
    this.replayMode = false;
    this.replayTick = this.market.tick;
    this.requestRender();
  },

  /* -------- Render loop -------- */

  requestRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  },

  render() {
    const view = this.replayMode
      ? Replay.buildViewAt(this.market, this.logger, this.replayTick, this.ctx)
      : Replay.buildLiveView(this.market, this.logger, this.agents, this.ctx);

    UI.render(view, this.config);
    UI.setReplayPosition(view.tick, this.market.tick, !this.replayMode);
  },
};

function bootApp() {
  window.App = App;
  App.init();
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
