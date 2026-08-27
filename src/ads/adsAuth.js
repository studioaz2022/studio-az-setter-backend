// adsAuth.js — requester identity + lane access for the Ads Transparency endpoints.
//
// Ad spend is money billed to artists, so unlike the older analytics routes we do
// NOT trust a client-supplied ghlUserId. Identity comes from one of:
//   1. x-internal-key header (ops/testing/admin scripts — existing backend pattern)
//   2. Supabase Auth JWT (Authorization: Bearer <session token> the iOS app holds)
//
// Lane rule: role 'owner' (Lionel) sees every lane, including shop-level
// recruitment rows. Everyone else — 'admin' included, per Lionel — sees only the
// lane whose ghl_user_id matches their own profile.

const { supabase } = require("../clients/supabaseClient");

/**
 * Resolve who is calling. Returns:
 *   { kind: "internal" }                                    — internal key
 *   { kind: "user", ghlUserId, role, name }                 — verified app user
 *   null                                                    — unauthenticated
 */
async function resolveRequester(req) {
  const internalKey = req.headers["x-internal-key"];
  if (
    internalKey &&
    process.env.INTERNAL_API_KEY &&
    internalKey === process.env.INTERNAL_API_KEY
  ) {
    return { kind: "internal" };
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("ghl_user_id, role, full_name")
    .eq("id", data.user.id)
    .single();
  if (profileError || !profile) return null;

  return {
    kind: "user",
    ghlUserId: profile.ghl_user_id,
    role: profile.role,
    name: profile.full_name,
  };
}

/** Owner (Lionel) or internal key — the only identities that see every lane. */
function canSeeAllLanes(requester) {
  if (!requester) return false;
  return requester.kind === "internal" || requester.role === "owner";
}

/** May this requester read the given artist's lane? */
function canSeeLane(requester, ghlUserId) {
  if (canSeeAllLanes(requester)) return true;
  return requester?.kind === "user" && requester.ghlUserId === ghlUserId;
}

module.exports = { resolveRequester, canSeeAllLanes, canSeeLane };
