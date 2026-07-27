const request = require("supertest");
const crypto = require("crypto");

jest.mock("../src/ai/controller", () => ({
  handleInboundMessage: jest.fn(async () => ({})),
}));

jest.mock("../src/clients/ghlClient", () => ({
  getContact: jest.fn(async (id) => ({ id, customField: {} })),
  updateSystemFields: jest.fn(async () => ({})),
  createContact: jest.fn(async (body) => ({ id: "new_contact", ...body })),
  updateContact: jest.fn(async () => ({})),
  lookupContactIdByEmailOrPhone: jest.fn(async () => null),
}));

jest.mock("../src/payments/squareClient", () => ({
  getContactIdFromOrder: jest.fn(async () => "contact_from_order"),
}));

const { handleInboundMessage } = require("../src/ai/controller");
const {
  updateSystemFields,
  getContact,
  createContact,
  updateContact,
  lookupContactIdByEmailOrPhone,
} = require("../src/clients/ghlClient");
const { getContactIdFromOrder } = require("../src/payments/squareClient");
const { createApp } = require("../src/server/app");

/**
 * Square signs `notificationUrl + rawBody` with the webhook signing key and
 * sends it in `x-square-hmacsha256-signature`. The URL is part of the signed
 * string, so it must match the value the handler uses.
 */
const SQUARE_NOTIFICATION_URL =
  "https://studio-az-setter-backend.onrender.com/square/webhook";

function squareSignature(body, key) {
  return crypto
    .createHmac("sha256", key)
    .update(SQUARE_NOTIFICATION_URL + body)
    .digest("base64");
}

/** A completed-payment event — the only shape the handler acts on. */
function completedPaymentBody(overrides = {}) {
  return JSON.stringify({
    type: "payment.updated",
    data: {
      object: {
        payment: { status: "COMPLETED", reference_id: "contact123", ...overrides },
      },
    },
  });
}

describe("Webhook server", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SQUARE_WEBHOOK_SECRET = "test_secret";
    delete process.env.SQUARE_SANDBOX_WEBHOOK_SECRET;
  });

  describe("/ghl/message-webhook", () => {
    // The route acknowledges immediately and processes on a 15s debounce in
    // setImmediate. That is deliberate: awaiting the AI pipeline exceeded GHL's
    // webhook timeout and caused 5–7 retries per message (duplicate APNs). So
    // the contract under test is the ack, not a synchronous controller call.
    // NOTE: a payload WITH a contactId enters the 15s debounce, which leaves a
    // live setTimeout behind and makes jest hang after the suite finishes. The
    // ack contract is identical either way, so these exercise the path that
    // returns before a timer is armed.
    test("acknowledges immediately with a queued receipt", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/ghl/message-webhook")
        .send({ message: "orphan message" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, queued: true });
      // Never called synchronously — real work happens after the debounce.
      expect(handleInboundMessage).not.toHaveBeenCalled();
    });

    test("acknowledges an empty body rather than erroring", async () => {
      const app = createApp();
      const res = await request(app).post("/ghl/message-webhook").send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, queued: true });
    });
  });

  describe("/square/webhook", () => {
    test("rejects a garbage signature", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", "bad")
        .send("{}");

      expect(res.status).toBe(401);
      expect(updateSystemFields).not.toHaveBeenCalled();
    });

    test("rejects a body signed with the wrong key", async () => {
      const app = createApp();
      const body = completedPaymentBody();
      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", squareSignature(body, "not_the_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(401);
      expect(updateSystemFields).not.toHaveBeenCalled();
    });

    test("rejects a correctly-signed body sent under the legacy header name", async () => {
      const app = createApp();
      const body = completedPaymentBody();
      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-signature", squareSignature(body, "test_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(401);
      expect(updateSystemFields).not.toHaveBeenCalled();
    });

    test("accepts a valid signature and marks the deposit paid", async () => {
      const app = createApp();
      const body = completedPaymentBody();

      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", squareSignature(body, "test_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(updateSystemFields).toHaveBeenCalledWith("contact123", {
        deposit_paid: true,
      });
    });

    test("ignores non payment.updated events", async () => {
      const app = createApp();
      const body = JSON.stringify({
        type: "payment.created",
        data: { object: { payment: { status: "COMPLETED", reference_id: "contact123" } } },
      });

      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", squareSignature(body, "test_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
      expect(updateSystemFields).not.toHaveBeenCalled();
    });

    test("ignores a payment that has not COMPLETED yet", async () => {
      const app = createApp();
      const body = completedPaymentBody({ status: "PENDING" });

      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", squareSignature(body, "test_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
      expect(updateSystemFields).not.toHaveBeenCalled();
    });

    test("falls back to the order lookup when reference_id is a Square customer id", async () => {
      const app = createApp();
      // 24-char lowercase hex = Square's own customer id, never a GHL contact id.
      const body = completedPaymentBody({
        reference_id: "a1b2c3d4e5f60718293a4b5c",
        order_id: "order_abc",
      });

      const res = await request(app)
        .post("/square/webhook")
        .set("x-square-hmacsha256-signature", squareSignature(body, "test_secret"))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      // The guard is the point: a Square customer id must not be treated as a
      // GHL contact id, so resolution falls through to the order. The deposit
      // write itself happens after the response on this path, so it is not
      // asserted here.
      expect(getContactIdFromOrder).toHaveBeenCalledWith("order_abc");
      expect(updateSystemFields).not.toHaveBeenCalledWith(
        "a1b2c3d4e5f60718293a4b5c",
        expect.anything()
      );
    });
  });
});
