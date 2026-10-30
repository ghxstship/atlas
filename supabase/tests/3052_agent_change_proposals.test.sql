-- pgTAP: hosted MCP connectors and the changes they propose (B16, 3052; Sections 10.2 and 4.7, ADR 0155 D1 and D2).
-- An Admin registers a Claude connector; Dave and Alice let it act for them. The connector's session proposes
-- changes, never writes them: a direct write is refused, a proposal waits for the person, an app session never
-- confirms one but may withdraw its own, and a grant that ends expires them. A paused org and a read-only seat refuse
-- proposals like any other write. A plain OAuth app's writes are unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(58);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
-- A session of an app: the access token Supabase Auth issues carries client_id.
create function pg_temp.as_app(p_user text, p_client text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated',
    'aal', 'aal1', 'session_id', gen_random_uuid(), 'client_id', pg_temp.id(p_client), 'scope', 'email',
    'amr', jsonb_build_array(jsonb_build_object('method', 'oauth_provider/authorization_code',
      'timestamp', extract(epoch from now() - interval '1 hour')::bigint)))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.propose(p_operation text, p_scopes text[], p_fields jsonb default '[{"field_path": "name", "value": "Encore Tour"}]')
returns uuid language sql as $$
  select p.suggestion_id from app.propose_agent_change(p_operation, p_scopes, pg_temp.id('prj'), 'Rename the tour.',
    jsonb_build_object('id', pg_temp.id('prj')), 'W/"etag-1"', p_fields) p $$;
create function pg_temp.proposed(p_person text) returns integer language sql stable as $$
  select count(*)::integer from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
  where r.person_id = pg_temp.id(p_person) and r.oauth_app_id is not null and s.suggestion_state = 'Proposed' $$;

create temporary table k (key text primary key, id uuid, txt text);
grant select, insert, update on k to public;

select pg_temp.as_user('alice');
insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWT', 'Northwind Tour', 'America/New_York');
select pg_temp.as_platform();
insert into world select 'prj', p.id from app.projects p where p.project_key = 'NWT';
-- A clean file on the project, for the share link a connector may not make.
select pg_temp.as_user('alice');
insert into k (key, id) select 'file_version', u.attachment_version_id
from app.begin_attachment_upload('app.projects', pg_temp.id('prj'), 'rider.pdf', 'application/pdf', 1200) u;
insert into storage.objects (bucket_id, name, metadata)
select 'attachments', v.object_name, '{"size": 1200}' from app.attachment_versions v where v.id = (select id from k where key = 'file_version');
select app.complete_attachment_upload((select id from k where key = 'file_version'), repeat('ab', 32));
select pg_temp.as_platform();
select app.record_attachment_scan((select id from k where key = 'file_version'), true);
insert into k (key, id) select 'file', v.attachment_id from app.attachment_versions v where v.id = (select id from k where key = 'file_version');

-- Registering a connector ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.register_mcp_connector(pg_temp.id('org_a'), 'Claude', null, 'https://claude.ai/api/mcp/auth_callback', array['projects'])$$,
  '42501', null, 'a Member cannot register a connector');
select pg_temp.as_user('bob');
select throws_ok($$select * from app.register_mcp_connector(pg_temp.id('org_a'), 'Claude', null, 'https://claude.ai/api/mcp/auth_callback', array['projects', 'org'])$$,
  'XR001', null, 'a connector never gets a Restricted group by default');
select throws_like($$select * from app.register_mcp_connector(pg_temp.id('org_a'), 'Claude', null, 'https://claude.ai/api/mcp/auth_callback', array['projects', 'org'])$$,
  'mcp_scope_restricted:%', 'with its own rule');
select throws_like($$select * from app.register_mcp_connector(pg_temp.id('org_a'), 'Other', 'Mine', 'https://mine.example.test/cb', array['nope'])$$,
  'oauth_scope_unknown:%', 'unknown groups are refused');
select throws_like($$select * from app.register_mcp_connector(pg_temp.id('org_a'), 'Other', 'Mine', 'http://mine.example.test/cb', array['projects'])$$,
  'mcp_redirect_uri_invalid:%', 'the callback is https');
insert into k (key, id) select 'connector_app', r.oauth_app_id
from app.register_mcp_connector(pg_temp.id('org_a'), 'Claude', null, 'https://claude.ai/api/mcp/auth_callback', array['projects', 'home', 'projects']) r;
select pg_temp.as_platform();
insert into world select 'connector', c.auth_client_id from private.oauth_app_clients c where c.oauth_app_id = (select id from k where key = 'connector_app');
select results_eq($$select a.name, a.redirect_uri, m.client_kind::text, m.default_scopes from app.oauth_apps a
  join app.mcp_connectors m on m.oauth_app_id = a.id where a.id = (select id from k where key = 'connector_app')$$,
  $$values ('Claude'::text, 'https://claude.ai/api/mcp/auth_callback'::text, 'Claude'::text, array['home', 'projects'])$$,
  'the connector is an OAuth app named for the assistant with its default groups, sorted and distinct');
select is((select client_type::text || ' ' || token_endpoint_auth_method from auth.oauth_clients where id = pg_temp.id('connector')),
  'public none', 'mirrored into Supabase Auth as a public PKCE client');
select ok(not has_table_privilege('authenticated', 'app.mcp_connectors', 'insert'), 'connectors are written only through the RPC');

select pg_temp.as_user('bob');
insert into app.oauth_apps (org_id, name, redirect_uri) values (pg_temp.id('org_a'), 'Ledger Sync', 'https://ledger.example.test/callback');
select pg_temp.as_platform();
insert into world select 'plain_app', a.id from app.oauth_apps a where a.name = 'Ledger Sync';
insert into world select 'plain', c.auth_client_id from private.oauth_app_clients c where c.oauth_app_id = pg_temp.id('plain_app');
insert into k (key, txt) select 'connector_text', a.client_id from app.oauth_apps a where a.id = (select id from k where key = 'connector_app');
insert into k (key, txt) select 'plain_text', a.client_id from app.oauth_apps a where a.id = pg_temp.id('plain_app');

select pg_temp.as_user('dave');
select is(app.oauth_default_scopes(pg_temp.id('connector')), array['home', 'projects'], 'a member reads the connector''s default groups');
select is(app.oauth_default_scopes(pg_temp.id('plain')), null, 'a plain app has none');
select pg_temp.as_user('xavier');
select is(app.oauth_default_scopes(pg_temp.id('connector')), null, 'and a non-member reads none');

-- Consent --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('dave');
select app.grant_oauth_consent((select txt from k where key = 'connector_text'), array['projects', 'home', 'data']);
select pg_temp.as_user('alice');
select app.grant_oauth_consent((select txt from k where key = 'connector_text'), array['projects']);
select app.grant_oauth_consent((select txt from k where key = 'plain_text'), array['projects']);

-- Proposing ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_like($$select pg_temp.propose('projects.update', array['projects'])$$, 'agent_session_required:%',
  'the person''s own session does not propose; it confirms');
select pg_temp.as_app('dave', 'connector');
insert into k (key, id) values ('first', pg_temp.propose('projects.update', array['projects'],
  '[{"field_path": "name", "value": "Encore Tour"}, {"field_path": "description", "value": null}]'));
select pg_temp.as_platform();
select results_eq($$select r.feature::text, r.model, r.outcome::text, r.oauth_app_id, s.operation_id, s.target_id, s.operation_request
  from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id where s.id = (select id from k where key = 'first')$$,
  $$values ('assistant'::text, 'external-agent'::text, 'Answered'::text, (select id from k where key = 'connector_app'), 'projects.update'::text,
            pg_temp.id('prj'), jsonb_build_object('path', jsonb_build_object('id', pg_temp.id('prj')), 'if_match', 'W/"etag-1"'))$$,
  'a proposal stores an answered request of the app, the operation, its path and If-Match');
select is((select count(*)::integer from app.ai_usage u join app.ai_suggestions s on s.request_id = u.request_id where s.id = (select id from k where key = 'first')),
  0, 'and is never metered');
select ok((select s.expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
           from app.ai_suggestions s where s.id = (select id from k where key = 'first')), 'it expires in 7 days');
select results_eq($$select field_path, proposed_value, confidence from app.ai_suggestion_fields where suggestion_id = (select id from k where key = 'first') order by position$$,
  $$values ('name'::text, '"Encore Tour"'::jsonb, null::numeric), ('description'::text, 'null'::jsonb, null::numeric)$$,
  'fields carry no confidence, and a JSON null is a value that clears the field');
select is((select name from app.projects where id = pg_temp.id('prj')), 'Northwind Tour', 'nothing in the target changes');
select is((select count(*)::integer from app.notifications where recipient_person_id = pg_temp.id('dave') and kind = 'agent.change_proposed'), 1,
  'the person hears agent.change_proposed');
select is((select message_args ->> 'app' || ' ' || (message_args ->> 'operation') from app.notifications
           where recipient_person_id = pg_temp.id('dave') and kind = 'agent.change_proposed'), 'Claude projects.update',
  'naming the app and the operation, never the summary');
select pg_temp.as_app('dave', 'connector');
insert into k (key, id) values ('second', pg_temp.propose('projects.update', array['projects']));
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where recipient_person_id = pg_temp.id('dave') and kind = 'agent.change_proposed'), 1,
  'one unread notice per person and app is enough');

select pg_temp.as_app('dave', 'connector');
select throws_like($$select pg_temp.propose('purchaseOrders.create', array['finance'])$$, 'agent_outside_grant:%',
  'an operation outside the grant is refused');
select throws_like($$select pg_temp.propose('aiSuggestions.transition', array['projects'])$$, 'agent_operation_not_allowed:%',
  'Aurora''s own operations are refused');
select throws_like($$select pg_temp.propose('auroraConversations.create', array['projects'])$$, 'agent_operation_not_allowed:%',
  'every ai or aurora operation, as the API''s proposable list');
select throws_like($$select pg_temp.propose('people.update', array['data'])$$, 'agent_operation_restricted:%',
  'a change that reaches Restricted data is refused even inside the grant');
select throws_like($$select pg_temp.propose('projects.update', array['projects'], '[{"field_path": "Bad Path", "value": 1}]')$$, '%ai_suggestion_fields_path_format%',
  'field paths follow the suggestion path format');

-- A connector's direct writes are refused; a plain app's are not -----------------------------------------------------------------
select pg_temp.as_app('alice', 'connector');
select throws_like($$insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'AGT', 'Agent Tour', 'UTC')$$,
  'agent_write_needs_review:%', 'a connector session''s direct write (PostgREST or the API) is refused');
select throws_like($$insert into app.share_links (attachment_id, expires_at) values ((select id from k where key = 'file'), now() + interval '1 day')$$,
  'agent_write_needs_review:%', 'and so is making a share link');
select pg_temp.as_app('alice', 'plain');
select lives_ok($$insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'PLN', 'Plain Tour', 'UTC')$$,
  'a plain OAuth app''s write within its grant is unchanged');

-- Confirming needs the person ---------------------------------------------------------------------------------------------
select pg_temp.as_app('dave', 'connector');
select throws_like($$select app.transition_ai_suggestion((select id from k where key = 'first'), 'Proposed', 'Confirmed', 'Looks right.')$$,
  'ai_suggestion_needs_person:%', 'the app cannot confirm its own proposal');
select throws_like($$select * from app.agent_proposal_for_apply((select id from k where key = 'first'))$$,
  'ai_suggestion_needs_person:%', 'nor read it for applying');
select lives_ok($$select app.transition_ai_suggestion((select id from k where key = 'second'), 'Proposed', 'Rejected', 'Withdrawn by the assistant.')$$,
  'but may withdraw it');
select pg_temp.as_platform();
select is((select suggestion_state::text from app.ai_suggestions where id = (select id from k where key = 'second')), 'Rejected', 'which rejects it');
select ok(not exists (select 1 from private.trusted_operations where operation = 'agent_proposal'), 'and leaves no trusted operation open');

select pg_temp.as_user('dave');
select results_eq($$select operation_id, target_id, grant_scopes from app.agent_proposal_for_apply((select id from k where key = 'first'))$$,
  $$values ('projects.update'::text, pg_temp.id('prj'), array['data', 'home', 'projects'])$$,
  'the person''s own session reads what to apply, with the live grant''s groups');
select throws_like($$select * from app.agent_proposal_for_apply((select id from k where key = 'second'))$$, 'ai_suggestion_not_proposed:%',
  'a withdrawn proposal cannot be applied');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.agent_proposal_for_apply((select id from k where key = 'first'))$$, '42501', null, 'nor anyone else''s');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.my_agent_proposals(pg_temp.id('org_a'))), 1, 'Connected apps lists what waits for the person');
select is((select app_name || ' ' || jsonb_array_length(fields) from app.my_agent_proposals(pg_temp.id('org_a'))), 'Claude 2', 'with the app and the fields');
select lives_ok($$select app.transition_ai_suggestion((select id from k where key = 'first'), 'Proposed', 'Confirmed', 'Confirmed in Atlas.')$$,
  'the person confirms it');
select lives_ok($$select app.transition_ai_suggestion((select id from k where key = 'first'), 'Confirmed', 'Applied', 'Applied.', pg_temp.id('prj'))$$,
  'and marks it applied with the record');
select pg_temp.as_platform();
select is((select suggestion_state::text || ' ' || (applied_id = pg_temp.id('prj'))::text from app.ai_suggestions where id = (select id from k where key = 'first')),
  'Applied true', 'the suggestion is Applied with the record id');
select lives_ok($$insert into app.ai_suggestion_fields (suggestion_id, field_path, proposed_value, position) values ((select id from k where key = 'second'), 'notes', '"x"', 9)$$,
  'a value without a confidence is allowed');
select throws_like($$insert into app.ai_suggestion_fields (suggestion_id, field_path, refusal, position) values ((select id from k where key = 'second'), 'notes2', 'NO_ANSWER', 10)$$,
  '%ai_suggestion_fields_value_or_refusal%', 'NO_ANSWER still names what is missing');

-- The limit of 100 ---------------------------------------------------------------------------------------------------------
select pg_temp.as_app('dave', 'connector');
select count(*) from (select pg_temp.propose('projects.update', array['projects']) from generate_series(1, 100)) proposals;
select pg_temp.as_platform();
select is(pg_temp.proposed('dave'), 100, '100 proposals wait');
select pg_temp.as_app('dave', 'connector');
select throws_like($$select pg_temp.propose('projects.update', array['projects'])$$, 'agent_proposals_limit:%', 'a 101st is refused');

-- A re-consent keeps them; a revoked grant expires them -------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('dave');
select app.grant_oauth_consent((select txt from k where key = 'connector_text'), array['projects', 'home', 'data']);
select pg_temp.as_platform();
select is(pg_temp.proposed('dave'), 100, 'consenting again keeps the proposals waiting');
update app.oauth_grants set deleted_at = now()
where oauth_app_id = (select id from k where key = 'connector_app') and person_id = pg_temp.id('dave') and deleted_at is null;
select is(pg_temp.proposed('dave'), 0, 'revoking the grant expires the person''s proposals at once');
select is((select count(*)::integer from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
           where r.person_id = pg_temp.id('dave') and s.suggestion_state = 'Expired'), 100, 'as Expired');
select pg_temp.as_app('dave', 'connector');
select throws_like($$select pg_temp.propose('projects.update', array['projects'])$$, 'agent_session_required:%',
  'and the app can propose nothing more');

-- A read-only seat and a paused org refuse proposals ------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.over_limit_objects (org_id, limit_code, plan_code, membership_id)
values (pg_temp.id('org_a'), 'seats', 'team', pg_temp.id('alice@org_a'));
select pg_temp.as_app('alice', 'connector');
select throws_like($$select pg_temp.propose('projects.update', array['projects'])$$, 'plan_limit_read_only:%',
  'a person whose seat is read-only (A107) cannot propose');
select pg_temp.as_platform();
delete from app.over_limit_objects where membership_id = pg_temp.id('alice@org_a');
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'team', 'Monthly', 'active', now() + interval '20 days', false,
  0, false, null, now() - interval '1 minute');
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'team', 'Monthly', 'paused', now() + interval '20 days', false,
  0, false, null, now());
select pg_temp.as_app('alice', 'connector');
select throws_like($$select pg_temp.propose('projects.update', array['projects'])$$, 'org_read_only: This organization is paused%',
  'nor can anyone in a paused org');
select pg_temp.as_platform();
update app.subscription_pauses set ended_at = now(), end_reason = 'Resumed in Stripe' where org_id = pg_temp.id('org_a') and ended_at is null;

-- Removing the app ends everything ------------------------------------------------------------------------------------
select pg_temp.as_app('alice', 'connector');
insert into k (key, id) values ('alice', pg_temp.propose('projects.update', array['projects']));
select pg_temp.as_user('bob');
update app.oauth_apps set deleted_at = now() where id = (select id from k where key = 'connector_app');
select pg_temp.as_platform();
select is((select suggestion_state::text from app.ai_suggestions where id = (select id from k where key = 'alice')), 'Expired',
  'removing the app expires its pending proposals');
select ok((select deleted_at is not null from app.mcp_connectors where oauth_app_id = (select id from k where key = 'connector_app')),
  'and removes the connector');
select is((select count(*)::integer from app.oauth_grants where oauth_app_id = (select id from k where key = 'connector_app') and deleted_at is null), 0,
  'and its grants');
select pg_temp.as_user('dave');
select is(app.oauth_default_scopes(pg_temp.id('connector')), null, 'a removed connector has no default groups');
select pg_temp.as_platform();

-- The guards, Trash and the console ------------------------------------------------------------------------------------------
select ok(exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'app.ai_requests'::regclass and t.tgname = 't30_refuse_cross_org_reference'),
  'the app on a request must belong to the request''s org');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'mcp_connectors'), 'connectors are kept out of Trash');
select ok(exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'app.ai_suggestions'::regclass and t.tgname = 't14_agent_needs_person')
  and exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'app.oauth_grants'::regclass and t.tgname = 't91_expire_agent_proposals'),
  'the person rule and the grant rule are triggers');

select * from finish();
rollback;
