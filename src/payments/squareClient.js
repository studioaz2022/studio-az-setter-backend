// squareClient.js
// Direct HTTP client for Square payment links + orders using axios.
// Uses the Payment Links API with reference_id for bulletproof webhook tracing.
// Location-level policy provides rich "What's Included" content on checkout.

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
 * Uses the Payment Links API with reference_id on the order for reliable
 * webhook tracing. Location-level checkout policy adds rich content.
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

  const idempotencyKey = `${contactId}-${Date.now()}`;

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
      line_items: [
        {
          name: description,
          quantity: "1",
          base_price_money: {
            amount: amountCents,
            currency,
          },
        },
      ],
    },
  };

  if (!COMPACT_MODE) {
    console.log("[Square] Creating payment link:", {
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
      },
    });

    const data = response.data || {};
    const paymentLink = data.payment_link;

    if (!paymentLink || !paymentLink.url) {
      console.error(
        "[Square] No payment_link.url in response:",
        JSON.stringify(data, null, 2)
      );
      throw new Error("No payment link URL returned from Square");
    }

    if (COMPACT_MODE) {
      console.log(`💳 SQUARE: link created contact=${shortId(contactId)} $${amountCents / 100}`);
    } else {
      console.log("💳 Square payment link created:", {
        contactId,
        paymentLinkId: paymentLink.id,
        url: paymentLink.url,
      });
    }

    return {
      url: paymentLink.url,
      paymentLinkId: paymentLink.id,
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
 * Given an orderId from a webhook, fetch the order and return the contactId
 * from reference_id.
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
