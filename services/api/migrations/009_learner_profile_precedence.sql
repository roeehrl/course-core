ALTER TABLE learner_model_profiles ADD COLUMN manually_edited boolean NOT NULL DEFAULT false;
UPDATE learner_model_profiles p SET manually_edited=true
WHERE EXISTS (SELECT 1 FROM learner_model_changes c WHERE c.enrollment_id=p.enrollment_id AND c.action='profile.edited');
