/**
 * Minimal in-memory fake of the Supabase client surface used by
 * refundRequestService.
 *
 * We don't try to be a general-purpose Supabase shim — we just emulate the
 * exact chains the service uses:
 *
 *   from("refund_requests").select(...).eq("token", T).limit(1).maybeSingle()
 *   from("refund_requests").update({...}).eq("token", T).eq("status", "pending").select().maybeSingle()
 *   from("refund_requests").update({...}).eq("token", T)
 *   from("transactions").select(...).eq("square_payment_id", X).is("superseded_by", null)
 *                                   .is("deleted_at", null).limit(1).maybeSingle()
 *   from("checkout_sessions") — not exercised in Phase 5 tests; createRefundRequest
 *                               isn't under test (Phase 3 covers it). If a test
 *                               wants it, add a seed.
 *   from("fireflies_transcripts") — same.
 *
 * The fake stores rows by primary key (`token` for refund_requests,
 * `square_payment_id` for transactions) and resolves chains by filtering with
 * each accumulated eq/is predicate.
 *
 * State is module-scoped so multiple tests can share/reset cleanly.
 */

const tables = {
  refund_requests: new Map(), // keyed by token
  transactions: new Map(),    // keyed by square_payment_id
  checkout_sessions: new Map(),
  fireflies_transcripts: new Map(),
};

function reset() {
  for (const k of Object.keys(tables)) tables[k].clear();
}

function seedRefundRequest(row) {
  if (!row.token) throw new Error("seedRefundRequest needs token");
  // Defaults so the service's selects find what it expects.
  const defaults = {
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refund_status: row.multi_or_missing_deposit ? "manual_review" : "not_attempted",
    refund_type: null,
    square_refund_id: null,
  };
  tables.refund_requests.set(row.token, { ...defaults, ...row });
}

function seedOriginalDepositTxn(row) {
  if (!row.square_payment_id) throw new Error("seedOriginalDepositTxn needs square_payment_id");
  const defaults = {
    superseded_by: null,
    deleted_at: null,
    id: `tx_${row.square_payment_id}`,
  };
  tables.transactions.set(row.square_payment_id, { ...defaults, ...row });
}

function getRow(token) {
  return tables.refund_requests.get(token);
}

// ---- Query-builder shim ----

function matchesAll(row, predicates) {
  for (const [op, col, val] of predicates) {
    const actual = row[col];
    if (op === "eq" && actual !== val) return false;
    if (op === "gt" && !(actual > val)) return false;
    if (op === "is" && actual !== val) return false;
    if (op === "not_is" && actual === val) return false;
  }
  return true;
}

function makeChain(tableName, intent) {
  // intent: { kind: "select" | "update", patch?, columns? }
  const predicates = [];

  const chain = {
    select(_cols) {
      return chain; // We don't filter columns; tests look at full row.
    },
    eq(col, val) {
      predicates.push(["eq", col, val]);
      return chain;
    },
    gt(col, val) {
      predicates.push(["gt", col, val]);
      return chain;
    },
    is(col, val) {
      predicates.push(["is", col, val]);
      return chain;
    },
    not(col, op, val) {
      // .not("square_payment_id", "is", null) → predicate "not_is"
      predicates.push(["not_is", col, val]);
      return chain;
    },
    limit(_n) {
      return chain;
    },
    order(_col, _opts) {
      return chain;
    },
    async maybeSingle() {
      return finalize(true);
    },
    async single() {
      return finalize(true);
    },
    then(resolve, reject) {
      // Some service paths await the chain directly (no .maybeSingle()).
      // We resolve as if .select() was called and return { data, error }.
      try {
        const out = finalize(false);
        // Update without .select() returns { data: null, error: null } and the
        // service treats no error as success. Mimic that.
        if (intent.kind === "update") {
          resolve({ data: null, error: null });
        } else {
          resolve({ data: out.data, error: out.error });
        }
      } catch (err) {
        reject(err);
      }
      return Promise.resolve();
    },
  };

  function finalize(returnFirstRow) {
    const table = tables[tableName];
    if (!table) {
      return { data: null, error: { message: `unknown table ${tableName}` } };
    }
    const rows = Array.from(table.values()).filter((r) => matchesAll(r, predicates));

    if (intent.kind === "select") {
      const data = returnFirstRow ? rows[0] || null : rows;
      return { data, error: null };
    }
    if (intent.kind === "update") {
      // Apply patch to matched rows.
      for (const r of rows) {
        Object.assign(r, intent.patch);
        // Re-key by token if changed (not used in our flow).
      }
      const data = returnFirstRow ? rows[0] || null : rows;
      return { data, error: null };
    }
    return { data: null, error: null };
  }

  return chain;
}

const client = {
  from(tableName) {
    return {
      select(cols) {
        return makeChain(tableName, { kind: "select", columns: cols });
      },
      update(patch) {
        return makeChain(tableName, { kind: "update", patch });
      },
      insert() {
        // Phase 5 tests don't exercise insert paths via refund_requests.
        return makeChain(tableName, { kind: "update", patch: {} });
      },
    };
  },
};

module.exports = {
  client,
  reset,
  seedRefundRequest,
  seedOriginalDepositTxn,
  getRow,
};
