// squareClient.js
// Direct HTTP client for Square checkout links using axios.
// Uses CHECKOUT_LINK catalog objects for rich checkout pages (logo, description).
// Embeds a unique code (last 5 chars of contactId) in the checkout name for
// reliable webhook tracing: "Tattoo Deposit #kOvnQ" → parse code → Supabase lookup.

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
 * Uses CHECKOUT_LINK catalog objects for rich checkout (logo + description).
 * Embeds last 5 chars of contactId as "#XXXXX" in the name for webhook tracing.
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

  // Unique code from last 5 chars of contactId
  const trackingCode = contactId.slice(-5);

  // Pick the right display name and description based on amount
  const baseName =
    amountCents >= 10000 ? "Tattoo Deposit" :
    amountCents === 5000 ? "Tattoo Consultation Fee" :
    description;

  const checkoutName = `${baseName} #${trackingCode}`;

  const checkoutDescription =
    amountCents >= 10000 ? DEPOSIT_100_DESCRIPTION :
    amountCents === 5000 ? CONSULT_50_DESCRIPTION :
    amountCents > 5000 ? DEPOSIT_100_DESCRIPTION :
    null;

  if (!COMPACT_MODE) {
    console.log("[Square] Creating checkout link:", {
      contactId,
      amountCents,
      trackingCode,
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
                name: baseName,
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

    // Store mapping in Supabase for webhook tracing via tracking code
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
    }

    if (COMPACT_MODE) {
      console.log(`\ud83d\udcb3 SQUARE: link created contact=${shortId(contactId)} #${trackingCode} $${amountCents / 100}`);
    } else {
      console.log("\ud83d\udcb3 Square checkout link created:", {
        contactId,
        trackingCode,
        checkoutLinkId,
        url: checkoutUrl,
      });
    }

    return {
      url: checkoutUrl,
      paymentLinkId: checkoutLinkId,
      orderId: null,
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
 * Given an orderId from a webhook, fetch the order and resolve the contactId.
 * 1. Try order.reference_id (Payment Links API — backwards compat)
 * 2. Parse tracking code from line item name (CHECKOUT_LINK — "#XXXXX")
 * 3. Look up contact from Supabase via the tracking code
 */
async function getContactIdFromOrder(orderId) {
  if (!orderId) return null;

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
      return null;
    }

    const amount = order.total_money?.amount || 0;

    // 1. Try reference_id (Payment Links API orders)
    let contactId = order.reference_id || null;

    // 2. Parse tracking code from line item name
    if (!contactId) {
      const lineItemName = order.line_items?.[0]?.name || "";
      const match = lineItemName.match(/#(\w{5})\s*$/);

      if (match) {
        const trackingCode = match[1];
        if (!COMPACT_MODE) {
          console.log(`[Square] Found tracking code #${trackingCode} in line item: "${lineItemName}"`);
        }

        // Look up contact by matching last 5 chars of contact_id
        const { data: rows, error } = await supabase
          .from("square_checkout_links")
          .select("contact_id, artist_id, artist_name, business, payment_type")
          .like("contact_id", `%${trackingCode}`)
          .order("created_at", { ascending: false })
          .limit(1);

        if (error) {
          console.error("[Square] Supabase lookup error:", error.message);
        } else if (rows?.[0]) {
          contactId = rows[0].contact_id;
          if (COMPACT_MODE) {
            console.log(`\ud83d\udcb3 SQUARE: #${trackingCode} → contact=${shortId(contactId)}`);
          } else {
            console.log("[Square] Resolved contact via tracking code:", {
              trackingCode,
              contactId,
              artistName: rows[0].artist_name,
            });
          }
        } else {
          console.warn(`[Square] No checkout link found for tracking code #${trackingCode}`);
        }
      }
    }

    if (COMPACT_MODE) {
      console.log(`\ud83d\udcb3 SQUARE: order=${shortId(orderId)} → contact=${shortId(contactId)} $${amount / 100}`);
    } else {
      console.log("[Square] Resolved order → contact mapping:", { orderId, contactId });
    }

    return contactId;
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
    return null;
  }
}

module.exports = {
  createDepositLinkForContact,
  getContactIdFromOrder,
};
