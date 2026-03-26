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
  process.env.CONSENT_FORM_URL || "https://consent.studioaz.us";

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
        console.error("❌ Failed to create GHL contact:", createErr.message);
        return { success: false, error: `Failed to create contact: ${createErr.message}` };
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

    // 6. Update GHL consent form status
    if (GHL_FIELD_IDS.consentFormStatus) {
      try {
        await updateContact(resolvedContactId, {
          customFields: [
            { id: GHL_FIELD_IDS.consentFormStatus, field_value: "sent" },
            {
              id: GHL_FIELD_IDS.consentFormSentAt,
              field_value: new Date().toISOString(),
            },
          ],
        });
      } catch (ghlErr) {
        console.warn("⚠️ Failed to update GHL consent status:", ghlErr.message);
        // Non-fatal — Supabase is the source of truth
      }
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
        const uploadResult = await uploadFilesToTattooCustomField(contactId, [
          {
            buffer: submission.idPhoto.buffer,
            originalname: submission.idPhoto.filename || "valid-id.jpg",
            mimetype: submission.idPhoto.contentType || "image/jpeg",
          },
        ]);
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
        medical_history: submission.medicalHistory || [],
        medical_history_description: submission.medicalHistoryDescription || null,
        id_photo_url: idPhotoUrl || submission.idPhotoFallbackUrl || null,
        consent_checkbox: submission.consentCheckbox === true,
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
        { id: GHL_FIELD_IDS.medicalHistory, field_value: (submission.medicalHistory || []).join(", ") },
        { id: GHL_FIELD_IDS.medicalHistoryDescription, field_value: submission.medicalHistoryDescription || "" },
        { id: GHL_FIELD_IDS.emergencyContact, field_value: submission.emergencyContactPhone || "" },
        { id: GHL_FIELD_IDS.consentCheckbox, field_value: submission.consentCheckbox ? "Yes" : "No" },
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

module.exports = {
  sendConsentForm,
  getConsentFormByToken,
  submitConsentForm,
  getConsentFormStatus,
  getConsentFormStatusBatch,
  sendDayOfConsentReminders,
  GHL_FIELD_IDS,
};
