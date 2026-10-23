-- 1396_document_number_padding.sql
-- Orchestrator fix (RRR-121, audit of A76 on batch-c): numbering.document_number_padding pads document numbers and
-- never cuts them.
--
--   * private.document_number (1326) passed the padding to lpad, which truncates a longer string: at a padding of 1
--     the 10th number came out as 1 again, and at the default 4 the 10000th invoice duplicated INV-1000. A number
--     longer than the padding now keeps every digit, as 1326 documented.
--   * Training certificates follow the padding below 4 too: training_completions_certificate_format (0804) required
--     at least four digits, so at a padding of 1 to 3 every passing app.complete_training failed. The check now
--     accepts TRN- and any digits; the number stays unique per org (training_completions_certificate_key).

create or replace function private.document_number(p_org_id uuid, p_prefix text, p_sequence_name text)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select coalesce(p_prefix, '') || lpad(n.digits, greatest(n.padding, char_length(n.digits)), '0')
  from (
    select private.next_sequence(p_org_id, p_sequence_name)::text as digits,
      greatest(coalesce(private.setting_integer(p_org_id, 'numbering.document_number_padding'), 4)::integer, 1) as padding
  ) n;
$$;

comment on function private.document_number(uuid, text, text) is 'The next document number of an org''s sequence: the prefix and the number padded with zeros to numbering.document_number_padding digits (1326). A number longer than the padding keeps every digit (1396).';
revoke all on function private.document_number(uuid, text, text) from public, anon, authenticated;

alter table app.training_completions drop constraint training_completions_certificate_format;
alter table app.training_completions add constraint training_completions_certificate_format
  check (certificate_number is null or certificate_number ~ '^TRN-[0-9]+$');

comment on column app.training_completions.certificate_number is 'Completion certificate number for passes: TRN- and the org''s next certificate number, padded to numbering.document_number_padding digits (TRN-0001 by default; 1326, 1396).';
