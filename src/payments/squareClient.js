// squareClient.js
// Square Payment Link + Orders client for Studio AZ Setter backend.
// - Creates payment links for deposits
// - Uses order.reference_id = GHL contactId so webhooks can map payment → contact
// - Exposes a helper to fetch an order and read its reference_id

const {
  SquareClient,
  SquareEnvironment,
  SquareError,
} = require("square");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

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

const environment =
  process.env.SQUARE_ENVIRONMENT === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;

console.log("[Square] Initializing SquareClient with env:", environment);

const squareClient = new SquareClient({
  environment,
  token: SQUARE_ACCESS_TOKEN,
});

/**
 * Create a Square payment link for a specific contact.
 * - contactId: GHL contactId (saved as order.reference_id)
 * - amountCents: integer cents (e.g. 10000 = $100.00)
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
    throw new Error("amountCents (number) is required for createDepositLinkForContact");
  }
  if (!SQUARE_LOCATION_ID) {
    throw new Error(
      "SQUARE_LOCATION_ID is not set. Cannot create payment link."
    );
  }

  const idempotencyKey = `${contactId}-${Date.now()}`;

  // Use checkout.paymentLinks.create with an ORDER that includes reference_id
  const body = {
    idempotencyKey,
    description,
    order: {
      locationId: SQUARE_LOCATION_ID,
      referenceId: contactId, // 🔥 binds order → GHL contact
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
    checkoutOptions: {
      // Optional: redirect after payment
      redirectUrl:
        process.env.SQUARE_REDIRECT_URL ||
        "https://studioaztattoo.com/thank-you",
    },
  };

  console.log("[Square] Creating payment link with body:", {
    contactId,
    amountCents,
    currency,
  });

  try {
    const res = await squareClient.checkout.paymentLinks.create(body);
    const result = res.result;
    const paymentLink = result && result.paymentLink;

    if (!paymentLink || !paymentLink.url) {
      console.error("[Square] No paymentLink or URL in response:", result);
      throw new Error("No payment link URL returned from Square");
    }

    console.log("💳 Square payment link created:", {
      contactId,
      paymentLinkId: paymentLink.id,
      url: paymentLink.url,
      orderId: paymentLink.orderId || paymentLink.order_id,
    });

    return {
      url: paymentLink.url,
      paymentLinkId: paymentLink.id,
      orderId: paymentLink.orderId || paymentLink.order_id || null,
    };
  } catch (err) {
    if (err instanceof SquareError) {
      console.error("[Square] SquareError creating payment link:", err.errors);
    } else {
      console.error("[Square] Unexpected error creating payment link:", err);
    }
    throw err;
  }
}

/**
 * Given an orderId from a webhook (payment.created/payment.updated),
 * fetch the order and return its reference_id (which we use as GHL contactId).
 */
async function getContactIdFromOrder(orderId) {
  if (!orderId) return null;

  try {
    const res = await squareClient.orders.getOrder(orderId);
    const order = res.result && res.result.order;

    if (!order) {
      console.warn("[Square] No order found for id:", orderId);
      return null;
    }

    const contactId = order.referenceId || order.reference_id || null;

    console.log("[Square] Resolved order → contact mapping:", {
      orderId,
      contactId,
    });

    return contactId;
  } catch (err) {
    if (err instanceof SquareError) {
      console.error("[Square] SquareError reading order:", err.errors);
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
