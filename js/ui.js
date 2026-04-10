'use strict';

/* =====================================================================
   ui.js — DOM + canvas rendering.

   The UI module is purely a consumer of "views" — plain objects built
   by Replay.buildLiveView / Replay.buildViewAt. It never touches the
   Market, Engine, or Agent directly. This means live rendering and
   replay rendering go through identical code, so visual consistency
   is guaranteed.
   ===================================================================== */

const UI = {
  els:     {},
  charts:  {},
  canvases: {},

  // Human-readable labels used by the agents panel. Kept on the UI
  // object so renderAgents stays compact.
  _riskLabel: {
    loving:  'Risk-loving',
    neutral: 'Risk-neutral',
    averse:  'Risk-averse',
  },
  _typeLabel: {
    fundamentalist: 'Fundamentalist',
    trend:          'Trend follower',
    random:         'Random (ZI)',
    experienced:    'Experienced',
    utility:        'Utility',
  },
  // Paper-symbol cross-reference for each utility-agent risk preference
  // and each classic strategy type. Both maps key into Sym (js/mathml.js),
  // so every symbol rendered here goes through the same MathML source of
  // truth as the static HTML notes and figure captions.
  _riskSym: {
    loving:  'uLoving',
    neutral: 'uNeutral',
    averse:  'uAverse',
  },
  _typeSym: {
    fundamentalist: 'inF',
    trend:          'inT',
    random:         'inR',
    experienced:    'inE',
    utility:        'inU',
  },

  // Canvas-time theme cache. Populated by refreshTheme() which reads
  // CSS custom properties off :root via getComputedStyle. Every chart
  // renderer pulls colors from here so a theme switch flows through
  // the canvas layer identically to the DOM layer.
  theme: {
    fg0: '#1a1d23', fg2: '#6b7080', fg3: '#9aa0ad',
    bg1: '#ffffff', bg2: '#f4f5f7',
    accent: '#2563eb', amber: '#d97706', red: '#dc2626',
    green:  '#16a34a', purple: '#7c3aed', teal:   '#0d9488',
    frame:  '#c6cad1', grid:   'rgba(0,0,0,0.06)',
    stripe: 'rgba(0,0,0,0.025)', band: 'rgba(0,0,0,0.022)',
    palette: [],
  },

  refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    const read = k => (cs.getPropertyValue(k) || '').trim();
    const t = this.theme;
    t.fg0    = read('--fg-0')     || t.fg0;
    t.fg2    = read('--fg-2')     || t.fg2;
    t.fg3    = read('--fg-3')     || t.fg3;
    t.bg1    = read('--bg-1')     || t.bg1;
    t.bg2    = read('--bg-2')     || t.bg2;
    t.accent = read('--accent')   || t.accent;
    t.amber  = read('--amber')    || t.amber;
    t.red    = read('--red')      || t.red;
    t.green  = read('--green')    || t.green;
    t.purple = read('--purple')   || t.purple;
    t.teal   = read('--teal')     || t.teal;
    t.frame  = read('--chart-frame')  || t.frame;
    t.grid   = read('--chart-grid')   || t.grid;
    t.stripe = read('--chart-stripe') || t.stripe;
    t.band   = read('--chart-band')   || t.band;
    // Six-slot palette for multi-series charts, drawn from semantic
    // tokens so it shifts with the theme without breaking its meaning.
    t.palette = [t.accent, t.amber, t.green, t.red, t.purple, t.teal];
    if (typeof Viz !== 'undefined' && typeof Viz.setTheme === 'function') {
      Viz.setTheme({ frame: t.frame, grid: t.grid, label: t.fg3 });
    }
  },

  init() {
    this.refreshTheme();
    // Stat cells
    this.els.period  = document.getElementById('stat-period');
    this.els.tick    = document.getElementById('stat-tick');
    this.els.price   = document.getElementById('stat-price');
    this.els.fv      = document.getElementById('stat-fv');
    this.els.bubble  = document.getElementById('stat-bubble');
    this.els.volume  = document.getElementById('stat-volume');

    this.els.bidsBody   = document.getElementById('bids-body');
    this.els.asksBody   = document.getElementById('asks-body');
    this.els.tradeFeed  = document.getElementById('trade-feed');
    this.els.agentsGrid = document.getElementById('agents-grid');

    this.els.traceBody    = document.getElementById('trace-body');
    this.els.replayPos    = document.getElementById('replay-position');
    this.els.replaySlider = document.getElementById('replay-slider');

    // Extended-mode elements (may be absent in legacy builds).
    this.els.metricsBody = document.getElementById('metrics-body');

    this.canvases = {
      price:     document.getElementById('chart-price'),
      bubble:    document.getElementById('chart-bubble'),
      volume:    document.getElementById('chart-volume'),
      timeline:  document.getElementById('chart-timeline'),
      heatmap:   document.getElementById('chart-heatmap'),
      valuation: document.getElementById('chart-valuation'),
      utility:   document.getElementById('chart-utility'),
      messages:  document.getElementById('chart-messages'),
      trust:     document.getElementById('chart-trust'),
      ownership: document.getElementById('chart-ownership'),
    };

    this.resizeCanvases();
    window.addEventListener('resize', () => {
      this.resizeCanvases();
      if (window.App) window.App.requestRender();
    });
  },

  resizeCanvases() {
    this.charts = {};
    for (const [k, c] of Object.entries(this.canvases)) {
      if (!c) continue;
      // Skip canvases that are currently hidden (display:none makes
      // getBoundingClientRect return 0×0). They'll be re-setup next
      // time extended mode toggles on.
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      this.charts[k] = Viz.setupHiDPI(c);
    }
  },

  /** Deterministic color per utility agent id for multi-series charts. */
  agentColor(id) {
    const palette = this.theme.palette;
    return palette[(Number(id) - 1) % palette.length];
  },

  /* -------- Top-level render dispatcher -------- */

  render(view, config) {
    this.renderStats(view, config);
    this.renderBook(view);
    this.renderAgents(view, config);
    this.renderFeed(view);
    this.renderPriceChart(view, config);
    this.renderBubbleChart(view, config);
    this.renderVolumeChart(view, config);
    this.renderHeatmapChart(view, config);
    this.renderTimelineChart(view, config);
    // Extended panels — no-ops when their canvases are absent/hidden.
    this.renderValuationChart(view, config);
    this.renderUtilityChart(view, config);
    this.renderMessagesChart(view, config);
    this.renderTrustChart(view, config);
    this.renderOwnershipChart(view, config);
    this.renderMetrics(view, config);
    this.renderTraces(view);
  },

  /* -------- Stats row -------- */

  renderStats(v, config) {
    this.els.period.textContent = `${v.period} / ${config.periods}`;
    this.els.tick.textContent   = v.tick;
    this.els.price.textContent  = v.lastPrice == null ? '—' : v.lastPrice.toFixed(2);
    this.els.fv.textContent     = v.fv.toFixed(2);
    this.els.bubble.textContent = v.lastPrice == null
      ? '—'
      : Math.abs(v.lastPrice - v.fv).toFixed(2);
    this.els.volume.textContent = v.volumeByPeriod[v.period] || 0;
  },

  /* -------- Order book -------- */

  renderBook(v) {
    const row = o => {
      const name = v.agents[o.agentId]?.name || ('A' + o.agentId);
      return `<tr><td>${o.price.toFixed(2)}</td><td>${o.remaining}</td><td>${name}</td></tr>`;
    };
    this.els.bidsBody.innerHTML =
      v.bids.slice(0, 12).map(row).join('') ||
      '<tr><td colspan="3" class="muted">empty</td></tr>';
    this.els.asksBody.innerHTML =
      v.asks.slice(0, 12).map(row).join('') ||
      '<tr><td colspan="3" class="muted">empty</td></tr>';
  },

  /* -------- Agent cards -------- */

  renderAgents(v, config) {
    const initialFV = config.dividendMean * config.periods;
    // Pre-run: live view, tick still at 0. Only then do we render the
    // editable endowment inputs — once the engine has ticked past 0,
    // the numbers reflect live trading state and must not be edited.
    const editable = !v.isReplay && v.tick === 0;
    const panel = document.querySelector('.panel-agents');
    if (panel) panel.classList.toggle('preview', editable);
    this._toggleAgentStageLabel(editable);

    const html = Object.values(v.agents).map(a => {
      const action = a.lastAction || 'hold';
      const isUtil = a.riskPref != null;
      const valueAnchor = isUtil && a.subjectiveValuation != null ? a.subjectiveValuation : v.fv;
      const wealth = a.cash + a.inventory * valueAnchor;
      const init   = a.initialWealth != null ? a.initialWealth : (1000 + 3 * initialFV);
      const pnl    = wealth - init;
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(0);
      const pnlColor = pnl >= 0 ? 'var(--volume)' : 'var(--ask)';
      const borderStyle = isUtil ? ` style="border-left-color:${this.agentColor(a.id)}"` : '';
      // Subtitle is one of the three risk preferences for utility
      // agents, or a human-readable role for classic agents. The
      // strategy-cube code (U3, F1, …) is intentionally dropped here
      // because the #N prefix on displayName already carries the slot
      // number, and the full risk-mode label is easier to scan than
      // the cube notation.
      const subtitle = isUtil
        ? (UI._riskLabel[a.riskPref] || a.riskPref)
        : (UI._typeLabel[a.type] || a.type);
      const subtitleKey = isUtil
        ? UI._riskSym[a.riskPref]
        : UI._typeSym[a.type];
      const subtitleSym = (subtitleKey && window.Sym) ? window.Sym[subtitleKey] : '';
      const sym = window.Sym || {};
      const displayName = a.name || ('A' + a.id);
      // Only the live-updating numeric values. The agent's risk label
      // already sits in the subtitle, so repeating it in the metrics
      // block would look inconsistent with the single-label rule.
      const extraRows = isUtil ? `
          <span class="metric">Subj V <span class="sym">${sym.subjV || ''}</span></span> <span class="metric-val">${a.subjectiveValuation != null ? a.subjectiveValuation.toFixed(1) : '—'}</span>
          <span class="metric">Report <span class="sym">${sym.reportV || ''}</span></span> <span class="metric-val">${a.reportedValuation != null ? a.reportedValuation.toFixed(1) : '—'}</span>` : '';

      const cashCell = editable
        ? `<input class="endow-input" type="number" min="0" step="10"
                  data-agent-id="${a.id}" data-field="cash"
                  value="${a.cash.toFixed(0)}">`
        : a.cash.toFixed(0);
      const invCell = editable
        ? `<input class="endow-input" type="number" min="0" step="1"
                  data-agent-id="${a.id}" data-field="inventory"
                  value="${a.inventory}">`
        : a.inventory;

      return `
        <div class="agent-card ${a.type}"${borderStyle}>
          <div class="agent-header">
            <div class="agent-head-left">
              <div class="agent-name">${displayName}</div>
              <div class="agent-type">${subtitle}${subtitleSym ? ` <span class="sym">${subtitleSym}</span>` : ''}</div>
            </div>
            <div class="agent-head-right">
              <span class="last-action ${action}">${action}</span>
              <span class="sym action-sym">${sym.action || ''}</span>
            </div>
          </div>
          <div class="metrics">
            <span class="metric">Cash <span class="sym">${sym.cash || ''}</span></span>    <span class="metric-val">${cashCell}</span>
            <span class="metric">Shares <span class="sym">${sym.shares || ''}</span></span>  <span class="metric-val">${invCell}</span>
            <span class="metric">Wealth <span class="sym">${sym.wealth || ''}</span></span>  <span class="metric-val">${wealth.toFixed(0)}</span>
            <span class="metric">P&amp;L <span class="sym">${sym.pnl || ''}</span></span> <span class="metric-val" style="color:${pnlColor}">${pnlStr}</span>${extraRows}
          </div>
        </div>`;
    }).join('');
    this.els.agentsGrid.innerHTML = html;

    if (editable) this._wireEndowmentInputs();
  },

  /**
   * Bind change handlers to the inline endowment inputs so edits are
   * committed through App.updateEndowment. Called every render while
   * in the pre-run preview stage since the grid HTML is replaced.
   */
  _wireEndowmentInputs() {
    const inputs = this.els.agentsGrid.querySelectorAll('.endow-input');
    inputs.forEach(inp => {
      inp.addEventListener('change', e => {
        const id    = Number(e.target.dataset.agentId);
        const field = e.target.dataset.field;
        const val   = Number(e.target.value);
        if (window.App && typeof window.App.updateEndowment === 'function') {
          window.App.updateEndowment(id, field, val);
        }
      });
      // Prevent Enter from bubbling up to any global keybindings;
      // commit the change on Enter instead of waiting for blur.
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      });
    });
  },

  /**
   * Toggle a small pre-run status label on the agents panel header.
   * Separated out so renderAgents stays readable.
   */
  _toggleAgentStageLabel(on) {
    const h = document.querySelector('.panel-agents .agents-header .stage-label');
    if (!h) return;
    h.textContent = on
      ? 'Pre-run draft · editable before the simulation starts'
      : 'Running · live state';
    h.classList.toggle('live', !on);
  },

  /* -------- Trade feed (trades + dividend events) -------- */

  renderFeed(v) {
    const items = [];
    for (const t of v.trades) items.push({ kind: 'trade',    tick: t.timestamp, t });
    for (const e of v.events) {
      if (e.type === 'dividend') items.push({ kind: 'dividend', tick: e.tick, e });
    }
    items.sort((a, b) => b.tick - a.tick);

    // Slice to however many rows actually fit in the current panel
    // height. The feed panel stretches vertically to match the Agents
    // sibling, so the row count has to track that dynamically instead
    // of being hard-coded. Row height is the CSS padding + font-size +
    // border (≈ 23px); fall back to 24 rows on the first paint when
    // clientHeight hasn't been laid out yet.
    const rowH = 23;
    const avail = this.els.tradeFeed.clientHeight || (rowH * 24);
    const rows  = Math.max(8, Math.floor(avail / rowH));
    const recent = items.slice(0, rows);
    if (!recent.length) { this.els.tradeFeed.innerHTML = '<li class="muted">no activity yet</li>'; return; }

    this.els.tradeFeed.innerHTML = recent.map(r => {
      if (r.kind === 'trade') {
        const t = r.t;
        const buyer  = v.agents[t.buyerId]?.name  || t.buyerId;
        const seller = v.agents[t.sellerId]?.name || t.sellerId;
        return `<li>
          <span class="t-tick">t${t.timestamp}</span>
          <span class="t-price">$${t.price.toFixed(2)}</span>
          <span class="t-agents">${buyer} ← ${seller}</span>
        </li>`;
      }
      return `<li class="feed-dividend">
        <span class="t-tick">t${r.e.tick}</span>
        <span class="t-price">DIV $${r.e.value.toFixed(0)}</span>
        <span class="t-agents">Period ${r.e.period} · all holders</span>
      </li>`;
    }).join('');
  },

  /* -------- Price vs FV chart -------- */

  renderPriceChart(v, config) {
    const { ctx, width, height } = this.charts.price;
    Viz.clear(ctx, width, height);
    // padL 44: y-tick numerics only. padB 38: tick row + "Period t" label.
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const maxFV      = config.dividendMean * config.periods;
    const priceMax   = Math.max(
      maxFV * 1.3,
      ...v.priceHistory.map(p => p.price || 0),
    );
    const xMin = 0, xMax = totalTicks;
    const yMin = 0, yMax = Math.max(10, priceMax * 1.05);

    // Alternating period bands for visual separation.
    for (let p = 1; p <= config.periods; p++) {
      if (p % 2 === 0) {
        const x1 = Viz.mapX(rect, (p - 1) * config.ticksPerPeriod, xMin, xMax);
        const x2 = Viz.mapX(rect,  p      * config.ticksPerPeriod, xMin, xMax);
        Viz.verticalBand(ctx, rect, x1, x2, this.theme.band);
      }
    }

    Viz.axes(ctx, rect, {
      xMin, xMax, yMin, yMax,
      xTicks: config.periods, yTicks: 5,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });

    // Deterministic FV step line — FV_t = (T − t + 1)·μ_d.
    const fvPoints = [];
    for (let p = 1; p <= config.periods; p++) {
      const fv = config.dividendMean * (config.periods - p + 1);
      fvPoints.push({ x: (p - 1) * config.ticksPerPeriod, y: fv });
      fvPoints.push({ x:  p      * config.ticksPerPeriod, y: fv });
    }
    Viz.line(ctx, rect, fvPoints, { xMin, xMax, yMin, yMax, color: this.theme.amber, width: 2, dashed: true });

    // Observed price line P_t (null-aware breaks).
    const pricePoints = v.priceHistory.map(p => ({ x: p.tick, y: p.price }));
    Viz.line(ctx, rect, pricePoints, { xMin, xMax, yMin, yMax, color: this.theme.accent, width: 2 });

    // Individual trade prints — one dot per executed trade.
    ctx.save();
    ctx.fillStyle = this.theme.accent;
    for (const t of v.trades) {
      const x = Viz.mapX(rect, t.timestamp, xMin, xMax);
      const y = Viz.mapY(rect, t.price,     yMin, yMax);
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');

    Viz.legendRow(ctx, rect, [
      { color: this.theme.accent, label: '● observed price' },
      { color: this.theme.amber,  label: '▬ fundamental value' },
    ]);
  },

  /* -------- Bubble magnitude chart -------- */

  renderBubbleChart(v, config) {
    const { ctx, width, height } = this.charts.bubble;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const pts = v.priceHistory.map(p => ({
      x: p.tick,
      y: p.price != null ? Math.abs(p.price - p.fv) : null,
    }));
    const ys   = pts.filter(p => p.y != null).map(p => p.y);
    const yMax = Math.max(10, ...(ys.length ? ys : [10])) * 1.1;
    const yMin = 0;

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin, yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });
    Viz.area(ctx, rect, pts, { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.theme.red + '30' });
    Viz.line(ctx, rect, pts, { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.theme.red, width: 2 });

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
    Viz.legendRow(ctx, rect, [
      { color: this.theme.red, label: '▬ absolute mispricing' },
    ]);
  },

  /* -------- Volume-per-period chart -------- */

  renderVolumeChart(v, config) {
    const { ctx, width, height } = this.charts.volume;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    // Share the totalTicks coordinate frame with the price and bubble
    // charts so all three row-1 figures anchor periods to the same
    // horizontal positions.
    const totalTicks = config.periods * config.ticksPerPeriod;
    const xMin = 0, xMax = totalTicks;

    const pts = [];
    for (let p = 1; p <= config.periods; p++) {
      pts.push({
        x: (p - 0.5) * config.ticksPerPeriod,
        y: v.volumeByPeriod[p] || 0,
      });
    }
    const yMax = Math.max(4, ...pts.map(p => p.y)) * 1.1;

    // Alternating period bands — same pattern used by renderPriceChart.
    for (let p = 1; p <= config.periods; p++) {
      if (p % 2 === 0) {
        const x1 = Viz.mapX(rect, (p - 1) * config.ticksPerPeriod, xMin, xMax);
        const x2 = Viz.mapX(rect,  p      * config.ticksPerPeriod, xMin, xMax);
        Viz.verticalBand(ctx, rect, x1, x2, this.theme.band);
      }
    }

    Viz.axes(ctx, rect, {
      xMin, xMax, yMin: 0, yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });

    const barW = (rect.w / config.periods) * 0.55;
    Viz.bars(ctx, rect, pts, {
      xMin, xMax, yMin: 0, yMax,
      color: this.theme.green,
      barWidth: barW,
    });

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
    Viz.legendRow(ctx, rect, [
      { color: this.theme.green, label: '▮ shares traded' },
    ]);
  },

  /* -------- Price × period trade-density heatmap -------- */

  renderHeatmapChart(v, config) {
    const { ctx, width, height } = this.charts.heatmap;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const maxFV    = config.dividendMean * config.periods;
    const maxPrice = Math.max(maxFV * 1.4, ...v.trades.map(t => t.price || 0));
    const nCols    = config.periods;
    const nRows    = 10;
    const grid     = Array.from({ length: nRows }, () => new Array(nCols).fill(0));
    let maxCount   = 0;
    for (const t of v.trades) {
      const col = Math.min(nCols - 1, Math.max(0, t.period - 1));
      const row = Math.min(nRows - 1, Math.floor((t.price / maxPrice) * nRows));
      grid[row][col] += t.quantity;
      if (grid[row][col] > maxCount) maxCount = grid[row][col];
    }

    const cellW = rect.w / nCols;
    const cellH = rect.h / nRows;

    if (maxCount > 0) {
      for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < nCols; c++) {
          const count = grid[r][c];
          if (count <= 0) continue;
          ctx.fillStyle = Viz.heatColor(count / maxCount);
          const x = rect.x + c * cellW;
          const y = rect.y + (nRows - 1 - r) * cellH;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        }
      }
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Price axis labels (left)
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= nRows; r += 2) {
      const val = (r / nRows) * maxPrice;
      const y   = rect.y + (nRows - r) * cellH;
      ctx.fillText(val.toFixed(0), rect.x - 5, y);
    }
    // Period labels (bottom)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let p = 1; p <= nCols; p++) {
      const x = rect.x + (p - 0.5) * cellW;
      ctx.fillText('P' + p, x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* -------- Agent action timeline -------- */

  renderTimelineChart(v, config) {
    const { ctx, width, height } = this.charts.timeline;
    Viz.clear(ctx, width, height);
    // padL 66: wide enough for the longest agent name (e.g. "Quinn").
    const rect = Viz.plotRect(width, height, 66, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const ids        = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA         = Math.max(1, ids.length);
    const rowH       = rect.h / nA;

    // Row backgrounds + names.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    for (let i = 0; i < nA; i++) {
      const y = rect.y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = this.theme.stripe;
        ctx.fillRect(rect.x, y, rect.w, rowH);
      }
      ctx.fillStyle = this.theme.fg3;
      ctx.fillText(v.agents[ids[i]]?.name || ('A' + ids[i]), rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators.
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    for (let p = 1; p < config.periods; p++) {
      const x = Viz.mapX(rect, p * config.ticksPerPeriod, 0, totalTicks);
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    ctx.restore();

    // One rect per agent decision, colored by action type.
    const colors = { bid: this.theme.green, ask: this.theme.red, hold: this.theme.fg3 };
    const mW     = Math.max(1.6, (rect.w / totalTicks) * 0.85);

    for (const tr of v.traces) {
      const rowIdx = ids.indexOf(tr.agentId);
      if (rowIdx < 0) continue;
      const x = Viz.mapX(rect, tr.timestamp, 0, totalTicks);
      const y = rect.y + rowIdx * rowH + rowH * 0.28;
      const h = rowH * 0.44;
      ctx.fillStyle = colors[tr.decision.type] || this.theme.fg3;
      ctx.fillRect(x - mW / 2, y, mW, h);
      if (tr.filled > 0) {
        ctx.fillStyle = this.theme.accent;
        ctx.beginPath();
        ctx.arc(x, y + h + 3, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // X labels (period markers).
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let p = 1; p <= config.periods; p++) {
      const x = Viz.mapX(rect, (p - 0.5) * config.ticksPerPeriod, 0, totalTicks);
      ctx.fillText('P' + p, x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* ============================================================
     Extended panels (utility experiment mode).
     Each panel is a no-op when its canvas is missing/hidden or
     when the required data array is empty — legacy populations
     render nothing from these methods.
     ============================================================ */

  /* -------- Valuation chart: true vs reported over time -------- */
  renderValuationChart(v, config) {
    const chart = this.charts.valuation;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const hist       = v.valuationHistory || [];
    const byAgent    = {};
    for (const row of hist) {
      if (!byAgent[row.agentId]) byAgent[row.agentId] = [];
      byAgent[row.agentId].push({ x: row.tick, y: row.subjV });
    }

    let yMax = config.dividendMean * config.periods * 1.4;
    for (const row of hist) {
      if (row.subjV != null && row.subjV > yMax) yMax = row.subjV;
    }
    if (v.messages && v.messages.length) {
      for (const m of v.messages) {
        if (m.claimedValuation > yMax) yMax = m.claimedValuation;
      }
    }
    yMax = Math.max(10, yMax * 1.08);

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin: 0, yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });

    // Dashed FV reference step line.
    const fvPoints = [];
    for (let p = 1; p <= config.periods; p++) {
      const fv = config.dividendMean * (config.periods - p + 1);
      fvPoints.push({ x: (p - 1) * config.ticksPerPeriod, y: fv });
      fvPoints.push({ x:  p      * config.ticksPerPeriod, y: fv });
    }
    Viz.line(ctx, rect, fvPoints, { xMin: 0, xMax: totalTicks, yMin: 0, yMax, color: this.theme.amber, width: 2, dashed: true });

    // One subjective-valuation line per agent.
    const ids = Object.keys(byAgent).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      Viz.line(ctx, rect, byAgent[id], { xMin: 0, xMax: totalTicks, yMin: 0, yMax, color: this.agentColor(id), width: 1.6 });
    }

    // Reported-valuation markers. Deceptive messages are ringed red
    // and connected to the sender's true valuation by a dotted line,
    // so you can see the "lie gap" directly.
    const msgs = v.messages || [];
    if (msgs.length) {
      ctx.save();
      for (const m of msgs) {
        const x     = Viz.mapX(rect, m.tick, 0, totalTicks);
        const yRep  = Viz.mapY(rect, m.claimedValuation, 0, yMax);
        ctx.fillStyle = this.agentColor(m.senderId);
        ctx.beginPath(); ctx.arc(x, yRep, 3, 0, Math.PI * 2); ctx.fill();
        if (m.deceptive) {
          const yTrue = Viz.mapY(rect, m.trueValuation, 0, yMax);
          ctx.strokeStyle = this.theme.red;
          ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(x, yRep); ctx.lineTo(x, yTrue); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = this.theme.red;
          ctx.beginPath(); ctx.arc(x, yRep, 5, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Legend row. Each entry's horizontal advance is measured from the
    // rendered text so longer agent names can't overlap the next label.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const gap = 12;
    const y   = rect.y + 12;
    let legendX = rect.x + 10;
    const drawEntry = (label, color) => {
      ctx.fillStyle = color;
      ctx.fillText(label, legendX, y);
      legendX += ctx.measureText(label).width + gap;
    };
    drawEntry('▬ FVₜ', this.theme.amber);
    drawEntry('▬ V̂ᵢ,ₜ', this.theme.fg2);
    for (const id of ids) {
      const name = v.agents[id] ? v.agents[id].name : 'U' + id;
      drawEntry('● ' + name, this.agentColor(id));
    }
    drawEntry('○ Ṽ ≠ V̂  (lie gap)', this.theme.red);
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* -------- Utility-over-time chart -------- */
  renderUtilityChart(v, config) {
    const chart = this.charts.utility;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const hist       = v.utilityHistory || [];
    const byAgent    = {};
    for (const row of hist) {
      if (!byAgent[row.agentId]) byAgent[row.agentId] = [];
      byAgent[row.agentId].push({ x: row.tick, y: row.utility });
    }

    let yMin = 0.7, yMax = 1.3;
    for (const row of hist) {
      if (row.utility != null) {
        if (row.utility < yMin) yMin = row.utility;
        if (row.utility > yMax) yMax = row.utility;
      }
    }
    const span = Math.max(0.2, yMax - yMin);
    yMin = Math.max(0, yMin - span * 0.1);
    yMax = yMax + span * 0.1;

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin, yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(2),
    });

    // Baseline at U = 1.0 (each agent's initial utility).
    const baseY = Viz.mapY(rect, 1, yMin, yMax);
    ctx.save();
    ctx.strokeStyle = this.theme.fg3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(rect.x, baseY); ctx.lineTo(rect.x + rect.w, baseY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const ids = Object.keys(byAgent).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      Viz.line(ctx, rect, byAgent[id], { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.agentColor(id), width: 1.6 });
    }

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* -------- Messages timeline -------- */
  renderMessagesChart(v, config) {
    const chart = this.charts.messages;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 66, 14, 16, 38);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const ids        = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA         = Math.max(1, ids.length);
    const rowH       = rect.h / nA;

    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    for (let i = 0; i < nA; i++) {
      const y = rect.y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = this.theme.stripe;
        ctx.fillRect(rect.x, y, rect.w, rowH);
      }
      ctx.fillStyle = this.agentColor(ids[i]);
      const name = v.agents[ids[i]] ? v.agents[ids[i]].name : 'U' + ids[i];
      ctx.fillText(name, rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators.
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    for (let p = 1; p < config.periods; p++) {
      const x = Viz.mapX(rect, p * config.ticksPerPeriod, 0, totalTicks);
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); ctx.stroke();
    }
    ctx.restore();

    // Messages: one dot per broadcast, colored by signal, ringed red if deceptive.
    const msgs = v.messages || [];
    for (const m of msgs) {
      const rowIdx = ids.indexOf(m.senderId);
      if (rowIdx < 0) continue;
      const x = Viz.mapX(rect, m.tick, 0, totalTicks);
      const y = rect.y + rowIdx * rowH + rowH / 2;
      const sigColor = m.signal === 'buy' ? this.theme.green
                     : m.signal === 'sell' ? this.theme.red
                     : this.theme.fg2;
      ctx.fillStyle = sigColor;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (m.deceptive) {
        ctx.strokeStyle = this.theme.red;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // X labels.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let p = 1; p <= config.periods; p++) {
      const x = Viz.mapX(rect, (p - 0.5) * config.ticksPerPeriod, 0, totalTicks);
      ctx.fillText('P' + p, x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* -------- Trust matrix heatmap -------- */
  renderTrustChart(v, config) {
    const chart = this.charts.trust;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 66, 12, 14, 44);

    const agentIds = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const n = agentIds.length;
    if (!n) return;

    const cellW = rect.w / n;
    const cellH = rect.h / n;
    const trust = v.trust || null;

    for (let i = 0; i < n; i++) {          // i = receiver (row)
      for (let j = 0; j < n; j++) {        // j = sender   (col)
        const r = agentIds[i];
        const s = agentIds[j];
        const val = trust && trust[r] && trust[r][s] != null ? trust[r][s] : 0.5;
        const x = rect.x + j * cellW;
        const y = rect.y + i * cellH;
        if (r === s) {
          ctx.fillStyle = this.theme.stripe;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        } else {
          ctx.fillStyle = Viz.heatColor(val);
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
          if (cellW > 24 && cellH > 18) {
            ctx.fillStyle = this.theme.fg0;
            ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(val.toFixed(2), x + cellW / 2, y + cellH / 2);
          }
        }
      }
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Axis labels.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const name = v.agents[agentIds[i]] ? v.agents[agentIds[i]].name : 'U' + agentIds[i];
      ctx.fillText(name, rect.x - 4, rect.y + i * cellH + cellH / 2);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let j = 0; j < n; j++) {
      const name = v.agents[agentIds[j]] ? v.agents[agentIds[j]].name : 'U' + agentIds[j];
      ctx.fillText(name, rect.x + j * cellW + cellW / 2, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'sender', 'bottom');
  },

  /* -------- Ownership over time (stacked) -------- */
  renderOwnershipChart(v, config) {
    const chart = this.charts.ownership;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    // padT 28 leaves room for the in-plot legend row above the chart.
    const rect = Viz.plotRect(width, height, 44, 14, 28, 38);

    const totalTicks  = config.periods * config.ticksPerPeriod;
    const ids         = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const n           = ids.length;
    if (!n) return;

    // Reconstruct per-tick inventory by replaying trades.
    // Starting inventory is whatever each agent's initial inventory is
    // — here always 3, giving totalShares = n * 3.
    const initialInv  = 3;
    const totalShares = n * initialInv;
    const yMax        = Math.max(totalShares, totalShares + 2);

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin: 0, yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });

    // Build inv[tick][id] by walking through trades in order.
    const invByTick = new Array(totalTicks + 1);
    const start = {};
    for (const id of ids) start[id] = initialInv;
    invByTick[0] = start;
    let tIdx = 0;
    const sortedTrades = v.trades;   // already append-order
    for (let tick = 1; tick <= totalTicks; tick++) {
      const cur = {};
      const prev = invByTick[tick - 1];
      for (const id of ids) cur[id] = prev[id];
      while (tIdx < sortedTrades.length && sortedTrades[tIdx].timestamp <= tick) {
        const t = sortedTrades[tIdx];
        if (cur[t.buyerId]  != null) cur[t.buyerId]  += t.quantity;
        if (cur[t.sellerId] != null) cur[t.sellerId] -= t.quantity;
        tIdx++;
      }
      invByTick[tick] = cur;
    }

    const series = ids.map(id => ({
      color: this.agentColor(id),
      name:  v.agents[id] ? v.agents[id].name : 'U' + id,
      points: invByTick.map((m, tick) => ({ x: tick, y: Math.max(0, m[id] || 0) })),
    }));
    Viz.stackedArea(ctx, rect, series, { xMin: 0, xMax: totalTicks, yMin: 0, yMax });

    // Inline legend above the plot. Per-entry advance is measured
    // from the rendered name so long names can't overlap.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const swatch = 10;
    const gap    = 14;
    let legendX = rect.x + 4;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, rect.y - 16, swatch, swatch);
      ctx.fillStyle = this.theme.fg0;
      ctx.fillText(s.name, legendX + swatch + 3, rect.y - 10);
      legendX += swatch + 3 + ctx.measureText(s.name).width + gap;
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'Period t', 'bottom');
  },

  /* -------- Extended metrics panel -------- */
  renderMetrics(v, config) {
    const el = this.els.metricsBody;
    if (!el) return;

    const hasExtended = (v.valuationHistory && v.valuationHistory.length) ||
                        (v.utilityHistory && v.utilityHistory.length);
    if (!hasExtended) {
      el.innerHTML = '<div class="muted">Select the Utility population to see extended metrics.</div>';
      return;
    }

    // ---- Dufwenberg, Lindqvist & Moore (2005) market-quality statistics.
    // All of these operate on the per-period mean trade price P̄_t and the
    // deterministic fundamental value FV_t = (T − t + 1)·μ_d. We reconstruct
    // P̄_t from v.trades grouped by trade.period.
    const sumByPeriod = {}, cntByPeriod = {};
    for (const t of v.trades) {
      sumByPeriod[t.period] = (sumByPeriod[t.period] || 0) + t.price;
      cntByPeriod[t.period] = (cntByPeriod[t.period] || 0) + 1;
    }
    const meanP = new Array(config.periods + 1).fill(null);
    for (let p = 1; p <= config.periods; p++) {
      if (cntByPeriod[p]) meanP[p] = sumByPeriod[p] / cntByPeriod[p];
    }
    const fvOf = p => config.dividendMean * (config.periods - p + 1);

    // Total shares outstanding (conserved under double-auction trades).
    let totalShares = 0;
    for (const a of Object.values(v.agents)) totalShares += (a.inventory || 0);

    // Haessel (1978) R²: 1 − Σ(P̄_t − FV_t)² / Σ(P̄_t − mean P̄)². Uses only
    // periods that had trades. Can be negative if the fit is worse than
    // predicting the sample mean of P̄.
    let haessel = null;
    {
      const obs = [];
      for (let p = 1; p <= config.periods; p++) {
        if (meanP[p] != null) obs.push({ y: meanP[p], x: fvOf(p) });
      }
      if (obs.length >= 2) {
        const ybar = obs.reduce((s, c) => s + c.y, 0) / obs.length;
        let ssRes = 0, ssTot = 0;
        for (const o of obs) {
          ssRes += (o.y - o.x) ** 2;
          ssTot += (o.y - ybar) ** 2;
        }
        if (ssTot > 0) haessel = 1 - ssRes / ssTot;
      }
    }

    // Normalized absolute price deviation:
    // Σ_trades |P_trade − FV_period| · q / total shares outstanding.
    let normAbsDev = null;
    if (totalShares > 0 && v.trades.length) {
      let s = 0;
      for (const t of v.trades) s += Math.abs(t.price - fvOf(t.period)) * t.quantity;
      normAbsDev = s / totalShares;
    }

    // Normalized average price deviation:
    // Σ_periods |P̄_t − FV_t| / total shares outstanding.
    let normAvgDev = null;
    if (totalShares > 0) {
      let s = 0;
      for (let p = 1; p <= config.periods; p++) {
        if (meanP[p] != null) s += Math.abs(meanP[p] - fvOf(p));
      }
      normAvgDev = s / totalShares;
    }

    // Price amplitude: (max (P̄_t − FV_t) − min (P̄_t − FV_t)) / FV_1.
    let amplitude = null;
    {
      const diffs = [];
      for (let p = 1; p <= config.periods; p++) {
        if (meanP[p] != null) diffs.push(meanP[p] - fvOf(p));
      }
      const fv1 = fvOf(1);
      if (diffs.length && fv1 > 0) amplitude = (Math.max(...diffs) - Math.min(...diffs)) / fv1;
    }

    // Turnover: Σ q_traded / total shares outstanding. Standard SSW
    // measure of churn — 1.0 means every share changed hands once.
    let turnover = null;
    if (totalShares > 0) {
      let sharesTraded = 0;
      for (const t of v.trades) sharesTraded += t.quantity;
      turnover = sharesTraded / totalShares;
    }

    // Lopez-Lira (2025) price-to-fundamental ratio ρ = P / FV.
    let rho = null;
    if (v.lastPrice != null && v.priceHistory.length) {
      const lastFV = v.priceHistory[v.priceHistory.length - 1].fv;
      if (lastFV > 0) rho = v.lastPrice / lastFV;
    }

    // ---- Extended (Utility-mode) aggregates.
    const latestV = {};
    for (const row of v.valuationHistory) latestV[row.agentId] = row.subjV;
    const Vlist = Object.entries(latestV).map(([id, vv]) => ({ id: Number(id), vv }));
    const avgV  = Vlist.length ? Vlist.reduce((s, c) => s + c.vv, 0) / Vlist.length : null;

    let efficiency = null;
    if (Vlist.length) {
      let maxVV = -Infinity;
      for (const c of Vlist) if (c.vv > maxVV) maxVV = c.vv;
      let actual = 0;
      for (const c of Vlist) {
        const agent = v.agents[c.id];
        if (agent) actual += c.vv * (agent.inventory || 0);
      }
      const optimal = maxVV * totalShares;
      efficiency = optimal > 0 ? actual / optimal : 0;
    }

    let totalWelfare = null;
    const latestU = {};
    for (const row of v.utilityHistory) latestU[row.agentId] = row.utility;
    const uvals = Object.values(latestU);
    if (uvals.length) totalWelfare = uvals.reduce((s, x) => s + x, 0);

    const pDev = (v.lastPrice != null && avgV != null) ? Math.abs(v.lastPrice - avgV) : null;

    let deceptionMag = null;
    let nDeceptive = 0;
    const msgs = v.messages || [];
    if (msgs.length) {
      let total = 0;
      for (const m of msgs) {
        total += Math.abs(m.claimedValuation - m.trueValuation);
        if (m.deceptive) nDeceptive++;
      }
      deceptionMag = total / msgs.length;
    }

    const fmt = (x, d = 2) => x == null ? '—' : x.toFixed(d);
    const sym = window.Sym || {};
    el.innerHTML = `
      <div class="metric-group-label">Market quality · Dufwenberg, Lindqvist &amp; Moore (2005)</div>
      <div class="metric-row"><span>Haessel R²&nbsp;&nbsp;<em>1 − Σ(P̄−FV)² / Σ(P̄−P̄̄)²</em></span><strong>${fmt(haessel, 3)}</strong></div>
      <div class="metric-row"><span>Norm. absolute price deviation&nbsp;&nbsp;<em>Σ|P−FV|·q / Q</em></span><strong>${fmt(normAbsDev, 2)}</strong></div>
      <div class="metric-row"><span>Norm. average price deviation&nbsp;&nbsp;<em>${sym.normAvgDev || ''}</em></span><strong>${fmt(normAvgDev, 2)}</strong></div>
      <div class="metric-row"><span>Price amplitude&nbsp;&nbsp;<em>(max−min)(P̄−FV) / FV₁</em></span><strong>${fmt(amplitude, 3)}</strong></div>
      <div class="metric-row"><span>Turnover&nbsp;&nbsp;<em>Σ q / Q</em></span><strong>${fmt(turnover, 3)}</strong></div>
      <div class="metric-row"><span>P / FV ratio&nbsp;&nbsp;<em>${sym.rhoT || ''} &nbsp;(Lopez-Lira 2025)</em></span><strong>${fmt(rho, 3)}</strong></div>

      <div class="metric-group-label">Utility-agent welfare &amp; deception</div>
      <div class="metric-row"><span>Avg subjective V̂&nbsp;&nbsp;<em>${sym.avgVbar || ''}</em></span><strong>${fmt(avgV)}</strong></div>
      <div class="metric-row"><span>Allocative efficiency&nbsp;&nbsp;<em>${sym.efficiencyEq || ''}</em></span><strong>${fmt(efficiency, 3)}</strong></div>
      <div class="metric-row"><span>Total welfare&nbsp;&nbsp;<em>${sym.totalWelfareEq || ''}</em></span><strong>${fmt(totalWelfare, 3)}</strong></div>
      <div class="metric-row"><span>|P − ⟨V̂⟩|</span><strong>${fmt(pDev)}</strong></div>
      <div class="metric-row"><span>Mean lie magnitude&nbsp;&nbsp;<em>⟨${sym.lieGap || ''}⟩</em></span><strong>${fmt(deceptionMag)}</strong></div>
      <div class="metric-row"><span>Deceptive / total msgs</span><strong>${nDeceptive} / ${msgs.length}</strong></div>
    `;
  },

  /* -------- Trace inspector -------- */

  renderTraces(v) {
    const tick   = v.tick;
    const traces = v.traces.filter(t => t.timestamp === tick);
    if (!traces.length) {
      this.els.traceBody.innerHTML =
        `<div class="muted">No decisions recorded at tick ${tick}.</div>`;
      return;
    }
    this.els.traceBody.innerHTML = traces.map(t => {
      const d         = t.decision;
      const r         = t.reasoning;
      const kind      = d.type;
      const valStr    = r.estimatedValue != null ? r.estimatedValue.toFixed(2) : '—';
      const profitStr = r.expectedProfit != null ? r.expectedProfit.toFixed(2) : '—';
      const priceStr  = d.price          != null ? d.price.toFixed(2)          : '—';
      const qtyStr    = d.quantity       != null ? d.quantity                  : '—';
      const agentName = t.agentName || ('A' + t.agentId);
      const kindLabel = kind === 'hold'
        ? 'hold'
        : `${kind} ${qtyStr} @ ${priceStr}${t.filled ? ' ✓' : ''}`;

      // Extended: expected-utility candidate table.
      const u = r.utility;
      const uBlock = u ? `
          <div class="trace-row">subj V <strong>${u.subjectiveValue != null ? u.subjectiveValue.toFixed(2) : '—'}</strong> <span class="muted">(true ${u.trueValuation != null ? u.trueValuation.toFixed(2) : '—'})</span></div>
          <div class="trace-row">w₀ <strong>${u.wealth0 != null ? u.wealth0.toFixed(0) : '—'}</strong> · U₀ <strong>${u.U0 != null ? u.U0.toFixed(3) : '—'}</strong> <span class="muted">(${u.riskPref})</span></div>
          <div class="trace-eu">
            ${(u.candidates || []).map(c => `
              <div class="eu-row${c.label === u.chosen ? ' chosen' : ''}">
                <span class="eu-lbl">${c.label}</span>
                <span class="eu-val">${c.eu.toFixed(4)}</span>
              </div>`).join('')}
          </div>` : '';

      // Extended: messages heard this period.
      const msgBlock = (r.receivedMsgs && r.receivedMsgs.length)
        ? `<div class="trace-row muted">heard ${r.receivedMsgs.map(m => `${m.from}:${m.claim.toFixed(0)}(${m.sig})`).join(', ')}</div>`
        : '';

      return `
        <div class="trace-card">
          <div class="trace-head">
            <span>${agentName} <span class="muted">· ${t.agentType}</span></span>
            <span class="trace-kind ${kind}">${kindLabel}</span>
          </div>
          <div class="trace-row">rule <strong>${r.ruleUsed}</strong></div>
          <div class="trace-row">trigger <strong>${r.triggerCondition || '—'}</strong></div>
          <div class="trace-row">est value <strong>${valStr}</strong> · E[π] <strong>${profitStr}</strong></div>
          <div class="trace-row">cash <strong>${t.state.cash.toFixed(0)}</strong> · inv <strong>${t.state.inventory}</strong></div>
          ${uBlock}
          ${msgBlock}
        </div>`;
    }).join('');
  },

  /* -------- Replay slider sync -------- */

  setReplayPosition(tick, total, isLive) {
    this.els.replayPos.textContent = isLive
      ? `Live — tick ${tick}`
      : `Replay — tick ${tick} / ${total}`;
    this.els.replaySlider.max = Math.max(1, total);
    if (isLive) this.els.replaySlider.value = tick;
  },
};
