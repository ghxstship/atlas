-- 0369_record_kind_fk_indexes.sql
-- A03 Domain Data (RRR-71). ADR 0002 puts an index behind every foreign key. Supabase's performance
-- advisor flagged the composite (record_id, record_kind) foreign key of each of the 26 record kind
-- extension tables (Section 7.4 record spine) on staging on 2026-10-14: record_id is each table's primary
-- key, but no index leads with the pair the key checks. A sweep of every foreign key in app and private
-- found no other unindexed key. pgTAP 0369 now fails the build on any unindexed foreign key.

create index if not exists record_approval_record_kind_idx on app.record_approval (record_id, record_kind);
create index if not exists record_booking_record_kind_idx on app.record_booking (record_id, record_kind);
create index if not exists record_build_record_kind_idx on app.record_build (record_id, record_kind);
create index if not exists record_compliance_record_kind_idx on app.record_compliance (record_id, record_kind);
create index if not exists record_contract_record_kind_idx on app.record_contract (record_id, record_kind);
create index if not exists record_deadline_record_kind_idx on app.record_deadline (record_id, record_kind);
create index if not exists record_decision_record_kind_idx on app.record_decision (record_id, record_kind);
create index if not exists record_distribution_record_kind_idx on app.record_distribution (record_id, record_kind);
create index if not exists record_document_record_kind_idx on app.record_document (record_id, record_kind);
create index if not exists record_event_record_kind_idx on app.record_event (record_id, record_kind);
create index if not exists record_goal_record_kind_idx on app.record_goal (record_id, record_kind);
create index if not exists record_inspection_record_kind_idx on app.record_inspection (record_id, record_kind);
create index if not exists record_meeting_record_kind_idx on app.record_meeting (record_id, record_kind);
create index if not exists record_milestone_record_kind_idx on app.record_milestone (record_id, record_kind);
create index if not exists record_payment_record_kind_idx on app.record_payment (record_id, record_kind);
create index if not exists record_permit_record_kind_idx on app.record_permit (record_id, record_kind);
create index if not exists record_recruitment_record_kind_idx on app.record_recruitment (record_id, record_kind);
create index if not exists record_rehearsal_record_kind_idx on app.record_rehearsal (record_id, record_kind);
create index if not exists record_report_record_kind_idx on app.record_report (record_id, record_kind);
create index if not exists record_risk_record_kind_idx on app.record_risk (record_id, record_kind);
create index if not exists record_shift_record_kind_idx on app.record_shift (record_id, record_kind);
create index if not exists record_strike_record_kind_idx on app.record_strike (record_id, record_kind);
create index if not exists record_supply_record_kind_idx on app.record_supply (record_id, record_kind);
create index if not exists record_task_record_kind_idx on app.record_task (record_id, record_kind);
create index if not exists record_timeline_record_kind_idx on app.record_timeline (record_id, record_kind);
create index if not exists record_training_record_kind_idx on app.record_training (record_id, record_kind);
