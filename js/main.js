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
  // Market config. Three of these four values are fixed-by-design
  // and surfaced read-only in companion cards at the top of the page:
  //
  //   periods, dividendMean   — paper constants from Dufwenberg,
  //                             Lindqvist & Moore (2005) §I (asset
  //                             life = 10 periods, E[dividend] = 10¢,
  //                             so FV_t = 10 · (T − t + 1)). Shown in
  //                             the "Paper constants" panel.
  //   ticksPerPeriod          — simulator constant. DLM 2005 uses a
  //                             continuous 2-minute z-Tree auction;
  //                             this sim discretizes each period into
  //                             18 decision rounds. Shown in the
  //                             "Simulator constants" panel. Not
  //                             tunable — see the evaluation in the
  //                             commit history for the reasoning.
  //   tickInterval            — wall-clock cadence only, driven by
  //                             the header Speed slider. Zero effect
  //                             on market dynamics.
  config: {
    periods:        10,
    ticksPerPeriod: 18,
    dividendMean:   10,
    tickInterval:   340,
  },

  // Population composition — feeds the sampling stage in agents.js,
  // which turns each per-type count into a per-agent spec. Only the E
  // and U slots are exposed as Population sliders; F/T/R are pinned
  // by FIXED_BACKGROUND below to a "common SSW market" mix and are
  // surfaced read-only in the Hidden Constants panel. Defaults pair
  // the fixed background with the original Utility preset so the
  // extended panels light up on first load.
  mix: { F: 2, T: 1, R: 1, E: 0, U: 6 },

  // Pinned counts for the F/T/R background. They are not adjustable
  // from the UI: 2 Fundamentalists supply a rational anchor, 1 Trend
  // follower carries momentum, 1 Random ZI provides liquidity/noise.
  // Together they reproduce the non-experienced portion of the Mixed
  // preset documented in CLAUDE.md and act as a stable scaffold for
  // every run regardless of the user's E/U choices.
  FIXED_BACKGROUND: { F: 2, T: 1, R: 1 },

  // Simulator-invented numeric constants consumed by the engine and
  // utility agents. None of these are proposed by DLM 2005 (which
  // studies human subjects and specifies no agent model), so they
  // are surfaced read-only in the Simulator constants panel rather
  // than as Experiment-settings sliders. Still dropped on ctx here
  // because agents.js/engine.js read them via the tunable() helper,
  // which falls back to UTILITY_DEFAULTS for any missing key — so
  // editing a default value in one place keeps behavior consistent.
  // Note: `periods`, `dividendMean`, and `ticksPerPeriod` live in
  // App.config instead — the first two are DLM 2005 paper constants
  // and the third is the period-discretization simulator constant.
  tunables: {
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

  // Experience-preference composition for experienced agents — the
  // E-slot mirror of riskMix. Three linked shares summing to 100,
  // distributed across DLM 2005's experience dimension: naive (round-1
  // first-timer), once-played (intermediate), and veteran (round-4
  // fully-experienced trader). Drives the per-slot experienceLevel in
  // the sampling stage. Defaults bias toward veteran so the E preset
  // remains bubble-suppressing unless the user dials in naive shares.
  experienceMix: { naive: 0, once: 0, veteran: 100 },

  // Extended-mode flags consulted by the engine's communication round
  // and by the utility-agent message-listener. Kept as constants now
  // that the old Communication & deception toggles are gone — the
  // messaging + deception path stays live whenever mix.U > 0.
  extendedConfig: {
    communication: true,
    deception:     true,
  },

  // Engine RNG seed. Rerolled from Math.random() on every reset() so
  // Reset doubles as "redraw the population" and no manual seed input
  // is needed in the UI. rebuild() (soft slider changes, endowment
  // edits) preserves the current seed so the existing draw survives.
  seed: 1,

  // Per-agent spec list produced by the sampling stage (names +
  // endowments + strategy fields). Nulled by reset() so the next
  // rebuild() re-samples against a fresh sample RNG; kept intact by
  // rebuild() when the user edits an individual endowment so those
  // edits survive the next market rebuild.
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
    this._initTheme();
    UI.init();
    this._wireControls();
    this.reset();
  },

  /* -------- Theme: auto / light / dark -------- */

  _initTheme() {
    const saved = localStorage.getItem('bubble-theme') || 'auto';
    document.documentElement.setAttribute('data-theme', saved);
    this._syncThemeButton(saved);
    // Re-apply canvas theme colors when the system scheme changes while
    // the user is on 'auto', so dark-mode OS switches repaint the charts.
    if (window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if (document.documentElement.getAttribute('data-theme') === 'auto') {
          UI.refreshTheme();
          this.requestRender();
        }
      };
      if (mql.addEventListener) mql.addEventListener('change', listener);
      else if (mql.addListener) mql.addListener(listener);
    }
  },

  _cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const cur   = document.documentElement.getAttribute('data-theme') || 'auto';
    const next  = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bubble-theme', next);
    this._syncThemeButton(next);
    UI.refreshTheme();
    this.requestRender();
  },

  _syncThemeButton(mode) {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const icons = { auto: '◑', light: '☀', dark: '☾' };
    btn.textContent  = icons[mode] || '◑';
    btn.title        = `Theme: ${mode} (click to cycle)`;
  },

  /* -------- Control wiring -------- */

  _wireControls() {
    document.getElementById('btn-start').addEventListener('click', () => this.start());
    document.getElementById('btn-pause').addEventListener('click', () => this.pause());
    document.getElementById('btn-reset').addEventListener('click', () => this.reset());
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', () => this._cycleTheme());

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

  /* -------- Experiment settings panel -------- */

  /**
   * Map of every slider → the Tunables/mix key it drives. Each entry
   * specifies how to format the readout and whether the value is an
   * integer. The loop below wires change events uniformly so adding
   * a new slider only requires extending this map and the HTML.
   */
  _paramMap: {
    // Population mix — only the user-controlled slot. F/T/R are pinned
    // by FIXED_BACKGROUND, and U is derived as N − E − N_fixed by
    // _onPopulationChange below since the Utility slider was always
    // a 1:1 alias of the Total N slider once E was fixed.
    'p-mix-E':       { target: 'mix.E',                         out: 'v-mix-E',       fmt: v => String(v | 0), int: true },
    // Risk preferences — three linked shares summing to 100
    'p-risk-loving': { target: 'riskMix.loving',                out: 'v-risk-loving', fmt: v => v + '%', int: true },
    'p-risk-neutral':{ target: 'riskMix.neutral',               out: 'v-risk-neutral',fmt: v => v + '%', int: true },
    'p-risk-averse': { target: 'riskMix.averse',                out: 'v-risk-averse', fmt: v => v + '%', int: true },
    // Experience preferences — same linked-triplet pattern, applied to E slots
    'p-exp-naive':   { target: 'experienceMix.naive',           out: 'v-exp-naive',   fmt: v => v + '%', int: true },
    'p-exp-once':    { target: 'experienceMix.once',            out: 'v-exp-once',    fmt: v => v + '%', int: true },
    'p-exp-veteran': { target: 'experienceMix.veteran',         out: 'v-exp-veteran', fmt: v => v + '%', int: true },
  },

  _wireParamsPanel() {
    // Push the initial tunables/mix values into the sliders so the
    // controls reflect App state on first paint regardless of the
    // values baked into the HTML defaults.
    this._pushStateToSliders();
    this._refreshMixTotal();

    // Uniform wiring for every slider in the param map. Sliders that
    // change the population *structure* (mix counts, risk shares) call
    // reset() on release, which rolls a new seed and re-samples the
    // population; everything else calls rebuild() and keeps the
    // cached specs intact.
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const structural =
        spec.target.startsWith('mix.') ||
        spec.target.startsWith('riskMix.') ||
        spec.target.startsWith('experienceMix.');
      input.addEventListener('input', e => {
        const raw = Number(e.target.value);
        const val = spec.int ? (raw | 0) : raw;
        this._setByPath(spec.target, val);
        const out = document.getElementById(spec.out);
        if (out) out.textContent = spec.fmt(val);
        this._updateSliderPct(e.target);
        if (spec.target === 'mix.E')                  this._onExperiencedChanged(e.target);
        if (spec.target.startsWith('mix.'))           this._refreshMixTotal();
        if (spec.target.startsWith('riskMix.'))       this._constrainRiskMix(inputId);
        if (spec.target.startsWith('experienceMix.')) this._constrainExperienceMix(inputId);
      });
      input.addEventListener('change', () => {
        // Structural edits (population mix counts, risk-share shares)
        // ask for a fresh draw, so they roll a new seed via reset().
        // Everything else is a soft change that keeps the current
        // draw and just rebuilds the market/engine.
        if (structural) this.reset();
        else            this.rebuild();
      });
    }
    this._updateCompBar();
    this._updateExpCompBar();

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
        this._updateSliderPct(e.target);
      });
      totalSlider.addEventListener('change', () => this.reset());
    }

    // Prime the custom --pct on every slider so the filled portion of
    // the track matches the initial value before any interaction.
    this._updateAllSliderPcts();

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
    this._constrainLinkedTriplet(changedId, {
      ids:    ['p-risk-loving', 'p-risk-neutral', 'p-risk-averse'],
      keys:   ['loving',        'neutral',        'averse'],
      state:  this.riskMix,
      labels: ['v-risk-loving', 'v-risk-neutral', 'v-risk-averse'],
      onAfter: () => this._updateCompBar(),
    });
  },

  /**
   * Linked-slider constraint for the three experience-preference shares.
   * Shares the implementation with _constrainRiskMix so the two preference
   * blocks behave identically — same sum-to-100, same proportional split,
   * same 50/50 fallback when both other sliders are zero — and the only
   * thing that varies is which state object and which DOM ids are touched.
   */
  _constrainExperienceMix(changedId) {
    this._constrainLinkedTriplet(changedId, {
      ids:    ['p-exp-naive', 'p-exp-once', 'p-exp-veteran'],
      keys:   ['naive',       'once',       'veteran'],
      state:  this.experienceMix,
      labels: ['v-exp-naive', 'v-exp-once', 'v-exp-veteran'],
      onAfter: () => this._updateExpCompBar(),
    });
  },

  /**
   * Shared linked-triplet rebalancer used by both preference blocks. When
   * one of the three sliders moves to cv, the remaining (100 − cv) is
   * split between the other two in proportion to their previous values,
   * with the residual absorbed by the first of the two. If both others
   * are zero, the remainder is split 50/50. After rebalancing, the bound
   * state object, the readouts, and the supplied onAfter hook (used to
   * refresh the comp-bar) are all called.
   */
  _constrainLinkedTriplet(changedId, cfg) {
    const ci = cfg.ids.indexOf(changedId);
    if (ci < 0) return;
    const els = cfg.ids.map(id => document.getElementById(id));
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
    this._updateSliderPct(els[oi[0]]);
    this._updateSliderPct(els[oi[1]]);
    cfg.state[cfg.keys[ci]]    = cv;
    cfg.state[cfg.keys[oi[0]]] = r0;
    cfg.state[cfg.keys[oi[1]]] = r1;
    for (let i = 0; i < 3; i++) {
      const out = document.getElementById(cfg.labels[i]);
      if (out) out.textContent = cfg.state[cfg.keys[i]] + '%';
    }
    if (cfg.onAfter) cfg.onAfter();
  },

  /**
   * Write the [min..max]→[0..100] percentage into the --pct custom
   * property on one range input. The CSS track uses this as a
   * linear-gradient stop so the filled portion follows the thumb.
   */
  _updateSliderPct(el) {
    if (!el) return;
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 100;
    const v   = Number(el.value) || 0;
    const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
    el.style.setProperty('--pct', pct.toFixed(2) + '%');
  },

  _updateAllSliderPcts() {
    const sliders = document.querySelectorAll('.panel-params input[type=range]');
    sliders.forEach(el => this._updateSliderPct(el));
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

  _updateExpCompBar() {
    const bar = document.getElementById('comp-bar-exp');
    if (!bar) return;
    const { naive, once, veteran } = this.experienceMix;
    bar.children[0].style.flex = naive   || 0.001;
    bar.children[1].style.flex = once    || 0.001;
    bar.children[2].style.flex = veteran || 0.001;
    bar.children[0].querySelector('span').textContent = naive   + '%';
    bar.children[1].querySelector('span').textContent = once    + '%';
    bar.children[2].querySelector('span').textContent = veteran + '%';
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
      this._updateSliderPct(input);
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
      this._updateSliderPct(totalSlider);
    }
    if (totalReadout) totalReadout.textContent = String(total);
  },

  /**
   * Rescale the mix to a new total population N. F/T/R are pinned by
   * FIXED_BACKGROUND, E is held at its current value (clamped down if
   * the new N would not leave room for it), and U is derived as the
   * residual N − E − fixedSum. With the U slider gone, this is just
   * "what the N slider does": E is preserved, U absorbs the slack.
   */
  _rescaleMixToTotal(newTotal) {
    const FIXED    = this.FIXED_BACKGROUND;
    const fixedSum = FIXED.F + FIXED.T + FIXED.R;
    newTotal = Math.max(newTotal | 0, fixedSum);
    const E = Math.min(this.mix.E | 0, newTotal - fixedSum);
    const U = newTotal - fixedSum - E;
    this.mix = { ...FIXED, E, U };
  },

  /**
   * Called when the user moves the Experienced slider. The Total N
   * slider is held at its current value, so adding an E agent removes
   * a U agent and vice versa: mix.U = N − E − fixedSum. The E input is
   * also clamped here so the user cannot drag it past the available
   * room (N − fixedSum).
   */
  _onExperiencedChanged(input) {
    const FIXED    = this.FIXED_BACKGROUND;
    const fixedSum = FIXED.F + FIXED.T + FIXED.R;
    const totalSlider = document.getElementById('p-total');
    const N    = totalSlider ? (Number(totalSlider.value) | 0) : (fixedSum + (this.mix.E | 0) + (this.mix.U | 0));
    const eMax = Math.max(0, N - fixedSum);
    const E    = Math.min(Math.max(this.mix.E | 0, 0), eMax);
    if (E !== (this.mix.E | 0)) {
      this.mix.E = E;
      input.value = String(E);
      this._updateSliderPct(input);
      const out = document.getElementById('v-mix-E');
      if (out) out.textContent = String(E);
    }
    this.mix.U = N - fixedSum - E;
    document.body.classList.toggle('has-experienced', E > 0);
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

  /**
   * Full reset — rolls a new random engine seed, drops the cached
   * agentSpecs, and delegates to rebuild() which will re-sample a
   * fresh population against the new seed. This is the only path
   * that changes the seed; rebuild() alone preserves it.
   */
  reset() {
    this.seed = this._rollSeed();
    this.agentSpecs = null;
    this.rebuild();
  },

  /**
   * Produce a 32-bit engine seed from Math.random(). Kept as its
   * own method so tests or future URL-parameter overrides can swap
   * the source without touching reset().
   */
  _rollSeed() {
    return (Math.floor(Math.random() * 0x100000000)) >>> 0 || 1;
  },

  /**
   * Rebuild market + engine + agents from the current seed and the
   * current agentSpecs cache. Called directly from soft slider
   * changes and endowment edits (which must preserve both); called
   * indirectly from reset() (which nulls the cache first so a fresh
   * sample is drawn against the new seed).
   */
  rebuild() {
    if (this.engine) this.engine.pause();
    Order.nextId = 1;
    Trade.nextId = 1;

    // Nothing is folded from tunables into config here any more:
    // periods, dividendMean, and ticksPerPeriod are all fixed
    // constants (two from the paper, one from the simulator) and
    // live only in App.config. tickInterval is controlled by the
    // header Speed slider and is intentionally preserved across
    // rebuilds.

    this._rng = makeRNG(this.seed);

    // Sampling RNG is independent of the engine RNG so that editing
    // endowments (which skips the re-sample path) leaves the engine's
    // tick-level draws unchanged.
    const totalN =
      (this.mix.F | 0) + (this.mix.T | 0) + (this.mix.R | 0) +
      (this.mix.E | 0) + (this.mix.U | 0);
    if (!this.agentSpecs || this.agentSpecs.length !== totalN) {
      const sampleRng = makeRNG((this.seed ^ 0xA5A5A5A5) >>> 0);
      this.agentSpecs = sampleAgents(this.mix, sampleRng, {
        riskMix:       this.riskMix,
        experienceMix: this.experienceMix,
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
    document.body.classList.toggle('extended',       (this.mix.U | 0) > 0);
    document.body.classList.toggle('has-experienced', (this.mix.E | 0) > 0);
    UI.resizeCanvases();
    this.requestRender();
  },

  /**
   * Apply a user edit to one agent's endowment and rebuild the
   * market without re-sampling or reseeding. Called from the
   * per-agent editable inputs in ui.js. Field is 'cash' or
   * 'inventory'; non-finite or negative values are ignored.
   */
  updateEndowment(id, field, value) {
    if (!this.agentSpecs) return;
    const spec = this.agentSpecs.find(s => s.id === id);
    if (!spec) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    spec[field] = field === 'inventory' ? (v | 0) : Math.round(v);
    this.rebuild();
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
