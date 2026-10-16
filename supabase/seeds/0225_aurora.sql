-- 0225_aurora.sql
-- A25 Aurora AI demo seed (Section 19.6). For the demo org Northwind Live (Team plan, aurora_ai with 10,000
-- requests a month): the Admin has turned on the assistant, document extraction and summaries; one answered
-- assistant request with its redacted log and metering; and one extraction suggestion waiting for confirmation,
-- with a NO_ANSWER field where the certificate states no limit. Fictional data only; idempotent; loads cleanly
-- before 0010 exists because every insert is guarded by the demo org (0000_demo_tenant_conventions.sql).
--   ai_settings          01920000-0000-7000-8000-000000022501
--   ai_requests          01920000-0000-7000-8000-000000022511 (assistant), ...022512 (extraction)
--   ai_usage             01920000-0000-7000-8000-000000022521, ...022522
--   ai_suggestions       01920000-0000-7000-8000-000000022531
--   ai_suggestion_fields 01920000-0000-7000-8000-000000022541 to ...022544

insert into app.ai_settings (id, org_id, assistant_enabled, extraction_enabled, summaries_enabled)
select '01920000-0000-7000-8000-000000022501', o.id, true, true, true
from app.organizations o
where o.id = '01920000-0000-7000-8000-000000000001'
  and private.org_has_feature(o.id, 'aurora_ai')
on conflict do nothing;

insert into app.ai_requests (id, org_id, person_id, feature, model, outcome, prompt_redacted, output_redacted, completed_at)
select '01920000-0000-7000-8000-000000022511', o.id, p.id, 'assistant', 'claude-sonnet-5-5', 'Answered',
  'Which permits for the Harbor Nights show are still blocked?',
  'One permit is blocked: the Fire Marshal Permit, waiting on the revised egress plan.',
  now() - interval '2 hours'
from app.organizations o
join app.people p on p.id = '01920000-0000-7000-8000-000000000102'
where o.id = '01920000-0000-7000-8000-000000000001'
on conflict do nothing;

insert into app.ai_requests (id, org_id, person_id, feature, model, outcome, subject_table, subject_id, prompt_redacted, output_redacted, completed_at)
select '01920000-0000-7000-8000-000000022512', o.id, p.id, 'extraction', 'claude-opus-5-5', 'Answered',
  null, null,
  'Read the attached insurance certificate and fill the fields. [document application/pdf]',
  'record_fields coverage_type General Liability, expires_on 2027-03-31',
  now() - interval '1 hour'
from app.organizations o
join app.people p on p.id = '01920000-0000-7000-8000-000000000102'
where o.id = '01920000-0000-7000-8000-000000000001'
on conflict do nothing;

insert into app.ai_usage (id, request_id, metered_at, input_tokens, output_tokens)
select v.id, v.request_id, now() - v.age, v.input_tokens, v.output_tokens
from (values
  ('01920000-0000-7000-8000-000000022521'::uuid, '01920000-0000-7000-8000-000000022511'::uuid, interval '2 hours', 1840, 112),
  ('01920000-0000-7000-8000-000000022522'::uuid, '01920000-0000-7000-8000-000000022512'::uuid, interval '1 hour', 6210, 304)
) as v (id, request_id, age, input_tokens, output_tokens)
where exists (select 1 from app.ai_requests r where r.id = v.request_id)
on conflict do nothing;

insert into app.ai_suggestions (id, request_id, operation_id, target_id, summary)
select '01920000-0000-7000-8000-000000022531', r.id, 'insuranceCertificates.create', null,
  'Add the Harborline Staging general liability certificate, expiring 2027-03-31.'
from app.ai_requests r
where r.id = '01920000-0000-7000-8000-000000022512'
on conflict do nothing;

insert into app.ai_suggestion_fields (id, suggestion_id, field_path, proposed_value, confidence, refusal, missing, source_excerpt, position)
select v.id, s.id, v.field_path, v.proposed_value, v.confidence, v.refusal, v.missing, v.source_excerpt, v.position
from app.ai_suggestions s
cross join (values
  ('01920000-0000-7000-8000-000000022541'::uuid, 'coverage_type', '"General Liability"'::jsonb, 0.980::numeric, null::text, null::text, 'COMMERCIAL GENERAL LIABILITY', 0::smallint),
  ('01920000-0000-7000-8000-000000022542'::uuid, 'expires_on', '"2027-03-31"'::jsonb, 0.930, null, null, 'Policy expiration 03/31/2027', 1),
  ('01920000-0000-7000-8000-000000022543'::uuid, 'currency', '"USD"'::jsonb, 0.900, null, null, 'All amounts in USD', 2),
  ('01920000-0000-7000-8000-000000022544'::uuid, 'each_occurrence_minor', null, null, 'NO_ANSWER', 'The certificate refers to an attached schedule for limits and states none itself.', null, 3)
) as v (id, field_path, proposed_value, confidence, refusal, missing, source_excerpt, position)
where s.id = '01920000-0000-7000-8000-000000022531'
on conflict do nothing;
