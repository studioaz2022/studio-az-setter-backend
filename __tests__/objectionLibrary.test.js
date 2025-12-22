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
      expect(context).toContain("[TIME A] or [TIME B]");
    });

    it("should format objection context for Spanish", () => {
      const objection = getObjectionById("price_too_high");
      const context = formatObjectionContext(objection, "es");
      
      expect(context).toContain("Response Template (ES)");
      expect(context).toContain("depósito de $100");
      expect(context).toContain("[TIME A] o [TIME B]");
    });

    it("should return empty string for null objection", () => {
      expect(formatObjectionContext(null)).toBe("");
    });
  });

  describe("GLOBAL_RULES", () => {
    it("should have all required global rules", () => {
      expect(GLOBAL_RULES.structure).toBeDefined();
      expect(GLOBAL_RULES.response_format).toBeDefined();
      expect(GLOBAL_RULES.required_ending).toContain("TIME A / TIME B");
      expect(GLOBAL_RULES.financing_rule).toContain("NEVER for consult deposit");
      expect(GLOBAL_RULES.close_rule).toContain("Always use TIME A / TIME B");
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
    it("all English templates should end with time choice", () => {
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        const template = objection.response_templates.en.toLowerCase();
        const hasTimeChoice = 
          template.includes("[time a]") || 
          template.includes("time a") ||
          template.includes("which works");
        expect(hasTimeChoice).toBe(true);
      }
    });

    it("all Spanish templates should end with time choice", () => {
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        const template = objection.response_templates.es.toLowerCase();
        const hasTimeChoice = 
          template.includes("[time a]") || 
          template.includes("time a") ||
          template.includes("cuál") ||
          template.includes("prefieres");
        expect(hasTimeChoice).toBe(true);
      }
    });

    it("all templates should mention the deposit", () => {
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        const enTemplate = objection.response_templates.en.toLowerCase();
        const esTemplate = objection.response_templates.es.toLowerCase();
        
        expect(
          enTemplate.includes("deposit") || 
          enTemplate.includes("$100")
        ).toBe(true);
        
        expect(
          esTemplate.includes("depósito") || 
          esTemplate.includes("$100")
        ).toBe(true);
      }
    });

    it("all templates should mention refundable", () => {
      for (const [id, objection] of Object.entries(OBJECTIONS)) {
        const enTemplate = objection.response_templates.en.toLowerCase();
        const esTemplate = objection.response_templates.es.toLowerCase();
        
        expect(enTemplate.includes("refund")).toBe(true);
        expect(esTemplate.includes("reembols")).toBe(true);
      }
    });
  });
});

