/**
 * Reconciliation math engine tests.
 *
 * Covers every scenario in TATTOO_FINANCE_PLAN.md Phase 1's "Foreseeable
 * problems" section. The engine is pure-functional, so all tests use
 * synthetic transaction arrays — no DB, no fetches.
 */

const {
  computeContactReconciliation,
  computeWeeklyReconciliation,
  generateVenmoCode,
  formatVenmoNote,
  dollarsToCents,
  centsToDollars,
  VENMO_NOTE_MAX_LEN,
} = require("../src/services/reconciliationService");

const { getWeekStart, getWeekEnd } = require("../src/utils/dateUtils");

// Build a realistic transaction row matching the live `transactions` schema.
function tx({
  gross,
  recipient = "shop",
  shopPct = 30,
  type = "session_payment",
  method = "square",
}) {
  const shopAmt = Math.round(gross * shopPct) / 100;
  const artistAmt = gross - shopAmt;
  return {
    transaction_type: type,
    payment_method: method,
    payment_recipient: recipient,
    gross_amount: gross,
    shop_percentage: shopPct,
    artist_percentage: 100 - shopPct,
    shop_amount: shopAmt,
    artist_amount: artistAmt,
  };
}

describe("dollarsToCents / centsToDollars", () => {
  test("round-trips standard amounts", () => {
    expect(dollarsToCents(100)).toBe(10000);
    expect(dollarsToCents(99.99)).toBe(9999);
    expect(centsToDollars(10000)).toBe(100);
    expect(centsToDollars(9999)).toBe(99.99);
  });

  test("handles edge values", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("50")).toBe(5000);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30); // float drift handled by rounding
  });
});

describe("computeContactReconciliation — core math", () => {
  test("fully paid project at 30/70 — Stripe financing path", () => {
    // Quote $1000, paid via Stripe (recorded as gross=$1000, fee in notes)
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [tx({ gross: 1000, recipient: "shop", shopPct: 30 })],
    });
    expect(result.shopShouldReceive).toBe(300);
    expect(result.artistShouldReceive).toBe(700);
    expect(result.shopActualReceived).toBe(1000);
    expect(result.artistActualReceived).toBe(0);
    expect(result.collected).toBe(1000);
    expect(result.outstanding).toBe(0);
    expect(result.netToArtist).toBe(700); // shop has $1000, owes artist 70%
    expect(result.isFullyPaid).toBe(true);
    expect(result.isOverpaid).toBe(false);
  });

  test("fully paid via cash to artist — artist owes shop 30%", () => {
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [tx({ gross: 1000, recipient: "artist_direct", shopPct: 30 })],
    });
    expect(result.shopActualReceived).toBe(0);
    expect(result.artistActualReceived).toBe(1000);
    expect(result.netToArtist).toBe(-300); // artist has all, owes shop $300
  });

  test("split: deposit via shop + remainder cash to artist", () => {
    // Quote $1000: shop took $200 deposit; artist took $800 cash on the day
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [
        tx({ gross: 200, recipient: "shop", type: "deposit" }),
        tx({ gross: 800, recipient: "artist_direct", type: "session_payment", method: "cash" }),
      ],
    });
    expect(result.collected).toBe(1000);
    expect(result.outstanding).toBe(0);
    // shop has $200, should have $300 → shop is short $100 → net to artist = -$100
    expect(result.netToArtist).toBe(-100);
    expect(result.isFullyPaid).toBe(true);
  });

  test("partially paid project — outstanding > 0", () => {
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [tx({ gross: 400, recipient: "shop" })],
    });
    expect(result.collected).toBe(400);
    expect(result.outstanding).toBe(600);
    expect(result.isFullyPaid).toBe(false);
  });

  test("overpaid project — outstanding negative, isOverpaid true", () => {
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [tx({ gross: 1100, recipient: "shop" })],
    });
    expect(result.outstanding).toBe(-100);
    expect(result.isOverpaid).toBe(true);
  });

  test("contact with no quote — outstanding null, fields still computable", () => {
    const result = computeContactReconciliation({
      quote: null,
      shopPercentage: 30,
      transactions: [tx({ gross: 200, recipient: "shop" })],
    });
    expect(result.quote).toBeNull();
    expect(result.outstanding).toBeNull();
    expect(result.collected).toBe(200);
    expect(result.isFullyPaid).toBe(false);
  });

  test("refund transaction reduces collected", () => {
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [
        tx({ gross: 500, recipient: "shop" }),
        tx({ gross: -100, recipient: "shop", type: "refund" }),
      ],
    });
    expect(result.collected).toBe(400);
  });

  test("contact with no transactions — collected zero, outstanding = quote", () => {
    const result = computeContactReconciliation({
      quote: 800,
      shopPercentage: 30,
      transactions: [],
    });
    expect(result.collected).toBe(0);
    expect(result.outstanding).toBe(800);
    expect(result.isFullyPaid).toBe(false);
  });

  test("rounding: $33.33 quote does not produce drift over many ops", () => {
    const result = computeContactReconciliation({
      quote: 333.33,
      shopPercentage: 30,
      transactions: [
        tx({ gross: 100.10, recipient: "shop" }),
        tx({ gross: 233.23, recipient: "artist_direct" }),
      ],
    });
    expect(result.collected).toBe(333.33);
    expect(result.outstanding).toBe(0);
  });
});

describe("computeContactReconciliation — fee-handling guarantees", () => {
  test("Stripe 6% fee is NOT subtracted from collected (gross_amount is already the commission base)", () => {
    // Webhook records gross=$1000 even though client paid $1060.
    // Math engine sees only the $1000 — that's the contract balance side.
    const result = computeContactReconciliation({
      quote: 1000,
      shopPercentage: 30,
      transactions: [tx({ gross: 1000, recipient: "shop" })],
    });
    expect(result.collected).toBe(1000);
    expect(result.outstanding).toBe(0);
  });
});

describe("generateVenmoCode", () => {
  test("uppercases first 3 letters of first name + MMDD", () => {
    const ws = new Date("2026-04-27T05:00:00Z"); // Mon Apr 27 CT
    expect(generateVenmoCode({ artistName: "Claudia Chavarria", weekStart: ws })).toBe("CLA0427");
    expect(generateVenmoCode({ artistName: "Andrew Fernandez", weekStart: ws })).toBe("AND0427");
    expect(generateVenmoCode({ artistName: "Joan Martinez", weekStart: ws })).toBe("JOA0427");
  });

  test("supports collision suffix", () => {
    const ws = new Date("2026-04-27T05:00:00Z");
    expect(
      generateVenmoCode({ artistName: "Claudia", weekStart: ws, suffix: 2 })
    ).toBe("CLA0427-2");
  });

  test("handles short / weird names defensively", () => {
    const ws = new Date("2026-04-27T05:00:00Z");
    expect(generateVenmoCode({ artistName: "Al", weekStart: ws })).toBe("ALX0427");
    expect(generateVenmoCode({ artistName: "", weekStart: ws })).toBe("ART0427");
    expect(generateVenmoCode({ artistName: null, weekStart: ws })).toBe("ART0427");
  });
});

describe("formatVenmoNote", () => {
  const ws = new Date("2026-04-20T05:00:00Z");
  const we = new Date("2026-04-27T04:59:59.999Z");

  test("formats canonical example", () => {
    const note = formatVenmoNote({
      weekStart: ws,
      weekEnd: we,
      projects: [
        { contactName: "Maria Garcia", netToArtist: 800 },
        { contactName: "Jose Lopez", netToArtist: 460 },
      ],
      totalNet: 1260,
      venmoCode: "CHA0427",
    });
    expect(note).toBe("StudioAZ Recon Apr 20-26 · Maria Garcia, Jose Lopez · Net $1260 · [a:CHA0427]");
  });

  test("truncates with '+ N more' when too many clients", () => {
    const projects = [];
    for (let i = 0; i < 30; i++) {
      projects.push({ contactName: `Client Number ${i}`, netToArtist: 100 });
    }
    const note = formatVenmoNote({
      weekStart: ws,
      weekEnd: we,
      projects,
      totalNet: 3000,
      venmoCode: "CHA0427",
    });
    expect(note.length).toBeLessThanOrEqual(VENMO_NOTE_MAX_LEN);
    expect(note).toMatch(/\+ \d+ more/);
    expect(note).toMatch(/\[a:CHA0427\]$/);
  });

  test("handles zero clients gracefully", () => {
    const note = formatVenmoNote({
      weekStart: ws,
      weekEnd: we,
      projects: [],
      totalNet: 0,
      venmoCode: "CHA0427",
    });
    expect(note).toContain("(no clients)");
    expect(note).toMatch(/\[a:CHA0427\]$/);
  });

  test("falls back to 'Unknown Client' for projects without name", () => {
    const note = formatVenmoNote({
      weekStart: ws,
      weekEnd: we,
      projects: [{ contactName: "", netToArtist: 100 }],
      totalNet: 100,
      venmoCode: "X",
    });
    expect(note).toContain("Unknown Client");
  });

  test("rounds the net to integer dollars in the note (no $1260.00)", () => {
    const note = formatVenmoNote({
      weekStart: ws,
      weekEnd: we,
      projects: [{ contactName: "X", netToArtist: 1259.5 }],
      totalNet: 1259.5,
      venmoCode: "X",
    });
    expect(note).toContain("Net $1260");
  });
});

describe("computeWeeklyReconciliation", () => {
  const weekDate = new Date("2026-04-22T18:00:00Z"); // Wed Apr 22 CT
  const weekStart = getWeekStart(weekDate);
  const weekEnd = getWeekEnd(weekDate);

  test("aggregates completions and emits direction", () => {
    const result = computeWeeklyReconciliation({
      artistGhlId: "art1",
      artistName: "Claudia",
      weekStart,
      weekEnd,
      completions: [
        {
          contact_id: "c1",
          contact_name: "Maria Garcia",
          quote_at_completion: 1000,
          collected_at_completion: 1000,
          net_to_artist: 700,
        },
        {
          contact_id: "c2",
          contact_name: "Jose Lopez",
          quote_at_completion: 800,
          collected_at_completion: 800,
          net_to_artist: -300, // artist took cash, owes shop
        },
      ],
    });
    expect(result.totalNetToArtist).toBe(400);
    expect(result.direction).toBe("shop_owes_artist");
    expect(result.netAmount).toBe(400);
    expect(result.projectCount).toBe(2);
    expect(result.weekStart).toBe("2026-04-20");
    expect(result.weekEnd).toBe("2026-04-26");
    expect(result.venmoCode).toBe("CLA0420");
    expect(result.venmoNote).toContain("Net $400");
  });

  test("settles to zero when net is exactly balanced", () => {
    const result = computeWeeklyReconciliation({
      artistGhlId: "art1",
      artistName: "Andrew",
      weekStart,
      weekEnd,
      completions: [
        { contact_id: "c1", contact_name: "A", quote_at_completion: 100, collected_at_completion: 100, net_to_artist: 70 },
        { contact_id: "c2", contact_name: "B", quote_at_completion: 100, collected_at_completion: 100, net_to_artist: -70 },
      ],
    });
    expect(result.direction).toBe("settled");
  });

  test("artist owes shop when net is negative", () => {
    const result = computeWeeklyReconciliation({
      artistGhlId: "art1",
      artistName: "Andrew",
      weekStart,
      weekEnd,
      completions: [
        { contact_id: "c1", contact_name: "A", quote_at_completion: 500, collected_at_completion: 500, net_to_artist: -150 },
      ],
    });
    expect(result.direction).toBe("artist_owes_shop");
    expect(result.netAmount).toBe(150);
  });

  test("empty week — no projects, settled, valid note", () => {
    const result = computeWeeklyReconciliation({
      artistGhlId: "art1",
      artistName: "Andrew",
      weekStart,
      weekEnd,
      completions: [],
    });
    expect(result.direction).toBe("settled");
    expect(result.projectCount).toBe(0);
    expect(result.venmoNote).toContain("(no clients)");
  });
});
