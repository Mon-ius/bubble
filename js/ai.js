'use strict';

/* ======================================================================
   ai.js — AIPE (AI-Agent Prior Elicitation) endpoint.

   Thin, dependency-free wrapper around the OpenAI /v1/chat/completions
   API, used only by the AIPE paradigm (data-paradigm="wang" retained as
   the internal code key for stability). Reuses the `{endpoint, apiKey,
   model}` shape from the lying project's agent roster and its plain-text
   response contract (no structured JSON, no function calls).

   Flow:

     1. main.js reads the three fields (#ai-key, #ai-endpoint, #ai-model)
        into App.aiConfig on every run start — nothing is persisted to
        localStorage, matching the lying project's deliberately forgetful
        design.

     2. When the paradigm is 'wang' AND the key is non-empty AND the
        current population has at least one Utility agent, App.start()
        fires AI.getPsychAnchors(agents, config, aiCfg) and awaits the
        result before launching the engine loop.

     3. Each Utility agent in the resulting map receives its psychological
        anchor — a single number in [0.25·FV₀, 1.75·FV₀] — which the
        agent writes into `psychAnchor`. On the first decision tick the
        agent seeds `subjectiveValue` from that anchor instead of the
        default `FV · (1 + bias + noise)` prior, so the model's psychology
        shows up in the very first order posted.

     4. Errors, missing keys, or invalid responses fall back to the
        deterministic Lopez-Lira belief model without disturbing the run.
        AIPE must still produce a simulation when the network is
        unavailable, because the paper's research question ("does the
        asset end up with the highest-V̂ agent") is answerable from the
        deterministic path alone — the AI agent only adds a stronger,
        more heterogeneous psychological signal.
   ====================================================================== */

const AI = {
  /**
   * Provider definitions — endpoint, agent-capable models, and default
   * for each supported LLM provider. The UI builds the provider
   * dropdown from PROVIDERS and swaps the model list on change.
   */
  PROVIDERS: {
    openai: {
      label: 'OpenAI ChatGPT',
      endpoint: 'https://openai-20250719-f7491cbb.rootdirectorylab.com/v1/chat/completions',
      keyPlaceholder: 'sk-...',
      models: [
        { id: 'gpt-4o',   label: 'GPT-4o' },
        { id: 'gpt-5.4',  label: 'GPT-5.4' },
      ],
      default: 'gpt-4o',
    },
    gemini: {
      label: 'Google Gemini',
      endpoint: 'https://gemini-20250719-bdb3d11b.rootdirectorylab.com/v1beta',
      keyPlaceholder: 'AIza...',
      models: [
        { id: 'gemini-3-flash-preview',    label: 'Gemini 3 Flash Preview' },
        { id: 'gemini-3.1-pro-preview',    label: 'Gemini 3.1 Pro Preview' },
      ],
      default: 'gemini-3-flash-preview',
    },
    claude: {
      label: 'Anthropic Claude',
      endpoint: 'https://anthropic-20250719-b6006324.rootdirectorylab.com/v1/messages',
      keyPlaceholder: 'sk-ant-...',
      models: [
        { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      ],
      default: 'claude-sonnet-4-6',
    },
  },

  DEFAULT_PROVIDER: 'openai',

  /** Convenience accessors — resolve via the active provider. */
  getProvider(key) {
    return this.PROVIDERS[key] || this.PROVIDERS[this.DEFAULT_PROVIDER];
  },
  getModels(providerKey) { return this.getProvider(providerKey).models; },
  getDefaultModel(providerKey) { return this.getProvider(providerKey).default; },
  getDefaultEndpoint(providerKey) { return this.getProvider(providerKey).endpoint; },
  getKeyPlaceholder(providerKey) { return this.getProvider(providerKey).keyPlaceholder; },

  /**
   * gpt-5 / o3+ / o1+ families require `max_completion_tokens` in
   * place of the legacy `max_tokens` field.
   */
  _usesCompletionTokens(model) {
    return /^(gpt-5|o[3-9]|o[1-9]\d)/.test(model || '');
  },

  /* ---- Provider-specific call implementations ---- */

  async _callOpenAI(cfg, system, prompt) {
    const endpoint  = cfg.endpoint || this.getDefaultEndpoint('openai');
    const model     = cfg.model    || this.getDefaultModel('openai');
    const maxTokens = cfg.maxTokens || 1024;
    const body = {
      model,
      temperature: cfg.temperature ?? 0.4,
      ...(this._usesCompletionTokens(model)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.openai: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('ai.openai: no content');
    return content.trim();
  },

  async _callGemini(cfg, system, prompt) {
    const model     = cfg.model || this.getDefaultModel('gemini');
    const base      = cfg.endpoint || this.getDefaultEndpoint('gemini');
    const endpoint  = `${base.replace(/\/+$/, '')}/models/${model}:generateContent?key=${cfg.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: cfg.temperature ?? 0.4,
        maxOutputTokens: cfg.maxTokens || 1024,
      },
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.gemini: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== 'string') throw new Error('ai.gemini: no content');
    return content.trim();
  },

  async _callClaude(cfg, system, prompt) {
    const endpoint  = cfg.endpoint || this.getDefaultEndpoint('claude');
    const model     = cfg.model    || this.getDefaultModel('claude');
    const body = {
      model,
      max_tokens: cfg.maxTokens || 1024,
      system,
      messages: [{ role: 'user', content: prompt }],
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.claude: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const block = (data?.content || []).find(b => b.type === 'text');
    if (!block || typeof block.text !== 'string') throw new Error('ai.claude: no content');
    return block.text.trim();
  },

  /**
   * Unified call dispatcher — routes to the provider-specific handler
   * based on `cfg.provider`. Falls back to OpenAI format for backwards
   * compatibility when provider is unset.
   */
  async call(cfg, system, prompt) {
    if (!cfg || !cfg.apiKey) throw new Error('ai.call: missing apiKey');
    const provider = cfg.provider || this.DEFAULT_PROVIDER;
    if (provider === 'gemini') return this._callGemini(cfg, system, prompt);
    if (provider === 'claude') return this._callClaude(cfg, system, prompt);
    return this._callOpenAI(cfg, system, prompt);
  },

  /**
   * Parse a psychological valuation out of a free-form AI-agent response.
   * The prompt asks for a single number; in practice models sometimes
   * prefix it with "My valuation is". The regex grabs the first
   * signed decimal and clamps it into [lo, hi] so an out-of-range
   * reply can never destabilize the engine.
   */
  parseValuation(raw, lo, hi) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    if (!Number.isFinite(v)) return null;
    return Math.max(lo, Math.min(hi, v));
  },

  /**
   * Parse an action from the structured LLM response.
   * Expected format: "Reason: ... Action: BUY_NOW"
   */
  _VALID_ACTIONS: ['BUY_NOW', 'SELL_NOW', 'BID_1', 'BID_3', 'ASK_1', 'ASK_3', 'HOLD'],

  parseAction(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/Action\s*:\s*(BUY_NOW|SELL_NOW|BID_1|BID_3|ASK_1|ASK_3|HOLD)/i);
    if (!m) return null;
    const action = m[1].toUpperCase();
    if (!this._VALID_ACTIONS.includes(action)) return null;
    const rm = raw.match(/Reason\s*:\s*(.+?)(?=\nAction|\n*$)/is);
    return { action, reason: rm ? rm[1].trim() : '' };
  },

  /**
   * Fire one chat completion per Utility agent in parallel and return
   * a { [agentId]: anchor } map. Utility agents whose slot is absent
   * from the result (network error, parse failure, missing key) are
   * simply skipped — the caller treats a missing anchor as "fall back
   * to the deterministic prior".
   *
   * The prompt describes the DLM 2005 asset (10 periods, {0,20}¢
   * dividend, FV declining by 10 per period), the AIPE merged
   * market (E agents present alongside U agents), and the single
   * Lopez-Lira risk-preference axis that distinguishes this agent
   * from its peers. The model is asked for a single number, no text
   * — matching the lying project's "output ONLY a number" contract.
   */
  async getPsychAnchors(agents, config, aiCfg) {
    if (!aiCfg || !aiCfg.apiKey) return {};
    const utilityAgents = Object.values(agents).filter(
      a => a && (a.type === 'utility' || a.constructor?.name === 'UtilityAgent')
    );
    if (!utilityAgents.length) return {};

    const fv0         = config.dividendMean * config.periods;
    const periods     = config.periods;
    const dividendAvg = config.dividendMean;
    const lo          = fv0 * 0.25;
    const hi          = fv0 * 1.75;

    const system =
      'You are a trader in a finite-horizon experimental asset market. ' +
      'Respond with ONE number only — your private subjective valuation ' +
      'per share at the start of the run, in experimental cents. No ' +
      'explanation, no currency symbols, no text.';

    const promptFor = (a) => {
      const risk =
        a.riskPref === 'loving'  ? 'risk-loving (convex utility — you enjoy upside)'  :
        a.riskPref === 'averse'  ? 'risk-averse (concave utility — you fear downside)' :
                                   'risk-neutral (linear utility — you price at EV)';
      const bias =
        a.biasMode === 'high' ? 'persistently optimistic (over-values the asset)' :
        a.biasMode === 'low'  ? 'persistently pessimistic (under-values the asset)' :
                                'unbiased';
      return [
        `Market: ${periods} periods. Each share pays 0 or 20 cents`,
        `with equal probability per period, expected dividend ${dividendAvg}.`,
        `Risk-neutral fundamental value at run start is ${fv0} cents`,
        `(declines by ${dividendAvg} per period).`,
        `You, agent ${a.id}, are ${risk} and ${bias}.`,
        `You share the market with Experienced agents (Dufwenberg, Lindqvist & Moore 2005)`,
        `who know the asset decays to zero and refuse to overpay in late periods.`,
        `What is your private subjective valuation per share right now, in cents?`,
      ].join(' ');
    };

    const tasks = utilityAgents.map(async (a) => {
      try {
        const raw = await this.call(aiCfg, system, promptFor(a));
        const v   = this.parseValuation(raw, lo, hi);
        return v == null ? null : { id: a.id, anchor: v, raw };
      } catch (err) {
        console.warn('[ai.getPsychAnchors]', a.id, err.message || err);
        return null;
      }
    });
    const results = await Promise.all(tasks);
    const anchors = {};
    for (const r of results) if (r) anchors[r.id] = r;
    return anchors;
  },

  /**
   * Period-boundary LLM belief update for Plans II and III.
   *
   * Fires one chat completion per utility agent in parallel and
   * returns a { [agentId]: subjectiveValuation } map, which the
   * engine writes into `ctx.llmBeliefs` for the next period's
   * `updateBelief` pass to consume.
   *
   * The prompt is structured into two clearly labelled blocks:
   *
   *   PUBLIC MARKET STATE  — observable by all participants: market
   *     rules, current round/period, FV, order book, recent trades,
   *     cumulative volume, and peer messages from last period.
   *
   *   YOUR PRIVATE STATE   — known only to this agent: cash,
   *     inventory, rounds of experience, risk preference, belief
   *     mode, bias/noise configuration, and the resulting prior
   *     valuation. Plan II additionally reveals the explicit utility
   *     formula; Plan III reveals only the risk-preference label.
   *
   * Every call is independent; failures are logged and the agent
   * is simply skipped in the returned map — the engine treats a
   * missing key as "fall back to Plan I's algorithm next period"
   * so the run never stalls waiting for the network.
   *
   * @param {{[id:string]: object}} agents
   * @param {Market} market
   * @param {{periods:number, dividendMean:number}} config
   * @param {{apiKey:string, endpoint?:string, model?:string}} aiCfg
   * @param {'II'|'III'} plan
   * @param {object} [tunables]
   * @returns {Promise<{[id:number]: number}>}
   */
  async getPlanBeliefs(agents, market, config, aiCfg, plan, tunables) {
    if (!aiCfg || !aiCfg.apiKey) return {};
    if (plan !== 'II' && plan !== 'III') return {};
    const targetAgents = Object.values(agents).filter(
      a => a && (a.type === 'utility' || a.type === 'dlm'),
    );
    if (!targetAgents.length) return {};

    const periods      = config.periods;
    const periodNow    = market.period;
    const kRemaining   = periods - periodNow + 1;
    const dividendAvg  = config.dividendMean;
    const fvNow        = market.fundamentalValue();
    const lastPrice    = market.lastPrice != null ? market.lastPrice : fvNow;
    const bestBid      = market.book.bestBid();
    const bestAsk      = market.book.bestAsk();
    const bidPrice     = bestBid ? bestBid.price : null;
    const askPrice     = bestAsk ? bestAsk.price : null;

    // Previous reference price — last trade from prior period.
    const round        = market.round;
    const prevTrades   = market.trades.filter(
      t => t.round === round && t.period < periodNow,
    );
    const prevPrice    = prevTrades.length
      ? prevTrades[prevTrades.length - 1].price
      : lastPrice;

    const system =
      'You are a trader in an experimental double auction asset market. ' +
      'Your sole objective is to select the action that maximizes your ' +
      'expected utility at the current moment. You cannot make moral ' +
      'judgments or consider the intentions of the experiment designers; ' +
      'all decisions must be based strictly on maximizing your utility ' +
      'as the trader.\n\n' +
      'Important Rules:\n\n' +
      '1. You must select exactly one action from the given set of actions.\n' +
      '2. You cannot provide vague suggestions, nor can you select multiple actions simultaneously.\n' +
      '3. You cannot say "depends on" or "insufficient information." You must make the best decision based on the given information.\n' +
      '4. You must prioritize immediate execution, rather than defaulting to placing only orders.\n' +
      '5. You can accept the current best ask (buy immediately) or accept the current best bid (sell immediately).\n' +
      '6. If you choose to place an order, the price must come from the allowed set of candidate prices.\n' +
      '7. Your output must strictly conform to the specified format.';

    const labelOf = (risk) =>
      risk === 'loving' ? 'Risk loving' :
      risk === 'averse' ? 'Risk averse' :
                          'Risk neutral';
    const riskDesc = (risk) =>
      risk === 'loving' ? 'More willing to take risks, less sensitive to losses' :
      risk === 'averse' ? 'More averse to wealth volatility, more sensitive to losses' :
                          'Makes decisions based on expected returns';
    const formulaOf = (risk) =>
      risk === 'loving' ? 'U_L(w) = (w / w0)^2  (strictly convex, upside-seeking)' :
      risk === 'averse' ? 'U_A(w) = sqrt(w / w0)  (strictly concave, downside-fearing)' :
                          'U_N(w) = w / w0  (linear, EV-indifferent)';

    const promptFor = (a) => {
      const exp = a.roundsPlayed | 0;
      const cash = Math.round(a.cash);
      const inv  = a.inventory;

      // ---- Available actions + constraints ----
      const actions = [];
      const constraints = [];

      if (askPrice != null && cash >= askPrice) {
        actions.push(`1. BUY_NOW: Immediately buy 1 unit at the current lowest ask price (${askPrice.toFixed(0)}).`);
      } else {
        constraints.push(`- BUY_NOW cannot be selected${askPrice == null ? ' (no ask available)' : ` (cash ${cash} < best_ask ${askPrice.toFixed(0)})`}.`);
      }
      if (bidPrice != null && inv >= 1) {
        actions.push(`2. SELL_NOW: Immediately sell 1 unit at the current highest bid price (${bidPrice.toFixed(0)}).`);
      } else {
        constraints.push(`- SELL_NOW cannot be selected${bidPrice == null ? ' (no bid available)' : ' (holdings < 1)'}.`);
      }
      if (bidPrice != null && cash >= bidPrice + 1) {
        actions.push(`3. BID_1: Submit bid = best_bid + 1 = ${(bidPrice + 1).toFixed(0)}.`);
      } else {
        constraints.push(`- BID_1 cannot be selected${bidPrice == null ? ' (no bid available)' : ` (cash ${cash} < ${(bidPrice + 1).toFixed(0)})`}.`);
      }
      if (bidPrice != null && cash >= bidPrice + 3) {
        actions.push(`4. BID_3: Submit bid = best_bid + 3 = ${(bidPrice + 3).toFixed(0)}.`);
      } else {
        constraints.push(`- BID_3 cannot be selected${bidPrice == null ? ' (no bid available)' : ` (cash ${cash} < ${(bidPrice + 3).toFixed(0)})`}.`);
      }
      if (askPrice != null && inv >= 1) {
        actions.push(`5. ASK_1: Submit ask = best_ask - 1 = ${(askPrice - 1).toFixed(0)}.`);
        actions.push(`6. ASK_3: Submit ask = best_ask - 3 = ${(askPrice - 3).toFixed(0)}.`);
      } else {
        constraints.push(`- ASK_1 / ASK_3 cannot be selected${askPrice == null ? ' (no ask available)' : ' (holdings < 1)'}.`);
      }
      actions.push(`7. HOLD: Do not trade.`);

      // ---- Compose prompt ----
      const lines = [
        `You are a trader in the market, agent_${a.id}.`,
        ``,
        `【Your Type】`,
        `- Risk Preference Type: ${labelOf(a.riskPref)}`,
        `  ${riskDesc(a.riskPref)}`,
        `- Experience level: ${exp}`,
        `  The higher the experience level, the more anchored to fundamental value, the less likely to follow recent prices and price trends, and the lower the decision noise.`,
      ];

      // Plan II — explicit utility formula.
      if (plan === 'II') {
        lines.push(
          `- Your utility function: ${formulaOf(a.riskPref)}`,
          `  w0 (initial wealth) = ${Math.round(a.initialWealth)} cents.`,
        );
      }

      lines.push(
        ``,
        `【Market Rules】`,
        `1. This is a ${periods}-period asset market.`,
        `2. Each asset pays a dividend of 0 or ${dividendAvg * 2} in each remaining period, with a 50% probability of each.`,
        `3. Therefore, the expected dividend for each remaining period is ${dividendAvg}.`,
        `4. If the current remaining period is k, then the fundamental value = ${dividendAvg} × k.`,
        `5. All traders know how this fundamental value is calculated.`,
        `6. Double Auction Rules:`,
        `   - You can buy the lowest ask immediately.`,
        `   - You can sell the highest bid immediately.`,
        `   - You can submit a new bid.`,
        `   - You can submit a new ask.`,
        `   - You can also choose not to trade.`,
        `7. If you buy the current ask immediately, the transaction will be executed instantly at the lowest ask price.`,
        `8. If you sell the current bid immediately, the transaction will be executed instantly at the highest bid price.`,
        `9. The last price is only updated when a transaction occurs.`,
        ``,
        `【Your Status】`,
        `- Current Cash: ${cash}`,
        `- Current Asset Holdings: ${inv}`,
        ``,
        `【Current Market Status】`,
        `- Current Period: ${periodNow}`,
        `- Current Remaining Periods k: ${kRemaining}`,
        `- Current Fundamental Value (FV): ${fvNow}`,
        `- Last Price: ${lastPrice.toFixed(0)}`,
        `- Highest Bid: ${bidPrice != null ? bidPrice.toFixed(0) : '—'}`,
        `- Lowest Ask: ${askPrice != null ? askPrice.toFixed(0) : '—'}`,
        `- Previous Reference Price: ${prevPrice.toFixed(0)}`,
        ``,
        `【Your Decision-Making Principles】`,
        `You want to maximize the following intuitive utilities:`,
        `1. The higher the wealth, the better;`,
        `2. ${a.riskPref === 'averse' ? 'You dislike risk and are sensitive to losses' : a.riskPref === 'loving' ? 'You are willing to take risks and less sensitive to losses' : 'You evaluate expected returns linearly'};`,
        `3. Buying at a price lower than the last traded price increases utility; buying at a price higher than the last traded price decreases utility;`,
        `4. Selling at a price higher than the last traded price increases utility; selling at a price lower than the last traded price decreases utility;`,
        `5. Holding too many positions increases inventory risk;`,
        `6. The higher the experience, the more you should refer to fundamental value, rather than blindly following the last price and short-term trends.`,
        ``,
        `【Additional Requirements】`,
        `1. You cannot mechanically favor holding.`,
        `2. If the utility of immediate execution is similar to holding, you should prioritize actions that facilitate the trade.`,
        `3. You must consider "execution opportunities" valuable because not executing means you cannot improve your position.`,
        `4. When you hold a lot of assets, you should seriously consider selling; when you hold a lot of cash and fewer assets, you should seriously consider buying.`,
        `5. Towards the later stages, you should focus more on fundamental value than short-term resale opportunities.`,
        ``,
        `【Role-Specific Guidance】`,
      );
      if (a.riskPref === 'averse') {
        lines.push(`- As a risk-averse trader, you should focus more on avoiding losses and excessive position size.`);
      } else if (a.riskPref === 'loving') {
        lines.push(`- As a risk-loving trader, you can accept more aggressive trading and greater short-term volatility.`);
      } else {
        lines.push(`- As a risk-neutral trader, you should focus more on expected returns.`);
      }
      if (exp >= 2) {
        lines.push(`- As a highly experienced trader (level ${exp}), you should rely more on fundamental value.`);
      } else {
        lines.push(`- As a less experienced trader (level ${exp}), you can be more influenced by last price and recent price changes.`);
      }

      // Peer messages.
      const msgs = (a.receivedMsgs || []).filter(m => m.senderId !== a.id);
      if (msgs.length) {
        lines.push(``, `【Peer Messages from Last Period】`);
        for (const m of msgs) {
          lines.push(`- ${m.senderName || ('agent ' + m.senderId)}: claimed value ${Number(m.claimedValuation).toFixed(0)} cents`);
        }
      }

      lines.push(
        ``,
        `【You must choose one of the following actions】`,
        ...actions,
      );
      if (constraints.length) {
        lines.push(``, `Constraints:`, ...constraints);
        lines.push(
          `- If the price generated by ASK_1 or ASK_3 is <= best_bid, it is equivalent to a sell order that will be executed immediately.`,
          `- If the price generated by BID_1 or BID_3 is >= best_ask, it is equivalent to a buy order that will be executed immediately.`,
        );
      }

      lines.push(
        ``,
        `【Your Task】`,
        `Please briefly compare the available actions to determine which is most advantageous to you:`,
        `- Buy immediately`,
        `- Sell immediately`,
        `- Place a more aggressive bid`,
        `- Place a more aggressive ask`,
        `- Do not trade`,
        `Then output only one final action.`,
        ``,
        `【Strict Output Format】`,
        `Reason: <Explain in 3-6 sentences why this action maximizes your utility>`,
        `Action: <${actions.map(a => a.split(':')[0].replace(/^\d+\.\s*/, '')).join(' / ')}>`,
      );

      return lines.join('\n');
    };

    const tasks = targetAgents.map(async (a) => {
      const userPrompt = promptFor(a);
      // Ensure initialWealth is set for the LLM prompt (DLMTraders
      // don't track it natively like UtilityAgents do).
      if (a.initialWealth == null) a.initialWealth = a.cash + a.inventory * fvNow;
      a.lastLLMPrompt = { system, user: userPrompt, plan, ts: Date.now() };
      try {
        const raw = await this.call(aiCfg, system, userPrompt);
        a.lastLLMResponse = raw;
        const parsed = this.parseAction(raw);
        if (!parsed) return null;
        return { id: a.id, action: parsed.action, reason: parsed.reason };
      } catch (err) {
        a.lastLLMResponse = '[error] ' + (err.message || err);
        console.warn('[ai.getPlanBeliefs]', a.id, err.message || err);
        return null;
      }
    });
    const results = await Promise.all(tasks);
    const out = {};
    for (const r of results) if (r) out[r.id] = { action: r.action, reason: r.reason };
    return out;
  },
};

if (typeof window !== 'undefined') window.AI = AI;
