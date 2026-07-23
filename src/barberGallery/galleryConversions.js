// galleryConversions.js — server-side conversion recording for the gallery
// marketing pipeline (future-marketing-platform-roadmap.md Phase 4).
//
// Called from the booking create path AFTER an appointment is confirmed.
// Best-effort by contract: a conversion row that fails to write is a log
// line, never a failed booking.

const { supabase } = require("../clients/supabaseClient");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,48}$/;

/**
 * Insert a `conversion` row into gallery_events crediting the print that
 * drove the booking. sessionId joins the row to that visitor's impressions
 * and flips; a missing/invalid one gets a random UUID so distinct-session
 * counting still works.
 *
 * @returns {Promise<boolean>} recorded or not (never throws)
 */
async function recordGalleryConversion({
  gallery,
  contactId,
  isNewClient,
  leadSource,
}) {
  try {
    if (!supabase || !gallery) return false;
    const { photoId, barberSlug, sessionId } = gallery;
    if (!UUID_RE.test(String(photoId || ""))) return false;
    if (!SLUG_RE.test(String(barberSlug || ""))) return false;

    const { error } = await supabase.from("gallery_events").insert({
      event_type: "conversion",
      photo_id: photoId,
      barber_slug: barberSlug,
      session_id: UUID_RE.test(String(sessionId || ""))
        ? sessionId
        : require("crypto").randomUUID(),
      contact_id: contactId || null,
      is_new_client: typeof isNewClient === "boolean" ? isNewClient : null,
      lead_source: leadSource || null,
      page: "/book",
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`⚠️ [GalleryAnalytics] conversion insert failed: ${err.message?.slice(0, 150)}`);
    return false;
  }
}

module.exports = { recordGalleryConversion };
