-- Automated checks of generated media may also come from a frame and pixel inspection of the
-- asset itself (media-pixels.ts): duration, frame size, blank or frozen frames and cuts against
-- what the job asked for. Such a row has verifier 'pixels', no model, and an input digest of the
-- expectations it checked. Its findings are codes and numbers only, never learner content.
ALTER TABLE media_checks DROP CONSTRAINT media_checks_verifier_check;
ALTER TABLE media_checks ADD CONSTRAINT media_checks_verifier_check CHECK (verifier IN ('rules', 'model', 'pixels'));
