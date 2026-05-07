# Insight: /consultation form-start drop-off

**Date discovered:** May 6, 2026
**Status:** Fix shipped (May 6) — verification pending (re-check May 13)
**Loop iteration:** #1 (first run of the Insight Loop on this site)

---

## The Anomaly

Of 19 visitors who landed on `/consultation` in the last 7 days, only **1 (5.3%)** started the multi-step form (`consultation_started` event fired). The other 18 viewed the page, lingered, and left without engaging.

**Industry benchmark for landing→form-start:** 15-25%. We're at ~1/3 of normal floor.

**Source:** GA4 Data API + `runFunnelReport` (v1alpha) for the consultation funnel.

---

## Hypotheses

| # | Hypothesis | Likelihood Going In |
|---|------------|---------------------|
| 1 | Bot traffic inflating the page-view count (denominator wrong) | Medium |
| 2 | Slow page load → people bail before form mounts | Medium |
| 3 | Page is being treated as info content, not a CTA | High |
| 4 | Language picker doesn't visually read as "click here to start" | High |
| 5 | Confusing entry source — wrong-intent traffic landing here | Low (we control internal links) |

---

## Investigation

| Hypothesis | Query Run | Finding |
|------------|-----------|---------|
| 1. Bots | GA4 deviceCategory + browser breakdown for /consultation visitors | All mobile (Safari 7, Chrome 1). Real cities (Minneapolis 4, Chicago 2, MN suburbs). **Not bots.** |
| 2. Slow load | GA4 averageSessionDuration on /consultation | 2 min 43 sec. Bounce rate 20%. **They're staying long enough — not a load-time bail.** |
| 3. Treated as info | GA4 user_engagement + scroll events on /consultation | 8 of 8 fired user_engagement; 3 scrolled. **They're engaging with the page but not the form.** Strong support. |
| 4. Picker not as CTA | Same as #3 + visual review | First-screen content is just "Choose Your Language" + 2 flag images. No headline, no step indicator, no instruction. **Strong support.** |
| 5. Wrong-intent traffic | GA4 pageReferrer breakdown | Internal nav from / (5), /artists/joan (4), /artists/andrew (3), /artists (4), direct (2). **Quality traffic.** Not the cause. |

---

## Diagnosis

Hypotheses 3 + 4 are the cause, working together: visitors land on the page, see two flag images with no framing, scroll around looking for content, find none, and leave. They never realized the flags ARE the form.

The fix isn't technical (no bots, no load issue). It's UX framing.

---

## Fix Recommended

Add above-the-fold framing that signals "this is a form you start by clicking a flag below."

- **Headline:** "Start Your Free Consultation • Inicia Tu Consulta Gratis"
- **Subhead:** "Takes about 2-3 minutes. Custom design conversation. No commitment until you book."
- **Step indicator:** "Step 1 of 9 — Pick your language to begin / Elige tu idioma"

Only show on the first step (`q_language`); hide for subsequent steps.

---

## Fix Shipped

- **Implemented in:** [Future commit hash — TBD when shipped]
- **Date:** 2026-05-06
- **What changed:** Added intro section above `q_language` step in `tattoo-website/src/app/(site)/consultation/page.tsx`
- **What did NOT change:** Form logic, language flag UI, analytics events, downstream funnel steps

---

## Verification (PENDING — check 2026-05-13)

**Re-run query:**
```bash
# Funnel last 7d
curl -s -X POST -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  --url-query "" "https://analyticsdata.googleapis.com/v1alpha/properties/511557077:runFunnelReport" \
  -d '{
    "dateRanges":[{"startDate":"7daysAgo","endDate":"today"}],
    "funnel":{
      "steps":[
        {"name":"Visited","filterExpression":{"funnelEventFilter":{"eventName":"page_view","funnelParameterFilterExpression":{"funnelParameterFilter":{"eventParameterName":"page_location","stringFilter":{"matchType":"CONTAINS","value":"/consultation"}}}}}},
        {"name":"Started","filterExpression":{"funnelEventFilter":{"eventName":"consultation_started"}}}
      ]
    }
  }'
```

**Success criteria:** form-start rate moves from 5% → 20%+. Anything <15% means the fix didn't land — re-investigate.

**Failure paths to consider if rate doesn't move:**
- Try copy variations
- Test removing the flags entirely and using buttons that say "Start in English / Empezar en Español"
- Investigate whether `/consultation` is being shared as a link without context (pre-form preview text)

---

## What we learned

This investigation confirmed the [Insight Loop Pattern](../../../../../../.claude/projects/-Users-studioaz-Documents-Studio-AZ-Tattoo-App/memory/insight_loop_pattern.md) works in practice:
- Started with raw anomaly (5.3% form-start)
- Listed 5 hypotheses — including the ones that turned out to be wrong (bots, slow load) so they could be ruled out via data, not gut feeling
- Found 2 cooperating hypotheses (info-treatment + picker-not-as-CTA)
- Shipped one fix that addresses both with the same change
- Set verification window so we can know whether the fix worked

This is the loop we want to repeat weekly going forward.
