-- 2661_work_detail_category_contact.sql
-- R6a (RRR-185, ADR 0102 decision 1, ADR 0105): Contact joins the work detail categories, so a person can share the
-- verified email and phone they sign in with (read as private.recipient_address reads them) with an engagement. Alone in
-- its migration: Postgres cannot use an enum value in the transaction that adds it, and 2663 maps and reads it.

alter type app.work_detail_category add value if not exists 'Contact' after 'Emergency Contacts';
