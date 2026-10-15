-- 0640_view_types_support_enums.sql
-- A31 Views, Help and Support (Section 11.15, Section 11.16). Enum additions only: Postgres refuses to
-- use a value added by `alter type ... add value` in the same transaction, so the values land here
-- alone and 0641 onward use them.
--
-- app.view_type (A18, 0540) gains every view type of the view registry (packages/schemas/views.yaml)
-- that a person can save, so a saved view can hold the map, gallery or resource schedule a page offers.

alter type app.view_type add value if not exists 'Spreadsheet';
alter type app.view_type add value if not exists 'Gallery';
alter type app.view_type add value if not exists 'Resource Schedule';
alter type app.view_type add value if not exists 'Map';
alter type app.view_type add value if not exists 'Site Plan';
alter type app.view_type add value if not exists 'Tree';
alter type app.view_type add value if not exists 'Matrix';
alter type app.view_type add value if not exists 'Org Chart';
alter type app.view_type add value if not exists 'Chart';
alter type app.view_type add value if not exists 'Feed';
alter type app.view_type add value if not exists 'Inbox';

comment on type app.view_type is 'View types a collection can be shown in and saved as (Section 4.6.3, Section 11.15); the registry is packages/schemas/views.yaml.';
