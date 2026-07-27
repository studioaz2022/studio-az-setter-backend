// objectionLibrary.test.js
// Tests for objection detection and context formatting

const {
  OBJECTIONS,
  GLOBAL_RULES,
  detectObjection,
  formatObjectionContext,
  getObjectionIds,
  getObjectionById,
} = require("../src/prompts/objectionLibrary");
const { detectIntents } = require("../src/ai/intents");

describe("Objection Library", () => {
  describe("OBJECTIONS structure", () => {
    it("should have 10 objection types defined", () => {
      const ids = getObjectionIds();
      expect(ids).toHaveLength(10);
      expect(ids).toContain("price_too_high");
      expect(ids).toContain("need_to_think");
      expect(ids).toContain("ask_partner");
      expect(ids).toContain("fear_first_tattoo");
      expect(ids).toContain("timing_not_ready");
      expect(ids).toContain("design_uncertain");
      expect(ids).toContain("refund_skepticism");
      expect(ids).toContain("talk_to_artist");
      expect(ids).toContain("exact_price_now");
      expect(ids).toContain("reschedule_anxiety");
    });

    it("should have required fields for each objection", () => {
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        expect(objection.id).toBe(id);
        expect(objection.category).toBeDefined();
        expect(objection.trigger_patterns).toBeInstanceOf(Array);
        expect(objection.trigger_patterns.length).toBeGreaterThan(0);
        expect(objection.belief_to_fix).toBeDefined();
        expect(objection.diagnostic_questions).toBeInstanceOf(Array);
        expect(objection.core_reframe).toBeDefined();
        expect(objection.response_templates.en).toBeDefined();
        expect(objection.response_templates.es).toBeDefined();
      }
    });
  });

  describe("detectObjection", () => {
    // Price objections
    it("should detect 'price_too_high' objection in English", () => {
      const result = detectObjection("That's too expensive for me");
      expect(result).not.toBeNull();
      expect(result.id).toBe("price_too_high");
    });

    it("should detect 'price_too_high' objection in Spanish", () => {
      const result = detectObjection("Está muy caro eso");
      expect(result).not.toBeNull();
      expect(result.id).toBe("price_too_high");
    });

    it("should detect 'price_too_high' for 'more than expected'", () => {
      const result = detectObjection("That's more than I expected");
      expect(result).not.toBeNull();
      expect(result.id).toBe("price_too_high");
    });

    // Hesitation objections
    it("should detect 'need_to_think' objection", () => {
      const result = detectObjection("I need to think about it");
      expect(result).not.toBeNull();
      expect(result.id).toBe("need_to_think");
    });

    it("should detect 'need_to_think' in Spanish", () => {
      const result = detectObjection("Déjame pensarlo un poco");
      expect(result).not.toBeNull();
      expect(result.id).toBe("need_to_think");
    });

    // Partner objections
    it("should detect 'ask_partner' objection", () => {
      const result = detectObjection("I need to ask my partner first");
      expect(result).not.toBeNull();
      expect(result.id).toBe("ask_partner");
    });

    // Fear objections
    it("should detect 'fear_first_tattoo' for first tattoo mention", () => {
      const result = detectObjection("It's my first tattoo and I'm nervous");
      expect(result).not.toBeNull();
      expect(result.id).toBe("fear_first_tattoo");
    });

    it("should detect 'fear_first_tattoo' for pain concerns", () => {
      const result = detectObjection("Will it hurt a lot?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("fear_first_tattoo");
    });

    // Timing objections
    it("should detect 'timing_not_ready' objection", () => {
      const result = detectObjection("Not sure when I can do it, maybe later");
      expect(result).not.toBeNull();
      expect(result.id).toBe("timing_not_ready");
    });

    // Design uncertainty
    it("should detect 'design_uncertain' objection", () => {
      const result = detectObjection("What if I don't like the design?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("design_uncertain");
    });

    // Refund skepticism
    it("should detect 'refund_skepticism' objection", () => {
      const result = detectObjection("Is it really refundable though?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("refund_skepticism");
    });

    // Talk to artist
    it("should detect 'talk_to_artist' objection", () => {
      const result = detectObjection("Can I talk to the artist before paying?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("talk_to_artist");
    });

    // Exact price
    it("should detect 'exact_price_now' objection", () => {
      const result = detectObjection("How much will it cost?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("exact_price_now");
    });

    // Reschedule anxiety
    it("should detect 'reschedule_anxiety' objection", () => {
      const result = detectObjection("What if something comes up and I can't make it?");
      expect(result).not.toBeNull();
      expect(result.id).toBe("reschedule_anxiety");
    });

    // Non-objections
    it("should return null for non-objection messages", () => {
      expect(detectObjection("I want a dragon tattoo")).toBeNull();
      expect(detectObjection("Sounds good!")).toBeNull();
      expect(detectObjection("What times do you have?")).toBeNull();
      expect(detectObjection("Yes let's do it")).toBeNull();
    });

    it("should handle empty/null input", () => {
      expect(detectObjection("")).toBeNull();
      expect(detectObjection(null)).toBeNull();
      expect(detectObjection(undefined)).toBeNull();
    });
  });

  describe("formatObjectionContext", () => {
    it("should format objection context for English", () => {
      const objection = getObjectionById("price_too_high");
      const context = formatObjectionContext(objection, "en");
      
      expect(context).toContain("OBJECTION DETECTED: PRICE_TOO_HIGH");
      expect(context).toContain("Belief to Fix");
      expect(context).toContain("Diagnostic Questions");
      expect(context).toContain("Core Reframe");
      expect(context).toContain("Response Template (EN)");
      expect(context).toContain("$100 deposit");
      // The close references the lead's OWN confirmed time — the two-random-times
      // format ("[TIME A] or [TIME B]") was deliberately removed, see
      // GLOBAL_RULES.time_reference_rule.
      expect(context).toContain("or a different time");
      expect(context).toContain("Do NOT offer two random new times");
      expect(context).toContain(objection.closing_touch);
    });

    it("should format objection context for Spanish", () => {
      const objection = getObjectionById("price_too_high");
      const context = formatObjectionContext(objection, "es");

      expect(context).toContain("Response Template (ES)");
      expect(context).toContain("depósito de $100");
      expect(context).toContain("Match their language (Spanish)");
      expect(context).toContain(objection.closing_touch_es);
    });

    it("instructs a soft-close objection NOT to offer times", () => {
      const context = formatObjectionContext(getObjectionById("need_to_think"), "en");
      expect(context).toContain("SOFT CLOSE");
      expect(context).toContain("do NOT give specific times");
    });

    it("carries the refundable-deposit instruction even when the template omits it", () => {
      // exact_price_now's template intentionally does not name the deposit; the
      // requirement lives in the injected rules instead.
      const objection = getObjectionById("exact_price_now");
      expect(objection.response_templates.en.toLowerCase()).not.toContain("deposit");
      expect(formatObjectionContext(objection, "en")).toContain(
        "Mention refundable deposit and that it goes toward the tattoo"
      );
    });

    it("should return empty string for null objection", () => {
      expect(formatObjectionContext(null)).toBe("");
    });
  });

  describe("GLOBAL_RULES", () => {
    it("should have all required global rules", () => {
      expect(GLOBAL_RULES.structure).toBeDefined();
      expect(GLOBAL_RULES.response_format).toBeDefined();
      // The close now mirrors the lead's own confirmed time instead of always
      // presenting two fresh options.
      expect(GLOBAL_RULES.required_ending).toContain("or a different time");
      expect(GLOBAL_RULES.close_rule).toContain("or a different time");
      expect(GLOBAL_RULES.time_reference_rule).toContain(
        "Don't offer two new random times"
      );
      expect(GLOBAL_RULES.financing_rule).toContain(
        "NEVER mention financing for the $100 deposit"
      );
    });

    it("never reintroduces the two-random-times close", () => {
      // Guard against a regression back to the old rigid format.
      const allRules = Object.values(GLOBAL_RULES).filter((v) => typeof v === "string").join(" ");
      expect(allRules).not.toContain("TIME A");
      expect(allRules).not.toContain("TIME B");
    });
  });

  describe("Intent Integration", () => {
    it("should set objection_intent true when objection detected", () => {
      const intents = detectIntents("That's too expensive for me", {});
      expect(intents.objection_intent).toBe(true);
      expect(intents.objection_type).toBe("price_too_high");
      expect(intents.objection_data).not.toBeNull();
      expect(intents.objection_data.id).toBe("price_too_high");
    });

    it("should set objection fields to null when no objection", () => {
      const intents = detectIntents("I want a rose tattoo on my arm", {});
      expect(intents.objection_intent).toBe(false);
      expect(intents.objection_type).toBeNull();
      expect(intents.objection_data).toBeNull();
    });

    it("should detect objection alongside other intents", () => {
      // This message has both a price question AND could be seen as objection
      const intents = detectIntents("How much does it cost? That sounds expensive", {});
      expect(intents.objection_intent).toBe(true);
      expect(intents.process_or_price_question_intent).toBe(true);
    });
  });
});

describe("Objection Response Templates", () => {
  describe("Template Quality", () => {
    // Jest's expect() takes a single argument, so these collect offending
    // objection ids and assert on the list — a failure then names the culprit.

    it("every objection ships both languages and a closing touch in each", () => {
      const incomplete = Object.entries(OBJECTIONS)
        .filter(
          ([, o]) =>
            !o.response_templates?.en ||
            !o.response_templates?.es ||
            !o.closing_touch ||
            !o.closing_touch_es
        )
        .map(([id]) => id);
      expect(incomplete).toEqual([]);
    });

    it("hard-close objections move toward a time; soft-close ones deliberately do not", () => {
      const offenders = Object.entries(OBJECTIONS)
        .filter(([, o]) =>
          o.soft_close === true
            ? // A soft close asks whether they want times at all — it must not
              // presume a booking.
              !/times|schedule|look up/.test(o.closing_touch.toLowerCase())
            : // A hard close ends on a question that advances to the consult.
              !o.closing_touch.trim().endsWith("?")
        )
        .map(([id]) => id);
      expect(offenders).toEqual([]);
    });

    it("no template hardcodes a two-option time close", () => {
      const offenders = Object.entries(OBJECTIONS)
        .filter(([, o]) =>
          ["en", "es"].some((lang) => {
            const t = o.response_templates[lang].toLowerCase();
            return t.includes("[time a]") || t.includes("[time b]");
          })
        )
        .map(([id]) => id);
      expect(offenders).toEqual([]);
    });

    it("no template offers financing for the deposit", () => {
      // GLOBAL_RULES.financing_rule: financing applies to the tattoo TOTAL only.
      const offenders = [];
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        for (const lang of ["en", "es"]) {
          const t = objection.response_templates[lang].toLowerCase();
          if (
            /financ\w*[^.]{0,40}(deposit|depósito)/.test(t) ||
            /(deposit|depósito)[^.]{0,40}financ\w*/.test(t)
          ) {
            offenders.push(`${id}.${lang}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

