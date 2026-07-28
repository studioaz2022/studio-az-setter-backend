-- Apprentice-disclosure acknowledgment on the consent form.
-- When the assigned technician is an apprentice (temporary) technician, the
-- client sees a separate required checkbox acknowledging that. This records
-- whether they ticked it. NULL = artist was not an apprentice (checkbox not shown).
-- Voluntary disclosure — NOT required by MN (see mn-body-art-licensure-rules).

ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS apprentice_acknowledged BOOLEAN;

COMMENT ON COLUMN consent_forms.apprentice_acknowledged IS 'Client ticked the apprentice-technician disclosure checkbox. NULL when the artist was not an apprentice (checkbox not shown). Voluntary disclosure, not MN-mandated.';
