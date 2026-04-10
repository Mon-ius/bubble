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
  // Default to the Utility preset so the extended panels are visible
  // on first load.
  mix: { F: 0, T: 0, R: 0, E: 0, U: 6 },

  // Every invented numeric constant exposed by the Parameters panel.
  // Market-level knobs mirror App.config; the rest mirror UTILITY_DEFAULTS
  // in agents.js. The engine and agents read from ctx.tunables when
  // present, so changing a slider + reset re-seeds the whole run with
  // the new values.
  tunables: {
    periods:              10,
    ticksPerPeriod:       18,
    dividendMean:         10,
    naivePriorWeight:     0.6,
    skepticalPriorWeight: 0.9,
    adaptiveWeightCap:    0.5,
    passiveFillProb:      0.3,
    honestNoise:          0.01,
    biasedTilt:           0.10,
    deceptiveOverstate:   1.18,
    deceptiveUnderstate:  0.82,
    signalThreshold:      0.03,
    trustAlpha:           0.30,
    valuationNoise:       0.03,
    biasAmount:           0.15,
  },

  // Extended-mode toggles (communication bus + deception allowed).
  // Only consulted when mix.U > 0.
  extendedConfig: {
    communication: true,
    deception:     true,
  },

  seed: 42,

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
      this.reset();
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
    // Communication & deception
    'p-honest-noise':{ target: 'tunables.honestNoise',          out: 'v-honest-noise',fmt: v => v.toFixed(3) },
    'p-biased-tilt': { target: 'tunables.biasedTilt',           out: 'v-biased-tilt', fmt: v => v.toFixed(3) },
    'p-decep-over':  { target: 'tunables.deceptiveOverstate',   out: 'v-decep-over',  fmt: v => v.toFixed(2) },
    'p-decep-under': { target: 'tunables.deceptiveUnderstate',  out: 'v-decep-under', fmt: v => v.toFixed(2) },
    'p-signal-thr':  { target: 'tunables.signalThreshold',      out: 'v-signal-thr',  fmt: v => v.toFixed(3) },
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

    // Uniform wiring for every slider in the param map.
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      input.addEventListener('input', e => {
        const raw = Number(e.target.value);
        const val = spec.int ? (raw | 0) : raw;
        this._setByPath(spec.target, val);
        const out = document.getElementById(spec.out);
        if (out) out.textContent = spec.fmt(val);
        if (spec.target.startsWith('mix.')) this._refreshMixTotal();
      });
      input.addEventListener('change', () => this.reset());
    }

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
      totalSlider.addEventListener('change', () => this.reset());
    }

    // Communication / deception checkboxes live inside the panel too.
    const commBox = document.getElementById('toggle-communication');
    if (commBox) {
      commBox.checked = this.extendedConfig.communication;
      commBox.addEventListener('change', e => {
        this.extendedConfig.communication = e.target.checked;
        this.reset();
      });
    }
    const decBox = document.getElementById('toggle-deception');
    if (decBox) {
      decBox.checked = this.extendedConfig.deception;
      decBox.addEventListener('change', e => {
        this.extendedConfig.deception = e.target.checked;
        this.reset();
      });
    }

    // Preset buttons — snap the mix sliders to a known-good
    // population without touching any tunables.
    document.querySelectorAll('.params-presets .pill[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-preset');
        const preset = PRESET_MIXES[key];
        if (!preset) return;
        this.mix = Object.assign({ F: 0, T: 0, R: 0, E: 0, U: 0 }, preset);
        this._pushStateToSliders();
        this._refreshMixTotal();
        this.reset();
      });
    });

    // Defaults button — restore the full tunables object to its
    // initial state, reset the mix to Utility, and rebuild.
    const defBtn = document.getElementById('btn-reset-params');
    if (defBtn) {
      defBtn.addEventListener('click', () => {
        this.tunables = {
          periods: 10, ticksPerPeriod: 18, dividendMean: 10,
          naivePriorWeight: 0.6, skepticalPriorWeight: 0.9, adaptiveWeightCap: 0.5,
          passiveFillProb: 0.3, honestNoise: 0.01, biasedTilt: 0.10,
          deceptiveOverstate: 1.18, deceptiveUnderstate: 0.82, signalThreshold: 0.03,
          trustAlpha: 0.30, valuationNoise: 0.03, biasAmount: 0.15,
        };
        this.mix = { F: 0, T: 0, R: 0, E: 0, U: 6 };
        this.extendedConfig.communication = true;
        this.extendedConfig.deception     = true;
        const c = document.getElementById('toggle-communication'); if (c) c.checked = true;
        const d = document.getElementById('toggle-deception');     if (d) d.checked = true;
        this._pushStateToSliders();
        this._refreshMixTotal();
        this.reset();
      });
    }
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

    this._rng   = makeRNG(this.seed);
    this.agents = buildAgentsFromMix(this.mix, {
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
