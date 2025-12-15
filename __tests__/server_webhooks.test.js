const request = require("supertest");
const crypto = require("crypto");

jest.mock("../src/ai/controller", () => ({
  handleInboundMessage: jest.fn(async () => ({})),
}));

jest.mock("../ghlClient", () => ({
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
} = require("../ghlClient");
const { getContactIdFromOrder } = require("../src/payments/squareClient");
const { createApp } = require("../src/server/app");

describe("Webhook server", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SQUARE_WEBHOOK_SECRET = "test_secret";
  });

  test("/ghl/message-webhook returns 200 and calls controller", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/ghl/message-webhook")
      .send({ contactId: "contact123", message: "Hello world" });

    expect(res.status).toBe(200);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    const args = handleInboundMessage.mock.calls[0][0];
    expect(args.contact.id).toBe("contact123");
    expect(args.latestMessageText).toBe("Hello world");
  });

  test("/square/webhook rejects invalid signature", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/square/webhook")
      .set("x-square-signature", "bad")
      .send("{}");

    expect(res.status).toBe(401);
    expect(updateSystemFields).not.toHaveBeenCalled();
  });

  test("/square/webhook accepts valid signature and updates deposit", async () => {
    const app = createApp();
    const body = JSON.stringify({
      data: { object: { payment: { reference_id: "contact123" } } },
    });
    const signature = crypto
      .createHmac("sha256", process.env.SQUARE_WEBHOOK_SECRET)
      .update(body)
      .digest("base64");

    const res = await request(app)
      .post("/square/webhook")
      .set("x-square-signature", signature)
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(updateSystemFields).toHaveBeenCalledWith("contact123", {
      deposit_paid: true,
    });
  });
});
