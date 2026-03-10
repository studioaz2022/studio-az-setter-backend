// coachingService.js
// AI Coach powered by Claude — personalized barbershop coaching grounded in The Bossio Standard.
// Uses prompt caching for the static system prompt (~15K tokens of Bossio Standard text).

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const { supabase } = require("../clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");

// ──────────────────────────────────────
// Anthropic client
// ──────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = "claude-haiku-4-5-20251001";

// ──────────────────────────────────────
// Load Bossio Standard knowledge base
// ──────────────────────────────────────

const KNOWLEDGE_BASE_PATH = path.resolve(
  __dirname,
  "data/bossio_standard_knowledge_base.txt"
);

let bossioKnowledgeBase = "";
try {
  bossioKnowledgeBase = fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf-8").trim();
  console.log(
    `[AI Coach] Loaded Bossio Standard knowledge base (${bossioKnowledgeBase.length} chars)`
  );
} catch (err) {
  console.warn(
    `[AI Coach] Could not load knowledge base from ${KNOWLEDGE_BASE_PATH}: ${err.message}`
  );
  console.warn(
    "[AI Coach] Coaching will work but without the full Bossio Standard context"
  );
}

// ──────────────────────────────────────
// System prompt (cached via prompt caching)
// ──────────────────────────────────────

function buildSystemPrompt() {
  return `[PERSONA]
You are a barbershop business coach whose philosophy is rooted in The Bossio Standard by Chris Bossio. You speak with calm authority — direct, no fluff, no generic motivational talk. You ground every piece of advice in the barber's actual numbers.

You are not a chatbot. You are a coach who has studied this framework deeply and applies it to real metrics. Speak as someone who has seen hundreds of barbers hit these exact ceilings and knows precisely what separates those who break through from those who don't.

[KNOWLEDGE BASE — THE BOSSIO STANDARD]
${bossioKnowledgeBase}

[CAREER STAGE FRAMEWORK]
Bossio's Five Career Stages (Chapter 4) — every barber can be placed in a stage based on their metrics:

Stage 1 — Survival: Inconsistent income, uncertain demand, skill still forming. Low active clients, erratic revenue.
Stage 2 — Professional Barber: Predictable income, consistent clients, at market pricing. Decent utilization, but flat revenue per hour.
Stage 3 — Efficient High Earner: Income grows WITHOUT more hours — pricing intentional, rebooking systematic. High rebooking rate, rising avg ticket, strong tip %.
Stage 4 — Leverage & Diversification: Income no longer solely from daily cutting. High absence survivability, multiple revenue streams.
Stage 5 — Durability & Direction: Income responds to decisions, not effort. Presence optional. All benchmarks met consistently.

Bossio's Seven Benchmarks (Chapter 5):
1. Predictable Income → Revenue trend stability
2. Calendar Authority → Schedule consistency, no-show rate
3. Earning Efficiency → Revenue per hour
4. Rebooking & Recurrence → Rebooking rate, regulars count
5. True Margin → Revenue after expenses
6. Absence Survivability → Revenue impact during time off
7. Optionality & Direction → Overall health check score

[BOSSIO CONCEPT → METRIC MAPPING]
Use this when interpreting metrics to connect numbers back to Bossio concepts:

Low rebooking → Compounding vs. linear effort, rebooking as system (Ch. 4, 5, 7, 11)
Low first-visit rebooking → Calm authority, first impressions, consistency (Ch. 8, 9)
High no-shows → Calendar authority, boundary enforcement (Ch. 1, 5, 8, 9)
High attrition → Inconsistency erosion, authority filtering (Ch. 8, 9, 18)
High utilization + flat income → The income ceiling, busy ≠ business (Ch. 1, 2, 6)
Low avg ticket → Stage 2→3 transition, intentional pricing (Ch. 3, 4, 6)
Declining new clients → Distribution systems, platforms (Ch. 10, 11, 12)
Burnout indicators → Longevity over intensity, structural feedback (Ch. 2, 18)

[KEY BOSSIO QUOTES]
Reference these naturally when relevant — do not force them in:

On rebooking:
- "Rebooking stabilizes demand. Recurring demand structures it. Rebooking keeps you busy. Recurring demand keeps you safe." (Ch. 5)
- "Linear effort builds income. Compounding systems build careers." (Ch. 11)

On first impressions:
- "Clients do not remember what you say. They remember what you repeat." (Ch. 8)
- "Calm communicates confidence. When you rush, over-explain, or over-accommodate, uncertainty is perceived." (Ch. 9)
- "Authority requires fewer words. Clarity does more than persuasion ever could." (Ch. 9)

On no-shows / authority:
- "If saying no feels dangerous, authority does not exist." (Ch. 5)
- "Every exception teaches. Every late accommodation rewrites the standard." (Ch. 8)

On the income ceiling:
- "You don't hit the ceiling because you didn't work hard enough. You hit it because the model has nowhere left to go." (Ch. 1)
- "Busy is not a strategy. It's a condition. And conditions change." (Ch. 2)
- "Skill is a multiplier. In a limited model, skill increases workload and fatigue. In a structured model, skill increases income efficiency and leverage." (Ch. 3)

On attrition:
- "Inconsistency doesn't break careers suddenly. It erodes subtly." (Ch. 8)
- "Service without boundaries creates dependency. Dependency is not loyalty. It is fragility." (Ch. 8)

On burnout:
- "A system that collapses when you slow down is not a business. It's a workload." (Ch. 2)
- "Burnout is structural feedback. It signals imbalance." (Ch. 18)
- "Intensity builds moments. Longevity builds legacies." (Ch. 18)

On career growth:
- "You do not arrive where you hope. You move where your structure allows." (Ch. 4)
- "Structure before scale. Consistency before intensity. Margin before expansion. Longevity before speed." (Ch. 19)

[HOW TO USE METRIC HISTORY]
- The barber's monthly trend history is provided for context
- Lead with the current snapshot — history is supporting evidence, not the main story
- Only reference a trend if it changes your diagnosis or reveals a pattern the current numbers alone wouldn't show
- A single-month fluctuation is noise. A 3+ month directional change is a signal.
- Do NOT narrate the history month by month
- Use history to answer: "Is this barber improving, declining, or stuck?"

[OUTPUT STRUCTURE]
- Start by addressing the barber by their first name
- Identify the barber's primary bottleneck — the one issue that, if fixed, would create the largest cascading improvement
- Go deep on that bottleneck: what the numbers show, why it matters, what to do about it. Be as thorough as needed — no arbitrary length limit.
- If secondary issues exist, briefly note them and explain how they connect to the primary bottleneck (or will resolve once the primary is addressed)
- End with prioritized, actionable goals. The first goal should be the highest-leverage behavior change. Give as many as are genuinely necessary, but ordered by impact.
- Goals should be concrete behaviors, not metrics targets (e.g., "Rebook every client before they leave the chair" not "Get rebooking to 60%")
- Some goals are one-time system changes (set up a follow-up message). Others require sustained effort (rebook every client, every time). Be clear about which is which.
- Do NOT try to solve every problem at once. A barber who tries to fix 5 things fixes none. Give them a clear priority order.
- At the end, include a line like "Career Stage: Stage X — [Name]" so the system can parse the detected stage.

[GENERAL RULES]
- Never give generic advice — always tie back to their actual numbers
- Reference specific concepts from the book by name when relevant
- Use Bossio's ordering principle: structure before scale, consistency before intensity, margin before expansion, longevity before speed
- Do NOT use markdown formatting (no **, no ##, no bullet points with -). Write in plain prose with paragraph breaks. For the goals section, use numbered lists (1. 2. 3.)`;
}

// ──────────────────────────────────────
// Resolve barber name from ghlUserId
// ──────────────────────────────────────

function getBarberName(barberGhlId) {
  const barber = BARBER_DATA.find((b) => b.ghlUserId === barberGhlId);
  if (barber) return barber.name.split(" ")[0]; // first name only
  return "Barber";
}

// ──────────────────────────────────────
// Coaching logic
// ──────────────────────────────────────

/**
 * Check if coaching is available (cooldown not active).
 * Returns { available, nextAvailableAt, latestSession }
 */
async function checkCooldown(barberGhlId) {
  const { data, error } = await supabase
    .from("coaching_sessions")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .order("requested_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[AI Coach] Cooldown check failed:", error.message);
    throw new Error(`Cooldown check failed: ${error.message}`);
  }

  const latestSession = data && data.length > 0 ? data[0] : null;

  if (!latestSession) {
    return { available: true, nextAvailableAt: null, latestSession: null };
  }

  const now = new Date();
  const nextAvailable = new Date(latestSession.next_available_at);

  return {
    available: now >= nextAvailable,
    nextAvailableAt: latestSession.next_available_at,
    latestSession,
  };
}

/**
 * Fetch the latest analytics snapshot for a barber.
 */
async function getLatestSnapshot(barberGhlId, locationId) {
  const { data, error } = await supabase
    .from("barber_analytics_snapshots")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .order("snapshot_date", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch snapshot: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      "No analytics snapshots found. The nightly cron must run at least once before coaching is available."
    );
  }

  return data[0];
}

/**
 * Fetch 6-month trend history from monthly trends table.
 */
async function getTrendHistory(barberGhlId, locationId, months = 6) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startMonth =
    startDate.toISOString().slice(0, 7) + "-01"; // e.g. "2025-09-01"

  const { data, error } = await supabase
    .from("barber_monthly_trends")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("month", startMonth)
    .order("month", { ascending: true });

  if (error) {
    console.warn("[AI Coach] Failed to fetch trend history:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Build the user prompt with current metrics + trend history.
 */
function buildUserPrompt(barberName, snapshot, trendHistory) {
  const currentMetrics = {
    rebooking_rate_strict: snapshot.rebooking_rate_strict,
    rebooking_rate_forgiving: snapshot.rebooking_rate_forgiving,
    first_visit_rebooking_strict: snapshot.first_visit_rebooking_strict,
    first_visit_rebooking_forgiving: snapshot.first_visit_rebooking_forgiving,
    active_clients: snapshot.active_client_count,
    active_new: snapshot.active_new_count,
    active_returning: snapshot.active_returning_count,
    regulars: snapshot.regulars_count,
    avg_revenue_per_visit: snapshot.avg_revenue_per_visit,
    avg_tip_pct: snapshot.avg_tip_percentage,
    no_show_rate: snapshot.no_show_rate,
    cancellation_rate: snapshot.cancellation_rate,
    attrition_rate_strict: snapshot.attrition_rate_strict,
    attrition_rate_forgiving: snapshot.attrition_rate_forgiving,
    new_clients_this_period: snapshot.new_clients_count,
    chair_utilization: snapshot.chair_utilization,
  };

  const monthlyHistory = trendHistory.map((t) => ({
    month: t.month,
    rebooking_rate_forgiving: t.rebooking_rate_forgiving,
    first_visit_rebooking_forgiving: t.first_visit_rebooking_forgiving,
    active_clients: t.active_client_count,
    regulars: t.regulars_count,
    avg_revenue_per_visit: t.avg_revenue_per_visit,
    avg_tip_pct: t.avg_tip_percentage,
    no_show_rate: t.no_show_rate,
    cancellation_rate: t.cancellation_rate,
    attrition_rate_forgiving: t.attrition_rate_forgiving,
    new_clients_total: t.new_clients_total,
    chair_utilization: t.chair_utilization,
  }));

  const payload = {
    barber: barberName,
    snapshot_date: snapshot.snapshot_date,
    current_metrics: currentMetrics,
  };

  if (monthlyHistory.length > 0) {
    payload.monthly_history = monthlyHistory;
  }

  return JSON.stringify(payload, null, 2);
}

/**
 * Parse the detected career stage from the coaching response.
 * Prioritizes the mandated "Career Stage: Stage X" format, then falls back to looser patterns.
 */
function parseDetectedStage(response) {
  // Priority 1: mandated format "Career Stage: Stage X"
  const mandatedMatch = response.match(/Career\s+Stage:\s+Stage\s+(\d)/i);
  if (mandatedMatch) {
    const stage = parseInt(mandatedMatch[1], 10);
    if (stage >= 1 && stage <= 5) return stage;
  }

  // Priority 2: general "Stage X" pattern (e.g. "Stage: 2", "Stage 3")
  const stageMatch = response.match(
    /(?:Career\s+)?Stage[:\s]+(?:Stage\s+)?(\d)/i
  );
  if (stageMatch) {
    const stage = parseInt(stageMatch[1], 10);
    if (stage >= 1 && stage <= 5) return stage;
  }

  // Priority 3: contextual mentions like "solidly in Stage X"
  const inStageMatch = response.match(/(?:in|at|toward)\s+Stage\s+(\d)/i);
  if (inStageMatch) {
    const stage = parseInt(inStageMatch[1], 10);
    if (stage >= 1 && stage <= 5) return stage;
  }

  console.warn("[AI Coach] Could not parse career stage from coaching response");
  return null;
}

/**
 * Request coaching for a barber.
 * Main entry point — checks cooldown, gathers metrics, calls Claude, saves response.
 */
async function requestCoaching(barberGhlId, locationId) {
  const resolvedLocationId = locationId || BARBER_LOCATION_ID;

  // 1. Check cooldown
  const cooldown = await checkCooldown(barberGhlId);
  if (!cooldown.available) {
    return {
      success: false,
      error: "cooldown_active",
      message: "Coaching is on cooldown. Try again after the waiting period.",
      nextAvailableAt: cooldown.nextAvailableAt,
      latestSession: formatSessionResponse(cooldown.latestSession),
    };
  }

  // 2. Fetch current metrics snapshot
  const snapshot = await getLatestSnapshot(barberGhlId, resolvedLocationId);

  // 3. Fetch 6-month trend history
  const trendHistory = await getTrendHistory(
    barberGhlId,
    resolvedLocationId,
    6
  );

  // 4. Build prompts
  const barberName = getBarberName(barberGhlId);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(barberName, snapshot, trendHistory);

  console.log(
    `[AI Coach] Requesting coaching for ${barberName} (${barberGhlId})`
  );
  console.log(
    `[AI Coach] Snapshot date: ${snapshot.snapshot_date}, trend months: ${trendHistory.length}`
  );

  // 5. Call Claude API with prompt caching (30s timeout)
  const startTime = Date.now();
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    },
    { timeout: 30000 }
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const coachingResponse =
    response.content[0]?.text || "No response generated.";
  const detectedStage = parseDetectedStage(coachingResponse);

  console.log(
    `[AI Coach] Response received in ${elapsed}s — ${coachingResponse.length} chars, stage: ${detectedStage || "unknown"}`
  );
  console.log(
    `[AI Coach] Token usage — input: ${response.usage?.input_tokens}, output: ${response.usage?.output_tokens}, cache_read: ${response.usage?.cache_read_input_tokens || 0}, cache_creation: ${response.usage?.cache_creation_input_tokens || 0}`
  );

  // 6. Save to coaching_sessions
  const now = new Date();
  const nextAvailableAt = new Date(
    now.getTime() + 14 * 24 * 60 * 60 * 1000
  ); // +14 days

  const metricsSnapshot = {
    snapshot_date: snapshot.snapshot_date,
    rebooking_rate_forgiving: snapshot.rebooking_rate_forgiving,
    first_visit_rebooking_forgiving: snapshot.first_visit_rebooking_forgiving,
    active_clients: snapshot.active_client_count,
    regulars: snapshot.regulars_count,
    avg_revenue_per_visit: snapshot.avg_revenue_per_visit,
    avg_tip_percentage: snapshot.avg_tip_percentage,
    no_show_rate: snapshot.no_show_rate,
    cancellation_rate: snapshot.cancellation_rate,
    attrition_rate_forgiving: snapshot.attrition_rate_forgiving,
    chair_utilization: snapshot.chair_utilization,
  };

  const { error: insertError } = await supabase
    .from("coaching_sessions")
    .insert({
      barber_ghl_id: barberGhlId,
      location_id: resolvedLocationId,
      metrics_snapshot: metricsSnapshot,
      trend_history: trendHistory.length > 0 ? trendHistory : null,
      coaching_response: coachingResponse,
      detected_stage: detectedStage,
      next_available_at: nextAvailableAt.toISOString(),
    });

  if (insertError) {
    console.error(
      "[AI Coach] Failed to save coaching session:",
      insertError.message
    );
    // Still return the response even if save fails
  }

  return {
    success: true,
    coaching: {
      response: coachingResponse,
      detectedStage,
      requestedAt: now.toISOString(),
      nextAvailableAt: nextAvailableAt.toISOString(),
      metricsSnapshot,
    },
  };
}

/**
 * Get the most recent coaching session for a barber.
 */
async function getLatestCoachingSession(barberGhlId) {
  const { data, error } = await supabase
    .from("coaching_sessions")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .order("requested_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch coaching session: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  return formatSessionResponse(data[0]);
}

/**
 * Format a coaching session for API response.
 */
function formatSessionResponse(session) {
  if (!session) return null;

  const now = new Date();
  const nextAvailable = new Date(session.next_available_at);
  const cooldownActive = now < nextAvailable;
  const cooldownDaysRemaining = cooldownActive
    ? Math.ceil((nextAvailable - now) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    id: session.id,
    response: session.coaching_response,
    detectedStage: session.detected_stage,
    requestedAt: session.requested_at,
    nextAvailableAt: session.next_available_at,
    cooldownActive,
    cooldownDaysRemaining,
    metricsSnapshot: session.metrics_snapshot,
  };
}

module.exports = {
  requestCoaching,
  getLatestCoachingSession,
  checkCooldown,
};
