-- Commits stored the whole CMI, the learner's name and id with it (SCORM 1.2
-- cmi.core.student_name/student_id, 2004 cmi.learner_name/learner_id). Hubium knows who
-- the learner is, so the copies go.
UPDATE "ScormTrack"
SET cmi = cmi
  #- '{core,student_name}' #- '{core,student_id}' #- '{learner_name}' #- '{learner_id}'
  #- '{cmi,core,student_name}' #- '{cmi,core,student_id}' #- '{cmi,learner_name}' #- '{cmi,learner_id}'
WHERE jsonb_typeof(cmi) = 'object' AND cmi::text ~ '(student|learner)_(name|id)';
