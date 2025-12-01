// src/payments/squareClient.js
//
// Square payments client for Studio AZ Setter backend.
// NOTE: This is a stub. It does NOT call the real Square API yet.
// We will implement real link creation + webhook handling later.

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";

if (!SQUARE_ACCESS_TOKEN) {
  console.warn(
    "[Square] SQUARE_ACCESS_TOKEN is not set. Square client is running in STUB mode."
  );
}

/**
 * Stub for creating a deposit link for a specific contact.
 * 
 * Later this will:
 *  - Call Square to create a Checkout / Payment Link
 *  - Include a reference to the GHL contact (contactId)
 *  - Store/link this in GHL custom fields
 *  - Return the URL
 * 
 * For now, it just logs the intent and returns a placeholder object.
 */
async function createDepositLinkForContact({
  contactId,
  amountCents,
  currency = "USD",
  description = "Studio AZ Tattoo consult deposit",
}) {
  console.log("[Square] Stub: createDepositLinkForContact called with:", {
    contactId,
    amountCents,
    currency,
    description,
    env: SQUARE_ENVIRONMENT,
    hasToken: Boolean(SQUARE_ACCESS_TOKEN),
  });

  // TODO: Implement real Square API call here in a future phase.

  return {
    url: null, // no real link yet
    debug: true,
    note: "Square deposit link not implemented yet. This is a stub response.",
  };
}

module.exports = {
  createDepositLinkForContact,
};

