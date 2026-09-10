// contactSearch.js — front-desk client lookup.
//
// WHY THIS EXISTS. The desk reported having to type a client's full name
// exactly before they'd appear, and that a surname alone often wasn't
// enough. Measured against the live barbershop location 2026-09-09,
// GHL's contact search has three properties that together produce that:
//
//   1. IT PAGES, IT DOESN'T RANK. "John" matches 93 contacts; asking for
//      20 returns an arbitrary 20 and the other 73 are simply invisible.
//      "Alex" hides 62, "Sam" 43. Typing the full name was the only way
//      to get under the cap — exactly the workaround reported.
//   2. IT MATCHES AN ORDERED PREFIX SEQUENCE. "milkert spencer" -> 0
//      results for a contact named Spencer Milkert. "jean pribessan" ->
//      0 for "Jean Carlo Pribessan", because the middle token is
//      skipped. Word order and completeness both matter to GHL.
//   3. IT MATCHES WORD PREFIXES ONLY, AND ONLY FROM 4 CHARACTERS.
//      "Milk" finds Milkert; "ilker" and "kert" find nothing, and even
//      "Mil" misses it.
//
// So the fix cannot be a different GHL endpoint — the modern
// searchContactsAdvanced has identical matching semantics (verified).
// It has to be query STRATEGY plus local ranking:
//
//   - Ask GHL using the most selective token rather than the whole
//     phrase. Longest-token is a good free proxy for the surname:
//     "sam" matches 80 contacts, "schumacher" matches 2.
//   - Pull a generous page for that one token and do the AND-matching
//     locally, so word order and skipped middle names stop mattering.
//   - RANK before truncating, so the person you meant is at the top
//     instead of being cut off at an arbitrary boundary.
//
// searchContactsAdvanced is used over the deprecated getContacts
// because it reports `total`, which lets the desk see when a query is
// broader than the list being shown.

/** Strip diacritics + lowercase so "José" matches "jose". */
function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(q) {
  return norm(q)
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^a-z0-9@.+'-]+|[^a-z0-9@.+'-]+$/g, ""))
    .filter(Boolean);
}

const digitsOf = (s) => (s || "").replace(/\D+/g, "");

/** Levenshtein with an early bail — we only ever care about tiny edits. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1; // no path can recover
    prev = cur;
  }
  return prev[b.length];
}

/** How much slop to allow for a token of this length. */
function fuzzyBudget(token) {
  if (token.length <= 4) return 0; // too short to guess safely
  if (token.length <= 7) return 1;
  return 2;
}

/** The words we're willing to match a name token against. */
function contactWords(c) {
  const name = norm(
    c.contactName || `${c.firstName || ""} ${c.lastName || ""}`
  );
  const email = norm(c.email);
  return {
    name,
    words: [
      ...name.split(/\s+/).filter(Boolean),
      // Local-part of the email is a real handle people search by.
      ...(email ? email.split(/[@._-]+/).filter(Boolean) : []),
    ],
    email,
    phone: digitsOf(c.phone),
  };
}

/**
 * Score one contact against the tokens. Returns null when it isn't a
 * match at all. Higher is better.
 *
 * The tiers exist so that ranking, not GHL's arbitrary page order,
 * decides who survives truncation.
 */
function scoreContact(c, tokens, normQuery, allowFuzzy) {
  const { name, words, email, phone } = contactWords(c);
  if (!name && !email && !phone) return null;

  let score = 0;
  let fuzzyUsed = 0;

  for (const t of tokens) {
    const tDigits = digitsOf(t);
    // A numeric token is a phone fragment, not a name.
    if (tDigits.length >= 3 && tDigits.length === t.length) {
      if (phone.includes(tDigits)) {
        score += 40;
        continue;
      }
      return null;
    }
    // Prefer a word-start match; fall back to anywhere in the name.
    // Checked BEFORE the email so a token that appears in both is
    // credited as the name match it almost certainly is.
    const startsIdx = words.findIndex((w) => w.startsWith(t));
    if (startsIdx !== -1) {
      // Exact whole-word beats a prefix; earlier words beat later ones.
      score += words[startsIdx] === t ? 60 : 45;
      score += Math.max(0, 6 - startsIdx);
      continue;
    }
    if (name.includes(t)) {
      score += 20;
      continue;
    }
    if (email && email.includes(t)) {
      score += 30;
      continue;
    }
    if (allowFuzzy) {
      const budget = fuzzyBudget(t);
      if (budget > 0) {
        const near = words.some(
          (w) => editDistance(t, w, budget) <= budget
        );
        if (near) {
          score += 12;
          fuzzyUsed++;
          continue;
        }
      }
    }
    return null; // every token must land somewhere — this is an AND
  }

  // Whole-phrase bonuses: these are what put the obvious answer first.
  if (name === normQuery) score += 500;
  else if (name.startsWith(normQuery)) score += 200;
  else if (name.includes(normQuery)) score += 80;

  // A surname that is also a common prefix was getting buried: every
  // "Justin" starts with "just" and collected the +200, so searching
  // "Just" for the client actually named Elijah Just returned ten
  // Justins and not him. Naming someone exactly is at least as strong
  // a signal as prefixing them, so an exact whole-word hit scores
  // alongside the prefix bonus rather than far below it.
  if (words.some((w) => w === normQuery)) score += 190;

  // A tight match on a short name beats the same match buried in a long
  // one ("Sam Roble" over "Sam Roblexander-Smith" for query "sam rob").
  score -= Math.min(20, Math.floor(name.length / 4));
  score -= fuzzyUsed * 25; // exact matches always outrank guesses
  return score;
}

/**
 * Ask GHL with the `query` parameter — a word-prefix match on an
 * ordered phrase. Kept only as a fallback for the typo rescue, where
 * a 4-character stem is exactly the shape `query` is good at.
 */
async function ghlQuery(sdk, locationId, query, pageLimit) {
  const r = await sdk.contacts.searchContactsAdvanced(
    { locationId, query, pageLimit, page: 1 },
    { timeout: QUERY_TIMEOUT_MS }
  );
  return { total: r?.total ?? null, contacts: r?.contacts || [] };
}

/**
 * Ask GHL with structured FILTERS — the good primitive.
 *
 * The `query` parameter only does an ordered word-prefix match, which
 * is what made mid-word searches and phone-suffix lookups impossible:
 * "kert" found nobody though three clients have it in their surname,
 * and "3536" found the client whose NAME is a phone number instead of
 * the one whose number ends in 3536. `filters` with the `contains`
 * operator is a true substring match, and the array is ANDed, so:
 *
 *   every token must appear SOMEWHERE (AND across the tokens)
 *   in the name, the email, or the phone (OR within each token)
 *
 * That single shape covers word order, skipped middle names, mid-word
 * fragments and phone suffixes at the API level, in one round trip.
 */
/** GHL rejects a `contains` filter on fewer than 3 characters. */
const CONTAINS_MIN = 3;

// Budget for the whole lookup: the good path, then the fallback, has to
// finish inside the front end's deadline or the desk sees an aborted
// request instead of results.
// GHL's filter endpoint normally answers in ~3s and hangs for 18-20s
// when it misbehaves, so the cut goes between those: wide enough to
// ride out ordinary variance and keep the good matching, tight enough
// that a hang never reaches the desk. Worst case here plus the
// fallback stays inside the front end's 12s deadline.
const FILTER_TIMEOUT_MS = 6000;
const QUERY_TIMEOUT_MS = 3500;

async function ghlFilterQuery(sdk, locationId, tokens, pageLimit) {
  const filters = tokens.map((tok) => {
    const d = digitsOf(tok);
    const or = [
      { field: "contactName", operator: "contains", value: tok },
      { field: "email", operator: "contains", value: tok },
    ];
    // Only a real fragment of a number is worth matching against a
    // phone — two digits would match almost everyone.
    if (d.length >= 3) {
      or.push({ field: "phone", operator: "contains", value: d });
    }
    return { group: "OR", filters: or };
  });
  // GHL's filter endpoint is unreliable in two directions: sometimes it
  // answers "Network error: no response received" instantly, and
  // sometimes it HANGS for 18-20 seconds on the very same payload that
  // returns in 3. Measured directly against the SDK, with no retry
  // involved, and unrelated to pageLimit — "3536" took 20.7s at a page
  // limit of 25 and 3.0s at 100.
  //
  // The desk types into this box, and the browser gives up before that
  // ever lands, so an unbounded wait is not a slow search — it is a
  // failed one with a worse error message. Bound it and let the caller
  // fall back to the prefix search, which is consistently around a
  // second. Retrying the filter would just risk a second hang.
  const r = await sdk.contacts.searchContactsAdvanced(
    { locationId, pageLimit, page: 1, filters },
    { timeout: FILTER_TIMEOUT_MS }
  );
  return { total: r?.total ?? null, contacts: r?.contacts || [] };
}

/**
 * Front-desk contact search.
 *
 * @returns {Promise<{contacts: object[], total: number|null, fuzzy: boolean, strategy: string}>}
 */
async function searchContacts({ sdk, locationId, q, limit = 25, fetchSize = 100 }) {
  const tokens = tokenize(q);
  const normQuery = norm(q);
  if (!tokens.length) {
    return { contacts: [], total: 0, fuzzy: false, strategy: "empty" };
  }

  const seen = new Map();
  const collect = (list) => {
    for (const c of list) if (c?.id && !seen.has(c.id)) seen.set(c.id, c);
  };

  // GHL refuses a `contains` filter shorter than 3 characters, so only
  // the long-enough tokens can be pushed down to the API. Any shorter
  // ones are still enforced locally by the ranker, which is an AND —
  // so "jo smith" filters on "smith" server-side and then requires
  // "jo" here. Without this the whole filter query 422s and every
  // search with a short token silently drops to the weaker path.
  const filterable = tokens.filter((t) => t.length >= CONTAINS_MIN);

  let strategy = "contains";
  let total = null;
  if (filterable.length) {
    try {
      const r = await ghlFilterQuery(sdk, locationId, filterable, fetchSize);
      total = r.total;
      collect(r.contacts);
    } catch (err) {
      // Never let a filter failure cost the desk their search — fall
      // back to the older prefix behaviour rather than returning none.
      console.warn(
        "[contactSearch] filter query failed/timed out, falling back:",
        err?.message || err
      );
      const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
      const r = await ghlQuery(sdk, locationId, longest, fetchSize);
      total = r.total;
      collect(r.contacts);
      strategy = "query-fallback";
    }
  } else {
    // Every token is 1-2 characters ("jo", "li"). Nothing to filter
    // on, so use the prefix search, which has no minimum.
    const r = await ghlQuery(sdk, locationId, normQuery, fetchSize);
    total = r.total;
    collect(r.contacts);
    strategy = "short-query";
  }

  let ranked = rank([...seen.values()], tokens, normQuery, false);

  // Typo rescue. `contains` is exact about the characters it is given,
  // so a misspelling matches nothing at all. GHL's `query` parameter
  // matches word prefixes from about four characters, which still
  // reaches the record when the error is later in the word
  // ("Milkurt" -> stem "Milk" -> Milkert). An error inside the first
  // four characters is not recoverable this way, and the result is
  // flagged `fuzzy` so the desk verifies rather than trusting it.
  let fuzzy = false;
  if (!ranked.length) {
    const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length >= 5) {
      try {
        const r = await ghlQuery(sdk, locationId, longest.slice(0, 4), fetchSize);
        collect(r.contacts);
        ranked = rank([...seen.values()], tokens, normQuery, true);
        if (ranked.length) {
          fuzzy = true;
          strategy = "fuzzy-stem";
        }
      } catch {
        /* the rescue is best-effort; a failure just means no results */
      }
    }
  }

  return {
    contacts: ranked.slice(0, limit),
    // With filters this is the true count for the WHOLE query, so
    // "showing 25 of 118" is now an honest statement.
    total,
    fuzzy,
    strategy,
  };
}

function rank(candidates, tokens, normQuery, allowFuzzy) {
  const scored = [];
  for (const c of candidates) {
    const s = scoreContact(c, tokens, normQuery, allowFuzzy);
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const an = norm(a.c.contactName || ""), bn = norm(b.c.contactName || "");
    if (an.length !== bn.length) return an.length - bn.length;
    return an.localeCompare(bn);
  });
  return scored.map((x) => x.c);
}

module.exports = { searchContacts, tokenize, norm, scoreContact, editDistance };
