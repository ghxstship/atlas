-- 1170_price_books.sql
-- A50 gate 5 handlers (RRR-94, ADR 0031). Section 7.3 lists `price_books` under money and formats, and the frozen v1
-- contract documents priceBooks (list, get, create, update, delete) as an org price book for selling items, but no
-- table backed it. app.price_books holds an org's named price books, each in one currency:
--   * read with procurement.catalog.read, written with procurement.catalog.write (the capabilities the v1 contract
--     names), so Owners, Admins and Managers maintain them and Members read them
--   * a name appears once per org among live price books; delete is soft, through deleted_at

create table app.price_books (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  currency_code char(3) not null references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint price_books_name_length check (char_length(btrim(name)) between 1 and 200)
);

create index price_books_currency_code_idx on app.price_books (currency_code);
create unique index price_books_org_name_key on app.price_books (org_id, lower(btrim(name))) where deleted_at is null;

call private.install_domain_table('app.price_books');
call private.describe('app.price_books', 'Named price books an org sells from, each in one currency (Section 7.3). A name appears once per org among live price books.', array[
  'name', 'Price book name, for example Standard Client Rates.',
  'currency_code', 'ISO 4217 currency every price in the book is stated in.'
]);

call private.install_policies('app.price_books',
  $$org_id in (select private.orgs_with_capability('procurement.catalog.read'))$$,
  $$org_id in (select private.orgs_with_capability('procurement.catalog.write'))$$);

call private.install_default_retention('app.price_books');
call private.install_audit_trail('app.price_books');
