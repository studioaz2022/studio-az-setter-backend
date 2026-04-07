// stripeClient.js
// Stripe Checkout Sessions for tattoo financing.
// Creates one-time Checkout Sessions with Affirm + Klarna + card on one page.
// Maps payments back to GHL contacts via session metadata.contactId.

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { COMPACT_MODE, shortId } = require("../utils/logger");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("[Stripe] STRIPE_SECRET_KEY is not set. Financing link creation will fail.");
}

/**
 * Create a Stripe Checkout Session for tattoo financing.
 * Offers Affirm, Klarna, and card on one checkout page.
 * Metadata carries contactId, artistId for webhook mapping.
 */
async function createFinancingLinkForContact({
  contactId,
  amountCents,
  currency = "usd",
  description = "Tattoo Session",
  artistId = null,
  artistName = null,
  contactName = null,
}) {
  if (!contactId) {
    throw new Error("contactId is required for createFinancingLinkForContact");
  }
  if (typeof amountCents !== "number" || amountCents <= 0) {
    throw new Error("amountCents (positive number) is required for createFinancingLinkForContact");
  }
  if (amountCents < 50000) {
    throw new Error("Financing links require a minimum of $500. Use a deposit link for smaller amounts.");
  }

  if (!COMPACT_MODE) {
    console.log("[Stripe] Creating financing session:", {
      contactId,
      amountCents,
      description,
      artistName,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["affirm", "klarna", "card"],
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: description,
            description: contactName ? `Client: ${contactName}` : undefined,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      contactId,
      artistId: artistId || "",
      artistName: artistName || "",
      contactName: contactName || "",
    },
    // After payment, show Stripe's built-in confirmation page
    after_completion: {
      type: "redirect",
      redirect: {
        url: "https://studioaztattoo.com",
      },
    },
    // Session expires after 24 hours
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  });

  // Store mapping in Supabase for history/iOS display
  const { error: dbError } = await supabase
    .from("stripe_checkout_sessions")
    .insert({
      session_id: session.id,
      checkout_url: session.url,
      contact_id: contactId,
      contact_name: contactName,
      artist_id: artistId,
      artist_name: artistName,
      amount_cents: amountCents,
      status: "pending",
    });

  if (dbError) {
    console.error("[Stripe] Failed to store session mapping:", dbError.message);
  }

  if (COMPACT_MODE) {
    console.log(`💳 STRIPE: session created contact=${shortId(contactId)} $${amountCents / 100}`);
  } else {
    console.log("💳 Stripe financing session created:", {
      contactId,
      sessionId: session.id,
      url: session.url,
    });
  }

  return {
    url: session.url,
    sessionId: session.id,
  };
}

module.exports = {
  createFinancingLinkForContact,
};
