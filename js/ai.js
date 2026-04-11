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
   * Default OpenAI endpoint — matches the lying project's GPT
   * provider default (`PROVIDERS.gpt.defaultEndpoint` in
   * `/Users/monius/Documents/code/2026/lying/js/ai-agent.js`). A
   * user-supplied `endpoint` override in the AI-config form wins;
   * leaving the field blank routes through this URL.
   */
  DEFAULT_ENDPOINT: 'https://openai-20250719-f7491cbb.rootdirectorylab.com/v1/chat/completions',

  /**
   * Supported models — mirror-image of `PROVIDERS.gpt.models` in the
   * lying project. The ordering is preserved so UI.populate() can
   * build the model select identically in both codebases, and the
   * first entry is the implicit default when the user has not yet
   * interacted with the dropdown.
   */
  MODELS: [
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini',  label: 'GPT-5.4 Mini' },
    { id: 'gpt-5.4-nano',  label: 'GPT-5.4 Nano' },
    { id: 'o3',            label: 'o3' },
    { id: 'o4-mini',       label: 'o4-mini' },
    { id: 'gpt-4.1',       label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini',  label: 'GPT-4.1 Mini' },
    { id: 'gpt-4o',        label: 'GPT-4o' },
    { id: 'gpt-4o-mini',   label: 'GPT-4o Mini' },
  ],

  /** Default model used when the user leaves the dropdown untouched. */
  DEFAULT_MODEL: 'gpt-5.4',

  /**
   * gpt-5 / o3+ / o1+ families require `max_completion_tokens` in
   * place of the legacy `max_tokens` field. Regex matches the lying
   * project's `_openaiCall` branch verbatim — both codebases must
   * agree on this test or a model upgrade will 400 in one place
   * and succeed in the other.
   */
  _usesCompletionTokens(model) {
    return /^(gpt-5|o[3-9]|o[1-9]\d)/.test(model || '');
  },

  /**
   * Low-level chat-completion call. Intentionally mirrors the
   * `_openaiCall` helper in the lying project's js/ai-agent.js so
   * the two codebases stay trivially portable: identical headers,
   * identical body shape, identical token-field branching.
   *
   * @param {{apiKey: string, endpoint?: string, model?: string, maxTokens?: number, temperature?: number}} cfg
   * @param {string} system  — system prompt
   * @param {string} prompt  — user prompt
   * @returns {Promise<string>} the plain-text content of the first choice
   */
  async call(cfg, system, prompt) {
    if (!cfg || !cfg.apiKey) throw new Error('ai.call: missing apiKey');
    const endpoint  = cfg.endpoint || this.DEFAULT_ENDPOINT;
    const model     = cfg.model    || this.DEFAULT_MODEL;
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
      throw new Error(`ai.call: HTTP ${res.status} ${res.statusText} ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('ai.call: no content in response');
    return content.trim();
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
};

if (typeof window !== 'undefined') window.AI = AI;
