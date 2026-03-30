// consentFormService.js
// Service for managing tattoo consent forms — Supabase storage + GHL sync

const crypto = require("crypto");
const { supabase } = require("../clients/supabaseClient");
const {
  getContact,
  createContact,
  updateContact,
  sendConversationMessage,
  uploadFilesToTattooCustomField,
} = require("../clients/ghlClient");
const { GHL_LOCATION_ID } = require("../config/constants");

const CONSENT_FORM_BASE_URL =
  process.env.CONSENT_FORM_URL || "https://consent.studioaztattoo.com";

// Artist name → MN tattoo technician license number mapping
const ARTIST_LICENSE_MAP = {
  joan: "3110164",
  andrew: "319777",
  lionel: "317960",
};

// GHL custom field IDs for consent form fields
const GHL_FIELD_IDS = {
  consentFormStatus: "t6ky77s281oHFEJepml2",
  consentFormSentAt: "fSPJFS6t0B2mER1k6v4U",
  consentFormCompletedAt: "xr7j0PrbBde5WXyQRAgn",
  consentSignedAt: "fGEVZ3rksFpFFJJUA9nt",
  consentSignerIp: "r1M2tnNjzod58OGjxgQQ",
  consentSignerDevice: "3RcDtX7gLf1K9QzbhbYI",
  consentLegalTextHash: "yzcr4kgEO6xWp2GRhBgm",
  medicalHistory: "n9fWT15VGRpi3XHQeHKH",
  medicalHistoryDescription: "nmCsftTxJGoZ3MN3lbvk",
  emergencyContact: "QLNaHO4A0DZ36Z0WEEIz",
  validIdUpload: "h2hGFmpmr4ubqahWh2Fa",
  consentCheckbox: "b4OBYxR07y6YpmPyLgc9",
  signature: "BNHfUe5g9ukbxfSwcOjf",
  dateOfProcedure: "lcp5msRKH7SA6F3mk0oP",
  finalPrice: "gPilaCtR7j32ACQIwAzk",
  assignedTechnician: "zoqWKnANjd1ZfDAlCxsF",
  technicianLicense: "pwuGhZnB6oJr8SA31fsr",
  locationOfTattoo: "aajOy0O9UvljR2JGtEVn",
};

/**
 * Look up technician license number by artist name (case-insensitive).
 * Returns empty string if not found.
 */
function lookupLicense(artistName) {
  if (!artistName) return "";
  const firstName = artistName.split(" ")[0].toLowerCase();
  return ARTIST_LICENSE_MAP[firstName] || "";
}

/**
 * Generate a secure, short-lived token for a consent form link.
 * Returns a random hex string stored in the consent_forms row.
 */
function generateFormToken() {
  return crypto.randomBytes(24).toString("hex"); // 48-char token
}

/**
 * Send a consent form to a contact.
 * Creates a Supabase row, generates a token, sends SMS via GHL.
 * If newContact is provided, creates the GHL contact first (atomic).
 *
 * @param {object} params
 * @param {string} [params.contactId] - GHL contact ID (for existing contacts)
 * @param {object} [params.newContact] - New contact info: { firstName, lastName, phone }
 * @param {number} params.quotedPrice - Tattoo quote (from artist confirmation)
 * @param {number} params.numberOfSessions - Number of sessions (from artist confirmation)
 * @param {string} params.assignedTechnician - Artist name
 * @param {string} [params.technicianLicense] - License # (auto-populated if omitted)
 * @param {string} params.procedureDate - ISO date string
 * @param {string} params.tattooPlacement - Tattoo placement description
 * @param {string} [params.appointmentId] - GHL appointment ID (for stable linking)
 * @returns {object} { success, consentFormId, formUrl, error }
 */
async function sendConsentForm({
  contactId,
  newContact,
  quotedPrice,
  numberOfSessions,
  assignedTechnician,
  technicianLicense,
  procedureDate,
  tattooPlacement,
  appointmentId = null,
}) {
  try {
    // Auto-populate technician license from artist name if not provided
    const resolvedLicense = technicianLicense || lookupLicense(assignedTechnician);

    let contact;
    let resolvedContactId = contactId;

    // 0. If newContact provided, create the GHL contact first (atomic)
    if (newContact && !contactId) {
      const { firstName, lastName, phone } = newContact;
      if (!phone) {
        return { success: false, error: "New contact must have a phone number" };
      }
      if (!firstName) {
        return { success: false, error: "New contact must have a first name" };
      }

      console.log(`📝 Creating new GHL contact: ${firstName} ${lastName || ""} (${phone})`);

      const createBody = {
        firstName: firstName.trim(),
        lastName: (lastName || "").trim(),
        phone,
        locationId: GHL_LOCATION_ID,
        source: "Consent Form — Studio AZ App",
      };

      // Set assigned artist + quote on the new contact
      const customFields = [];
      if (assignedTechnician) {
        customFields.push({ id: GHL_FIELD_IDS.assignedTechnician, field_value: assignedTechnician });
      }
      if (resolvedLicense) {
        customFields.push({ id: GHL_FIELD_IDS.technicianLicense, field_value: resolvedLicense });
      }
      if (quotedPrice) {
        customFields.push({ id: GHL_FIELD_IDS.finalPrice, field_value: String(quotedPrice) });
      }
      if (customFields.length > 0) {
        createBody.customFields = customFields;
      }

      try {
        const createResult = await createContact(createBody);
        const newContactData = createResult?.data?.contact || createResult?.data;
        if (!newContactData?.id) {
          console.error("❌ GHL createContact returned no ID:", JSON.stringify(createResult?.data));
          return { success: false, error: "Failed to create contact in GHL — no contact ID returned" };
        }
        resolvedContactId = newContactData.id;
        contact = newContactData;
        console.log(`✅ Created GHL contact ${resolvedContactId} for ${firstName}`);
      } catch (createErr) {
        // Handle duplicate contact — extract existing contact ID and continue
        const dupeContactId = createErr.response?.meta?.contactId
          || createErr.response?.contactId;
        if (dupeContactId) {
          console.log(`🔄 Phone already exists in GHL — using existing contact ${dupeContactId}`);
          resolvedContactId = dupeContactId;
          contact = await getContact(dupeContactId);
          if (!contact) {
            return { success: false, error: "Duplicate contact found but could not fetch details" };
          }
        } else {
          console.error("❌ Failed to create GHL contact:", createErr.message);
          return { success: false, error: `Failed to create contact: ${createErr.message}` };
        }
      }
    } else {
      // 1. Fetch existing contact data from GHL for pre-fill fields
      contact = await getContact(resolvedContactId);
      if (!contact) {
        return { success: false, error: "Contact not found in GHL" };
      }
    }

    const firstName =
      contact.firstName || contact.name?.split(" ")[0] || "there";
    const phone = contact.phone || newContact?.phone;

    if (!phone) {
      return { success: false, error: "Contact has no phone number — cannot send SMS" };
    }

    // 2. Generate token for secure form link
    const token = generateFormToken();

    // 3. Create consent form row in Supabase
    const { data: consentForm, error: insertError } = await supabase
      .from("consent_forms")
      .upsert(
        {
          contact_id: resolvedContactId,
          appointment_id: appointmentId,
          first_name: contact.firstName || newContact?.firstName || null,
          last_name: contact.lastName || newContact?.lastName || null,
          phone: phone || null,
          email: contact.email || null,
          date_of_procedure: procedureDate || null,
          assigned_technician: assignedTechnician || null,
          technician_license: resolvedLicense || contact.customField?.assigned_technician_license_ || null,
          quoted_price: quotedPrice || null,
          number_of_sessions: numberOfSessions || null,
          location_of_tattoo: contact.customField?.location_of_tattoo || null,
          tattoo_placement: tattooPlacement || null,
          token,
          status: "sent",
          sent_at: new Date().toISOString(),
        },
        { onConflict: "contact_id,appointment_id" }
      )
      .select()
      .single();

    if (insertError) {
      console.error("❌ Error creating consent form row:", insertError);
      return { success: false, error: insertError.message };
    }

    // 4. Build form URL
    const formUrl = `${CONSENT_FORM_BASE_URL}/f/${token}`;

    // 5. Send SMS via GHL
    const dateDisplay = procedureDate
      ? new Date(procedureDate).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
        })
      : "your upcoming appointment";

    const smsBody = `Hi ${firstName}, please complete your consent form before your appointment on ${dateDisplay}${assignedTechnician ? ` with ${assignedTechnician}` : ""}: ${formUrl}`;

    await sendConversationMessage({
      contactId: resolvedContactId,
      body: smsBody,
      channelContext: { hasPhone: true, phone },
    });

    // 6. Update GHL consent form status + key fields
    try {
      const sendCustomFields = [
        { id: GHL_FIELD_IDS.consentFormStatus, field_value: "sent" },
        { id: GHL_FIELD_IDS.consentFormSentAt, field_value: new Date().toISOString() },
      ];
      if (quotedPrice) {
        sendCustomFields.push({ id: GHL_FIELD_IDS.finalPrice, field_value: String(quotedPrice) });
      }
      if (tattooPlacement) {
        sendCustomFields.push({ id: GHL_FIELD_IDS.locationOfTattoo, field_value: tattooPlacement });
      }
      if (assignedTechnician) {
        sendCustomFields.push({ id: GHL_FIELD_IDS.assignedTechnician, field_value: assignedTechnician });
      }
      if (resolvedLicense) {
        sendCustomFields.push({ id: GHL_FIELD_IDS.technicianLicense, field_value: resolvedLicense });
      }
      if (procedureDate) {
        sendCustomFields.push({ id: GHL_FIELD_IDS.dateOfProcedure, field_value: procedureDate });
      }
      await updateContact(resolvedContactId, { customFields: sendCustomFields });
    } catch (ghlErr) {
      console.warn("⚠️ Failed to update GHL consent status:", ghlErr.message);
      // Non-fatal — Supabase is the source of truth
    }

    console.log(`✅ Consent form sent to ${firstName} (${resolvedContactId}), token: ${token}`);

    return {
      success: true,
      consentFormId: consentForm.id,
      formUrl,
    };
  } catch (err) {
    console.error("❌ Error sending consent form:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get pre-filled consent form data by token.
 * Called by the web form when the client opens the link.
 *
 * @param {string} token - Form token from URL
 * @returns {object} { success, data, error }
 */
async function getConsentFormByToken(token) {
  try {
    const { data, error } = await supabase
      .from("consent_forms")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !data) {
      return { success: false, error: "Consent form not found or link expired" };
    }

    if (data.status === "completed") {
      return { success: false, error: "This consent form has already been submitted" };
    }

    // Check if this form has been expired/superseded by an update
    if (data.expired_at) {
      return { success: false, error: "form_expired", expired: true };
    }

    // Fetch language preference from GHL contact (for Spanish auto-detection)
    let languagePreference = null;
    try {
      const contact = await getContact(data.contact_id);
      if (contact?.customField?.language_preference) {
        languagePreference = contact.customField.language_preference;
      }
    } catch (langErr) {
      console.warn("⚠️ Could not fetch language preference:", langErr.message);
    }

    // Return pre-filled data (exclude internal fields)
    return {
      success: true,
      data: {
        id: data.id,
        firstName: data.first_name,
        lastName: data.last_name,
        phone: data.phone,
        email: data.email,
        dateOfProcedure: data.date_of_procedure,
        assignedTechnician: data.assigned_technician,
        technicianLicense: data.technician_license,
        quotedPrice: data.quoted_price,
        numberOfSessions: data.number_of_sessions,
        locationOfTattoo: data.location_of_tattoo,
        tattooPlacement: data.tattoo_placement,
        languagePreference,
        // Don't expose: contact_id, appointment_id, token, internal status
      },
    };
  } catch (err) {
    console.error("❌ Error fetching consent form by token:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Submit a completed consent form.
 * Writes to Supabase, uploads ID photo to GHL, syncs fields to GHL contact.
 * Captures e-signature evidence package (IP, user agent, legal text hash, timestamp).
 *
 * @param {string} token - Form token
 * @param {object} submission - Client-submitted data
 * @param {object} [requestMeta] - Request metadata for e-signature evidence
 * @param {string} [requestMeta.ip] - Client IP address
 * @param {string} [requestMeta.userAgent] - Client user agent string
 * @returns {object} { success, error }
 */
async function submitConsentForm(token, submission, requestMeta = {}) {
  try {
    // 1. Look up the consent form by token
    const { data: form, error: lookupError } = await supabase
      .from("consent_forms")
      .select("*")
      .eq("token", token)
      .single();

    if (lookupError || !form) {
      return { success: false, error: "Consent form not found or link expired" };
    }

    if (form.status === "completed") {
      return { success: false, error: "This consent form has already been submitted" };
    }

    const contactId = form.contact_id;

    // 2. Upload ID photo to GHL media storage (if provided)
    let idPhotoUrl = null;
    if (submission.idPhoto) {
      try {
        // submission.idPhoto is expected as { buffer, filename, contentType }
        // Upload to the Valid ID field, NOT the tattoo reference photo field
        const uploadResult = await uploadFilesToTattooCustomField(contactId, [
          {
            buffer: submission.idPhoto.buffer,
            originalname: submission.idPhoto.filename || "valid-id.jpg",
            mimetype: submission.idPhoto.contentType || "image/jpeg",
          },
        ], GHL_FIELD_IDS.validIdUpload);
        // Extract URL from GHL upload response
        if (uploadResult?.data?.urls?.length > 0) {
          idPhotoUrl = uploadResult.data.urls[0];
        }
      } catch (uploadErr) {
        console.error("⚠️ ID photo upload to GHL failed:", uploadErr.message);
        // Continue — store base64 in Supabase as fallback
      }
    }

    // 3. Generate legal text hash for tamper-proof audit trail
    const legalTextHash = submission.legalTextHash || null;

    // Parse fields that arrive as strings from FormData (multipart/form-data)
    const medicalHistory = typeof submission.medicalHistory === "string"
      ? (() => { try { return JSON.parse(submission.medicalHistory); } catch { return []; } })()
      : submission.medicalHistory || [];
    const consentChecked = submission.consentCheckbox === true || submission.consentCheckbox === "true";

    // 4. Write full record to Supabase (including e-signature evidence package)
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("consent_forms")
      .update({
        // Client-entered fields
        date_of_birth: submission.dateOfBirth || null,
        email: submission.email || form.email || null,
        emergency_contact_name: submission.emergencyContactName || null,
        emergency_contact_phone: submission.emergencyContactPhone || null,
        address: submission.address || null,
        city: submission.city || null,
        state: submission.state || null,
        country: submission.country || null,
        medical_history: medicalHistory,
        medical_history_description: submission.medicalHistoryDescription || null,
        id_photo_url: idPhotoUrl || submission.idPhotoFallbackUrl || null,
        consent_checkbox: consentChecked,
        signature_data: submission.signatureData || null,
        // Backfill optional fields if artist left them empty
        date_of_procedure: submission.dateOfProcedure || form.date_of_procedure || null,
        tattoo_placement: submission.tattooPlacement || form.tattoo_placement || null,
        // E-signature evidence package
        signed_at: now,
        signer_ip: requestMeta.ip || null,
        signer_user_agent: requestMeta.userAgent || null,
        legal_text_hash: legalTextHash,
        // Status
        status: "completed",
        completed_at: now,
      })
      .eq("id", form.id);

    if (updateError) {
      console.error("❌ Error updating consent form in Supabase:", updateError);
      return { success: false, error: updateError.message };
    }

    // 4. Sync key fields back to GHL contact
    try {
      const customFields = [
        { id: GHL_FIELD_IDS.medicalHistory, field_value: medicalHistory.join(", ") },
        { id: GHL_FIELD_IDS.medicalHistoryDescription, field_value: submission.medicalHistoryDescription || "" },
        { id: GHL_FIELD_IDS.emergencyContact, field_value: submission.emergencyContactPhone || "" },
        { id: GHL_FIELD_IDS.consentCheckbox, field_value: consentChecked ? "Yes" : "No" },
      ];

      // Signature — verified 2026-03-26 that GHL accepts base64 data URI writes
      if (submission.signatureData && GHL_FIELD_IDS.signature) {
        customFields.push({
          id: GHL_FIELD_IDS.signature,
          field_value: submission.signatureData,
        });
      }

      // Consent form status fields
      customFields.push(
        { id: GHL_FIELD_IDS.consentFormStatus, field_value: "completed" },
        { id: GHL_FIELD_IDS.consentFormCompletedAt, field_value: now }
      );

      // E-signature audit trail backup to GHL
      customFields.push(
        { id: GHL_FIELD_IDS.consentSignedAt, field_value: now },
        { id: GHL_FIELD_IDS.consentSignerIp, field_value: requestMeta.ip || "" },
        { id: GHL_FIELD_IDS.consentSignerDevice, field_value: requestMeta.userAgent || "" },
        { id: GHL_FIELD_IDS.consentLegalTextHash, field_value: legalTextHash || "" }
      );

      const contactUpdate = {
        customFields,
      };

      // Backfill standard fields — only update if client provided a value
      if (submission.dateOfBirth) contactUpdate.dateOfBirth = submission.dateOfBirth;
      if (submission.address) contactUpdate.address1 = submission.address;
      if (submission.city) contactUpdate.city = submission.city;
      if (submission.state) contactUpdate.state = submission.state;
      if (submission.country) contactUpdate.country = submission.country;
      if (submission.email) contactUpdate.email = submission.email;

      await updateContact(contactId, contactUpdate);

      console.log(`✅ GHL contact ${contactId} synced with consent form data`);
    } catch (ghlErr) {
      console.error("⚠️ GHL sync failed (Supabase is source of truth):", ghlErr.message);
      // Non-fatal — data is safe in Supabase
    }

    console.log(`✅ Consent form completed for contact ${contactId}`);
    return { success: true };
  } catch (err) {
    console.error("❌ Error submitting consent form:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get consent form status for a single contact.
 * Used by iOS app for contact profile status indicator.
 *
 * @param {string} contactId - GHL contact ID
 * @returns {object} { success, data: { status, sentAt, completedAt }, error }
 */
async function getConsentFormStatus(contactId) {
  try {
    const { data, error } = await supabase
      .from("consent_forms")
      .select("status, sent_at, completed_at, date_of_procedure, appointment_id")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return {
        success: true,
        data: { status: "not_sent", sentAt: null, completedAt: null },
      };
    }

    return {
      success: true,
      data: {
        status: data.status,
        sentAt: data.sent_at,
        completedAt: data.completed_at,
        dateOfProcedure: data.date_of_procedure,
        appointmentId: data.appointment_id,
      },
    };
  } catch (err) {
    console.error("❌ Error fetching consent form status:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Batch get consent form statuses for multiple contacts.
 * Used by iOS calendar day view to avoid N+1 API calls.
 *
 * @param {string[]} contactIds - Array of GHL contact IDs
 * @returns {object} { success, data: { [contactId]: { status, sentAt, completedAt } }, error }
 */
async function getConsentFormStatusBatch(contactIds) {
  try {
    if (!contactIds || contactIds.length === 0) {
      return { success: true, data: {} };
    }

    // Get the most recent consent form for each contact
    const { data, error } = await supabase
      .from("consent_forms")
      .select("contact_id, status, sent_at, completed_at, date_of_procedure, appointment_id")
      .in("contact_id", contactIds)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Error batch fetching consent form statuses:", error);
      return { success: false, error: error.message };
    }

    // Build a map — keep only the most recent per contact
    const statusMap = {};
    for (const row of data || []) {
      if (!statusMap[row.contact_id]) {
        statusMap[row.contact_id] = {
          status: row.status,
          sentAt: row.sent_at,
          completedAt: row.completed_at,
          dateOfProcedure: row.date_of_procedure,
          appointmentId: row.appointment_id,
        };
      }
    }

    // Fill in "not_sent" for contacts with no consent form
    for (const id of contactIds) {
      if (!statusMap[id]) {
        statusMap[id] = { status: "not_sent", sentAt: null, completedAt: null };
      }
    }

    return { success: true, data: statusMap };
  } catch (err) {
    console.error("❌ Error batch fetching consent form statuses:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Send day-of consent form reminders to clients with upcoming tattoo appointments
 * who haven't completed their consent forms.
 *
 * Queries Supabase for consent forms where:
 * - status ≠ "completed"
 * - date_of_procedure = today (Central time, America/Chicago)
 * - day_of_reminder_sent = false (avoid duplicate sends)
 *
 * @returns {object} { success, sent: number, errors: number }
 */
async function sendDayOfConsentReminders() {
  try {
    // Get today's date in Central time (America/Chicago)
    const centralNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );
    const todayStr = centralNow.toISOString().split("T")[0]; // YYYY-MM-DD

    console.log(`🔔 Checking day-of consent reminders for ${todayStr} (Central)`);

    // Find consent forms for today that aren't completed and haven't been reminded
    const { data: pendingForms, error } = await supabase
      .from("consent_forms")
      .select("id, contact_id, first_name, phone, token, assigned_technician")
      .eq("date_of_procedure", todayStr)
      .neq("status", "completed")
      .eq("day_of_reminder_sent", false);

    if (error) {
      console.error("❌ Error querying pending consent forms:", error);
      return { success: false, error: error.message };
    }

    if (!pendingForms || pendingForms.length === 0) {
      console.log("✅ No day-of consent reminders to send");
      return { success: true, sent: 0, errors: 0 };
    }

    console.log(`📋 Found ${pendingForms.length} pending consent forms for today`);

    let sent = 0;
    let errors = 0;

    for (const form of pendingForms) {
      try {
        const firstName = form.first_name || "there";
        const formUrl = `${CONSENT_FORM_BASE_URL}/f/${form.token}`;

        const smsBody = `Hi ${firstName}, your tattoo appointment is today! Please complete your consent form before arriving: ${formUrl}`;

        await sendConversationMessage({
          contactId: form.contact_id,
          body: smsBody,
          channelContext: { hasPhone: true, phone: form.phone },
        });

        // Mark reminder as sent
        await supabase
          .from("consent_forms")
          .update({ day_of_reminder_sent: true })
          .eq("id", form.id);

        console.log(`✅ Day-of reminder sent to ${firstName} (${form.contact_id})`);
        sent++;
      } catch (sendErr) {
        console.error(`❌ Failed to send day-of reminder for ${form.contact_id}:`, sendErr.message);
        errors++;
      }
    }

    console.log(`🔔 Day-of reminders complete: ${sent} sent, ${errors} errors`);
    return { success: true, sent, errors };
  } catch (err) {
    console.error("❌ Error sending day-of consent reminders:", err);
    return { success: false, error: err.message };
  }
}

// ─── Phase 6: Consent Form Updates & Amendments ───────────────────────

// GHL field ID → human-readable label (for SMS change summaries)
const FIELD_LABELS = {
  tattoo_placement: { en: "placement", es: "ubicación" },
  quoted_price: { en: "price", es: "precio" },
  number_of_sessions: { en: "sessions", es: "sesiones" },
  assigned_technician: { en: "artist", es: "artista" },
  date_of_procedure: { en: "procedure date", es: "fecha del procedimiento" },
};

// GHL field ID mapping for amendment GHL sync
const AMENDABLE_GHL_FIELDS = {
  tattoo_placement: GHL_FIELD_IDS.locationOfTattoo,
  quoted_price: GHL_FIELD_IDS.finalPrice,
  assigned_technician: GHL_FIELD_IDS.assignedTechnician,
  date_of_procedure: GHL_FIELD_IDS.dateOfProcedure,
};

/**
 * Build a changes array by comparing old and new values for amendable fields.
 */
function buildChangesArray(currentValues, newValues) {
  const changes = [];
  const fields = ["tattoo_placement", "quoted_price", "number_of_sessions", "assigned_technician", "date_of_procedure"];

  for (const field of fields) {
    if (newValues[field] !== undefined && String(newValues[field]) !== String(currentValues[field] || "")) {
      changes.push({
        field,
        old: currentValues[field] ?? null,
        new: newValues[field],
      });
    }
  }
  return changes;
}

/**
 * Build a brief SMS summary of what changed (e.g., "placement changed" / "cambio de ubicación").
 */
function buildChangesSummary(changes, lang = "en") {
  return changes
    .map((c) => {
      const label = FIELD_LABELS[c.field]?.[lang] || c.field;
      return lang === "es" ? `cambio de ${label}` : `${label} changed`;
    })
    .join(", ");
}

/**
 * Update an UNSIGNED consent form (status = "sent").
 * Expires old token, generates new token, updates values, records audit trail, sends SMS.
 *
 * @param {string} contactId - GHL contact ID
 * @param {object} updates - { tattoo_placement, quoted_price, number_of_sessions, assigned_technician, date_of_procedure }
 * @param {string} [changedBy] - Artist name who made the change
 * @returns {object} { success, formUrl, error }
 */
async function updateConsentForm(contactId, updates, changedBy = null) {
  try {
    // 1. Find the most recent active (non-expired) sent form for this contact
    const { data: form, error: lookupError } = await supabase
      .from("consent_forms")
      .select("*")
      .eq("contact_id", contactId)
      .eq("status", "sent")
      .is("expired_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lookupError || !form) {
      return { success: false, error: "No active unsigned consent form found for this contact" };
    }

    // 2. Build changes array
    const changes = buildChangesArray(form, updates);
    if (changes.length === 0) {
      return { success: false, error: "No changes detected" };
    }

    // 3. Generate new token
    const newToken = generateFormToken();

    // 4. Expire old form (keep old token in DB so expired check works)
    //    Clear appointment_id on expired row to avoid unique constraint conflict with new row
    const { error: expireError } = await supabase
      .from("consent_forms")
      .update({ expired_at: new Date().toISOString(), appointment_id: null })
      .eq("id", form.id);

    if (expireError) {
      console.error("❌ Error expiring old consent form:", expireError);
      return { success: false, error: expireError.message };
    }

    // 5. Create new form row with updated values + new token
    const newFormData = {
      contact_id: form.contact_id,
      appointment_id: form.appointment_id,
      first_name: form.first_name,
      last_name: form.last_name,
      phone: form.phone,
      email: form.email,
      date_of_procedure: updates.date_of_procedure !== undefined ? updates.date_of_procedure : form.date_of_procedure,
      assigned_technician: updates.assigned_technician !== undefined ? updates.assigned_technician : form.assigned_technician,
      technician_license: updates.assigned_technician !== undefined
        ? (lookupLicense(updates.assigned_technician) || form.technician_license)
        : form.technician_license,
      quoted_price: updates.quoted_price !== undefined ? updates.quoted_price : form.quoted_price,
      number_of_sessions: updates.number_of_sessions !== undefined ? updates.number_of_sessions : form.number_of_sessions,
      location_of_tattoo: form.location_of_tattoo,
      tattoo_placement: updates.tattoo_placement !== undefined ? updates.tattoo_placement : form.tattoo_placement,
      token: newToken,
      status: "sent",
      sent_at: new Date().toISOString(),
    };

    const { data: newForm, error: insertError } = await supabase
      .from("consent_forms")
      .insert(newFormData)
      .select()
      .single();

    if (insertError) {
      console.error("❌ Error creating updated consent form:", insertError);
      return { success: false, error: insertError.message };
    }

    // Link old form to new one
    await supabase
      .from("consent_forms")
      .update({ superseded_by: newForm.id })
      .eq("id", form.id);

    // 6. Record audit trail (on the NEW form, linking back to original)
    await supabase.from("consent_form_changes").insert({
      consent_form_id: newForm.id,
      changes,
      changed_by: changedBy,
    });

    // 7. Send SMS with new link
    const formUrl = `${CONSENT_FORM_BASE_URL}/f/${newToken}`;
    const firstName = form.first_name || "there";

    // Detect language preference
    let lang = "en";
    try {
      const contact = await getContact(contactId);
      if (contact?.customField?.language_preference?.toLowerCase() === "spanish" || contact?.customField?.language_preference === "es") {
        lang = "es";
      }
    } catch (e) { /* default to English */ }

    const summary = buildChangesSummary(changes, lang);
    const smsBody = lang === "es"
      ? `Hola ${firstName}, tu formulario de consentimiento ha sido actualizado (${summary}). Por favor usa este nuevo enlace: ${formUrl}`
      : `Hi ${firstName}, your consent form has been updated (${summary}). Please use this new link: ${formUrl}`;

    try {
      await sendConversationMessage({
        contactId,
        body: smsBody,
        channelContext: { hasPhone: true, phone: form.phone },
      });
    } catch (smsErr) {
      console.error("⚠️ SMS send failed for consent form update (DB update succeeded):", smsErr.message);
      // Non-fatal — form was updated, client can be resent manually
    }

    console.log(`✅ Consent form updated for ${firstName} (${contactId}), new token: ${newToken}`);
    return { success: true, formUrl };
  } catch (err) {
    console.error("❌ Error updating consent form:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Create an amendment for a SIGNED consent form (status = "completed").
 * Creates a consent_amendments record with fresh token, sends SMS.
 *
 * @param {string} contactId - GHL contact ID
 * @param {object} updates - { tattoo_placement, quoted_price, number_of_sessions, assigned_technician, date_of_procedure }
 * @returns {object} { success, amendmentId, amendmentUrl, error }
 */
async function amendConsentForm(contactId, updates) {
  try {
    // 1. Find the most recent completed form for this contact
    const { data: form, error: lookupError } = await supabase
      .from("consent_forms")
      .select("*")
      .eq("contact_id", contactId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lookupError || !form) {
      return { success: false, error: "No completed consent form found for this contact" };
    }

    // 2. Build changes array (compare against current effective values — apply ALL completed amendments)
    const { data: completedAmendments } = await supabase
      .from("consent_amendments")
      .select("changes")
      .eq("consent_form_id", form.id)
      .eq("status", "completed")
      .order("created_at", { ascending: true });

    // Get current effective values (original form + all completed amendments in order)
    const currentValues = {
      tattoo_placement: form.tattoo_placement,
      quoted_price: form.quoted_price,
      number_of_sessions: form.number_of_sessions,
      assigned_technician: form.assigned_technician,
      date_of_procedure: form.date_of_procedure,
    };

    // Apply all completed amendments chronologically
    if (completedAmendments) {
      for (const amdt of completedAmendments) {
        for (const change of amdt.changes) {
          if (currentValues.hasOwnProperty(change.field)) {
            currentValues[change.field] = change.new;
          }
        }
      }
    }

    const changes = buildChangesArray(currentValues, updates);
    if (changes.length === 0) {
      return { success: false, error: "No changes detected" };
    }

    // 3. Generate amendment token
    const token = generateFormToken();

    // 4. Create consent_amendments record
    const { data: amendment, error: insertError } = await supabase
      .from("consent_amendments")
      .insert({
        consent_form_id: form.id,
        contact_id: contactId,
        changes,
        token,
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("❌ Error creating consent amendment:", insertError);
      return { success: false, error: insertError.message };
    }

    // 5. Send SMS with amendment link
    const amendmentUrl = `${CONSENT_FORM_BASE_URL}/a/${token}`;
    const firstName = form.first_name || "there";

    let lang = "en";
    try {
      const contact = await getContact(contactId);
      if (contact?.customField?.language_preference?.toLowerCase() === "spanish" || contact?.customField?.language_preference === "es") {
        lang = "es";
      }
    } catch (e) { /* default to English */ }

    const smsBody = lang === "es"
      ? `Hola ${firstName}, los detalles de tu tatuaje han sido actualizados. Por favor revisa y firma la enmienda: ${amendmentUrl}`
      : `Hi ${firstName}, your tattoo details have been updated. Please review and sign the amendment: ${amendmentUrl}`;

    try {
      await sendConversationMessage({
        contactId,
        body: smsBody,
        channelContext: { hasPhone: true, phone: form.phone },
      });
    } catch (smsErr) {
      console.error("⚠️ SMS send failed for consent amendment (DB record created):", smsErr.message);
    }

    console.log(`✅ Amendment created for ${firstName} (${contactId}), token: ${token}`);
    return { success: true, amendmentId: amendment.id, amendmentUrl };
  } catch (err) {
    console.error("❌ Error creating consent amendment:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get amendment details by token (for the amendment web page).
 *
 * @param {string} token - Amendment token
 * @returns {object} { success, data, error }
 */
async function getAmendmentByToken(token) {
  try {
    const { data: amendment, error } = await supabase
      .from("consent_amendments")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !amendment) {
      return { success: false, error: "Amendment not found or link expired" };
    }

    if (amendment.status === "completed") {
      return { success: false, error: "This amendment has already been signed" };
    }

    // Fetch the original consent form for context
    const { data: form } = await supabase
      .from("consent_forms")
      .select("first_name, last_name, assigned_technician, signed_at, completed_at")
      .eq("id", amendment.consent_form_id)
      .single();

    // Fetch language preference
    let languagePreference = null;
    try {
      const contact = await getContact(amendment.contact_id);
      if (contact?.customField?.language_preference) {
        languagePreference = contact.customField.language_preference;
      }
    } catch (e) { /* default */ }

    return {
      success: true,
      data: {
        id: amendment.id,
        changes: amendment.changes,
        firstName: form?.first_name || null,
        lastName: form?.last_name || null,
        assignedTechnician: form?.assigned_technician || null,
        originalSignedAt: form?.signed_at || form?.completed_at || null,
        languagePreference,
      },
    };
  } catch (err) {
    console.error("❌ Error fetching amendment by token:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Submit a signed amendment.
 * Updates amendment record, syncs changed fields to GHL contact.
 *
 * @param {string} token - Amendment token
 * @param {object} submission - { signatureData, consentCheckbox, legalTextHash }
 * @param {object} [requestMeta] - { ip, userAgent }
 * @returns {object} { success, error }
 */
async function submitAmendment(token, submission, requestMeta = {}) {
  try {
    // 1. Look up amendment
    const { data: amendment, error: lookupError } = await supabase
      .from("consent_amendments")
      .select("*")
      .eq("token", token)
      .single();

    if (lookupError || !amendment) {
      return { success: false, error: "Amendment not found or link expired" };
    }

    if (amendment.status === "completed") {
      return { success: false, error: "This amendment has already been signed" };
    }

    const now = new Date().toISOString();

    // 2. Update amendment with signature + evidence
    const { error: updateError } = await supabase
      .from("consent_amendments")
      .update({
        signature_data: submission.signatureData || null,
        signed_at: now,
        signer_ip: requestMeta.ip || null,
        signer_user_agent: requestMeta.userAgent || null,
        legal_text_hash: submission.legalTextHash || null,
        status: "completed",
        completed_at: now,
      })
      .eq("id", amendment.id);

    if (updateError) {
      console.error("❌ Error updating amendment:", updateError);
      return { success: false, error: updateError.message };
    }

    // 3. Sync changed fields to GHL contact
    try {
      const customFields = [];
      for (const change of amendment.changes) {
        const ghlFieldId = AMENDABLE_GHL_FIELDS[change.field];
        if (ghlFieldId) {
          customFields.push({ id: ghlFieldId, field_value: String(change.new) });
        }
      }

      if (customFields.length > 0) {
        await updateContact(amendment.contact_id, { customFields });
        console.log(`✅ GHL contact ${amendment.contact_id} synced with amendment changes`);
      }
    } catch (ghlErr) {
      console.error("⚠️ GHL sync failed for amendment (Supabase is source of truth):", ghlErr.message);
    }

    console.log(`✅ Amendment completed for contact ${amendment.contact_id}`);
    return { success: true };
  } catch (err) {
    console.error("❌ Error submitting amendment:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get the current effective consent form data for a contact.
 * Returns the latest form values + any completed amendments applied on top.
 * Used by the iOS update/amend sheet to show current values.
 *
 * @param {string} contactId - GHL contact ID
 * @returns {object} { success, data: { status, form fields, amendmentCount }, error }
 */
async function getConsentFormDetails(contactId) {
  try {
    const { data: form, error } = await supabase
      .from("consent_forms")
      .select("*")
      .eq("contact_id", contactId)
      .is("expired_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !form) {
      return { success: false, error: "No consent form found for this contact" };
    }

    // Get current effective values
    const values = {
      tattooPlacement: form.tattoo_placement,
      quotedPrice: form.quoted_price,
      numberOfSessions: form.number_of_sessions,
      assignedTechnician: form.assigned_technician,
      dateOfProcedure: form.date_of_procedure,
    };

    // Count amendments + apply latest completed amendment values
    let amendmentCount = 0;
    if (form.status === "completed") {
      const { data: amendments } = await supabase
        .from("consent_amendments")
        .select("changes, status")
        .eq("consent_form_id", form.id)
        .order("created_at", { ascending: true });

      if (amendments) {
        amendmentCount = amendments.filter(a => a.status === "completed").length;
        for (const amendment of amendments) {
          if (amendment.status === "completed") {
            for (const change of amendment.changes) {
              const camelKey = {
                tattoo_placement: "tattooPlacement",
                quoted_price: "quotedPrice",
                number_of_sessions: "numberOfSessions",
                assigned_technician: "assignedTechnician",
                date_of_procedure: "dateOfProcedure",
              }[change.field];
              if (camelKey) values[camelKey] = change.new;
            }
          }
        }
      }
    }

    return {
      success: true,
      data: {
        status: form.status,
        consentFormId: form.id,
        ...values,
        amendmentCount,
      },
    };
  } catch (err) {
    console.error("❌ Error fetching consent form details:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Check if a phone number belongs to an existing GHL contact.
 * Used by iOS when artist enters a "new" phone number — if the contact
 * already exists, we return their data so iOS can pre-fill the form
 * instead of erroring on duplicate creation.
 *
 * @param {string} phone - Phone number (E.164 format, e.g. +16125550142)
 * @returns {object} { exists, contact: { id, firstName, lastName, phone, email, customFields... } | null }
 */
async function checkPhoneForExistingContact(phone) {
  if (!phone) return { exists: false, contact: null };

  try {
    // Use getDuplicateContact to check if phone exists in GHL
    const { ghl: ghlSdk } = require("../clients/ghlSdk");
    const locationId = process.env.GHL_LOCATION_ID;
    const dupeData = await ghlSdk.contacts.getDuplicateContact({
      locationId,
      number: phone,
    });

    const contactId = dupeData?.contact?.id || dupeData?.id;
    if (!contactId) {
      return { exists: false, contact: null };
    }

    // Fetch the full contact to get custom fields for pre-fill
    const contact = await getContact(contactId);
    if (!contact) {
      return { exists: false, contact: null };
    }

    // Return a normalized subset iOS needs for pre-filling
    return {
      exists: true,
      contact: {
        id: contact.id,
        firstName: contact.firstName || null,
        lastName: contact.lastName || null,
        phone: contact.phone || phone,
        email: contact.email || null,
        assignedTo: contact.assignedTo || null,
        // Custom fields relevant to consent form pre-fill
        assignedArtist: contact.customField?.assigned_artist || null,
        tattooPlacement: contact.customField?.tattoo_placement || null,
        quotedPrice: contact.customField?.final_price || contact.customField?.quote_to_client || null,
        sessionEstimate: contact.customField?.session_estimate || null,
        tattooSize: contact.customField?.tattoo_size || null,
        tattooStyle: contact.customField?.tattoo_style || null,
      },
    };
  } catch (err) {
    // 404 means no duplicate found — not an error
    if (err.statusCode === 404 || err.response?.statusCode === 404) {
      return { exists: false, contact: null };
    }
    console.error("⚠️ Phone check error:", err.message);
    return { exists: false, contact: null };
  }
}

module.exports = {
  sendConsentForm,
  getConsentFormByToken,
  submitConsentForm,
  getConsentFormStatus,
  getConsentFormStatusBatch,
  sendDayOfConsentReminders,
  updateConsentForm,
  amendConsentForm,
  getAmendmentByToken,
  submitAmendment,
  getConsentFormDetails,
  checkPhoneForExistingContact,
  GHL_FIELD_IDS,
};
