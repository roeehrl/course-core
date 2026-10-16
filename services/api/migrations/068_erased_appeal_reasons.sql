-- Erasure replaces a written-answer appeal's reason with the placeholder '[erased]'
-- (data-lifecycle.ts), as it does for gate review requests (036) and placement
-- overrides (048). The column's 10-2000 character check from 027 refused that
-- placeholder, so erasing any enrollment that had ever appealed a written answer
-- failed and rolled back. Allow the placeholder exactly; every other reason keeps
-- the original length bounds.
ALTER TABLE rubric_appeals DROP CONSTRAINT rubric_appeals_reason_check,
  ADD CONSTRAINT rubric_appeals_reason_check CHECK (reason = '[erased]' OR length(reason) BETWEEN 10 AND 2000);
