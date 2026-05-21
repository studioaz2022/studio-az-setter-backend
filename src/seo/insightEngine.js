// insightEngine.js
// Generates Stats Dashboard insight cards.
//
// Pipeline:
//   1. Pull all live metrics we have flowing (funnel snapshot + GA4 site totals
//      + GA4 consultation step drop-off + abandoners count).
//   2. Detect anomalies — for v1, threshold-based: |delta| > 0.5 or a
//      consultation-form step that lost > 50% of users from the previous step.
//   3. Dedup against insight_cards already created this week for the same
//      metric_key + site (avoid spam if the same anomaly persists).
//   4. For each fresh anomaly, ask Claude Haiku 4.5 for a one-line headline
//      and 3 ranked hypotheses, grounded in the supporting data we pass it.
//   5. Write each card to Supabase.
//
// The whole pipeline is idempotent: re-running on the same day produces zero
// new cards (because of the dedup step).

const Anthropic = require("@anthropic-ai/sdk").default;
const { supabase } = require("../clients/supabaseClient");
const { getFunnelSnapshot } = require("../analytics/leadFunnelAnalytics");
const {
  siteTotals,
  consultationEventCounts,
  consultationStepCompletions,
} = require("./ga4DataClient");
const axios = require("axios");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001";

// Anomaly thresholds — same value used on the dashboard's HeadlineMetrics
// gold ◆ marker, so the UI and the engine flag the same things.
const ANOMALY_DELTA_THRESHOLD = 0.5;     // |delta| > 50%
const CLIFF_DELTA_THRESHOLD = -0.5;      // step lost > 50% of previous step's users

// Dedup window — if we already generated a card for this metric_key + site
// within this many days, skip. Prevents the weekly cron from filing the same
// "consultation submits +500%" card 4 weeks in a row if the metric is sticky.
const DEDUP_WINDOW_DAYS = 7;

/**
 * Pull all live metric snapshots we know about. Returns a shape the detector
 * can scan uniformly. Each entry has:
 *   { metric_key, label, current, prior, delta, supporting }
 * where `supporting` is an opaque object the LLM prompt can include verbatim
 * for context (per-artist breakdown, surrounding step counts, etc.).
 */
async function collectSignals(site) {
  if (site !== "tattoo") {
    throw new Error(`Insights only support 'tattoo' in v1; got '${site}'`);
  }

  // Run all 4 pulls in parallel.
  const [funnel, totals7, events7, stepReport] = await Promise.all([
    getFunnelSnapshot(20).catch((e) => ({ _error: e.message })),
    siteTotals("tattoo", 7).catch((e) => ({ _error: e.message })),
    consultationEventCounts("tattoo", 7).catch((e) => ({ _error: e.message })),
    consultationStepCompletions("tattoo", 30).catch((e) => ({ _error: e.message })),
  ]);

  const signals = [];

  // ── GA4 site totals (last 7d vs prior 7d) ──
  if (!totals7._error && totals7.rows) {
    const { current, comparison } = pluckRanges(totals7);
    if (current && comparison) {
      pushDeltaSignal(signals, {
        metric_key: "sessions_7d",
        label: "Sessions",
        current: current[0],
        prior: comparison[0],
        supporting: { metric: "sessions", window: "7d vs prior 7d" },
      });
      pushDeltaSignal(signals, {
        metric_key: "users_7d",
        label: "Users",
        current: current[1],
        prior: comparison[1],
        supporting: { metric: "totalUsers", window: "7d vs prior 7d" },
      });
    }
  }

  // ── GA4 consultation event counts (last 7d vs prior 7d) ──
  if (!events7._error && events7.rows) {
    const byEvent = bucketEventByRange(events7);
    for (const [eventName, { current, comparison }] of Object.entries(byEvent)) {
      pushDeltaSignal(signals, {
        metric_key: `${eventName}_7d`,
        label: eventName.replace(/_/g, " "),
        current,
        prior: comparison,
        supporting: { metric: eventName, window: "7d vs prior 7d" },
      });
    }
  }

  // ── Fill-flow funnel: completion rate vs the inquiry baseline ──
  if (!funnel._error) {
    // Treat the funnel as a static health check rather than week-over-week
    // (we don't have weekly funnel history yet). Flag any stage with <50%
    // pass-through from the previous as a "cliff" signal.
    const stages = [
      ["inquiries", funnel.totals.inquiries],
      ["fill_links_clicked", funnel.totals.fill_links_clicked],
      ["fill_started", funnel.totals.fill_started],
      ["fill_completed", funnel.totals.fill_completed],
    ];
    for (let i = 1; i < stages.length; i++) {
      const [prevName, prevN] = stages[i - 1];
      const [name, n] = stages[i];
      if (prevN === 0) continue;
      const passRate = n / prevN;
      const dropRate = passRate - 1; // negative if it dropped
      if (dropRate <= CLIFF_DELTA_THRESHOLD) {
        signals.push({
          metric_key: `fill_flow_${name}_dropoff`,
          label: `Fill flow: ${name.replace(/_/g, " ")}`,
          current: n,
          prior: prevN,
          delta: dropRate,
          severity: severityFromDelta(dropRate),
          supporting: {
            metric: "fill_flow_stage_passthrough",
            window: `last ${funnel.window.days}d`,
            prev_stage: prevName,
            this_stage: name,
            funnel_totals: funnel.totals,
            by_artist: funnel.by_artist,
            nudge_outcomes: funnel.nudge_outcomes,
          },
        });
      }
    }
  }

  // ── GA4 consultation step drop-off: scan for cliff steps ──
  if (!stepReport._error && stepReport.rows) {
    const steps = collapseStepReport(stepReport);
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      if (prev.users === 0) continue;
      const passRate = curr.users / prev.users;
      const dropRate = passRate - 1;
      if (dropRate <= CLIFF_DELTA_THRESHOLD) {
        signals.push({
          metric_key: `consultation_step_${curr.stepIndex}_${curr.stepName}_dropoff`,
          label: `Consultation step ${curr.stepIndex}: ${curr.stepName}`,
          current: curr.users,
          prior: prev.users,
          delta: dropRate,
          severity: severityFromDelta(dropRate),
          supporting: {
            metric: "ga4_step_passthrough",
            window: "last 30d",
            prev_step: prev,
            this_step: curr,
            all_steps: steps,
          },
        });
      }
    }
  }

  return signals;
}

// ── GA4 row helpers ─────────────────────────────────────────────

function pluckRanges(report) {
  // siteTotals — no requested dimensions, dateRange marker is the only
  // dimensionValues entry. Returns { current: [m0, m1, ...], comparison: [...] }.
  let current = null;
  let comparison = null;
  for (const row of report.rows || []) {
    const dvs = row.dimensionValues || [];
    const range = dvs[dvs.length - 1]?.value;
    const values = (row.metricValues || []).map((m) => Number(m.value || 0));
    if (range === "date_range_0") current = values;
    else if (range === "date_range_1") comparison = values;
  }
  return { current, comparison };
}

function bucketEventByRange(report) {
  // consultationEventCounts — dimensions are [eventName, dateRange].
  const out = {};
  for (const row of report.rows || []) {
    const dvs = row.dimensionValues || [];
    const eventName = dvs[0]?.value;
    const range = dvs[dvs.length - 1]?.value;
    const v = Number(row.metricValues?.[0]?.value || 0);
    if (!eventName) continue;
    if (!out[eventName]) out[eventName] = { current: 0, comparison: 0 };
    if (range === "date_range_0") out[eventName].current = v;
    else if (range === "date_range_1") out[eventName].comparison = v;
  }
  return out;
}

function collapseStepReport(report) {
  // consultationStepCompletions returns one row per (step_index, step_name).
  // Sum across languages to get a per-index total, like the dropoff endpoint does.
  const totals = new Map();
  const labels = new Map();
  for (const row of report.rows || []) {
    const idx = Number(row.dimensionValues?.[0]?.value ?? -1);
    const name = row.dimensionValues?.[1]?.value || "(unknown)";
    const users = Number(row.metricValues?.[0]?.value || 0);
    totals.set(idx, (totals.get(idx) || 0) + users);
    // Use the row with the most users as the canonical name for that step.
    const existing = labels.get(idx);
    if (!existing || existing.users < users) {
      labels.set(idx, { name, users });
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, users]) => ({
      stepIndex: idx,
      stepName: labels.get(idx)?.name ?? "(unknown)",
      users,
    }));
}

function pushDeltaSignal(signals, { metric_key, label, current, prior, supporting }) {
  if (current === undefined || prior === undefined) return;
  if (prior === 0 && current === 0) return; // nothing happened
  // When prior is 0 but current > 0, treat as +infinity → use a sentinel large
  // delta so the severity bucket picks "attention" and the LLM gets context.
  const delta =
    prior === 0
      ? (current > 0 ? 10 : 0)
      : (current - prior) / prior;
  if (Math.abs(delta) < ANOMALY_DELTA_THRESHOLD) return;
  signals.push({
    metric_key,
    label,
    current,
    prior,
    delta,
    severity: severityFromDelta(delta),
    supporting,
  });
}

function severityFromDelta(delta) {
  const m = Math.abs(delta);
  if (m > 1) return "attention";
  if (m > 0.5) return "noteworthy";
  return "context";
}

// ── Claude call ─────────────────────────────────────────────────

/**
 * Ask Claude to write a one-line headline + 3 ranked hypotheses for a single
 * signal. Returns { headline, hypotheses: [{text, confidence}], severity }.
 *
 * Uses prompt caching on the static system prompt — the per-signal context
 * goes in the user message so caching saves tokens across signals in the same
 * generation run.
 */
async function llmGenerateCard(signal) {
  const system = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];

  const userBlock = JSON.stringify(
    {
      metric_key: signal.metric_key,
      label: signal.label,
      current_value: signal.current,
      prior_value: signal.prior,
      delta_fraction: signal.delta,
      delta_percentage: `${Math.round(signal.delta * 100)}%`,
      severity_hint: signal.severity,
      supporting_data: signal.supporting,
    },
    null,
    2
  );

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [
      {
        role: "user",
        content: `Generate an insight card for the following anomaly:\n\n${userBlock}`,
      },
    ],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Extract the JSON block. The model is instructed to return ONLY a JSON
  // object — if it adds prose, we strip everything before the first { and
  // after the last }.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`LLM did not return JSON. Raw: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));

  return {
    headline: String(parsed.headline || "").trim(),
    hypotheses: Array.isArray(parsed.hypotheses)
      ? parsed.hypotheses
          .slice(0, 5)
          .map((h) => ({
            text: String(h.text || h).trim(),
            confidence:
              typeof h.confidence === "string"
                ? h.confidence.toLowerCase()
                : "medium",
          }))
          .filter((h) => h.text.length > 0)
      : [],
  };
}

const SYSTEM_PROMPT = `You are the analytical layer of an internal stats dashboard for Studio AZ — a tattoo shop in Minneapolis. The dashboard surfaces anomalies in week-over-week metrics. Your job: read one anomaly + supporting data, and write a concise "insight card" that helps the shop owner (Lionel) understand what's worth paying attention to.

OUTPUT FORMAT — return ONLY a JSON object, no prose, no markdown fences:
{
  "headline": "one-line summary, under 90 chars, no emojis",
  "hypotheses": [
    { "text": "<one plausible explanation, under 120 chars>", "confidence": "high|medium|low" },
    { "text": "...", "confidence": "..." },
    { "text": "...", "confidence": "..." }
  ]
}

VOICE:
- Factual. No marketing language, no exclamation marks, no "great news!"
- Specific. "Mobile sessions dropped 32%" beats "fewer people visited."
- Honest about uncertainty. If the absolute numbers are tiny (e.g. 1 → 6), label noise as a candidate hypothesis with "high" confidence.

HYPOTHESIS RULES:
- Return exactly 3.
- Rank them by your best guess of likelihood — the FIRST one is the most likely.
- Each one should be testable (something Lionel could investigate further).
- Include at least one "noise / small sample" hypothesis when the absolute numbers are under 10.
- Distinguish causes (Mother's Day promo) from correlations (ad spend up). Causal language only when the supporting data supports it.

HEADLINE RULES:
- Lead with the metric and the change. "Consultation submits +500% week-over-week (6 vs 1)" > "We're getting more submits!"
- Always include both the absolute numbers and the percent in parentheses if it would fit.
- Never start with "Alert" or "Anomaly detected" — the card itself signals that.

Studio AZ context (for grounding only — don't quote this back):
- Tattoo shop in Minneapolis. Owner Lionel. Two active artists: Andrew + Joan.
- Primary conversion event: consultation_submitted (form submission on /consultation).
- Volume is modest: 7d sessions are in the 30-70 range; submits in single digits.
- Common traffic source is Instagram bio.`;

// ── DB layer ────────────────────────────────────────────────────

async function recentExistingMetricKeys(site, days = DEDUP_WINDOW_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("insight_cards")
    .select("metric_key")
    .eq("site", site)
    .in("status", ["open", "acknowledged"]) // exclude resolved cards from dedup
    .gte("created_at", cutoff);
  if (error) {
    console.warn("[insights] dedup lookup failed:", error.message);
    return new Set();
  }
  return new Set((data || []).map((r) => r.metric_key));
}

async function insertCard(site, signal, llmOutput) {
  const row = {
    site,
    headline: llmOutput.headline,
    hypotheses: llmOutput.hypotheses,
    severity: signal.severity,
    metric_key: signal.metric_key,
    current_value: signal.current,
    prior_value: signal.prior,
    delta: signal.delta,
    status: "open",
  };
  const { data, error } = await supabase
    .from("insight_cards")
    .insert(row)
    .select("*")
    .single();
  if (error) {
    console.error("[insights] insert failed:", error.message);
    throw error;
  }
  return data;
}

// ── Public entry points ─────────────────────────────────────────

/**
 * Run the full pipeline for one site. Returns a summary.
 *
 * @param {"tattoo"|"barbershop"} site
 * @returns {Promise<{ generated: number, deduped: number, errors: number, cards: object[] }>}
 */
async function generateInsights(site) {
  const signals = await collectSignals(site);
  const skipKeys = await recentExistingMetricKeys(site);

  const summary = { generated: 0, deduped: 0, errors: 0, cards: [] };

  for (const signal of signals) {
    if (skipKeys.has(signal.metric_key)) {
      summary.deduped += 1;
      continue;
    }
    try {
      const llmOutput = await llmGenerateCard(signal);
      if (!llmOutput.headline || llmOutput.hypotheses.length === 0) {
        summary.errors += 1;
        continue;
      }
      const card = await insertCard(site, signal, llmOutput);
      summary.generated += 1;
      summary.cards.push(card);
    } catch (err) {
      console.error(
        `[insights] generate failed for ${signal.metric_key}:`,
        err.message
      );
      summary.errors += 1;
    }
  }

  return summary;
}

/**
 * List insight cards for a site, partitioned by active vs resolved.
 */
async function listInsights(site) {
  const { data, error } = await supabase
    .from("insight_cards")
    .select("*")
    .eq("site", site)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(`listInsights query failed: ${error.message}`);
  }
  const active = [];
  const history = [];
  for (const card of data || []) {
    if (card.status === "open" || card.status === "acknowledged") {
      active.push(card);
    } else {
      history.push(card);
    }
  }
  return { active, history };
}

/**
 * Update the status of one card. Sets the matching `*_at` timestamp.
 */
async function updateCardStatus(cardId, status, notes) {
  const allowed = new Set([
    "open",
    "acknowledged",
    "shipped",
    "verified",
    "dismissed",
  ]);
  if (!allowed.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const update = { status };
  if (notes != null) update.notes = notes;
  // Stamp the transition timestamp for the workflow log.
  const nowIso = new Date().toISOString();
  if (status === "acknowledged") update.acknowledged_at = nowIso;
  if (status === "shipped") update.shipped_at = nowIso;
  if (status === "verified") update.verified_at = nowIso;
  if (status === "dismissed") update.dismissed_at = nowIso;

  const { data, error } = await supabase
    .from("insight_cards")
    .update(update)
    .eq("id", cardId)
    .select("*")
    .single();
  if (error) {
    throw new Error(`updateCardStatus failed: ${error.message}`);
  }
  return data;
}

module.exports = {
  generateInsights,
  listInsights,
  updateCardStatus,
  // exported for testing
  _collectSignals: collectSignals,
};
