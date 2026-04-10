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

  seed:            42,
  populationKey:   'inexperienced',

  agents: {},
  market: null,
  logger: null,
  engine: null,
  _rng:   null,

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

    document.getElementById('mix-select').addEventListener('change', e => {
      this.populationKey = e.target.value;
      this.reset();
    });
    document.getElementById('seed').addEventListener('change', e => {
      this.seed = Number(e.target.value) || 1;
      this.reset();
    });
    document.getElementById('speed').addEventListener('input', e => {
      // speed 1 → ~953ms, speed 20 → ~60ms
      const s = Number(e.target.value);
      this.config.tickInterval = Math.max(40, Math.round(1000 - s * 47));
    });

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

  /* -------- Lifecycle -------- */

  reset() {
    if (this.engine) this.engine.pause();
    Order.nextId = 1;
    Trade.nextId = 1;
    this._rng   = makeRNG(this.seed);
    this.agents = buildAgents(this.populationKey);
    this.market = new Market(this.config);
    this.logger = new Logger();
    this.engine = new Engine(this.market, this.agents, this.logger, this.config, this._rng);
    this.engine.onTick = () => this.requestRender();
    this.engine.onEnd  = () => this.requestRender();
    this.replayMode = false;
    this.replayTick = 0;
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
      ? Replay.buildViewAt(this.market, this.logger, this.replayTick)
      : Replay.buildLiveView(this.market, this.logger, this.agents);

    UI.render(view, this.config);
    UI.setReplayPosition(view.tick, this.market.tick, !this.replayMode);
  },
};

window.addEventListener('DOMContentLoaded', () => {
  window.App = App;
  App.init();
});
