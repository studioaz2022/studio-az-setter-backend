-- Origin stamping for gallery_events (GALLERY_RANKING_PLAN.md — automatic
-- launch cutover). The browser's Origin header is stored per event; the
-- scoring job counts only production-origin events, so the ranking clock
-- starts by itself the moment minneapolisbarbershop.com serves its first
-- real gallery visitor — no env flip, no manual Render step. Bay/localhost
-- traffic is excluded forever, not just pre-launch.
alter table gallery_events add column if not exists origin text;
