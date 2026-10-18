-- 1150_separation_of_duties_registry.sql
-- A47 gate audit (RRR-91), Section 18 gate 18 and Section 8.2. private.separation_of_duties_rules, read through
-- app.separation_of_duties_rules, is "the separation of duties rules the database enforces, with the rule codes
-- refusals name". Six rules added after 0320 refuse with their code but were never registered, so the view listed
-- 12 of the 18 rules the functions raise. This registers them with the sentence each refusal already uses. The
-- pgTAP suite 1150 checks from the catalog that every sod_ code in a function body has a registry row, so a new
-- rule cannot be added without one.

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_work_order_award', 'Work orders', 'A work order is awarded by someone other than the person who created it.'),
  ('sod_offer_self', 'Offers', 'A person cannot send an offer on their own application.'),
  ('sod_onboarding_self_verify', 'Onboarding items', 'An engaged party cannot verify their own onboarding.'),
  ('sod_rating_self', 'Ratings', 'A person cannot rate their own engagement for the org.'),
  ('sod_deliverable_self', 'Engagement deliverables', 'The party who handed in work cannot accept it.'),
  ('sod_form_submitter', 'Form submissions', 'The person who submitted a form cannot approve or reject it.')
on conflict (code) do nothing;
