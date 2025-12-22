// objectionLibrary.js
// Parses and exports the AI Setter Objection Library for intent detection and AI context injection

const fs = require("fs");
const path = require("path");

/**
 * Structured objection definitions parsed from the library
 * Each entry contains patterns, beliefs, reframes, and response templates
 */
const OBJECTIONS = {
  price_too_high: {
    id: "price_too_high",
    category: "price",
    trigger_patterns: [
      /too expensive/i,
      /está muy caro/i,
      /muy caro/i,
      /more than (i |I )?expected/i,
      /can('t| not)? afford/i,
      /out of (my )?budget/i,
      /work with my budget/i,
      /something cheaper/i,
      /más barato/i,
      /no tengo (tanto|suficiente)/i,
      /that's a lot/i,
      /too much (money)?/i,
    ],
    belief_to_fix: "They believe price > value or fear committing financially without clarity.",
    diagnostic_questions: [
      "Is the concern more about the total tattoo cost, or just making the right decision?",
      "How important is getting this done right from 1–10?",
    ],
    core_reframe: "Shift from price → clarity + permanence + risk removal. Mention financing for tattoo total.",
    closing_touch: "so you can get a real estimate?",
    closing_touch_es: "para que te den un estimado real?",
    response_templates: {
      en: "Totally get it — custom work is an investment and it's permanent. The smartest way to decide is a short consult so the artist can size it properly and give you a real estimate. We just hold it with a $100 deposit that goes toward the tattoo and is fully refundable if you don't love the concept. We also offer financing for the tattoo total if that helps. Want me to grab [CONFIRMED TIME] or a different time so you can get a real estimate?",
      es: "Te entiendo — un trabajo personalizado es una inversión y es permanente. La mejor forma de decidir es una consulta corta para que el artista lo mida bien y te dé un precio real. Solo se asegura con un depósito de $100 que se aplica al tatuaje y es totalmente reembolsable si no te gusta la idea. También ofrecemos financiamiento para el total del tatuaje si eso ayuda. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que te den un estimado real?",
    },
    financing_hook: "Mention financing for tattoo total (NOT the deposit)",
    lead_temperature_effect: "warm_if_engaging",
  },

  need_to_think: {
    id: "need_to_think",
    category: "hesitation",
    trigger_patterns: [
      /need to think/i,
      /let me think/i,
      /déjame pensarlo/i,
      /tengo que pensarlo/i,
      /i('ll| will) get back/i,
      /te aviso/i,
      /give me (some )?time/i,
      /not sure yet/i,
      /still deciding/i,
      /need (some )?time/i,
    ],
    belief_to_fix: "They want certainty before committing.",
    diagnostic_questions: [
      "What part are you still deciding — design, timing, or budget?",
    ],
    core_reframe: "The consult is the clarity step; deposit removes risk.",
    closing_touch: "Would you like me to look up some times for you?",
    closing_touch_es: "¿Quieres que te busque algunos horarios?",
    soft_close: true, // This objection uses a soft close, not a binary time choice
    response_templates: {
      en: "Of course — totally fair. Is what you're thinking about more the design, timing, or budget? The consult answers all of that, and the deposit is refundable if it doesn't feel right. Would you like me to look up some times for you?",
      es: "Claro — es normal. ¿Estás decidiendo más el diseño, la fecha o el presupuesto? La consulta te da esa claridad y el depósito es reembolsable. ¿Quieres que te busque algunos horarios?",
    },
    financing_hook: false,
    lead_temperature_effect: "warming",
  },

  ask_partner: {
    id: "ask_partner",
    category: "external_validation",
    trigger_patterns: [
      /ask (my )?(partner|spouse|husband|wife|boyfriend|girlfriend)/i,
      /tengo que consultar/i,
      /preguntarle a/i,
      /show (it to )?(someone|my)/i,
      /check with/i,
      /talk to (my )?/i,
      /run it by/i,
    ],
    belief_to_fix: "They want validation or fear judgment.",
    diagnostic_questions: [
      "What do you think they'll want to know most — design or price?",
    ],
    core_reframe: "Consult gives something concrete to show.",
    closing_touch: "so you have something solid to show them?",
    closing_touch_es: "para que tengas algo concreto que mostrarles?",
    response_templates: {
      en: "That makes total sense. The consult gives you a real design direction and a ballpark, which makes that conversation easier. It's held with a refundable $100 deposit. Want me to grab [CONFIRMED TIME] or a different time so you have something solid to show them?",
      es: "Tiene sentido. La consulta te da una dirección real del diseño y un estimado para explicarlo mejor. Se asegura con un depósito reembolsable de $100. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que tengas algo concreto que mostrarles?",
    },
    financing_hook: false,
    lead_temperature_effect: "warm",
  },

  fear_first_tattoo: {
    id: "fear_first_tattoo",
    category: "fear",
    trigger_patterns: [
      /first tattoo/i,
      /mi primer tatuaje/i,
      /primera vez/i,
      /will it hurt/i,
      /does it hurt/i,
      /duele (mucho)?/i,
      /tengo (miedo|nervios)/i,
      /i('m| am) nervous/i,
      /scared/i,
      /piel sensible/i,
      /sensitive skin/i,
      /afraid/i,
      /worried about (the )?pain/i,
    ],
    belief_to_fix: "Fear of pain or the unknown.",
    diagnostic_questions: [
      "Is the concern more about pain or healing?",
    ],
    core_reframe: "Normalize fear → consult removes uncertainty.",
    closing_touch: "to talk through everything before committing?",
    closing_touch_es: "para hablar de todo antes de comprometerte?",
    response_templates: {
      en: "Totally normal — almost everyone feels that way at first. The consult lets you talk through pain, placement, and healing before committing. It's held with a refundable $100 deposit. Want me to grab [CONFIRMED TIME] or a different time to talk through everything before committing?",
      es: "Es totalmente normal. En la consulta pueden hablar de dolor, colocación y cuidados antes de comprometerte. Se asegura con un depósito reembolsable de $100. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para hablar de todo antes de comprometerte?",
    },
    financing_hook: false,
    lead_temperature_effect: "warming",
  },

  timing_not_ready: {
    id: "timing_not_ready",
    category: "timing",
    trigger_patterns: [
      /not sure when/i,
      /maybe later/i,
      /no sé cuándo/i,
      /más adelante/i,
      /sometime (in the )?future/i,
      /not ready (yet)?/i,
      /no estoy list[oa]/i,
      /down the (road|line)/i,
      /eventually/i,
      /algún día/i,
    ],
    belief_to_fix: "They think booking = choosing an exact date now.",
    diagnostic_questions: [
      "Are you thinking soon, or just exploring ideas?",
    ],
    core_reframe: "Deposit secures the artist, not the date.",
    closing_touch: "to at least lock in your artist?",
    closing_touch_es: "para al menos asegurar a tu artista?",
    response_templates: {
      en: "Totally understandable. The deposit doesn't lock you into a date — it just reserves your artist. Want me to grab [CONFIRMED TIME] or a different time to at least lock in your artist?",
      es: "Se entiende. El depósito no te obliga a una fecha — solo asegura al artista. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para al menos asegurar a tu artista?",
    },
    financing_hook: false,
    lead_temperature_effect: "warm",
  },

  design_uncertain: {
    id: "design_uncertain",
    category: "uncertainty",
    trigger_patterns: [
      /what if (i |I )?don('t| not) like/i,
      /y si no me gusta/i,
      /need to see (something|it) first/i,
      /quiero ver(lo)? primero/i,
      /not sure (about )?(the )?design/i,
      /no estoy segur[oa]/i,
      /can (i|I) see/i,
      /how (do i|will I) know/i,
    ],
    belief_to_fix: "They think deposit locks them into a design.",
    diagnostic_questions: [
      "Is it the concept, size, or style you're unsure about?",
    ],
    core_reframe: "Nothing is permanent until approval.",
    closing_touch: "so you can see it for real?",
    closing_touch_es: "para que lo veas de verdad?",
    response_templates: {
      en: "Nothing is permanent until you approve the design 100%. The deposit just lets the artist start designing — and it's refunded if you don't like the direction. Want me to grab [CONFIRMED TIME] or a different time so you can see it for real?",
      es: "Nada es permanente hasta que apruebes el diseño al 100%. El depósito solo permite que el artista empiece a diseñar y se reembolsa si no te gusta la dirección. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que lo veas de verdad?",
    },
    financing_hook: false,
    lead_temperature_effect: "hot",
  },

  refund_skepticism: {
    id: "refund_skepticism",
    category: "trust",
    trigger_patterns: [
      /is it really refundable/i,
      /sí es reembolsable/i,
      /what if (i |I )?change (my )?mind/i,
      /can (i|I) get (my )?money back/i,
      /puedo recuperar/i,
      /really get (it )?refunded/i,
      /actually refundable/i,
      /how does the refund/i,
    ],
    belief_to_fix: "Fear of losing money unfairly.",
    diagnostic_questions: [
      "What part makes you unsure?",
    ],
    core_reframe: "Transparency + safety.",
    closing_touch: "to lock in that spot?",
    closing_touch_es: "para asegurar ese horario?",
    response_templates: {
      en: "Yes — if the design or fit isn't right, it's fully refunded. No tricks. It just secures your consult time. Want me to grab [CONFIRMED TIME] or a different time to lock in that spot?",
      es: "Sí — si el diseño o el ajuste no es el correcto, se reembolsa totalmente. Solo asegura tu tiempo de consulta. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para asegurar ese horario?",
    },
    financing_hook: false,
    lead_temperature_effect: "hot",
  },

  talk_to_artist: {
    id: "talk_to_artist",
    category: "trust",
    trigger_patterns: [
      /talk to the artist (first|before)/i,
      /hablar con el artista (antes|primero)/i,
      /speak (to |with )?(the )?artist/i,
      /can (i|I) talk to/i,
      /puedo hablar con/i,
      /meet the artist/i,
      /conocer al artista/i,
    ],
    belief_to_fix: "They think they're paying to talk to a middleman.",
    diagnostic_questions: [
      "Is it important for you to explain the idea directly?",
    ],
    core_reframe: "Consult is with the artist; deposit reserves time.",
    closing_touch: "so the artist can prepare your idea?",
    closing_touch_es: "para que el artista pueda preparar tu idea?",
    response_templates: {
      en: "The consult is directly with the artist — the deposit just reserves their time so they can prepare your idea. And it's refundable if it's not the right fit. Want me to grab [CONFIRMED TIME] or a different time so the artist can prepare your idea?",
      es: "La consulta es directamente con el artista. El depósito solo reserva su tiempo y es reembolsable. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que el artista pueda preparar tu idea?",
    },
    financing_hook: false,
    lead_temperature_effect: "warm",
  },

  exact_price_now: {
    id: "exact_price_now",
    category: "price_clarity",
    trigger_patterns: [
      /give me (a |an |the )?(exact )?price/i,
      /dime el precio exacto/i,
      /how much (is it|will it (be|cost))/i,
      /cuánto (cuesta|va a costar|sería)/i,
      /what('s| is) the (total )?price/i,
      /need (a |the )?price (first|now|before)/i,
      /price before (i |I )?/i,
      /ballpark/i,
    ],
    belief_to_fix: "They think pricing is being hidden.",
    diagnostic_questions: [
      "Is it size or placement you're unsure about?",
    ],
    core_reframe: "Accuracy over guessing.",
    closing_touch: "so the artist can give you a real number?",
    closing_touch_es: "para que el artista te dé un número real?",
    response_templates: {
      en: "Size, detail, and placement change pricing a lot — I don't want to mislead you with a guess. The consult gives you a real number from the artist. Want me to grab [CONFIRMED TIME] or a different time so the artist can give you a real number?",
      es: "El tamaño, detalle y colocación cambian mucho el precio. La consulta te da un número real del artista. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que el artista te dé un número real?",
    },
    financing_hook: false,
    lead_temperature_effect: "warm",
  },

  reschedule_anxiety: {
    id: "reschedule_anxiety",
    category: "flexibility",
    trigger_patterns: [
      /what if something comes up/i,
      /y si necesito cambiar/i,
      /can (i|I) reschedule/i,
      /puedo cambiar la cita/i,
      /what if (i |I )?can('t| not) make it/i,
      /flexibility/i,
      /change the (date|time|appointment)/i,
      /busy schedule/i,
      /things come up/i,
    ],
    belief_to_fix: "Fear of losing money if plans change.",
    diagnostic_questions: [
      "Is flexibility important for you?",
    ],
    core_reframe: "Reschedule window + refund safety.",
    closing_touch: "so you're covered?",
    closing_touch_es: "para que estés cubierto?",
    response_templates: {
      en: "Totally get that — life happens. You can reschedule within our window, and if the design isn't right, the deposit is refunded. Want me to grab [CONFIRMED TIME] or a different time so you're covered?",
      es: "Se entiende — pueden pasar cosas. Puedes reprogramar y el depósito se reembolsa si el diseño no es el correcto. ¿Te reservo [CONFIRMED TIME] o prefieres otro horario para que estés cubierto?",
    },
    financing_hook: false,
    lead_temperature_effect: "warm",
  },
};

/**
 * Global rules that apply to ALL objection handling
 */
const GLOBAL_RULES = {
  structure: "belief_to_fix → diagnostic_questions → core_reframe → response_templates",
  response_format: "1–3 short message bubbles",
  language_matching: true,
  required_ending: "If they have a confirmed/preferred time: '[CONFIRMED TIME] or a different time' + objection-specific closing touch. If no time yet: soft close asking if they want times.",
  financing_rule: "Financing for tattoo TOTAL can be mentioned (especially for price objections). NEVER mention financing for the $100 deposit.",
  close_rule: "Reference their confirmed time if they have one, followed by 'or a different time' + the objection-specific closing touch.",
  time_reference_rule: "If lead already selected or confirmed a time, reference THAT specific time + 'or a different time'. Don't offer two new random times.",
};

/**
 * Detect which objection type matches the message
 * @param {string} messageText - The lead's message
 * @returns {object|null} The matched objection entry or null
 */
function detectObjection(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return null;
  }

  const text = messageText.toLowerCase();

  for (const [objectionId, objection] of Object.entries(OBJECTIONS)) {
    for (const pattern of objection.trigger_patterns) {
      if (pattern.test(text)) {
        console.log(`🎯 [OBJECTION] Detected "${objectionId}" from pattern: ${pattern}`);
        return objection;
      }
    }
  }

  return null;
}

/**
 * Get the formatted objection context for injection into AI prompt
 * @param {object} objection - The objection entry
 * @param {string} language - "en" or "es"
 * @returns {string} Formatted context for the AI
 */
function formatObjectionContext(objection, language = "en") {
  if (!objection) return "";

  const lang = language === "es" ? "es" : "en";
  const template = objection.response_templates[lang] || objection.response_templates.en;
  const closingTouch = lang === "es" ? objection.closing_touch_es : objection.closing_touch;
  const isSoftClose = objection.soft_close === true;

  return `
**🚨 OBJECTION DETECTED: ${objection.id.toUpperCase()}**
Category: ${objection.category}

**Belief to Fix:**
${objection.belief_to_fix}

**Diagnostic Questions (use 1 if needed):**
${objection.diagnostic_questions.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

**Core Reframe:**
${objection.core_reframe}

**Closing Touch for This Objection:**
"${closingTouch}"

**Response Template (${lang.toUpperCase()}):**
"${template}"

**MANDATORY RULES FOR THIS OBJECTION:**
1. Keep response to 1-3 short bubbles
2. Address their underlying belief, not just the surface objection
3. Use the core reframe to shift their perspective
4. ${isSoftClose 
    ? "This is a SOFT CLOSE objection — do NOT give specific times. Just ask: \"" + closingTouch + "\""
    : "If they already have a confirmed/preferred time: reference THAT time + 'or a different time' + closing touch: \"" + closingTouch + "\""
  }
5. Mention refundable deposit and that it goes toward the tattoo
6. Match their language (${lang === "es" ? "Spanish" : "English"})
7. ${objection.financing_hook === false ? "DO NOT mention financing for the deposit" : objection.financing_hook}

**TIME REFERENCE RULE (CRITICAL):**
- If lead already selected or confirmed a time in the conversation, reference THAT specific time
- Format: "[Their confirmed time] or a different time ${closingTouch}"
- Example: "Want me to grab Tuesday at 3pm or a different time ${closingTouch}"
- Do NOT offer two random new times — that's redundant

**DO NOT:**
- Ask vague closes like "want me to reserve?"
- Offer two new random times if they already picked one
- Repeat their objection back verbatim
- Sound defensive or apologetic
`;
}

/**
 * Load the raw objection library text (for full context injection if needed)
 */
function loadRawObjectionLibrary() {
  try {
    const libPath = path.join(__dirname, "../../AI_Setter_Objection_Library.txt");
    return fs.readFileSync(libPath, "utf8");
  } catch (err) {
    console.error("❌ Failed to load objection library:", err.message);
    return null;
  }
}

/**
 * Get all objection IDs for reference
 */
function getObjectionIds() {
  return Object.keys(OBJECTIONS);
}

/**
 * Get a specific objection by ID
 */
function getObjectionById(id) {
  return OBJECTIONS[id] || null;
}

module.exports = {
  OBJECTIONS,
  GLOBAL_RULES,
  detectObjection,
  formatObjectionContext,
  loadRawObjectionLibrary,
  getObjectionIds,
  getObjectionById,
};

