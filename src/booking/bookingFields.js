// ─── Booking-widget GHL custom fields (barbershop location) ───
//
// Field IDs + CHECKBOX options were read from the LIVE location on 2026-07-21
// (GET /locations/{id}/customFields). The option strings below must match GHL
// byte-for-byte — GHL stores the label, not an index, so a typo writes a value
// that no filter or workflow will ever match.
//
// ⚠️ FILE_UPLOAD ("Desired Hairstyle") is deliberately NOT part of the
// customFields payload. Verified against this location:
//   • a valid URL string      → accepted, stored as {meta,url}
//   • any NON-URL text        → 400 "Invalid URL", and the ENTIRE customFields
//                               payload is discarded (every other field with it)
// So we never send it inline. Real files go through the multipart endpoint
// POST /forms/upload-custom-files (see uploadHairstylePhoto in bookingCreate).
// See the ghl-invalid-url-gotcha note — this is the same trap that silently ate
// consultation fields on the tattoo side.

const FIELDS = {
  silent: {
    id: "CcpvJtvNoCGOXzPNFKqm",
    name: "Silent Appointment Request",
    type: "CHECKBOX",
    options: ["Silent"],
  },
  notes: {
    id: "7SsJ0ujn7Nr1ejHZbRDb",
    name: "Notes to Barber",
    type: "LARGE_TEXT",
    maxLength: 1000,
  },
  hairstylePhoto: {
    id: "Oyi3c20MciIMLGx6nNqU",
    name: "Desired Hairstyle",
    type: "FILE_UPLOAD", // multipart only — never in customFields
  },
  videoLink: {
    id: "uDIELphwjFHntmCQ11UR",
    name: "Desired Hairstyle (Video Link)",
    type: "TEXT",
    maxLength: 500,
  },
};

// Paid extras offered by specific barbers only. `barbers` is the allow-list —
// enforced server-side, not just hidden in the UI, so a hand-crafted request
// can't book David's waxing with a barber who doesn't do it.
const ADD_ONS = {
  eyebrows: {
    id: "BvwkPghnWwqOOiciXAKX",
    name: "Eyebrows",
    label: "Eyebrows",
    type: "CHECKBOX",
    options: ["Eyebrows ($10)"],
    multi: false,
    barbers: ["david"],
  },
  waxing: {
    id: "q64JfWy3niKxXAnjKFDM",
    name: "Waxing Add On",
    label: "Waxing",
    type: "CHECKBOX",
    options: ["Nose or Ear Wax ($15)", "Eye Brow Wax ($15)", "Both Wax ($30)"],
    multi: true,
    // "Both Wax" is the pair — offering it alongside the singles would let a
    // customer submit a contradiction, so the widget treats it as exclusive.
    exclusive: ["Both Wax ($30)"],
    barbers: ["david"],
  },
};

/** Add-ons a given barber offers, shaped for the public services catalog. */
function addOnsForBarber(barberSlug) {
  return Object.entries(ADD_ONS)
    .filter(([, a]) => a.barbers.includes(barberSlug))
    .map(([key, a]) => ({
      key,
      label: a.label,
      options: a.options,
      multi: a.multi,
      exclusive: a.exclusive || [],
    }));
}

function offersAddOn(barberSlug, key) {
  return !!ADD_ONS[key]?.barbers.includes(barberSlug);
}

/**
 * The one place that decides what a selection for an add-on actually means:
 * keep only real options (in GHL's own order), and collapse to the exclusive
 * option when one is present — "Both Wax" and "Eye Brow Wax" together is a
 * contradiction no barber can act on. Returns [] for nothing usable.
 */
function normalizeAddOnSelection(key, chosen) {
  const addOn = ADD_ONS[key];
  if (!addOn || !Array.isArray(chosen) || !chosen.length) return [];
  const valid = addOn.options.filter((o) => chosen.includes(o));
  if (!valid.length) return [];
  const exclusive = (addOn.exclusive || []).find((o) => valid.includes(o));
  return exclusive ? [exclusive] : valid;
}

/** A URL we're willing to hand to GHL — http(s) only, bounded length. */
function isHttpUrl(value) {
  if (!value || value.length > FIELDS.videoLink.maxLength) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Build the customFields array for upsertContact from validated booking input.
 * Only includes fields the customer actually filled in — writing "" to a
 * checkbox would clear a value a previous booking set.
 *
 * Returns { customFields, dropped } where `dropped` names add-ons that were
 * requested but not offered by this barber (recorded in the audit row).
 */
function buildCustomFields(input, barberSlug) {
  const customFields = [];
  const dropped = [];

  if (input.silent) {
    customFields.push({ id: FIELDS.silent.id, field_value: FIELDS.silent.options });
  }
  if (input.notes) {
    customFields.push({ id: FIELDS.notes.id, field_value: input.notes });
  }
  if (input.videoLink) {
    customFields.push({ id: FIELDS.videoLink.id, field_value: input.videoLink });
  }

  for (const [key, addOn] of Object.entries(ADD_ONS)) {
    const chosen = input.addOns?.[key];
    if (!chosen || !chosen.length) continue;
    if (!offersAddOn(barberSlug, key)) {
      dropped.push(key);
      continue;
    }
    const valid = normalizeAddOnSelection(key, chosen);
    if (valid.length) customFields.push({ id: addOn.id, field_value: valid });
  }

  return { customFields, dropped };
}

module.exports = {
  FIELDS,
  ADD_ONS,
  addOnsForBarber,
  offersAddOn,
  normalizeAddOnSelection,
  isHttpUrl,
  buildCustomFields,
};
