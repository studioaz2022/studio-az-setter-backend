const {
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
  buildContactProfile,
} = require("../contextBuilder");
const {
  buildCanonicalState,
  computeLastSeenDiff,
} = require("../phaseContract");

describe("contextBuilder normalization", () => {
  test("merges payload custom fields and normalizes to canonical state", () => {
    const payload = {
      "Tattoo Placement": "forearm",
      "Tattoo Summary": "skateboard scene",
      tattoo_size: "6x3",
    };
    const contactRaw = {
      customField: [
        { id: "tattoo_style", value: "neo-traditional" },
        { id: "language_preference", value: "English" },
      ],
    };

    const webhookCustom = extractCustomFieldsFromPayload(payload);
    const effectiveContact = buildEffectiveContact(contactRaw, webhookCustom);

    expect(effectiveContact.customField.tattoo_placement).toBe("forearm");
    expect(effectiveContact.customField.tattoo_summary).toBe("skateboard scene");
    expect(effectiveContact.customField.tattoo_size).toBe("6x3");
    expect(effectiveContact.customField.tattoo_style).toBe("neo-traditional");

    const canonical = buildCanonicalState(effectiveContact);
    expect(canonical.tattooPlacement).toBe("forearm");
    expect(canonical.tattooSummary).toBe("skateboard scene");
    expect(canonical.tattooSize).toBe("6x3");
    expect(canonical.tattooStyle).toBe("neo-traditional");
  });

  test("buildContactProfile carries derived phase and changed fields", () => {
    const contact = {
      customField: {
        tattoo_summary: "lion",
        tattoo_placement: "arm",
        tattoo_size: "5x3",
        last_seen_fields_snapshot: JSON.stringify({}),
      },
    };
    const canonical = buildCanonicalState(contact);
    const { changedFields } = computeLastSeenDiff(canonical, canonical.lastSeenSnapshot || {});

    expect(changedFields.tattooSize).toBe("5x3");

    const profile = buildContactProfile(canonical, {
      changedFields,
      derivedPhase: "qualification",
    });

    expect(profile.tattooPlacement).toBe("arm");
    expect(profile.tattooSummary).toBe("lion");
    expect(profile.changedFieldsThisTurn.tattooSize).toBe("5x3");
    expect(profile.derivedPhase).toBe("qualification");
  });
});

