// squareClient.js
// Direct HTTP client for Square payment links + orders using axios.
// Uses CHECKOUT_LINK catalog objects for rich checkout pages (logo, description).
// Maps checkout links → contacts via Supabase for webhook tracing.

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { COMPACT_MODE, logSquareEvent, shortId } = require("../utils/logger");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";

const isProd = SQUARE_ENVIRONMENT === "production";

const SQUARE_BASE_URL = isProd
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Studio AZ logo image ID in Square catalog
const LOGO_IMAGE_ID = "RK4P3O5ONUIHXYETBDEVQNCU";

// Rich descriptions for deposit tiers
const DEPOSIT_100_DESCRIPTION =
  "\ud83c\udfa8 Design Consult + Concept Sketch\n" +
  "\ud83d\udcb5 If You Don\u2019t Love the Concept, Get Your Full Deposit Back\n" +
  "\ud83d\udcf8 Pro Photo Set (Optional)\n\n" +
  "PLUS:\n" +
  "\ud83e\uddd1\u200d\ud83c\udfa8 Art Director (Concierge) to guide your process\n" +
  "\ud83c\udf10 Live Translator for seamless communication (Optional)\n" +
  "\u23f1\ufe0f Priority Scheduling\n" +
  "\ud83e\udd1d Ongoing Healing Support: direct access to your Concierge and Artist for aftercare guidance so your tattoo looks its best";

const CONSULT_50_DESCRIPTION =
  "\ud83c\udfa8 Design Consult + Concept Sketch\n" +
  "\ud83d\udcb5 Applied to Your Tattoo Total Fee\n" +
  "\ud83d\udcaf or Fully Refundable";

if (!SQUARE_ACCESS_TOKEN) {
  console.warn(
    "[Square] SQUARE_ACCESS_TOKEN is not set. Payment link creation will fail."
  );
}

if (!SQUARE_LOCATION_ID) {
  console.warn(
    "[Square] SQUARE_LOCATION_ID is not set. Payment link creation will fail."
  );
}

/**
 * Create a Square checkout link for a specific contact.
 * Uses CHECKOUT_LINK catalog objects for rich checkout pages with logo + description.
 * Stores the mapping in Supabase for webhook tracing.
 */
async function createDepositLinkForContact({
  contactId,
  amountCents,
  currency = "USD",
  description = "Studio AZ Tattoo Deposit",
  business = "tattoo",
  paymentType = "deposit",
  artistId = null,
  artistName = null,
  contactName = null,
}) {
  if (!contactId) {
    throw new Error("contactId is required for createDepositLinkForContact");
  }
  if (typeof amountCents !== "number" || !amountCents) {
    throw new Error(
      "amountCents (number) is required for createDepositLinkForContact"
    );
  }
  if (!SQUARE_LOCATION_ID) {
    throw new Error(
      "SQUARE_LOCATION_ID is not set. Cannot create payment link."
    );
  }

  // Pick the right description based on amount
  const checkoutDescription =
    amountCents === 10000 ? DEPOSIT_100_DESCRIPTION :
    amountCents === 5000 ? CONSULT_50_DESCRIPTION :
    null; // Custom amounts get no description

  const checkoutName =
    amountCents === 10000 ? "Tattoo Deposit" :
    amountCents === 5000 ? "Tattoo Consultation Fee" :
    description;

  if (!COMPACT_MODE) {
    console.log("[Square] Creating checkout link:", {
      contactId,
      amountCents,
      currency,
      checkoutName,
      env: isProd ? "production" : "sandbox",
    });
  }

  try {
    const url = `${SQUARE_BASE_URL}/v2/catalog/object`;

    const catalogBody = {
      idempotency_key: `${contactId}-${Date.now()}`,
      object: {
        type: "CHECKOUT_LINK",
        id: `#checkout-${contactId}-${Date.now()}`,
        present_at_location_ids: [SQUARE_LOCATION_ID],
        checkout_link_data: {
          name: checkoutName,
          ...(checkoutDescription && { description: checkoutDescription }),
          link_type: "PAYMENT_LINK",
          enabled: true,
          order_details: {
            line_items: [
              {
                ordinal: 0,
                quantity: { quantity: 1 },
                name: checkoutName,
                price_money: { amount: amountCents, currency },
              },
            ],
          },
          allow_tipping: false,
          image_ids: [LOGO_IMAGE_ID],
        },
      },
    };

    const response = await axios.post(url, catalogBody, {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2049-01-03",
      },
    });

    const catalogObject = response.data?.catalog_object;
    const checkoutData = catalogObject?.checkout_link_data;

    if (!checkoutData?.url) {
      console.error(
        "[Square] No checkout URL in response:",
        JSON.stringify(response.data, null, 2)
      );
      throw new Error("No checkout URL returned from Square");
    }

    const checkoutLinkId = catalogObject.id;
    const checkoutUrl = checkoutData.url;

    // Store mapping in Supabase for webhook tracing
    const { error: dbError } = await supabase
      .from("square_checkout_links")
      .insert({
        checkout_link_id: checkoutLinkId,
        checkout_url: checkoutUrl,
        contact_id: contactId,
        contact_name: contactName,
        artist_id: artistId,
        artist_name: artistName,
        business,
        payment_type: paymentType,
        amount_cents: amountCents,
      });

    if (dbError) {
      console.error("[Square] Failed to store checkout link mapping:", dbError.message);
      // Don't fail — the link was created, just webhook tracing may not work
    }

    if (COMPACT_MODE) {
      console.log(`\ud83d\udcb3 SQUARE: checkout link created contact=${shortId(contactId)} $${amountCents / 100}`);
    } else {
      console.log("\ud83d\udcb3 Square checkout link created:", {
        contactId,
        checkoutLinkId,
        url: checkoutUrl,
      });
    }

    return {
      url: checkoutUrl,
      paymentLinkId: checkoutLinkId,
      orderId: null, // CHECKOUT_LINKs don't pre-create orders
    };
  } catch (err) {
    if (err.response) {
      console.error(
        "[Square] HTTP error creating checkout link:",
        err.response.status,
        JSON.stringify(err.response.data, null, 2)
      );
      throw new Error(
        `Square HTTP error ${err.response.status}: ${
          err.response.data?.errors?.[0]?.detail ||
          JSON.stringify(err.response.data)
        }`
      );
    } else if (err.message?.includes("Square HTTP error")) {
      throw err;
    } else {
      console.error("[Square] Unexpected error creating checkout link:", err);
      throw err;
    }
  }
}

/**
 * Given an orderId from a webhook, fetch the order and try to resolve the contactId.
 * First checks order.reference_id (Payment Links API orders), then falls back to
 * looking up the checkout link mapping in Supabase (CHECKOUT_LINK orders).
 *
 * Returns { contactId, mapping } where mapping contains artist/business info
 * from the checkout link (null if resolved via reference_id).
 */
async function getContactIdFromOrder(orderId, paymentId) {
  if (!orderId) return { contactId: null, mapping: null };

  try {
    const url = `${SQUARE_BASE_URL}/v2/orders/${orderId}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const data = response.data || {};
    const order = data.order;

    if (!order) {
      console.warn("[Square] No order found for id:", orderId);
      return { contactId: null, mapping: null };
    }

    // Try reference_id first (Payment Links API orders have this)
    let contactId = order.reference_id || null;
    let mapping = null;
    const amount = order.total_money?.amount || 0;

    // If no reference_id, match against unclaimed checkout links in Supabase
    if (!contactId) {
      mapping = await claimCheckoutLink(amount, orderId, paymentId);
      if (mapping) {
        contactId = mapping.contact_id;
        if (COMPACT_MODE) {
          console.log(`\ud83d\udcb3 SQUARE: checkout link claimed → contact=${shortId(contactId)} link=${shortId(mapping.checkout_link_id)}`);
        } else {
          console.log("[Square] Claimed checkout link mapping:", {
            checkoutLinkId: mapping.checkout_link_id,
            contactId,
            artistName: mapping.artist_name,
          });
        }
      }
    }

    if (COMPACT_MODE) {
      console.log(`\ud83d\udcb3 SQUARE: order=${shortId(orderId)} → contact=${shortId(contactId)} $${amount / 100}`);
    } else {
      console.log("[Square] Resolved order → contact mapping:", { orderId, contactId });
    }

    return { contactId, mapping };
  } catch (err) {
    if (err.response) {
      console.error(
        "[Square] HTTP error reading order:",
        err.response.status,
        JSON.stringify(err.response.data, null, 2)
      );
    } else {
      console.error("[Square] Unexpected error reading order:", err);
    }
    return { contactId: null, mapping: null };
  }
}

/**
 * Find the oldest unclaimed checkout link matching this amount, claim it
 * by setting order_id/payment_id/claimed_at, and return the full mapping.
 * FIFO order ensures the first link created is matched to the first payment.
 */
async function claimCheckoutLink(amountCents, orderId, paymentId) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Find oldest unclaimed link matching this amount
    const { data, error } = await supabase
      .from("square_checkout_links")
      .select("*")
      .eq("amount_cents", amountCents)
      .is("claimed_at", null)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) {
      console.error("[Square] Supabase lookup error:", error.message);
      return null;
    }

    const match = data?.[0];
    if (!match) return null;

    // Claim it — mark as used so it's never matched again
    const { error: updateError } = await supabase
      .from("square_checkout_links")
      .update({
        claimed_at: new Date().toISOString(),
        order_id: orderId,
        payment_id: paymentId,
      })
      .eq("id", match.id)
      .is("claimed_at", null); // Double-check still unclaimed (race condition guard)

    if (updateError) {
      console.error("[Square] Failed to claim checkout link:", updateError.message);
    }

    return match;
  } catch (err) {
    console.error("[Square] Error claiming checkout link:", err.message);
    return null;
  }
}

module.exports = {
  createDepositLinkForContact,
  getContactIdFromOrder,
};
