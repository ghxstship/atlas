-- 0100_xpms_domains.sql
-- A01 Canon (ADR 0004 range 0100 to 0199). Domains and types shared by every xpms table.
--
-- Invariant 24 (Section 7.5): no em dash is accepted in canon or verbiage text. The
-- check lives on the domains, so every canon and Standard Library text column refuses
-- U+2014 by construction. The character is written as chr(8212) so this file stays clean.
--
-- The Bible tab 17 line that bans the identifier "status" is superseded by Section 3.6;
-- no domain, constraint or check here refers to it.

create domain xpms.canon_text as text
  check (strpos(value, chr(8212)) = 0);
comment on domain xpms.canon_text is 'Canon and verbiage text. Refuses the em dash (U+2014), Section 3.6 and invariant 24.';

create domain xpms.canon_code as text collate "C"
  check (
    value <> ''
    and value = btrim(value)
    and strpos(value, chr(8212)) = 0
  );
comment on domain xpms.canon_code is 'Natural canon code. Byte (C) collation so the default sort of fixed-width codes is numeric order; no surrounding whitespace; no em dash.';

create domain xpms.currency_code as char(3)
  check (value ~ '^[A-Z]{3}$');
comment on domain xpms.currency_code is 'ISO 4217 alphabetic currency code.';

create domain xpms.xyz_tag as char(1)
  check (value in ('X', 'Y', 'Z'));
comment on domain xpms.xyz_tag is 'Schema family tag: X Resource, Y Process, Z Timeline (Section 3.6). Not cost behavior.';

create type xpms.refusal as enum ('NO_ANSWER', 'UNRATIFIED', 'REFUSE');
comment on type xpms.refusal is 'First-class refusal outcomes (Section 3.7). Functions that resolve claims return these instead of guessing.';
