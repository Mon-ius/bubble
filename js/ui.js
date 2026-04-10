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
    const palette = ['#4fa3ff', '#ffb347', '#7ed6a5', '#ff5e78', '#c792ea', '#ffd166'];
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
      const subtitle = isUtil ? `${a.riskPref} · ${a.deceptionMode}` : a.type;
      const extraRows = isUtil ? `
          <span class="metric">Risk</span>   <span class="metric-val">${a.riskPref}</span>
          <span class="metric">Subj V</span> <span class="metric-val">${a.subjectiveValuation != null ? a.subjectiveValuation.toFixed(1) : '—'}</span>
          <span class="metric">Report</span> <span class="metric-val">${a.reportedValuation != null ? a.reportedValuation.toFixed(1) : '—'}</span>
          <span class="metric">Belief</span> <span class="metric-val">${a.beliefMode}</span>` : '';
      return `
        <div class="agent-card ${a.type}"${borderStyle}>
          <div class="agent-header">
            <div>
              <div class="agent-name">${a.name || ('A' + a.id)}</div>
              <div class="agent-type">${subtitle}</div>
            </div>
            <span class="last-action ${action}">${action}</span>
          </div>
          <div class="metrics">
            <span class="metric">Cash</span>   <span class="metric-val">${a.cash.toFixed(0)}</span>
            <span class="metric">Shares</span> <span class="metric-val">${a.inventory}</span>
            <span class="metric">Wealth</span> <span class="metric-val">${wealth.toFixed(0)}</span>
            <span class="metric">P&amp;L</span>   <span class="metric-val" style="color:${pnlColor}">${pnlStr}</span>${extraRows}
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
    const rect = Viz.plotRect(width, height);

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
    Viz.line(ctx, rect, fvPoints, { xMin: 0, xMax: totalTicks, yMin: 0, yMax, color: '#ffb347', width: 2, dashed: true });

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
          ctx.strokeStyle = '#ff5e78';
          ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(x, yRep); ctx.lineTo(x, yTrue); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = '#ff5e78';
          ctx.beginPath(); ctx.arc(x, yRep, 5, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Legend row.
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb347'; ctx.fillText('▬ FV', rect.x + 10, rect.y + 12);
    let legendX = rect.x + 52;
    for (const id of ids) {
      const name = v.agents[id] ? v.agents[id].name : 'U' + id;
      ctx.fillStyle = this.agentColor(id);
      ctx.fillText('●' + name, legendX, rect.y + 12);
      legendX += 36;
    }
    ctx.fillStyle = '#ff5e78';
    ctx.fillText('○ lie', legendX, rect.y + 12);
    ctx.restore();
  },

  /* -------- Utility-over-time chart -------- */
  renderUtilityChart(v, config) {
    const chart = this.charts.utility;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height);

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
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(rect.x, baseY); ctx.lineTo(rect.x + rect.w, baseY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const ids = Object.keys(byAgent).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      Viz.line(ctx, rect, byAgent[id], { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.agentColor(id), width: 1.6 });
    }
  },

  /* -------- Messages timeline -------- */
  renderMessagesChart(v, config) {
    const chart = this.charts.messages;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 56);

    const totalTicks = config.periods * config.ticksPerPeriod;
    const ids        = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA         = Math.max(1, ids.length);
    const rowH       = rect.h / nA;

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
      ctx.fillStyle = this.agentColor(ids[i]);
      const name = v.agents[ids[i]] ? v.agents[ids[i]].name : 'U' + ids[i];
      ctx.fillText(name, rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = '#2a3344';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
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
      const sigColor = m.signal === 'buy' ? '#2ecc71'
                     : m.signal === 'sell' ? '#ff5a5a'
                     : '#7a8599';
      ctx.fillStyle = sigColor;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (m.deceptive) {
        ctx.strokeStyle = '#ff5e78';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // X labels.
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

  /* -------- Trust matrix heatmap -------- */
  renderTrustChart(v, config) {
    const chart = this.charts.trust;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 52, 12, 14, 48);

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
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        } else {
          ctx.fillStyle = Viz.heatColor(val);
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
          if (cellW > 24 && cellH > 18) {
            ctx.fillStyle = '#0b0f16';
            ctx.font = '10px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(val.toFixed(2), x + cellW / 2, y + cellH / 2);
          }
        }
      }
    }
    ctx.strokeStyle = '#2a3344';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Axis labels.
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#5a6580';
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
    ctx.fillStyle = '#7a8599';
    ctx.fillText('sender →', rect.x + rect.w / 2, rect.y + rect.h + 22);
    ctx.restore();
  },

  /* -------- Ownership over time (stacked) -------- */
  renderOwnershipChart(v, config) {
    const chart = this.charts.ownership;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height);

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

    // Inline legend at the top of the plot.
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    let legendX = rect.x + 8;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, rect.y + 4, 10, 10);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(s.name, legendX + 13, rect.y + 10);
      legendX += 44;
    }
    ctx.restore();
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

    // Latest per-agent subjective valuation.
    const latestV = {};
    for (const row of v.valuationHistory) latestV[row.agentId] = row.subjV;
    const Vlist = Object.entries(latestV).map(([id, vv]) => ({ id: Number(id), vv }));
    const avgV  = Vlist.length ? Vlist.reduce((s, c) => s + c.vv, 0) / Vlist.length : null;

    // Allocative efficiency: ratio of actual Σ V_i·q_i to the optimum
    // where all shares go to the highest-valuation agent.
    let efficiency = null;
    if (Vlist.length) {
      let maxVV = -Infinity, maxId = null;
      for (const c of Vlist) if (c.vv > maxVV) { maxVV = c.vv; maxId = c.id; }
      let totalShares = 0;
      for (const a of Object.values(v.agents)) totalShares += (a.inventory || 0);
      let actual = 0;
      for (const c of Vlist) {
        const agent = v.agents[c.id];
        if (agent) actual += c.vv * (agent.inventory || 0);
      }
      const optimal = maxVV * totalShares;
      efficiency = optimal > 0 ? actual / optimal : 0;
    }

    // Total welfare: sum of current (latest) per-agent normalized utility.
    let totalWelfare = null;
    const latestU = {};
    for (const row of v.utilityHistory) latestU[row.agentId] = row.utility;
    const uvals = Object.values(latestU);
    if (uvals.length) totalWelfare = uvals.reduce((s, x) => s + x, 0);

    // Price deviation from average subjective valuation.
    const pDev = (v.lastPrice != null && avgV != null) ? Math.abs(v.lastPrice - avgV) : null;

    // Deception impact: mean |claim - true| magnitude + count.
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
    el.innerHTML = `
      <div class="metric-row"><span>Avg subjective V</span><strong>${fmt(avgV)}</strong></div>
      <div class="metric-row"><span>Allocative efficiency</span><strong>${fmt(efficiency, 3)}</strong></div>
      <div class="metric-row"><span>Total welfare (ΣU)</span><strong>${fmt(totalWelfare, 3)}</strong></div>
      <div class="metric-row"><span>|P − avgV|</span><strong>${fmt(pDev)}</strong></div>
      <div class="metric-row"><span>Mean lie magnitude</span><strong>${fmt(deceptionMag)}</strong></div>
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
