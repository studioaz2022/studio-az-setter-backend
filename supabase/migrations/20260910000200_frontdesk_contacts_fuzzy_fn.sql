-- Trigram word-similarity search over the contact index.
--
-- Substring matching handles every typo EXCEPT one in the opening characters,
-- because a stem taken off the front of a misspelling is itself misspelled:
-- "Mlikert" stems to "mli" and matches nothing.
--
-- Two things had to be measured rather than assumed:
--   * similarity() compares whole strings, and search_text is name + email +
--     digits concatenated. "mlikert" scored 0.091 against the row it should
--     obviously match. word_similarity(), which scores the query against the
--     best-matching extent inside the target, gives 0.375 on the same row.
--   * `a %> b` is word_similarity(a, b) — the QUERY must be the first
--     operand. Written the other way it answers ~0 for every row.
--
-- The comparison is spelled out rather than using %>, so the threshold is an
-- argument instead of depending on pg_trgm.word_similarity_threshold (default
-- 0.6, which would reject the 0.375 above). That costs the index here, but it
-- is a scan of ~9k short rows on a path that only runs when exact and
-- substring matching have already found nothing.

create or replace function public.search_contacts_fuzzy(
  loc         text,
  q           text,
  min_sim     real default 0.3,
  max_rows    int  default 50
)
returns setof public.frontdesk_contacts
language sql
stable
set search_path = public, pg_catalog
as $$
  select *
  from public.frontdesk_contacts
  where location_id = loc
    and word_similarity(q, search_text) >= min_sim
  order by word_similarity(q, search_text) desc
  limit max_rows;
$$;
