-- 2745_advancing_funnels.sql
-- R11 Advancing funnels (RRR-192; A146, ADR 0052, Section 11.14). Three more Section 11.11 workflows join A96's
-- pipeline (1532) and A146's hourly check (2340), each measured within one session of its own app:
--   * gateway.advance_typed_answer: the party opens its Advance tab, opens a section's form, and sends the answer.
--   * gateway.crew_roster: the party adds a first entry, submits the roster, and sees every entry accepted.
--   * atlas.advance_allocation: a reviewer opens a requested allocation, approves it, and issues it.
-- The browser registry (packages/data/src/product-workflows.ts) names the same funnels; its unit test holds them
-- together. Events still name a workflow and a step only, never a record, a person or an org.

insert into private.product_workflows (code, app_code, target) values
  ('gateway.advance_typed_answer', 'Gateway', 'A typed advance section answered in the sitting it is opened'),
  ('gateway.crew_roster', 'Gateway', 'A crew roster from its first entry to every entry accepted'),
  ('atlas.advance_allocation', 'Atlas', 'A requested allocation decided and issued in one sitting')
on conflict (code) do nothing;

insert into private.product_funnels (workflow_code, owning_team, steps, target_completion) values
  ('gateway.advance_typed_answer', 'Advancing', 1, 0.600),
  ('gateway.crew_roster', 'Advancing', 1, 0.400),
  ('atlas.advance_allocation', 'Advancing', 1, 0.500)
on conflict (workflow_code) do nothing;
