-- 1594_partner_prices_describe.sql
--
-- Orchestrator block (ADR 0022, 1590-1599), RRR-125. ADR 0033 decision 66 leaves Stripe Connect for partners out of 4.0
-- (finding A65-026): partners invoice their clients themselves, XOS records the partner's prices and takes no application
-- fee. The comment 1060 gave app.partner_client_prices still said the partner bills its clients through Stripe Connect,
-- and the published data dictionary repeats it. This restates the table's description in the decision's words; its
-- column comments stand.

call private.describe('app.partner_client_prices', 'What a partner charges a client org each month (Section 4.6.1; ADR 0033 decision 66). The partner invoices the client itself; XOS records the price for the partner''s reference and never shows it to the client. Read and written by the partner only.');
