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
 * @param {object} queryBuilder - Supabase query chain (e.g., supabase.from('x').select('y').eq('z', val))
 * @param {number} pageSize - Rows per page (default 1000, Supabase max)
 * @returns {Promise<{data: Array, error: object|null}>}
 */
async function fetchAllRows(queryBuilder, pageSize = 1000) {
  const allData = [];
  let from = 0;

  while (true) {
    const { data, error } = await queryBuilder.range(from, from + pageSize - 1);
    if (error) return { data: allData, error };
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break; // Last page
    from += pageSize;
  }

  return { data: allData, error: null };
}

module.exports = { supabase, fetchAllRows };

