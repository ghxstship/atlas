-- 3000_supply_follow_on_enums.sql
-- B11 Supply chain follow-ons (RRR-235). The two enums of the package: how often a maintenance plan repeats (G-95), and
-- which notice a supplier got about an RFQ (G-196).

create type app.maintenance_interval_unit as enum ('Day', 'Week', 'Month', 'Year');
comment on type app.maintenance_interval_unit is 'The unit of a recurring maintenance plan''s interval (B11, G-95): every_count of these after the last time the work was done.';

create type app.rfq_notice_kind as enum ('Quote Reminder', 'Not Awarded');
comment on type app.rfq_notice_kind is 'A notice a supplier got about an RFQ (B11, G-196): a reminder that a quote is still awaited, or word that the RFQ was awarded elsewhere.';
