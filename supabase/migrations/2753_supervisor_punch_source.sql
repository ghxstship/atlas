-- 2753_supervisor_punch_source.sql
-- R12 parity addition G-126 (RRR-190, competitor parity audit 2026-10-28): a supervisor clocks in a whole team from
-- Compass. The punch source gains Supervisor, written only by app.record_supervisor_punches (2754); app.record_punch
-- still refuses any source but Mobile from a signed-in caller (punch_source_mobile). This file holds the enum value
-- alone because Postgres cannot use a new enum value in the transaction that adds it.

alter type app.punch_source add value if not exists 'Supervisor';

comment on type app.punch_source is 'Where a punch was captured: the person''s phone (Compass), a shared kiosk, or a supervisor''s phone punching the team in or out (Supervisor, R12). The time entry of a Supervisor punch is recorded as Mobile; who punched is the punch''s created_by.';
