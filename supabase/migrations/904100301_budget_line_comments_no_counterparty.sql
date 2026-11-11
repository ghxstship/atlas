-- 4.10, block 03 (the WP18 tail, RRR-66): the comments on app.budget_lines and its urid column named the counterparty
-- type's default as the last step of a budget line's GL account. A budget line has no counterparty: app.budget_line_amounts
-- calls private.gl_account_for_line (latest definition 1613) without one, so that step never resolves a line's account.
-- Only an expense or invoice drawn on the line adds it. The comments 1611 set are restated to say so; nothing else changes.

comment on table app.budget_lines is 'Budget lines (Section 7.4). The unit price is NULL when unpriced and never defaulted to zero; the extended amount is derived. The GL account is derived, never stored: the priced item''s explicit GL default first, then the URID''s class account (decision D13 as owner decision 39 reads it, private.gl_account_for_line). A budget line has no counterparty; an expense or invoice drawn on it adds its counterparty type''s default as the last step.';
comment on column app.budget_lines.urid is 'Dimension 2: canon discipline or category the line spends on. Its class gives the GL account when the priced item carries no explicit GL default.';
