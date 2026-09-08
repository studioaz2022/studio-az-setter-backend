// venmoBarberPayment.js
// Handles Venmo "paid you" emails that are NOT rent payments — i.e., clients
// paying a barber for a haircut/service. Matches the sender to a GHL contact,
// links to an appointment if possible, and records to the Supabase transactions table.

const { createClient } = require("@supabase/supabase-js");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { generateDedup } = require("../rentTracker/venmoEmailParser");
const { toLocalDate } = require("./squareTransactionSync");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const BARBER_TZ = "America/Chicago";

/**
 * Parse a date from a Venmo note (e.g., "Feb 25", "Cut Feb 18th", "2/18").
 * Returns a Date if found and in the past, null otherwise.
 */
function parseNoteDate(note) {
  if (!note) return null;
  const currentYear = new Date().getFullYear();

  const patterns = [
    // "Feb 25", "Feb 25th", "February 25", "feb25"
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{1,2})(?:st|nd|rd|th)?\b/i,
    // "2/25", "02/25", "2/25/26"
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
  ];

  const monthNames = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

  for (const pattern of patterns) {
    const m = note.match(pattern);
    if (!m) continue;

    if (/^\d/.test(m[1])) {
      // Numeric: M/D or M/D/Y
      const month = parseInt(m[1]) - 1;
      const day = parseInt(m[2]);
      const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : currentYear;
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime()) && d <= new Date()) return d;
    } else {
      // Month name
      const month = monthNames[m[1].slice(0, 3).toLowerCase()];
      if (month === undefined) continue;
      const day = parseInt(m[2]);
      const d = new Date(currentYear, month, day);
      if (!isNaN(d.getTime()) && d <= new Date()) return d;
    }
  }
  return null;
}

/**
 * Handle a Venmo payment that isn't from a known rent tenant.
 * Tries to match the sender to a GHL contact and link to an appointment.
 *
 * @param {Object} params
 * @param {Object} params.parsed - Output from parseVenmoEmail()
 * @param {string} params.barberGhlId - GHL user ID of the barber who received the payment
 * @returns {Object} { recorded, matched, contactName, appointmentId, venmoTxId } or { skipped }
 */
async function handleBarberVenmoPayment({ parsed, barberGhlId }) {
  // Step 1: Build dedup key
  const venmoTxId = parsed.transactionId || generateDedup(parsed.senderName, parsed.amount, parsed.date, parsed.note);

  // Step 2: Dedup check
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("venmo_transaction_id", venmoTxId)
    .maybeSingle();

  if (existing) {
    console.log(`  [VenmoBarber] Duplicate: ${venmoTxId}`);
    return { skipped: "duplicate", venmoTxId };
  }

  // Step 3: Build unclaimed appointments list (needed for contact matching cross-ref)
  let appointmentId = null;
  let calendarId = null;
  const paymentDate = parsed.date || new Date();
  // If the note contains a date (e.g., "Cut Feb 18th"), use it for session_date
  // and appointment lookup instead of the email/payment date.
  const noteDate = parseNoteDate(parsed.note);
  const effectiveDate = noteDate || paymentDate;
  // `let`, not const: a cross-day contact match reassigns this so session_date
  // follows the appointment rather than the moment the client hit send.
  let localDate = toLocalDate(effectiveDate.toISOString());
  if (noteDate) {
    console.log(`  [VenmoBarber] Note date detected: "${parsed.note}" → ${localDate} (payment was ${toLocalDate(paymentDate.toISOString())})`);
  }
  let unclaimedAppts = [];      // same local day — used for the blind fallback
  let unclaimedApptsWide = [];  // ±1 day — used only once we know WHO paid

  try {
    // Venmo gets a three-day window, not one day.
    //
    // Venmo payers here are the shop's closest regulars, and they are loose
    // about when they actually hit send — payments stamped 03:01 and 04:33
    // against afternoon appointments are normal, not errors. A strict same-day
    // window drops those on the floor. (It was also subtly wrong already:
    // `new Date("YYYY-MM-DDT00:00:00")` parses in the server's zone, which is
    // UTC on Render, so the "day" was skewed hours off Chicago regardless.)
    //
    // Widening is safe here precisely because Venmo carries a sender name.
    // The wide list is only ever consulted after a contact has been identified,
    // and then only for THAT contact's appointments — so a bigger window cannot
    // pull in a stranger. The blind distance-scoring fallback keeps the narrow
    // same-day list, because there the time IS the only evidence.
    const dayStart = new Date(`${localDate}T00:00:00-06:00`);
    const wideStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const wideEnd = new Date(dayStart.getTime() + 48 * 60 * 60 * 1000);

    const appointments = await fetchAppointmentsForDateRange({
      locationId: BARBER_LOCATION_ID,
      startTime: wideStart.toISOString(),
      endTime: wideEnd.toISOString(),
      userId: barberGhlId,
      sdkInstance: ghlBarber,
    });

    // Filter to real client appointments — exclude breaks, blocks, personal holds.
    // "new" is excluded for the same reason as in the Square matcher: measured
    // over Jun-Sep 2026, 185 past appointments sat at "new" and exactly one ever
    // got paid. They are bookings that never happened.
    const blockedTitles = ["break", "block", "blocked", "lunch", "personal", "off"];
    const activeAppts = appointments.filter((apt) => {
      if (apt.assignedUserId !== barberGhlId) return false;
      if (!["confirmed", "showed"].includes(apt.appointmentStatus)) return false;
      const title = (apt.title || "").toLowerCase().trim();
      return !blockedTitles.includes(title);
    });

    if (activeAppts.length > 0) {
      // Claim check by appointment id rather than by session_date: a payment
      // recorded under a different day still claims its appointment, and the
      // old session_date-scoped query could not see that.
      const { data: existingTx } = await supabase
        .from("transactions")
        .select("appointment_id")
        .eq("artist_ghl_id", barberGhlId)
        .eq("transaction_type", "session_payment")
        .is("deleted_at", null)
        .is("superseded_by", null)
        .in("appointment_id", activeAppts.map((a) => a.id));

      const claimedAptIds = new Set((existingTx || []).map((t) => t.appointment_id));
      unclaimedApptsWide = activeAppts
        .filter((apt) => !claimedAptIds.has(apt.id))
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      unclaimedAppts = unclaimedApptsWide.filter(
        (apt) => toLocalDate(apt.startTime) === localDate
      );
      console.log(`  [VenmoBarber] ${unclaimedAppts.length} unclaimed on ${localDate}, ${unclaimedApptsWide.length} across the ±1 day window`);
    } else {
      console.log(`  [VenmoBarber] No active appointments found near ${localDate}`);
    }
  } catch (err) {
    console.warn(`  [VenmoBarber] Appointment fetch failed: ${err.message}`);
  }

  // Step 4: Contact matching by name
  // IMPORTANT: contactName is ALWAYS the original Venmo sender name.
  // We never overwrite it with GHL or appointment contact info.
  let contactId = null;
  const contactName = parsed.senderName; // immutable — always the Venmo sender

  // Normalize helper: strip periods, collapse whitespace, lowercase
  // e.g. "C.J. Washington" → "cj washington", "Pablo RP" → "pablo rp"
  const normalize = (s) => (s || "").replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();

  // Common nickname/diminutive pairs for first-name matching
  const nicknameMap = {
    ben: "benjamin", benjamin: "ben",
    mike: "michael", michael: "mike",
    steve: "stephen", stephen: "steve",
    steven: "steve",
    matt: "matthew", matthew: "matt",
    dan: "daniel", daniel: "dan",
    dave: "david", david: "dave",
    rob: "robert", robert: "rob", bob: "robert",
    jim: "james", james: "jim",
    joe: "joseph", joseph: "joe",
    tom: "thomas", thomas: "tom",
    nick: "nicholas", nicholas: "nick",
    chris: "christopher", christopher: "chris",
    jon: "jonathan", jonathan: "jon",
    alex: "alexander", alexander: "alex",
    will: "william", william: "will", bill: "william",
    ed: "edward", edward: "ed",
    tony: "anthony", anthony: "tony",
    jake: "jacob", jacob: "jake",
    josh: "joshua", joshua: "josh",
    sam: "samuel", samuel: "sam",
    zac: "zachary", zach: "zachary", zachary: "zach",
    drew: "andrew", andrew: "drew",
    pat: "patrick", patrick: "pat",
    greg: "gregory", gregory: "greg",
    jeff: "jeffrey", jeffrey: "jeff",
    charlie: "charles", charles: "charlie", chuck: "charles",
    dj: "d j",
  };

  const namesMatch = (name1, name2) => {
    const parts1 = name1.split(" ");
    const parts2 = name2.split(" ");
    if (parts1.length < 2 || parts2.length < 2) return false;
    const first1 = parts1[0], last1 = parts1[parts1.length - 1];
    const first2 = parts2[0], last2 = parts2[parts2.length - 1];
    if (last1 !== last2) return false;
    if (first1 === first2) return true;
    return nicknameMap[first1] === first2 || nicknameMap[first2] === first1;
  };

  // Strategy 1: Match sender name against appointment titles directly.
  // This catches cases like "CJ Washington" → "C.J. Washington" where GHL search fails.
  // Also handles nicknames (Ben → Benjamin, etc.).
  //
  // Searches the ±1 day window, same-day entries first, so a regular who pays
  // in the small hours for the previous day's cut still gets identified — but a
  // same-day title always wins over an adjacent-day one when both would match.
  const titleSearchAppts = [
    ...unclaimedAppts,
    ...unclaimedApptsWide.filter((a) => toLocalDate(a.startTime) !== localDate),
  ];
  if (titleSearchAppts.length > 0 && parsed.senderName) {
    const senderNorm = normalize(parsed.senderName);
    for (const apt of titleSearchAppts) {
      const titleNorm = normalize(apt.title);
      if (!titleNorm) continue;
      if (titleNorm.includes(senderNorm) || senderNorm.includes(titleNorm)) {
        contactId = apt.contactId || null;
        console.log(`  [VenmoBarber] Appointment title match: "${parsed.senderName}" → "${apt.title}" (contact: ${contactId})`);
        break;
      }
      if (namesMatch(senderNorm, titleNorm)) {
        contactId = apt.contactId || null;
        console.log(`  [VenmoBarber] Appointment nickname match: "${parsed.senderName}" → "${apt.title}" (contact: ${contactId})`);
        break;
      }
    }
  }

  // Strategy 2: GHL contact search (if appointment title match didn't work)
  if (!contactId && ghlBarber && parsed.senderName) {
    try {
      const result = await ghlBarber.contacts.getContacts({
        locationId: BARBER_LOCATION_ID,
        query: parsed.senderName,
        limit: 5,
      });

      const contacts = result?.contacts || [];
      if (contacts.length > 0) {
        const senderLower = parsed.senderName.toLowerCase().trim();
        const exactMatch = contacts.find((c) => {
          const fullName = `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase();
          return fullName === senderLower;
        });

        if (exactMatch) {
          contactId = exactMatch.id;
          console.log(`  [VenmoBarber] Exact name match: ${exactMatch.firstName} ${exactMatch.lastName} (${contactId})`);
        } else if (contacts.length === 1) {
          contactId = contacts[0].id;
          console.log(`  [VenmoBarber] Single result match: ${contacts[0].firstName} ${contacts[0].lastName} (${contactId})`);
        } else {
          // Multiple results, try first+last name substring match
          const senderParts = senderLower.split(/\s+/);
          if (senderParts.length >= 2) {
            const firstName = senderParts[0];
            const lastName = senderParts[senderParts.length - 1];
            const partialMatch = contacts.find((c) => {
              const fn = (c.firstName || "").toLowerCase();
              const ln = (c.lastName || "").toLowerCase();
              return fn === firstName && ln === lastName;
            });
            if (partialMatch) {
              contactId = partialMatch.id;
              console.log(`  [VenmoBarber] First+last match: ${partialMatch.firstName} ${partialMatch.lastName} (${contactId})`);
            }
          }
        }

        if (!contactId) {
          console.log(`  [VenmoBarber] ${contacts.length} results but no confident match for "${parsed.senderName}"`);
        }
      } else {
        console.log(`  [VenmoBarber] No GHL contacts found for "${parsed.senderName}"`);
      }

      // Fallback: Venmo names are often abbreviated (e.g., "Pablo RP" for "Pablo Ruiz Plaza").
      // If full-name search failed, try first-name-only and cross-reference with day's appointments.
      if (!contactId && parsed.senderName.includes(" ")) {
        const firstName = parsed.senderName.split(/\s+/)[0];
        const firstNameResult = await ghlBarber.contacts.getContacts({
          locationId: BARBER_LOCATION_ID,
          query: firstName,
          limit: 10,
        });
        const firstNameContacts = firstNameResult?.contacts || [];
        // Deliberately SAME-DAY only, unlike the full-name title search above.
        // This branch matches on a first name alone, which is weak enough that
        // the day constraint is carrying real weight — widen it to ±1 day and
        // two different Mikes on consecutive days become one Mike.
        if (firstNameContacts.length > 0 && unclaimedAppts.length > 0) {
          const apptContactIds = new Set(unclaimedAppts.map((a) => a.contactId).filter(Boolean));
          const apptMatch = firstNameContacts.find((c) => apptContactIds.has(c.id));
          if (apptMatch) {
            contactId = apptMatch.id;
            console.log(`  [VenmoBarber] First-name fallback matched "${parsed.senderName}" → ${apptMatch.firstName} ${apptMatch.lastName} (${contactId}) via appointment cross-ref`);
          }
        }
      }
    } catch (err) {
      console.warn(`  [VenmoBarber] Contact search failed: ${err.message}`);
    }
  }

  // Step 5: Appointment matching
  if (unclaimedApptsWide.length > 0) {
    if (contactId) {
      // We know who paid, so search the full ±1 day window — only ever among
      // THIS contact's own appointments, which is what makes the wider net safe.
      // A regular who pays at 3am for yesterday's cut now lands correctly
      // instead of falling into the review queue.
      //
      // Prefer the same day when this contact has appointments on more than one
      // day in the window; otherwise take the nearest in time to the payment.
      const paymentMs = (parsed.date || new Date()).getTime();
      const theirs = unclaimedApptsWide.filter((apt) => apt.contactId === contactId);
      const sameDay = theirs.filter((apt) => toLocalDate(apt.startTime) === localDate);
      const pool = sameDay.length > 0 ? sameDay : theirs;
      const contactAppt = pool.sort(
        (a, b) => Math.abs(new Date(a.startTime) - paymentMs) - Math.abs(new Date(b.startTime) - paymentMs)
      )[0];

      if (contactAppt) {
        appointmentId = contactAppt.id;
        calendarId = contactAppt.calendarId || null;
        const apptDay = toLocalDate(contactAppt.startTime);
        if (apptDay !== localDate) {
          // Revenue belongs to the day the service happened, not the day the
          // client got around to paying. Without this, a late-night Venmo lands
          // the money in the wrong month at a month boundary.
          console.log(`  [VenmoBarber] Cross-day match: payment on ${localDate} → appointment on ${apptDay}; session_date follows the appointment`);
          localDate = apptDay;
        }
        console.log(`  [VenmoBarber] Matched to contact's appointment: ${appointmentId}`);
      }
      // If their appointment is already claimed or doesn't exist, leave as unmatched
    } else if (unclaimedAppts.length > 0) {
      // No GHL contact found at all — use distance-from-end scoring as a best guess.
      // Same logic as Square batch matching: 10-min grace period, 45-min max threshold.
      const MAX_MATCH_DISTANCE_MIN = 45;
      const GRACE_PERIOD_MS = 10 * 60 * 1000;
      const paymentMs = (parsed.date || new Date()).getTime();
      let bestApt = null;
      let bestScore = Infinity;
      for (const apt of unclaimedAppts) {
        const aptStart = new Date(apt.startTime);
        const aptEnd = apt.endTime ? new Date(apt.endTime) : new Date(aptStart.getTime() + 60 * 60 * 1000);
        const graceStart = new Date(aptEnd.getTime() - GRACE_PERIOD_MS);
        let score;
        if (paymentMs >= graceStart.getTime()) {
          score = Math.abs(paymentMs - aptEnd.getTime()) / 60000;
        } else {
          score = 1000 + (aptEnd.getTime() - paymentMs) / 60000;
        }
        if (score < bestScore) {
          bestScore = score;
          bestApt = apt;
        }
      }
      if (bestApt && bestScore <= MAX_MATCH_DISTANCE_MIN) {
        appointmentId = bestApt.id;
        calendarId = bestApt.calendarId || null;
        if (bestApt.contactId) {
          contactId = bestApt.contactId;
        }
        console.log(`  [VenmoBarber] Distance-from-end match: appointment ${appointmentId} (score: ${bestScore.toFixed(1)} min)`);
      }
    }
  }

  // Step 6: Calculate service/tip split using calendar price when available
  const { lookupServicePrice } = require("../config/barberServicePrices");
  const calendarPrice = calendarId ? await lookupServicePrice(calendarId) : null;
  let servicePrice, tipAmount;
  if (calendarPrice && parsed.amount >= calendarPrice) {
    servicePrice = calendarPrice;
    tipAmount = +(parsed.amount - calendarPrice).toFixed(2);
  } else {
    servicePrice = parsed.amount;
    tipAmount = 0;
  }

  // Step 7: Record to Supabase
  const { error } = await supabase.from("transactions").insert({
    contact_id: contactId || "venmo_unmatched",
    contact_name: contactName || parsed.senderName,
    appointment_id: appointmentId || null,
    artist_ghl_id: barberGhlId,
    transaction_type: "session_payment",
    payment_method: "venmo",
    payment_recipient: "artist_direct",
    gross_amount: parsed.amount,
    shop_percentage: 0,
    artist_percentage: 100,
    shop_amount: 0,
    artist_amount: parsed.amount,
    settlement_status: "settled",
    venmo_transaction_id: venmoTxId,
    session_date: localDate,
    location_id: BARBER_LOCATION_ID,
    notes: parsed.note || null,
    calendar_id: calendarId || null,
    service_price: servicePrice,
    tip_amount: tipAmount,
    venmo_story_url: parsed.storyUrl || null,
    venmo_profile_pic_url: parsed.profilePicUrl || null,
    square_payment_time: parsed.date ? parsed.date.toISOString() : null,
  });

  if (error) {
    console.error(`  [VenmoBarber] Supabase insert failed:`, error.message);
    return { error: "insert-failed", message: error.message };
  }

  const matched = !!contactId && contactId !== "venmo_unmatched";
  console.log(
    `  [VenmoBarber] ✅ Recorded: $${parsed.amount} from ${contactName}` +
    (matched ? ` (contact: ${contactId})` : " (unmatched)") +
    (appointmentId ? ` → apt: ${appointmentId}` : "")
  );

  // Mirror to InstantDB for rent tracker income view (non-fatal)
  try {
    const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
    const { weekOfDate } = require("../rentTracker/tenantMatcher");
    await writeServiceIncome({
      senderName: contactName || parsed.senderName,
      amount: parsed.amount,
      method: "venmo",
      type: "service",
      paidAt: paymentDate,
      notes: parsed.note || null,
      venmoTxId,
      weekOf: weekOfDate(paymentDate),
      location: "barbershop",
      tipAmount: 0,
      servicePriceAmount: parsed.amount,
      barberGhlId,
    });
  } catch (err) {
    console.warn(`  [VenmoBarber] InstantDB write failed (non-fatal): ${err.message}`);
  }

  return { recorded: true, matched, contactName, appointmentId, venmoTxId };
}

module.exports = { handleBarberVenmoPayment };
