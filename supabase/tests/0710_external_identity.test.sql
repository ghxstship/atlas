-- pgTAP: external identity (Section 4.4.1, Section 4.8.1) and the Section 8.7 helpers. Account memberships
-- and roles (Account Owner, Admin, Finance, Member), representations (scopes, expiry, artist acceptance),
-- profile shares, engagement areas by relationship and by state, the 18-month close, the party's own
-- signature, and gate 33: one person holding several engagements across orgs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.scope_of(p_who text, p_engagement text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims(p_who);
  select coalesce(string_agg(a, ',' order by a), '') into v from private.engagement_scope(pg_temp.id(p_engagement)) a;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Accounts ---------------------------------------------------------------------------------------------------
select pg_temp.claims('victor');
select is((select array_agg(r) from private.account_role(pg_temp.id('acct_v')) r), array['Account Owner']::app.account_role[], 'the creator is Account Owner');
select pg_temp.claims('fiona');
select is((select array_agg(r) from private.account_role(pg_temp.id('acct_v')) r), array['Account Finance']::app.account_role[], 'fiona is Account Finance');
select pg_temp.claims('ivy');
select is((select count(*)::int from private.account_role(pg_temp.id('acct_v'))), 0, 'a stranger holds no account role');
select pg_temp.as_platform();
select is((select count(*)::int from app.subscriptions where org_id = pg_temp.id('acct_v')), 0, 'an external account has no subscription (Section 4.4.1)');

select pg_temp.as_user('sam');
select throws_ok($$select app.add_account_member((select id from world where key = 'acct_v'), (select id from world where key = 'quinn'), 'Account Member')$$,
  '42501', null, 'an Account Member cannot add members');
select is((select count(*)::int from app.account_memberships), 1, 'a member reads their own account membership');
select is((select count(*)::int from app.account_membership_roles), 1, 'and their own roles');
select pg_temp.as_user('victor');
select throws_ok($$select app.add_account_member((select id from world where key = 'acct_v'), (select id from world where key = 'victor'), 'Account Finance')$$,
  'XR001', 'sod_self_grant: A person cannot grant themselves a role or capability.', 'no self-granted account role (Section 8.2)');
select lives_ok($$select app.add_account_member((select id from world where key = 'acct_v'), (select id from world where key = 'sam'), 'Account Admin')$$,
  'an Owner grants a member a second role');
select pg_temp.claims('sam');
select is((select array_agg(r order by r) from private.account_role(pg_temp.id('acct_v')) r), array['Account Admin', 'Account Member']::app.account_role[],
  'a member holds the union of several account roles');
select pg_temp.as_user('sam');
select throws_ok($$select app.add_account_member((select id from world where key = 'acct_v'), (select id from world where key = 'quinn'), 'Account Owner')$$,
  'XR001', 'account_role_band: Only an Account Owner grants Account Owner.', 'an Admin cannot grant Owner');
select lives_ok($$select app.add_account_member((select id from world where key = 'acct_v'), (select id from world where key = 'quinn'), 'Account Member')$$,
  'an Admin adds a member');
select pg_temp.as_user('victor');
select throws_ok($$select app.end_account_membership((select m.id from app.account_memberships m where m.person_id = (select id from world where key = 'victor')))$$,
  'XR001', 'sole_account_owner: An account keeps at least one Account Owner.', 'the last Account Owner cannot leave');
select throws_ok($$select app.remove_account_role((select r.id from app.account_membership_roles r where r.account_role = 'Account Owner'))$$,
  'XR001', 'sole_account_owner: An account keeps at least one Account Owner.', 'the last Account Owner role cannot be removed');
select pg_temp.as_user('quinn');
select lives_ok($$select app.end_account_membership((select m.id from app.account_memberships m where m.org_id = (select id from world where key = 'acct_v')))$$,
  'a member leaves an account');
select pg_temp.claims('quinn');
select is((select count(*)::int from private.account_role(pg_temp.id('acct_v'))), 0, 'leaving ends account access at once');
select pg_temp.as_platform();
select throws_ok($$insert into app.account_memberships (org_id, person_id) values ((select id from world where key = 'acct_v'), (select id from world where key = 'sam'))$$,
  'XR001', 'account_membership_overlap: A person holds one membership per account at a time.', 'one membership per person and account');
select pg_temp.as_user('sam');
select throws_ok($$insert into app.account_memberships (org_id, person_id) values ((select id from world where key = 'acct_v'), (select id from world where key = 'ivy'))$$,
  '42501', null, 'account rows are written only through the account RPCs');
select pg_temp.as_anon();
select throws_ok($$select app.create_external_account('Anon Co', 'anon-co')$$, '42501', null, 'anon cannot create an account');
select throws_ok('select 1 from app.account_memberships', '42501', null, 'anon cannot read account memberships');
select throws_ok('select 1 from app.representations', '42501', null, 'anon cannot read representations');
select throws_ok('select 1 from app.profile_shares', '42501', null, 'anon cannot read profile shares');
select pg_temp.as_platform();

-- Representations ------------------------------------------------------------------------------------------------
select pg_temp.claims('rita');
select ok(private.represents(pg_temp.id('art'), 'Advance'), 'rita represents art for the advance');
select ok(not private.represents(pg_temp.id('art'), 'Settlement'), 'but not for settlement, a scope art did not give');
select ok(not private.represents(pg_temp.id('ivy'), 'Advance'), 'and not for another person');
select pg_temp.as_user('rita');
with r as (select app.propose_representation((select id from world where key = 'acct_t'), (select id from world where key = 'ivy'), null,
  current_date + 30, array['Offers']::app.representation_scope[]) as id) insert into world select 'rep_ivy', id from r;
select pg_temp.claims('rita');
select ok(not private.represents(pg_temp.id('ivy'), 'Offers'), 'a representation grants nothing until the artist accepts');
select pg_temp.as_user('rita');
select throws_ok($$select app.accept_representation((select id from world where key = 'rep_ivy'))$$,
  'XR001', 'representation_not_acceptable: Only the artist accepts a pending representation.', 'the agency cannot accept for the artist');
select throws_ok($$select app.propose_representation((select id from world where key = 'acct_t'), (select id from world where key = 'ivy'), null, current_date - 1, array['Offers']::app.representation_scope[])$$,
  'XR001', 'representation_expiry: A representation needs an expiry date in the future.', 'a representation needs a future expiry');
select throws_ok($$select app.propose_representation((select id from world where key = 'acct_t'), (select id from world where key = 'ivy'), (select id from world where key = 'sam'), current_date + 9, array['Offers']::app.representation_scope[])$$,
  'XR001', null, 'the named agent must belong to the representing account');
select pg_temp.as_user('sam');
select throws_ok($$select app.propose_representation((select id from world where key = 'acct_t'), (select id from world where key = 'ivy'), null, current_date + 9, array['Offers']::app.representation_scope[])$$,
  '42501', null, 'only the agency''s Owner or Admin proposes a representation');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.representations), 1, 'the artist reads representations of themselves');
select lives_ok($$select app.accept_representation((select id from world where key = 'rep_ivy'))$$, 'the artist accepts');
select pg_temp.claims('rita');
select ok(private.represents(pg_temp.id('ivy'), 'Offers'), 'an accepted representation takes effect');
select pg_temp.as_user('ivy');
select lives_ok($$select app.revoke_representation((select id from world where key = 'rep_ivy'))$$, 'the artist revokes');
select pg_temp.claims('rita');
select ok(not private.represents(pg_temp.id('ivy'), 'Offers'), 'revocation ends it at once');
select pg_temp.as_platform();
update app.representations set expires_on = current_date - 1 where id = pg_temp.id('rep_art');
select pg_temp.claims('rita');
select ok(not private.represents(pg_temp.id('art'), 'Advance'), 'an expired representation grants nothing');
select pg_temp.as_platform();
select throws_ok($$update app.representations set expires_on = current_date + 400 where id = (select id from world where key = 'rep_art')$$,
  'XR001', null, 'a representation is never extended in place');
-- Restore rep_art for the rest of the suite.
select pg_temp.as_user('rita');
with r as (select app.propose_representation((select id from world where key = 'acct_t'), (select id from world where key = 'art'), (select id from world where key = 'rita'),
  current_date + 90, array['Advance', 'Documents']::app.representation_scope[]) as id) insert into world select 'rep_art2', id from r;
select pg_temp.as_user('art');
select app.accept_representation(pg_temp.id('rep_art2'));
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.representations), 0, 'a stranger reads no representations');
select is((select count(*)::int from app.representation_scopes), 0, 'nor their scopes');
select pg_temp.as_platform();

-- Engagement areas by relationship (Section 8.7) ------------------------------------------------------------------
-- R4 (2632) adds the roster area, open from Onboarding to Closing.
select is(pg_temp.scope_of('sam', 'eng_vendor_a'), 'documents,engagement,onboarding,roster', 'own engagement while Onboarding: no operational access yet');
select is(pg_temp.scope_of('victor', 'eng_vendor_a'), 'documents,engagement,onboarding,roster', 'account engagement: the Account Owner');
select is(pg_temp.scope_of('fiona', 'eng_vendor_a'), 'documents,engagement', 'account engagement: Account Finance');
select is(pg_temp.scope_of('rita', 'eng_art_a'), 'documents,engagement,onboarding,roster', 'representation: Advance and Documents scopes');
select is(pg_temp.scope_of('quinn', 'eng_vendor_a'), '', 'denial for another party''s engagement');
select is(pg_temp.scope_of('ivy', 'eng_quinn_b'), '', 'denial for another freelancer''s engagement in an org the person also works for');
select is(pg_temp.scope_of('rita', 'eng_ivy_a'), '', 'a representative reaches only the represented artist''s engagements');
select is(pg_temp.scope_of('dave', 'eng_ivy_a'), '', 'internal members have no external scope');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select is(pg_temp.scope_of('sam', 'eng_vendor_a'), 'documents,engagement,money,onboarding,operational,roster', 'operational access opens at Active');
select is(pg_temp.scope_of('fiona', 'eng_vendor_a'), 'documents,engagement,money', 'Finance reaches money once Active');
select pg_temp.claims('sam');
select ok(private.is_engaged_party(pg_temp.id('prj_a')), 'is_engaged_party is true for an Active engagement on the project');
select pg_temp.claims('ivy');
select ok(not private.is_engaged_party(pg_temp.id('prj_a')), 'and false while the person''s own engagement is still Onboarding');
select pg_temp.claims('quinn');
select ok(not private.is_engaged_party(pg_temp.id('prj_a')), 'and false for a stranger');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.scope_of('sam', 'eng_vendor_a'), 'documents,engagement,money', 'at Complete access narrows to money and documents');
select pg_temp.claims('sam');
select ok(not private.is_engaged_party(pg_temp.id('prj_a')), 'operational access ends at Complete');
select pg_temp.as_platform();
select pg_temp.backdate_close('eng_vendor_a', interval '17 months');
select is(pg_temp.scope_of('victor', 'eng_vendor_a'), 'documents,engagement,money', 'still open 17 months after Complete');
select pg_temp.backdate_close('eng_vendor_a', interval '19 months');
select is(pg_temp.scope_of('victor', 'eng_vendor_a'), '', 'denial after close: everything closes 18 months after Complete');
select is(pg_temp.scope_of('sam', 'eng_vendor_a'), 'money', 'except the engaged person''s own payments');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Canceled');
select is(pg_temp.scope_of('art', 'eng_art_a'), 'documents,engagement', 'a canceled engagement keeps documents for its parties');
select pg_temp.backdate_close('eng_art_a', interval '2 years');
select is(pg_temp.scope_of('art', 'eng_art_a'), '', 'and closes 18 months later');

-- Gate 33: one person, several engagements across orgs ------------------------------------------------------------
select pg_temp.claims('ivy');
select is((select count(*)::int from private.my_engagement_ids('engagement')), 2, 'ivy holds engagements in two orgs at once');
select is((select count(distinct e.org_id)::int from app.engagements e where e.id in (select private.my_engagement_ids('engagement'))), 2,
  'across two tenants');
select pg_temp.claims('mia');
select is((select array_agg(x) from private.my_engagement_ids('engagement') x), array[pg_temp.id('eng_mia_b')],
  'a member of one org reaches their external engagement with another');
select pg_temp.as_platform();

-- Engagement documents: external read and the party's signature --------------------------------------------------
select pg_temp.as_user('carol');
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement') returning id)
  insert into world select 'doc_ivy', id from d;
select app.transition_engagement_document(pg_temp.id('doc_ivy'), 'Proposed', 'Sent', 'For signature.');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.engagement_documents), 1, 'access through own engagement: the party reads the document');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.engagement_documents), 0, 'denial for another party''s engagement documents');
select throws_ok($$select app.sign_engagement_document((select id from world where key = 'doc_ivy'))$$,
  '42501', null, 'a stranger cannot sign');
select pg_temp.as_user('ivy');
select lives_ok($$select app.sign_engagement_document((select id from world where key = 'doc_ivy'), 'I agree.')$$, 'the engaged person signs (Sent to Signed)');
select throws_ok($$select app.sign_engagement_document((select id from world where key = 'doc_ivy'))$$,
  'XR001', null, 'a signed document cannot be signed again');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_engagement_document((select id from world where key = 'doc_ivy'), 'Signed', 'Executed', 'Countersigned.')$$, 'the org countersigns (Signed to Executed)');
select throws_ok($$select app.transition_engagement_document((select id from world where key = 'doc_ivy'), 'Executed', 'Proposed', 'Undo.')$$, 'XR001', 'engagement_document_transition_not_allowed: A engagement document cannot move from Executed to Proposed.', 'an executed document never returns to draft');
select throws_ok($$update app.engagement_documents set title = 'Changed' where id = (select id from world where key = 'doc_ivy')$$,
  'XR001', 'engagement_document_signed: A signed document cannot be edited; issue a new document that supersedes it.', 'an executed document is never edited');
select lives_ok($$select app.transition_engagement_document((select id from world where key = 'doc_ivy'), 'Executed', 'Superseded', 'Amended.')$$, 'Executed to Superseded');
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_art_a'), 'Rider', 'Hospitality Rider') returning id)
  insert into world select 'doc_art', id from d;
select pg_temp.as_platform();
select pg_temp.as_user('rita');
select is((select count(*)::int from app.engagement_documents where id = pg_temp.id('doc_art')), 0, 'the representative loses documents once the canceled engagement closes');
select pg_temp.as_platform();

-- Profile shares (Section 4.4.1 consent) ---------------------------------------------------------------------------
select pg_temp.as_user('ivy');
with s as (select app.share_profile((select id from world where key = 'org_a'), array['headline', 'languages'], array['Head rigger', 'English, Italian']) as id)
  insert into world select 'share_ivy', id from s;
select throws_ok($$select app.share_profile((select id from world where key = 'org_a'), array['headline'], array[]::text[])$$,
  'XR001', null, 'each shared field carries its value');
select throws_ok($$select app.share_profile((select id from world where key = 'org_a'), array['headline'], array['x'], null, (select id from world where key = 'eng_quinn_b'))$$,
  'XR001', null, 'a share can name only the sharer''s own engagement');
select is((select count(*)::int from app.profile_share_fields), 2, 'the person reads their own snapshot');
select pg_temp.as_user('dave');
select is((select field_value from app.profile_share_fields where field_key = 'headline'), 'Head rigger', 'the receiving org reads the snapshot');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.profile_shares), 0, 'another org reads nothing that was not shared with it');
select pg_temp.as_user('quinn');
select throws_ok($$select app.revoke_profile_share((select id from world where key = 'share_ivy'))$$, '42501', null, 'only the owner revokes a share');
select pg_temp.as_user('ivy');
select lives_ok($$select app.revoke_profile_share((select id from world where key = 'share_ivy'))$$, 'the owner revokes consent');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.profile_share_fields), 2, 'the org keeps the snapshot it must retain');
select ok((select revoked_at is not null from app.profile_shares where id = pg_temp.id('share_ivy')), 'and sees that consent was revoked');
select pg_temp.as_user('victor');
select lives_ok($$select app.share_profile((select id from world where key = 'org_b'), array['legal_name'], array['Bayside Audio LLC'], (select id from world where key = 'acct_v'))$$,
  'an Account Owner shares the company profile');
select pg_temp.as_user('fiona');
select throws_ok($$select app.share_profile((select id from world where key = 'org_b'), array['legal_name'], array['x'], (select id from world where key = 'acct_v'))$$,
  '42501', null, 'Account Finance cannot share the company profile');
select pg_temp.as_platform();

-- Computed names -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.engaged_person_name(pg_temp.id('eng_ivy_a')), 'Ivy Marchetti', 'internal readers see the engaged person''s name from app.people');
select pg_temp.as_user('xavier');
select is(app.engaged_person_name(pg_temp.id('eng_ivy_a')), null, 'another org reads no name');
select pg_temp.as_platform();

select * from finish();
rollback;
