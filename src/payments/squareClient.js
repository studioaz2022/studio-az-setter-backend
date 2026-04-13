// squareClient.js
// Square payment integration for custom branded checkout.
// Creates Orders via Orders API (reference_id for webhook tracing),
// stores checkout sessions in Supabase, and processes payments via Payments API.

const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { COMPACT_MODE, shortId } = require("../utils/logger");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";
const CHECKOUT_BASE_URL = process.env.CHECKOUT_BASE_URL || "https://checkout.studioaztattoo.com";

const isProd = SQUARE_ENVIRONMENT === "production";

const SQUARE_BASE_URL = isProd
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Rich descriptions for deposit tiers (English + Spanish)
const DESCRIPTIONS = {
  en: {
    deposit:
      "\ud83c\udfa8 Design Consult + Concept Sketch\n" +
      "\ud83d\udcb5 If You Don\u2019t Love the Concept, Get Your Full Deposit Back\n" +
      "\ud83d\udcf8 Pro Photo Set (Optional)\n\n" +
      "PLUS:\n" +
      "\ud83e\uddd1\u200d\ud83c\udfa8 Art Director (Concierge) to guide your process\n" +
      "\ud83c\udf10 Live Translator for seamless communication (Optional)\n" +
      "\u23f1\ufe0f Priority Scheduling\n" +
      "\ud83e\udd1d Ongoing Healing Support: direct access to your Concierge and Artist for aftercare guidance so your tattoo looks its best",
    consult:
      "\ud83c\udfa8 Design Consult + Concept Sketch\n" +
      "\ud83d\udcb5 Applied to Your Tattoo Total Fee\n" +
      "\ud83d\udcaf or Fully Refundable",
    depositTitle: "Tattoo Deposit",
    consultTitle: "Tattoo Consultation Fee",
    greeting: (name) => name ? `Hey ${name}, you're almost there` : "You're almost there",
  },
  es: {
    deposit:
      "\ud83c\udfa8 Consulta de Dise\u00f1o + Boceto del Concepto\n" +
      "\ud83d\udcb5 Si No Te Encanta el Concepto, Te Devolvemos Tu Dep\u00f3sito Completo\n" +
      "\ud83d\udcf8 Sesi\u00f3n de Fotos Profesional (Opcional)\n\n" +
      "ADEM\u00c1S:\n" +
      "\ud83e\uddd1\u200d\ud83c\udfa8 Director Art\u00edstico (Concierge) para guiar tu proceso\n" +
      "\ud83c\udf10 Traductor en Vivo para comunicaci\u00f3n sin barreras (Opcional)\n" +
      "\u23f1\ufe0f Programaci\u00f3n Prioritaria\n" +
      "\ud83e\udd1d Apoyo Continuo de Sanaci\u00f3n: acceso directo a tu Concierge y Artista para gu\u00eda de cuidado posterior",
    consult:
      "\ud83c\udfa8 Consulta de Dise\u00f1o + Boceto del Concepto\n" +
      "\ud83d\udcb5 Se Aplica al Costo Total de Tu Tatuaje\n" +
      "\ud83d\udcaf o Completamente Reembolsable",
    depositTitle: "Dep\u00f3sito de Tatuaje",
    consultTitle: "Consulta de Tatuaje",
    greeting: (name) => name ? `Hola ${name}, ya casi est\u00e1s` : "Ya casi est\u00e1s",
  },
};

if (!SQUARE_ACCESS_TOKEN) {
  console.warn("[Square] SQUARE_ACCESS_TOKEN is not set.");
}
if (!SQUARE_LOCATION_ID) {
  console.warn("[Square] SQUARE_LOCATION_ID is not set.");
}

/**
 * Generate a short unique ID for checkout sessions.
 * 8 chars, URL-safe (a-z, 0-9).
 */
function generateSessionId() {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8).toLowerCase();
}

/**
 * Create a checkout session for a contact.
 * 1. Creates a Square Order with reference_id + metadata
 * 2. Stores a checkout session in Supabase
 * 3. Returns the custom checkout URL
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
  language = "en",
}) {
  if (!contactId) {
    throw new Error("contactId is required");
  }
  if (typeof amountCents !== "number" || !amountCents) {
    throw new Error("amountCents (number) is required");
  }
  if (!SQUARE_LOCATION_ID) {
    throw new Error("SQUARE_LOCATION_ID is not set");
  }

  // Determine title and description based on amount + language
  const lang = language === "es" ? "es" : "en";
  const strings = DESCRIPTIONS[lang];

  const title = amountCents <= 5000 ? strings.consultTitle : strings.depositTitle;
  const richDescription = amountCents <= 5000 ? strings.consult : strings.deposit;

  if (!COMPACT_MODE) {
    console.log("[Square] Creating checkout session:", {
      contactId,
      amountCents,
      title,
      env: isProd ? "production" : "sandbox",
    });
  }

  // 1. Create Square Order with reference_id for webhook tracing
  const orderResponse = await axios.post(
    `${SQUARE_BASE_URL}/v2/orders`,
    {
      idempotency_key: `order-${contactId}-${Date.now()}`,
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
            name: description || title,
            quantity: "1",
            base_price_money: { amount: amountCents, currency },
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  const squareOrderId = orderResponse.data?.order?.id;
  if (!squareOrderId) {
    throw new Error("Failed to create Square order");
  }

  // 2. Create checkout session in Supabase
  const sessionId = generateSessionId();

  const { error: dbError } = await supabase
    .from("checkout_sessions")
    .insert({
      id: sessionId,
      square_order_id: squareOrderId,
      status: "pending",
      amount_cents: amountCents,
      currency,
      title,
      description: richDescription,
      contact_id: contactId,
      contact_name: contactName,
      artist_id: artistId,
      artist_name: artistName,
      business,
      payment_type: paymentType,
      language: lang,
    });

  if (dbError) {
    console.error("[Square] Failed to create checkout session:", dbError.message);
    throw new Error("Failed to create checkout session");
  }

  // 3. Build custom checkout URL
  const checkoutUrl = `${CHECKOUT_BASE_URL}/${sessionId}`;

  if (COMPACT_MODE) {
    console.log(`\ud83d\udcb3 SQUARE: session=${sessionId} contact=${shortId(contactId)} $${amountCents / 100}`);
  } else {
    console.log("\ud83d\udcb3 Checkout session created:", {
      sessionId,
      contactId,
      squareOrderId,
      url: checkoutUrl,
    });
  }

  return {
    url: checkoutUrl,
    paymentLinkId: sessionId,
    orderId: squareOrderId,
  };
}

/**
 * Get checkout session details for the frontend to render.
 * Returns only display-safe data (no contactId or internal IDs).
 */
async function getCheckoutSession(sessionId) {
  const { data, error } = await supabase
    .from("checkout_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    id: data.id,
    status: data.status,
    amountCents: data.amount_cents,
    currency: data.currency,
    title: data.title,
    description: data.description,
    artistName: data.artist_name,
    contactFirstName: data.contact_name?.split(" ")?.[0] || null,
    business: data.business,
    paymentType: data.payment_type,
    language: data.language || "en",
    createdAt: data.created_at,
    expiresAt: data.expires_at,
    // Internal fields for payment processing (not sent to frontend)
    _squareOrderId: data.square_order_id,
    _contactId: data.contact_id,
  };
}

/**
 * Process a payment for a checkout session.
 * Called by frontend after Square Web Payments SDK tokenizes the card.
 *
 * @param {string} sessionId - Checkout session ID
 * @param {string} sourceId - Payment token from Square Web Payments SDK (nonce)
 * @param {string} buyerEmail - Optional buyer email from checkout form
 */
async function processCheckoutPayment(sessionId, sourceId, buyerEmail) {
  // 1. Load the session
  const session = await getCheckoutSession(sessionId);
  if (!session) {
    throw new Error("Checkout session not found");
  }
  if (session.status !== "pending") {
    throw new Error(`Checkout session is ${session.status}`);
  }

  // Check expiry
  if (new Date(session.expiresAt) < new Date()) {
    await supabase
      .from("checkout_sessions")
      .update({ status: "expired" })
      .eq("id", sessionId);
    throw new Error("Checkout session has expired");
  }

  // 2. Process payment via Square Payments API
  const paymentBody = {
    idempotency_key: `pay-${sessionId}-${Date.now()}`,
    source_id: sourceId,
    amount_money: {
      amount: session.amountCents,
      currency: session.currency,
    },
    order_id: session._squareOrderId,
    location_id: SQUARE_LOCATION_ID,
    autocomplete: true,
    ...(buyerEmail && {
      buyer_email_address: buyerEmail,
    }),
  };

  const response = await axios.post(
    `${SQUARE_BASE_URL}/v2/payments`,
    paymentBody,
    {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  const payment = response.data?.payment;
  if (!payment) {
    throw new Error("Payment failed — no payment object returned");
  }

  if (payment.status !== "COMPLETED") {
    throw new Error(`Payment status: ${payment.status}`);
  }

  // 3. Mark session as paid
  await supabase
    .from("checkout_sessions")
    .update({
      status: "paid",
      square_payment_id: payment.id,
      paid_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  if (COMPACT_MODE) {
    console.log(`\ud83d\udcb3 SQUARE: payment completed session=${sessionId} $${session.amountCents / 100}`);
  } else {
    console.log("\ud83d\udcb3 Checkout payment completed:", {
      sessionId,
      paymentId: payment.id,
      amount: session.amountCents / 100,
    });
  }

  // The webhook will fire separately and handle all downstream processing
  // (deposit confirmation, pipeline transition, earnings, rent tracker)
  // via reference_id on the order → contactId

  return {
    paymentId: payment.id,
    status: payment.status,
    receiptUrl: payment.receipt_url,
  };
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
      console.log(`\ud83d\udcb3 SQUARE: order=${shortId(orderId)} \u2192 contact=${shortId(contactId)} $${amount / 100}`);
    } else {
      console.log("[Square] Resolved order \u2192 contact mapping:", { orderId, contactId });
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
  getCheckoutSession,
  processCheckoutPayment,
  getContactIdFromOrder,
};
