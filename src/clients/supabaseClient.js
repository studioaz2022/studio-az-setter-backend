// supabaseClient.js
// Supabase client initialization for financial tracking

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.warn('[Supabase] SUPABASE_URL is not set. Financial tracking will not work.');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[Supabase] SUPABASE_SERVICE_ROLE_KEY is not set. Financial tracking will not work.');
}

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('[Supabase] Client initialized successfully');
} else {
  console.warn('[Supabase] Client not initialized - missing credentials');
}

/**
 * Fetch all rows from a Supabase query, paginating past the 1000-row server limit.
 * Pass a query builder (without .limit() or .range()) and this handles pagination.
 *
 * WHY THIS EXISTS, in one paragraph, because it is easy to delete by accident:
 * PostgREST caps an unbounded select at db-max-rows — 1000 on Supabase — and
 * tells you nothing. No error, no flag, no truncation header. You get a shorter
 * array than the table holds and every total computed from it is quietly wrong.
 * That is how the revenue chart came to draw January as 1 transaction against
 * 158 actually on the books (commit 0ea89b0). Any select scoped only to an
 * artist, a location, or nothing at all must come through here.
 *
 * THE TIEBREAK IS NOT OPTIONAL. Paging is LIMIT/OFFSET underneath, and Postgres
 * does not promise a stable row order between two queries that tie on the sort
 * key — a row can be served twice, or skipped entirely, at a page boundary.
 * This table has 39 groups of appointments that share (assigned_user_id,
 * start_time) exactly, so the ties are real, not theoretical. We append a
 * unique second sort key (the primary key) so the total order is deterministic.
 * Pass `tiebreak: null` only for a relation that genuinely has no such column,
 * and accept that its pages may overlap.
 *
 * @param {object} queryBuilder - Supabase query chain (e.g., supabase.from('x').select('y').eq('z', val))
 * @param {object|number} [options] - Options, or a page size for the old signature
 * @param {number} [options.pageSize=1000] - Rows per page (1000 is the Supabase max)
 * @param {string|null} [options.tiebreak='id'] - Unique column appended as the last sort key
 * @param {number} [options.maxRows=100000] - Hard ceiling; a warning is logged if hit
 * @param {string} [options.label] - Name used in the ceiling warning
 * @returns {Promise<{data: Array, error: object|null}>}
 */
async function fetchAllRows(queryBuilder, options = {}) {
  const {
    pageSize = 1000,
    tiebreak = 'id',
    maxRows = 100000,
    label = 'query',
  } = typeof options === 'number' ? { pageSize: options } : options;

  // Appended once, before the loop — the builder is mutable and re-executed per
  // page, so ordering inside the loop would stack a new sort key every pass.
  // It lands last, so the caller's own .order() still decides the real sort.
  const pagedQuery = tiebreak
    ? queryBuilder.order(tiebreak, { ascending: true })
    : queryBuilder;

  const allData = [];
  let from = 0;

  while (from < maxRows) {
    const { data, error } = await pagedQuery.range(from, from + pageSize - 1);
    if (error) return { data: allData, error };
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break; // Last page
    from += pageSize;
  }

  if (from >= maxRows) {
    console.warn(
      `[Supabase] fetchAllRows(${label}) hit the ${maxRows}-row ceiling — results are truncated`
    );
  }

  return { data: allData, error: null };
}

module.exports = { supabase, fetchAllRows };

