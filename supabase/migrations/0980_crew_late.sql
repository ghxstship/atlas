-- 0980_crew_late.sql
-- A13 People and Crew, late slot (ADR 0022 section 6). Pieces of the Crew schema that depend on
-- later ranges: the retention policy for the shift ledger added in 0460 uses A18's
-- private.install_default_retention (0550).

call private.install_default_retention('app.shift_state_transitions');
