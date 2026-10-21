-- How conversation checkpoints are confirmed in a workspace (requirement Q08 "gate criteria and
-- evidence modes"; supervision-settings.ts). 'as_authored' keeps each gate's own evaluator
-- definition: a deterministic evaluator may confirm the AI reviewer's quoted findings. 'people_only'
-- is stricter: every finding waits for a person, whatever the course declares. It can only add
-- human review, never remove it.
ALTER TABLE supervision_settings ADD COLUMN conversation_confirmation text NOT NULL DEFAULT 'as_authored'
  CHECK (conversation_confirmation IN ('as_authored', 'people_only'));
