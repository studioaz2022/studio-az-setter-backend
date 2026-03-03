const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, contact_name, gross_amount, payment_method, transaction_type, session_date, square_payment_id, venmo_transaction_id")
    .eq("artist_ghl_id", "1kFG5FWdUDhXLUX46snG")
    .order("session_date", { ascending: false });

  if (error) {
    console.error("Error:", error.message);
    return;
  }

  console.log("Total Supabase transactions for Lionel:", data.length);
  console.log("\nFirst 15:");
  data.slice(0, 15).forEach((tx) => {
    const sq = tx.square_payment_id
      ? tx.square_payment_id.slice(0, 12) + "..."
      : "null";
    const vm = tx.venmo_transaction_id
      ? tx.venmo_transaction_id.slice(0, 25) + "..."
      : "null";
    console.log(
      `  ${tx.session_date} | $${tx.gross_amount} | ${tx.payment_method} | ${tx.transaction_type} | ${tx.contact_name} | sq:${sq} | venmo:${vm}`
    );
  });

  const withSquare = data.filter((tx) => tx.square_payment_id).length;
  const withVenmo = data.filter((tx) => tx.venmo_transaction_id).length;
  const noDedup = data.filter(
    (tx) => !tx.square_payment_id && !tx.venmo_transaction_id
  );
  console.log("\nWith square_payment_id:", withSquare);
  console.log("With venmo_transaction_id:", withVenmo);
  console.log("With NEITHER dedup ID:", noDedup.length);

  if (noDedup.length > 0) {
    console.log("\nExamples without dedup ID:");
    noDedup.slice(0, 5).forEach((tx) => {
      console.log(
        `  ${tx.session_date} | $${tx.gross_amount} | ${tx.payment_method} | ${tx.contact_name} | id:${tx.id}`
      );
    });
  }
})();
