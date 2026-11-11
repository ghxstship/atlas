-- 2380_export_filter_null_tests.sql
--
-- Exports keep the filters a page applies by default (2380-2389), A102, RRR-146, review finding 3. The Projects page
-- hides archived projects unless its URL says ?archived=1 (packages/data projects.ts listProjects), but an export's
-- filters (2030) were only eq, in and search, and none of them says "archived_at is null". So exporting Projects
-- carried the archived projects the page hides, and ?archived=1 changed nothing.
--
-- This migration adds the two null tests to app.export_filter_operator and nothing else: Postgres lets a new enum
-- value be used only after the transaction that adds it commits, so 2381 changes the filter table and recreates the
-- functions that use them.

alter type app.export_filter_operator add value if not exists 'is_null';
alter type app.export_filter_operator add value if not exists 'not_null';

comment on type app.export_filter_operator is 'How an export filter narrows its rows: eq compares one column with a value, in with any of a comma-separated list of values, search matches the value inside any exported column (the collection''s search box), and is_null or not_null keeps the rows whose column is unset or set (a page''s default, such as Projects hiding archived projects; 2381).';
