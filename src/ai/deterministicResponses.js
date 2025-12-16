// deterministicResponses.js
// Deterministic system responses for hard-skip scenarios (scheduling, slots, etc.)

const crypto = require("crypto");

const {
  generateSuggestedSlots,
  getAvailableSlots,
  formatSlotDisplay,
  parseTimeSelection,
  createConsultAppointment,
} = require("./bookingController");
const { updateSystemFields, sendConversationMessage, getContact } = require("../../ghlClient");
const { createDepositLinkForContact } = require("../payments/squareClient");
const { DEPOSIT_CONFIG } = require("../config/constants");
const { updateAppointmentStatus } = require("../clients/ghlCalendarClient");
const { parseJsonField } = require("./phaseContract");

/**
 * Extract time preferences from user message
 * Detects: "next week", "this week", day names, time windows
 */
function extractTimePreferences(messageText) {
  const text = String(messageText || "").toLowerCase();
  let preferredWeek = null;
  let preferredDay = null;
  let preferredTimeWindow = null;
  let preferredMonth = null;
  let preferredYear = null;

  const monthMatch = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i
  );
  if (monthMatch) {
    const monthToken = monthMatch[1].toLowerCase().slice(0, 3);
    const mapped = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    }[monthToken];
    if (mapped !== undefined) {
      preferredMonth = mapped;
    }
  }

  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    preferredYear = parseInt(yearMatch[1], 10);
  }

  // Detect week preference
  if (/next week/i.test(text)) {
    preferredWeek = "next";
  } else if (/this week/i.test(text)) {
    preferredWeek = "this";
  }

  // Detect time window
  if (/morning/i.test(text)) preferredTimeWindow = "morning";
  else if (/afternoon/i.test(text)) preferredTimeWindow = "afternoon";
  else if (/evening|night/i.test(text)) preferredTimeWindow = "evening";

  // Detect day preference
  const dayMatch = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch) preferredDay = dayMatch[1].toLowerCase();

  return { preferredWeek, preferredDay, preferredTimeWindow, preferredMonth, preferredYear };
}

function shortSha1(value) {
  try {
    return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

async function persistLastSentSlots(contactId, slots = []) {
  if (!contactId || !slots || slots.length === 0) return;
  try {
    const slotsJson = JSON.stringify(slots);
    const bytes = Buffer.byteLength(slotsJson, "utf8");
    console.log("🧾 [SLOT PERSIST] Writing last_sent_slots", {
      contactId,
      slotsCount: slots.length,
      bytes,
      sha1: shortSha1(slotsJson),
      preview: slots.slice(0, 4).map((s) => ({
        startTime: s?.startTime || null,
        endTime: s?.endTime || null,
        calendarId: s?.calendarId || null,
        displayText: s?.displayText || null,
      })),
    });

    const res = await updateSystemFields(contactId, {
      last_sent_slots: slotsJson,
      times_sent: true,
    });
    console.log("🧾 [SLOT PERSIST] updateSystemFields result", {
      contactId,
      ok: !!res,
    });
    console.log(`✅ [SLOT PERSIST] Saved ${slots.length} slots to GHL for contact ${contactId}`);

    if (String(process.env.DEBUG_SLOT_PERSIST_READBACK || "").toLowerCase() === "true") {
      try {
        const verifyContact = await getContact(contactId);
        const verifyCf = verifyContact?.customField || verifyContact?.customFields || {};
        const stored =
          verifyCf.last_sent_slots || verifyCf.lastSentSlots || verifyCf["Last Sent Slots"] || null;
        console.log("🧾 [SLOT PERSIST] Readback", {
          contactId,
          present: !!stored,
          type: Array.isArray(stored) ? "array" : typeof stored,
          len:
            typeof stored === "string"
              ? stored.length
              : Array.isArray(stored)
              ? stored.length
              : stored && typeof stored === "object"
              ? Object.keys(stored).length
              : 0,
          sha1: typeof stored === "string" ? shortSha1(stored) : null,
        });
      } catch (readErr) {
        console.error("❌ [SLOT PERSIST] Readback failed:", readErr.message || readErr);
      }
    }
  } catch (err) {
    console.error("❌ Failed to persist last_sent_slots:", err.message || err);
  }
}

async function buildDeterministicResponse({
  intents = {},
  derivedPhase = null,
  canonicalState = {},
  contact = {},
  channelContext = {},
  messageText = "",
  changedFields = {},
}) {
  const contactId = contact?.id || contact?._id || null;
  const depositPaid = canonicalState.depositPaid === true;
  const consultExplained = canonicalState.consultExplained === true || canonicalState.consultExplained === "Yes";
  const lastSentSlots = Array.isArray(canonicalState.lastSentSlots)
    ? canonicalState.lastSentSlots
    : [];
  const holdAppointmentId = canonicalState.holdAppointmentId || null;
  const upcomingAppointmentId = canonicalState.upcomingAppointmentId || holdAppointmentId || null;
  const channelContextResolved = channelContext || {};

  const offerSlots = async (internalNotes = "deterministic_scheduling_slots", userMessage = "") => {
    // Extract time preferences from user message
    const timePrefs = extractTimePreferences(userMessage || messageText);
    console.log(`📅 [SLOT OFFER] Time preferences extracted:`, timePrefs);

    let slots = [];
    try {
      slots = await getAvailableSlots({
        canonicalState,
        context: { 
          contact,
          preferredDay: timePrefs.preferredDay,
          preferredTimeWindow: timePrefs.preferredTimeWindow,
          preferredWeek: timePrefs.preferredWeek,
          preferredMonth: timePrefs.preferredMonth,
          preferredYear: timePrefs.preferredYear,
        },
      });
    } catch (err) {
      console.error("❌ Error generating suggested slots:", err.message || err);
    }

    const slotsToShow = Array.isArray(slots) ? slots.slice(0, 4) : [];

    if (slotsToShow.length > 0) {
      const lines = slotsToShow.map((slot, idx) => {
        const label = `${idx + 1})`;
        const display = slot.displayText
          ? slot.displayText
          : formatSlotDisplay
          ? formatSlotDisplay(new Date(slot.startTime))
          : slot.startTime;
        return `${label} ${display}`;
      });

      const message = `I pulled a few openings for a consult with an artist:\n${lines.join("\n")}\n\nWhich works best?`;

      await persistLastSentSlots(contactId, slotsToShow);

      return {
        language: "en",
        bubbles: [message],
        internal_notes: internalNotes,
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {
          consult_explained: true,
        },
      };
    }

    const fallback =
      "I can hold a spot—what day(s) this week and what time window works best (morning / afternoon / evening)?";
    return {
      language: "en",
      bubbles: [fallback],
      internal_notes: "deterministic_scheduling_fallback",
      meta: {
        aiPhase: derivedPhase || null,
        leadTemperature: null,
      },
      field_updates: {
        consult_explained: true,
      },
    };
  };

  // Translator affirmation: mark confirmed and proceed to scheduling
  if (intents.translator_affirm_intent) {
    if (contactId) {
      try {
        await updateSystemFields(contactId, {
          translator_confirmed: true,
          translator_needed: true,
          consultation_type: "appointment",
          consultation_type_locked: true,
        });
      } catch (err) {
        console.error("❌ Failed to persist translator confirmation:", err.message || err);
      }
    }
    return await offerSlots("deterministic_translator_confirmed_slots");
  }

  // Scheduling intent: offer slots immediately
  if (intents.scheduling_intent) {
    return await offerSlots();
  }

  // Slot selection intent: confirm slot, create hold, send deposit link
  if (intents.slot_selection_intent) {
    // === Slot Recovery: fetch from GHL if missing in webhook ===
    let recoveredSlots = lastSentSlots;
    if (recoveredSlots.length === 0 && canonicalState.timesSent && contactId) {
      console.log("🔄 [SLOT RECOVERY] lastSentSlots empty but timesSent=true, fetching from GHL...");
      try {
        const freshContact = await getContact(contactId);
        const cf = freshContact?.customField || freshContact?.customFields || {};
        
        // Try multiple possible field names/keys
        const rawSlots = cf.last_sent_slots || cf.lastSentSlots || cf["Last Sent Slots"] || null;
        const rawSlotsSourceKey =
          (cf.last_sent_slots && "last_sent_slots") ||
          (cf.lastSentSlots && "lastSentSlots") ||
          (cf["Last Sent Slots"] && "Last Sent Slots") ||
          null;
        
        // Log available fields for debugging
        const cfKeys = Object.keys(cf || {});
        console.log(`📋 [SLOT RECOVERY] Contact has ${cfKeys.length} custom fields. Looking for slot data...`);
        if (rawSlots) {
          const rawType = Array.isArray(rawSlots) ? "array" : typeof rawSlots;
          const rawLen =
            typeof rawSlots === "string"
              ? rawSlots.length
              : Array.isArray(rawSlots)
              ? rawSlots.length
              : rawSlots && typeof rawSlots === "object"
              ? Object.keys(rawSlots).length
              : 0;
          console.log("📋 [SLOT RECOVERY] Found last_sent_slots field", {
            sourceKey: rawSlotsSourceKey,
            type: rawType,
            len: rawLen,
          });
        }
        
        // Try to find any field that looks like slot data (JSON array)
        if (!rawSlots) {
          for (const key of cfKeys) {
            const val = cf[key];
            if (typeof val === "string" && val.startsWith("[{") && val.includes("startTime")) {
              console.log(`📋 [SLOT RECOVERY] Found potential slot data in field: ${key}`);
              console.log("📋 [SLOT RECOVERY] Potential slot field details", {
                key,
                type: typeof val,
                len: val.length,
                sha1: shortSha1(val),
              });
              recoveredSlots = parseJsonField(val, []);
              if (recoveredSlots.length > 0) break;
            }
          }
        } else {
          if (typeof rawSlots === "string") {
            console.log("📋 [SLOT RECOVERY] Raw slot field details", {
              key: rawSlotsSourceKey,
              type: "string",
              len: rawSlots.length,
              sha1: shortSha1(rawSlots),
            });
          }
          recoveredSlots = parseJsonField(rawSlots, []);
        }
        
        if (recoveredSlots.length > 0) {
          console.log(`✅ [SLOT RECOVERY] Recovered ${recoveredSlots.length} slots from GHL`);
        } else {
          console.log("⚠️ [SLOT RECOVERY] No slots found in GHL contact. Will regenerate fresh slots.");
          // If we can't recover slots but have a selection, regenerate slots and try to match
          const timePrefs = extractTimePreferences(messageText);
          try {
            const freshSlots = await getAvailableSlots({
              canonicalState,
              context: { 
                contact,
                preferredDay: timePrefs.preferredDay,
                preferredTimeWindow: timePrefs.preferredTimeWindow,
                preferredWeek: timePrefs.preferredWeek,
                preferredMonth: timePrefs.preferredMonth,
                preferredYear: timePrefs.preferredYear,
              },
            });
            if (freshSlots.length > 0) {
              recoveredSlots = freshSlots;
              console.log(`✅ [SLOT RECOVERY] Generated ${freshSlots.length} fresh slots to match against`);
            }
          } catch (genErr) {
            console.error("❌ [SLOT RECOVERY] Failed to generate fresh slots:", genErr.message || genErr);
          }
        }
      } catch (err) {
          console.error("❌ [SLOT RECOVERY] Failed to fetch contact:", err.message || err);
        }
      }

    const selectionResult = parseTimeSelection(messageText, recoveredSlots);
    const selectionFromIndex =
      Number.isInteger(selectionResult) && selectionResult >= 0
        ? recoveredSlots[selectionResult] || null
        : null;
    const chosenSlot =
      (selectionResult && typeof selectionResult === "object" && !Array.isArray(selectionResult)
        ? selectionResult
        : selectionFromIndex) ||
      (recoveredSlots.length === 1 ? recoveredSlots[0] : null);

    console.log(
      "🧭 [SLOT CHOICE] parseTimeSelection ->",
      selectionResult,
      typeof selectionResult,
      "chosenSlot",
      chosenSlot ? chosenSlot.startTime : null
    );

    if (!chosenSlot || !contactId) {
      // Re-offer structured availability if we cannot parse or have no contact
      const fallback =
        "I can hold a spot—what day(s) this week and what time window works best (morning / afternoon / evening)?";
      return {
        language: "en",
        bubbles: [fallback],
        internal_notes: "deterministic_slot_selection_fallback",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {},
      };
    }

    try {
      const appointment = await createConsultAppointment({
        contactId,
        calendarId: chosenSlot.calendarId,
        startTime: chosenSlot.startTime,
        endTime: chosenSlot.endTime,
        artist: chosenSlot.artist || "Joan",
        consultMode: chosenSlot.consultMode || "online",
        contactProfile: {
          tattooSummary: canonicalState.tattooSummary || "tattoo",
        },
        translatorNeeded:
          chosenSlot.translatorNeeded === true ||
          !!chosenSlot.translator ||
          canonicalState.translatorNeeded,
        translatorCalendarId: chosenSlot.translatorCalendarId || null,
        translatorName: chosenSlot.translator || null,
        sendHoldMessage: false, // prevent double messaging
      });

      const deposit = await createDepositLinkForContact({
        contactId,
        amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
        description: DEPOSIT_CONFIG.DEFAULT_DESCRIPTION,
      });

      const holdTimestamp = new Date().toISOString();
      await updateSystemFields(contactId, {
        hold_appointment_id: appointment?.id || appointment?._id,
        hold_created_at: holdTimestamp,
        hold_last_activity_at: holdTimestamp,
        hold_warning_sent: false,
        deposit_link_sent: true,
        deposit_link_url: deposit?.url || null,
      });

      const display =
        chosenSlot.displayText ||
        (chosenSlot.startTime && formatSlotDisplay
          ? formatSlotDisplay(new Date(chosenSlot.startTime))
          : chosenSlot.startTime);
      const amount = (DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS || 0) / 100;

      const message = `Got you for ${display}.\nHere’s the $${amount} refundable deposit to lock it: ${deposit?.url}\nI’ll keep it on hold for ~20 minutes.`;

      return {
        language: "en",
        bubbles: [message],
        internal_notes: "deterministic_slot_selection_hold_and_deposit",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {
          consult_explained: true,
        },
      };
    } catch (err) {
      console.error("❌ Deterministic slot selection failed:", err.message || err);
      const fallback =
        "I can hold a spot—what day(s) this week and what time window works best (morning / afternoon / evening)?";
      return {
        language: "en",
        bubbles: [fallback],
        internal_notes: "deterministic_slot_selection_error_fallback",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {
          consult_explained: true,
        },
      };
    }
  }

  // Deposit intent handling
  if (intents.deposit_intent) {
    // If already paid, do not resend link; advance to scheduling/confirmation
    if (depositPaid) {
      const slots =
        lastSentSlots.length > 0 ? lastSentSlots.slice(0, 3) : generateSuggestedSlots({}).slice(0, 3);

      if (slots.length > 0) {
        const lines = slots.map((slot, idx) => {
          const label = `${idx + 1})`;
          const display = slot.displayText
            ? slot.displayText
            : formatSlotDisplay
            ? formatSlotDisplay(new Date(slot.startTime))
            : slot.startTime;
          return `${label} ${display}`;
        });
        const message = `Thanks — your deposit is confirmed. Here are the next openings:\n${lines.join(
          "\n"
        )}\n\nWhich works best?`;
        await persistLastSentSlots(contactId, slots);
        return {
          language: "en",
          bubbles: [message],
          internal_notes: "deterministic_deposit_paid_scheduling",
          meta: {
            aiPhase: derivedPhase || null,
            leadTemperature: null,
          },
          field_updates: {},
        };
      }

      const fallback =
        "Thanks — your deposit is confirmed. What day(s) this week and what time window works best (morning / afternoon / evening)?";
      return {
        language: "en",
        bubbles: [fallback],
        internal_notes: "deterministic_deposit_paid_fallback",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {},
      };
    }

    // Not paid: generate and send deposit link
    if (!contactId) {
      const fallback = "I can send your deposit link—please confirm your contact info.";
      return {
        language: "en",
        bubbles: [fallback],
        internal_notes: "deterministic_deposit_missing_contact",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {},
      };
    }

    try {
      const deposit = await createDepositLinkForContact({
        contactId,
        amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
        description: DEPOSIT_CONFIG.DEFAULT_DESCRIPTION,
      });

      await updateSystemFields(contactId, {
        deposit_link_sent: true,
        deposit_link_url: deposit?.url || null,
        deposit_paid: false,
      });

      const amount = (DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS || 0) / 100;
      const message = `Here’s your $${amount} refundable deposit to lock your consult: ${deposit?.url}`;

      return {
        language: "en",
        bubbles: [message],
        internal_notes: "deterministic_deposit_link",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {
          consult_explained: true,
        },
      };
    } catch (err) {
      console.error("❌ Deterministic deposit link failed:", err.message || err);
      const fallback = "I can send your deposit link now—can you confirm email or phone?";
      return {
        language: "en",
        bubbles: [fallback],
        internal_notes: "deterministic_deposit_error_fallback",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {},
      };
    }
  }

  // Translator affirmation: mark confirmed and proceed to scheduling
  if (intents.translator_affirm_intent) {
    if (contactId) {
      try {
        await updateSystemFields(contactId, {
          translator_confirmed: true,
          translator_needed: true,
          consultation_type: "appointment",
          consultation_type_locked: true,
        });
      } catch (err) {
        console.error("❌ Failed to persist translator confirmation:", err.message || err);
      }
    }
    return await offerSlots("deterministic_translator_confirmed_slots");
  }

  // Process question after consult explained: avoid re-explaining, move to scheduling
  if (intents.process_or_price_question_intent && consultExplained) {
    return await offerSlots("deterministic_process_after_explained");
  }

  // Reschedule intent
  if (intents.reschedule_intent) {
    const targetAppointmentId = upcomingAppointmentId || holdAppointmentId || null;
    if (targetAppointmentId && contactId) {
      try {
        await updateAppointmentStatus(targetAppointmentId, "cancelled");
      } catch (err) {
        console.error("❌ Failed to cancel appointment for reschedule:", err.message || err);
      }
      try {
        if (targetAppointmentId === holdAppointmentId) {
          await updateSystemFields(contactId, {
            hold_appointment_id: null,
            hold_created_at: null,
            hold_last_activity_at: null,
            hold_warning_sent: false,
            last_sent_slots: null,
          });
        } else {
          await updateSystemFields(contactId, {
            consult_appointment_id: null,
            appointment_id: null,
            last_sent_slots: null,
            times_sent: false,
          });
        }
      } catch (err) {
        console.error("❌ Failed clearing hold fields during reschedule:", err.message || err);
      }
      return await offerSlots("deterministic_reschedule_slots");
    }
    // No appointment/hold: fall back to scheduling offer
    return await offerSlots("deterministic_reschedule_slots");
  }

  // Cancel intent
  if (intents.cancel_intent) {
    const targetAppointmentId = upcomingAppointmentId || holdAppointmentId || null;
    if (targetAppointmentId && contactId) {
      try {
        await updateAppointmentStatus(targetAppointmentId, "cancelled");
      } catch (err) {
        console.error("❌ Failed to cancel appointment for cancel intent:", err.message || err);
      }
      try {
        if (targetAppointmentId === holdAppointmentId) {
          await updateSystemFields(contactId, {
            hold_appointment_id: null,
            hold_created_at: null,
            hold_last_activity_at: null,
            hold_warning_sent: false,
            last_sent_slots: null,
          });
        } else {
          await updateSystemFields(contactId, {
            consult_appointment_id: null,
            appointment_id: null,
            last_sent_slots: null,
            times_sent: false,
          });
        }
      } catch (err) {
        console.error("❌ Failed clearing hold fields during cancel:", err.message || err);
      }
      return {
        language: "en",
        bubbles: ["You’re all set — the appointment has been canceled."],
        internal_notes: "deterministic_cancel_confirmed",
        meta: {
          aiPhase: derivedPhase || null,
          leadTemperature: null,
        },
        field_updates: {},
      };
    }
    return {
      language: "en",
      bubbles: ["I don’t see an upcoming appointment — would you like to book one?"],
      internal_notes: "deterministic_cancel_no_appt",
      meta: {
        aiPhase: derivedPhase || null,
        leadTemperature: null,
      },
      field_updates: {},
    };
  }

  // Default placeholder for other hard-skip reasons until implemented
  const bubble = `TODO deterministic handler for ${Object.keys(intents).filter((k) => intents[k]).join(",") || "unknown_reason"}`;
  return {
    language: "en",
    bubbles: [bubble],
    internal_notes: "deterministic_placeholder",
    meta: {
      aiPhase: derivedPhase || null,
      leadTemperature: null,
    },
    field_updates: {},
  };
}

module.exports = {
  buildDeterministicResponse,
};
