// consentFormService.js
// Service for managing tattoo consent forms — Supabase storage + GHL sync

const crypto = require("crypto");
const { supabase } = require("../clients/supabaseClient");
const {
  getContact,
  updateContact,
  sendConversationMessage,
  uploadFilesToTattooCustomField,
} = require("../clients/ghlClient");
const { GHL_LOCATION_ID } = require("../config/constants");

const CONSENT_FORM_BASE_URL =
  process.env.CONSENT_FORM_URL || "https://consent.studioaz.us";

// GHL custom field IDs for consent form fields
const GHL_FIELD_IDS = {
  consentFormStatus: null,       // TODO: create in GHL, add ID here
  consentFormSentAt: null,       // TODO: create in GHL, add ID here
  consentFormCompletedAt: null,  // TODO: create in GHL, add ID here
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
 * Generate a secure, short-lived token for a consent form link.
 * Returns a random hex string stored in the consent_forms row.
 */
function generateFormToken() {
  return crypto.randomBytes(24).toString("hex"); // 48-char token
}

/**
 * Send a consent form to a contact.
 * Creates a Supabase row, generates a token, sends SMS via GHL.
 *
 * @param {object} params
 * @param {string} params.contactId - GHL contact ID
 * @param {number} params.quotedPrice - Tattoo quote (from artist confirmation)
 * @param {number} params.numberOfSessions - Number of sessions (from artist confirmation)
 * @param {string} params.assignedTechnician - Artist name
 * @param {string} params.procedureDate - ISO date string
 * @param {string} params.tattooPlacement - Tattoo placement description
 * @param {string} [params.appointmentId] - GHL appointment ID (for stable linking)
 * @returns {object} { success, consentFormId, formUrl, error }
 */
async function sendConsentForm({
  contactId,
  quotedPrice,
  numberOfSessions,
  assignedTechnician,
  procedureDate,
  tattooPlacement,
  appointmentId = null,
}) {
  try {
    // 1. Fetch contact data from GHL for pre-fill fields
    const contact = await getContact(contactId);
    if (!contact) {
      return { success: false, error: "Contact not found in GHL" };
    }

    const firstName =
      contact.firstName || contact.name?.split(" ")[0] || "there";
    const phone = contact.phone;

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
          contact_id: contactId,
          appointment_id: appointmentId,
          first_name: contact.firstName || null,
          last_name: contact.lastName || null,
          phone: contact.phone || null,
          email: contact.email || null,
          date_of_procedure: procedureDate || null,
          assigned_technician: assignedTechnician || null,
          technician_license: contact.customField?.assigned_technician_license_ || null,
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
      contactId,
      body: smsBody,
      channelContext: { hasPhone: true, phone },
    });

    // 6. Update GHL consent form status
    if (GHL_FIELD_IDS.consentFormStatus) {
      try {
        await updateContact(contactId, {
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

    console.log(`✅ Consent form sent to ${firstName} (${contactId}), token: ${token}`);

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
 *
 * @param {string} token - Form token
 * @param {object} submission - Client-submitted data
 * @returns {object} { success, error }
 */
async function submitConsentForm(token, submission) {
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

    // 3. Write full record to Supabase
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("consent_forms")
      .update({
        date_of_birth: submission.dateOfBirth || null,
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

      // Only sync signature if GHL accepts base64 writes (needs verification — see plan issue #7)
      if (submission.signatureData && GHL_FIELD_IDS.signature) {
        customFields.push({
          id: GHL_FIELD_IDS.signature,
          field_value: submission.signatureData,
        });
      }

      // Consent form status fields
      if (GHL_FIELD_IDS.consentFormStatus) {
        customFields.push(
          { id: GHL_FIELD_IDS.consentFormStatus, field_value: "completed" },
          { id: GHL_FIELD_IDS.consentFormCompletedAt, field_value: now }
        );
      }

      await updateContact(contactId, {
        dateOfBirth: submission.dateOfBirth || undefined,
        address1: submission.address || undefined,
        city: submission.city || undefined,
        state: submission.state || undefined,
        country: submission.country || undefined,
        customFields,
      });

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

module.exports = {
  sendConsentForm,
  getConsentFormByToken,
  submitConsentForm,
  getConsentFormStatus,
  getConsentFormStatusBatch,
  GHL_FIELD_IDS,
};
