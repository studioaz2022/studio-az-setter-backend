-- Filter-tap events (GALLERY_RANKING_PLAN.md Phase 1):
-- visitors tapping taxonomy chips in the gallery land as event_type='filter'
-- rows carrying the tag slug and no photo. Relax the photo columns for this
-- one type only — a CHECK keeps every other event type exactly as strict as
-- the old NOT NULLs did.
alter table gallery_events add column if not exists tag text;
alter table gallery_events alter column photo_id drop not null;
alter table gallery_events alter column barber_slug drop not null;

-- the create-table migration pinned the allowed types inline — admit 'filter'
alter table gallery_events drop constraint if exists gallery_events_event_type_check;
alter table gallery_events add constraint gallery_events_event_type_check check (
  event_type in ('impression','flip','book_click','bio_click','conversion','filter')
);

alter table gallery_events drop constraint if exists gallery_events_filter_shape;
alter table gallery_events add constraint gallery_events_filter_shape check (
  (event_type = 'filter' and tag is not null and photo_id is null and barber_slug is null)
  or
  (event_type <> 'filter' and photo_id is not null and barber_slug is not null)
);
