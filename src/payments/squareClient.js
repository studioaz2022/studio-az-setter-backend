// src/payments/squareClient.js
// Direct HTTP client for Square payment links using axios.
// We skip the Node SDK weirdness and hit the REST endpoint that we KNOW works.

const axios = require("axios");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Decide base URL from environment
const isProd = process.env.SQUARE_ENVIRONMENT === "production";
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
 */
async function createDepositLinkForContact({
  contactId,
  amountCents,
  currency = "USD",
  description = "Studio AZ Tattoo Deposit",
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

  // Body mirrors your working test from Square's API explorer
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
    quick_pay: {
      location_id: SQUARE_LOCATION_ID,
      name: description,
      price_money: {
        amount: amountCents, // integer in cents, e.g. 1000 = $10.00
        currency,
      },
    },
  };

  console.log("[Square] Creating payment link (HTTP) with body:", {
    contactId,
    amountCents,
    currency,
    env: isProd ? "production" : "sandbox",
  });

  try {
    const url = `${SQUARE_BASE_URL}/v2/online-checkout/payment-links`;

    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        // We can omit Square-Version to use the account default.
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

    console.log("💳 Square payment link created (HTTP):", {
      contactId,
      paymentLinkId: paymentLink.id,
      url: paymentLink.url,
    });

    return {
      url: paymentLink.url,
      paymentLinkId: paymentLink.id,
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

module.exports = {
  createDepositLinkForContact,
};
