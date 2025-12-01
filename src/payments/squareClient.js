// src/payments/squareClient.js
// Square Checkout / Payment Link client for Studio AZ Setter backend.
//
// IMPORTANT:
// - Uses Square Sandbox or Production based on SQUARE_ENVIRONMENT.
// - We use referenceId = GHL contactId so webhooks can map payment → contact.

const { Client, Environment } = require("square");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT === "production"
    ? Environment.Production
    : Environment.Sandbox;

if (!SQUARE_ACCESS_TOKEN) {
  console.warn(
    "[Square] SQUARE_ACCESS_TOKEN is not set. Square client will NOT be able to create live links."
  );
}

const square = new Client({
  accessToken: SQUARE_ACCESS_TOKEN,
  environment: SQUARE_ENVIRONMENT,
});

/**
 * Create a Square payment link for a specific contact.
 * - contactId → used as referenceId so webhook can map payment → GHL contact
 * - amountCents → integer in cents, e.g. 10000 = $100.00
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
  if (!amountCents || typeof amountCents !== "number") {
    throw new Error("amountCents (number) is required for createDepositLinkForContact");
  }

  if (!process.env.SQUARE_LOCATION_ID) {
    console.warn(
      "[Square] SQUARE_LOCATION_ID is not set. createDepositLinkForContact will fail."
    );
  }

  const idempotencyKey = `${contactId}-${Date.now()}`;

  const body = {
    idempotencyKey,
    description,
    checkoutOptions: {
      redirectUrl:
        process.env.SQUARE_REDIRECT_URL ||
        "https://studioaztattoo.com/thank-you",
    },
    order: {
      locationId: process.env.SQUARE_LOCATION_ID,
      referenceId: contactId, // 🔥 ties payment back to the GHL contact
      lineItems: [
        {
          name: description,
          quantity: "1",
          basePriceMoney: {
            amount: amountCents,
            currency,
          },
        },
      ],
    },
  };

  console.log("[Square] Creating payment link with body:", {
    contactId,
    amountCents,
    env:
      process.env.SQUARE_ENVIRONMENT === "production"
        ? "production"
        : "sandbox",
  });

  try {
    const { result } = await square.checkoutApi.createPaymentLink(body);

    const url = result?.paymentLink?.url || null;
    const paymentLinkId = result?.paymentLink?.id || null;

    console.log("💳 Square payment link created:", { contactId, url, paymentLinkId });

    return { url, paymentLinkId };
  } catch (err) {
    console.error("❌ Error creating Square payment link:", err);
    throw err;
  }
}

module.exports = {
  createDepositLinkForContact,
};
