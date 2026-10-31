-- pgTAP: migration 2978 (B8), the scanned bucket list and the read gate after R9's 2712 and P5's 2821. Both stacked
-- buckets are scanned and held back before a Clean scan, and the earlier buckets are unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

select ok(private.scanned_upload_bucket('party-uploads'), 'party-uploads objects are virus-scanned (R9)');
select ok(private.scanned_upload_bucket('credential-photos'), 'credential-photos objects are virus-scanned (P5)');
select ok(private.scanned_upload_bucket('field-media') and private.scanned_upload_bucket('upload-staging'),
  'the earlier buckets are still scanned');
select ok(not private.scanned_upload_bucket('documents'), 'a bucket not on the list is not scanned');
select ok(
  (select pg_get_expr(polqual, polrelid) from pg_policy
    where polname = 'object_scan_read_gate' and polrelid = 'storage.objects'::regclass)
    ~ 'party-uploads' and
  (select pg_get_expr(polqual, polrelid) from pg_policy
    where polname = 'object_scan_read_gate' and polrelid = 'storage.objects'::regclass)
    ~ 'credential-photos',
  'the read gate holds back party-uploads and credential-photos before a Clean scan');

select * from finish();
rollback;
