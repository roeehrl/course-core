-- Placement blueprint and protected units set by staff (Q06). The course author declares the
-- placement blueprint (which items may be asked and which objectives may be placed out of) and the
-- protected, never-skippable episodes. Staff may only narrow that: leave out author items or
-- objectives, and protect more episodes. They can never add an item or un-protect an episode the
-- author protected. IDs that the active release does not know are ignored when applied.
ALTER TABLE placement_settings
  ADD COLUMN excluded_assessment_ids jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(excluded_assessment_ids) = 'array' AND jsonb_array_length(excluded_assessment_ids) <= 500),
  ADD COLUMN excluded_objective_ids jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(excluded_objective_ids) = 'array' AND jsonb_array_length(excluded_objective_ids) <= 500),
  ADD COLUMN protected_episode_ids jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(protected_episode_ids) = 'array' AND jsonb_array_length(protected_episode_ids) <= 500);
