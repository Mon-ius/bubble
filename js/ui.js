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

  init() {
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

    this.canvases = {
      price:    document.getElementById('chart-price'),
      bubble:   document.getElementById('chart-bubble'),
      volume:   document.getElementById('chart-volume'),
      timeline: document.getElementById('chart-timeline'),
      heatmap:  document.getElementById('chart-heatmap'),
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
      this.charts[k] = Viz.setupHiDPI(c);
    }
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
    const html = Object.values(v.agents).map(a => {
      const action = a.lastAction || 'hold';
      const wealth = a.cash + a.inventory * v.fv;
      const init   = 1000 + 3 * initialFV;
      const pnl    = wealth - init;
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(0);
      const pnlColor = pnl >= 0 ? 'var(--volume)' : 'var(--ask)';
      return `
        <div class="agent-card ${a.type}">
          <div class="agent-header">
            <div>
              <div class="agent-name">${a.name || ('A' + a.id)}</div>
              <div class="agent-type">${a.type}</div>
            </div>
            <span class="last-action ${action}">${action}</span>
          </div>
          <div class="metrics">
            <span class="metric">Cash</span>   <span class="metric-val">${a.cash.toFixed(0)}</span>
            <span class="metric">Shares</span> <span class="metric-val">${a.inventory}</span>
            <span class="metric">Wealth</span> <span class="metric-val">${wealth.toFixed(0)}</span>
            <span class="metric">P&amp;L</span>   <span class="metric-val" style="color:${pnlColor}">${pnlStr}</span>
          </div>
        </div>`;
    }).join('');
    this.els.agentsGrid.innerHTML = html;
  },

  /* -------- Trade feed (trades + dividend events) -------- */

  renderFeed(v) {
    const items = [];
    for (const t of v.trades) items.push({ kind: 'trade',    tick: t.timestamp, t });
    for (const e of v.events) {
      if (e.type === 'dividend') items.push({ kind: 'dividend', tick: e.tick, e });
    }
    items.sort((a, b) => b.tick - a.tick);

    const recent = items.slice(0, 24);
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
    const rect = Viz.plotRect(width, height);

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
        Viz.verticalBand(ctx, rect, x1, x2, 'rgba(255,255,255,0.022)');
      }
    }

    Viz.axes(ctx, rect, {
      xMin, xMax, yMin, yMax,
      xTicks: config.periods, yTicks: 5,
      xFmt: x => 'P' + Math.round(x / config.ticksPerPeriod + 1),
      yFmt: y => y.toFixed(0),
    });

    // Deterministic FV step line.
    const fvPoints = [];
    for (let p = 1; p <= config.periods; p++) {
      const fv = config.dividendMean * (config.periods - p + 1);
      fvPoints.push({ x: (p - 1) * config.ticksPerPeriod, y: fv });
      fvPoints.push({ x:  p      * config.ticksPerPeriod, y: fv });
    }
    Viz.line(ctx, rect, fvPoints, { xMin, xMax, yMin, yMax, color: '#ffb347', width: 2, dashed: true });

    // Observed price line (null-aware breaks).
    const pricePoints = v.priceHistory.map(p => ({ x: p.tick, y: p.price }));
    Viz.line(ctx, rect, pricePoints, { xMin, xMax, yMin, yMax, color: '#4fa3ff', width: 2 });

    // Individual trade prints.
    ctx.save();
    ctx.fillStyle = '#4fa3ff';
    for (const t of v.trades) {
      const x = Viz.mapX(rect, t.timestamp, xMin, xMax);
      const y = Viz.mapY(rect, t.price,     yMin, yMax);
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // Legend
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4fa3ff'; ctx.fillText('● Price', rect.x + 10, rect.y + 12);
    ctx.fillStyle = '#ffb347'; ctx.fillText('▬ FV',    rect.x + 74, rect.y + 12);
    ctx.restore();
  },

  /* -------- Bubble magnitude chart -------- */

  renderBubbleChart(v, config) {
    const { ctx, width, height } = this.charts.bubble;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height);

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
    Viz.area(ctx, rect, pts, { xMin: 0, xMax: totalTicks, yMin, yMax, color: 'rgba(255,94,120,0.18)' });
    Viz.line(ctx, rect, pts, { xMin: 0, xMax: totalTicks, yMin, yMax, color: '#ff5e78', width: 2 });
  },

  /* -------- Volume-per-period chart -------- */

  renderVolumeChart(v, config) {
    const { ctx, width, height } = this.charts.volume;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height);

    const pts = [];
    for (let p = 1; p <= config.periods; p++) {
      pts.push({ x: p, y: v.volumeByPeriod[p] || 0 });
    }
    const yMax = Math.max(4, ...pts.map(p => p.y)) * 1.1;

    Viz.axes(ctx, rect, {
      xMin: 0.5, xMax: config.periods + 0.5,
      yMin: 0,   yMax,
      xTicks: config.periods, yTicks: 4,
      xFmt: x => 'P' + Math.round(x),
      yFmt: y => y.toFixed(0),
    });
    const barW = (rect.w / config.periods) * 0.68;
    Viz.bars(ctx, rect, pts, {
      xMin: 0.5, xMax: config.periods + 0.5,
      yMin: 0,   yMax,
      color: 'rgba(126,214,165,0.75)',
      barWidth: barW,
    });
  },

  /* -------- Price × period trade-density heatmap -------- */

  renderHeatmapChart(v, config) {
    const { ctx, width, height } = this.charts.heatmap;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height);

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
    ctx.strokeStyle = '#2a3344';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Price axis labels (left)
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#5a6580';
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
  },

  /* -------- Agent action timeline -------- */

  renderTimelineChart(v, config) {
    const { ctx, width, height } = this.charts.timeline;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 56);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const ids        = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA         = Math.max(1, ids.length);
    const rowH       = rect.h / nA;

    // Row backgrounds + names.
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    for (let i = 0; i < nA; i++) {
      const y = rect.y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fillRect(rect.x, y, rect.w, rowH);
      }
      ctx.fillStyle = '#5a6580';
      ctx.fillText(v.agents[ids[i]]?.name || ('A' + ids[i]), rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = '#2a3344';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let p = 1; p < config.periods; p++) {
      const x = Viz.mapX(rect, p * config.ticksPerPeriod, 0, totalTicks);
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    ctx.restore();

    // One rect per agent decision, colored by action type.
    const colors = { bid: '#2ecc71', ask: '#ff5a5a', hold: '#3b4866' };
    const mW     = Math.max(1.6, (rect.w / totalTicks) * 0.85);

    for (const tr of v.traces) {
      const rowIdx = ids.indexOf(tr.agentId);
      if (rowIdx < 0) continue;
      const x = Viz.mapX(rect, tr.timestamp, 0, totalTicks);
      const y = rect.y + rowIdx * rowH + rowH * 0.28;
      const h = rowH * 0.44;
      ctx.fillStyle = colors[tr.decision.type] || '#555';
      ctx.fillRect(x - mW / 2, y, mW, h);
      if (tr.filled > 0) {
        ctx.fillStyle = '#4fa3ff';
        ctx.beginPath();
        ctx.arc(x, y + h + 3, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // X labels (period markers).
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#5a6580';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let p = 1; p <= config.periods; p++) {
      const x = Viz.mapX(rect, (p - 0.5) * config.ticksPerPeriod, 0, totalTicks);
      ctx.fillText('P' + p, x, rect.y + rect.h + 6);
    }
    ctx.restore();
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
