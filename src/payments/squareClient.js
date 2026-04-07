// squareClient.js
// Direct HTTP client for Square payment links + orders using axios.
// We skip the Node SDK and talk to the Square REST API directly.

const axios = require("axios");
const { COMPACT_MODE, logSquareEvent, shortId } = require("../utils/logger");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";

const isProd = SQUARE_ENVIRONMENT === "production";

const SQUARE_BASE_URL = isProd
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

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
 * Create a Square payment link for a specific contact.
 * - contactId: GHL contact id (for your internal reference / future metadata use)
 * - amountCents: integer in cents, e.g. 5000 = $50.00
 * - business: "tattoo" or "barbershop" — used to route payments in the sync
 * - paymentType: "deposit", "session_payment", "payment_plan", etc.
 * - description: client-facing line item name (e.g. "Tattoo Consultation")
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

  // Catalog variation IDs for rich checkout pages (created via /api/square/setup-catalog)
  const CATALOG_DEPOSIT_100 = "KPXHQ2L3UM4QN7FOFZYQT225";
  const CATALOG_CONSULT_50 = "EWQPQPQS2P6U5TWIEDQFYDMT";

  // Use catalog item for $100/$50 deposits to get rich description on checkout
  const catalogVariationId =
    amountCents === 10000 ? CATALOG_DEPOSIT_100 :
    amountCents === 5000 ? CATALOG_CONSULT_50 :
    null;

  const idempotencyKey = `${contactId}-${Date.now()}`;

  // Build line item: catalog reference for $100/$50, ad-hoc for custom amounts
  const lineItem = catalogVariationId
    ? { catalog_object_id: catalogVariationId, quantity: "1" }
    : {
        name: description,
        quantity: "1",
        base_price_money: { amount: amountCents, currency },
      };

  const body = {
    idempotency_key: idempotencyKey,
    checkout_options: {
      accepted_payment_methods: {
        afterpay_clearpay: true,
        apple_pay: true,
        cash_app_pay: true,
        google_pay: true,
      },
    },
    order: {
      location_id: SQUARE_LOCATION_ID,
      reference_id: contactId,
      metadata: {
        business,
        payment_type: paymentType,
        contact_id: contactId,
        ...(artistId && { artist_id: artistId }),
        ...(artistName && { artist_name: artistName }),
      },
      line_items: [lineItem],
    },
  };

  if (!COMPACT_MODE) {
    console.log("[Square] Creating payment link (HTTP) with body:", {
      contactId,
      amountCents,
      currency,
      env: isProd ? "production" : "sandbox",
    });
  }

  try {
    const url = `${SQUARE_BASE_URL}/v2/online-checkout/payment-links`;

    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        // Square-Version header is optional; we can rely on app default
      },
    });

    const data = response.data || {};
    const paymentLink = data.payment_link;

    if (!paymentLink || !paymentLink.url) {
      console.error(
        "[Square] No payment_link.url in HTTP response:",
        JSON.stringify(data, null, 2)
      );
      throw new Error("No payment link URL returned from Square");
    }

    if (COMPACT_MODE) {
      console.log(`💳 SQUARE: link created contact=${shortId(contactId)} $${amountCents / 100}`);
    } else {
      console.log("💳 Square payment link created (HTTP):", {
        contactId,
        paymentLinkId: paymentLink.id,
        url: paymentLink.url,
      });
    }

    return {
      url: paymentLink.url,
      paymentLinkId: paymentLink.id,
      // Some responses also include order_id – plumb it through if present
      orderId: paymentLink.order_id || null,
    };
  } catch (err) {
    if (err.response) {
      console.error(
        "[Square] HTTP error creating payment link:",
        err.response.status,
        JSON.stringify(err.response.data, null, 2)
      );
      throw new Error(
        `Square HTTP error ${err.response.status}: ${
          err.response.data?.errors?.[0]?.detail ||
          JSON.stringify(err.response.data)
        }`
      );
    } else {
      console.error("[Square] Unexpected error creating payment link:", err);
      throw err;
    }
  }
}

/**
 * Given an orderId from a webhook (payment.created/payment.updated),
 * fetch the order and return its reference_id (intended for future use
 * to map order → GHL contactId). For now, this will just try and log.
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

    const contactId = order.reference_id || null;
    const amount = order.total_money?.amount || 0;

    if (COMPACT_MODE) {
      console.log(`💳 SQUARE: order=${shortId(orderId)} → contact=${shortId(contactId)} $${amount / 100}`);
    } else {
      console.log("[Square] Raw order from getContactIdFromOrder:", JSON.stringify(order, null, 2));
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

/**
 * One-time setup: Create catalog items for $100 and $50 tattoo deposits.
 * These items include rich descriptions that render on the Square checkout page.
 * Call once, then store the returned variation IDs in env vars.
 */
async function createDepositCatalogItems() {
  const url = `${SQUARE_BASE_URL}/v2/catalog/batch-upsert`;

  const body = {
    idempotency_key: `catalog-setup-${Date.now()}`,
    batches: [
      {
        objects: [
          {
            type: "ITEM",
            id: "#tattoo-deposit-100",
            item_data: {
              name: "Tattoo Deposit",
              description_html:
                "<p>\ud83c\udfa8 Design Consult + Concept Sketch</p>" +
                "<p>\ud83d\udcb5 If You Don\u2019t Love the Concept, Get Your Full Deposit Back</p>" +
                "<p>\ud83d\udcf8 Pro Photo Set (Optional)</p>" +
                "<br><p>PLUS:</p>" +
                "<p>\ud83e\uddd1\u200d\ud83c\udfa8 Art Director (Concierge) to guide your process</p>" +
                "<p>\ud83c\udf10 Live Translator for seamless communication (Optional)</p>" +
                "<p>\u23f1\ufe0f Priority Scheduling</p>" +
                "<p>\ud83e\udd1d Ongoing Healing Support: direct access to your Concierge and Artist for aftercare guidance so your tattoo looks its best</p>",
              variations: [
                {
                  type: "ITEM_VARIATION",
                  id: "#tattoo-deposit-100-var",
                  item_variation_data: {
                    name: "Regular",
                    pricing_type: "FIXED_PRICING",
                    price_money: { amount: 10000, currency: "USD" },
                  },
                },
              ],
            },
          },
          {
            type: "ITEM",
            id: "#tattoo-consult-50",
            item_data: {
              name: "Tattoo Consultation Fee",
              description_html:
                "<p>\ud83c\udfa8 Design Consult + Concept Sketch</p>" +
                "<p>\ud83d\udcb5 Applied to Your Tattoo Total Fee</p>" +
                "<p>\ud83d\udcaf or Fully Refundable</p>",
              variations: [
                {
                  type: "ITEM_VARIATION",
                  id: "#tattoo-consult-50-var",
                  item_variation_data: {
                    name: "Regular",
                    pricing_type: "FIXED_PRICING",
                    price_money: { amount: 5000, currency: "USD" },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  const objects = response.data?.objects || [];
  const result = {};

  for (const obj of objects) {
    if (obj.type === "ITEM") {
      const variations = obj.item_data?.variations || [];
      for (const v of variations) {
        if (v.item_variation_data?.price_money?.amount === 10000) {
          result.deposit100VariationId = v.id;
          result.deposit100ItemId = obj.id;
        } else if (v.item_variation_data?.price_money?.amount === 5000) {
          result.consult50VariationId = v.id;
          result.consult50ItemId = obj.id;
        }
      }
    }
  }

  console.log("[Square] Catalog items created:", result);
  return result;
}

module.exports = {
  createDepositLinkForContact,
  getContactIdFromOrder,
  createDepositCatalogItems,
};
