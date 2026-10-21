-- pgTAP: personal keyboard shortcut bindings (A81, RRR-126, Section 11.7). A person rebinds their own shortcuts, in
-- every org at once; nobody else reads or writes them; one live binding per shell and shortcut; reset returns the
-- default; a binding never moves to another shortcut; ids and keys keep the registry's shape.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(23);

select has_table('app', 'shortcut_bindings', 'app.shortcut_bindings exists');
select is((select relrowsecurity from pg_class where oid = 'app.shortcut_bindings'::regclass), true,
  'row level security is on');
select is((select obj_description('app.shortcut_bindings'::regclass, 'pg_class') is not null), true,
  'the table carries a comment');
select is(
  (select count(*)::int from pg_attribute a where a.attrelid = 'app.shortcut_bindings'::regclass and a.attnum > 0
     and not a.attisdropped and col_description(a.attrelid, a.attnum) is null),
  0, 'every column carries a comment');
select is((select count(*)::int from private.retention_policies where table_name = 'app.shortcut_bindings'), 1,
  'reset bindings have a retention policy');

-- dave, a member of Northwind Live, binds Go to Safety and moves Go to Home.
select pg_temp.as_user('dave');
select isnt(app.set_shortcut_binding('Atlas', 'go.safety', 'G Z'), null, 'a person binds a shortcut with no default');
select lives_ok($$select app.set_shortcut_binding('Atlas', 'go.home', 'G Q')$$, 'and moves another to new keys');
select lives_ok($$select app.set_shortcut_binding('Atlas', 'go.home', 'Shift+H')$$, 'binding it again replaces his binding');
select is((select count(*)::int from app.shortcut_bindings where shortcut_id = 'go.home' and deleted_at is null), 1,
  'one live binding per shell and shortcut');
select is((select keys from app.shortcut_bindings where shortcut_id = 'go.home' and deleted_at is null), 'Shift+H',
  'holding the latest keys');
select lives_ok($$select app.set_shortcut_binding('Atlas', 'search', null)$$, 'NULL keys turn a shortcut off');
select is((select keys from app.shortcut_bindings where shortcut_id = 'search' and deleted_at is null), null,
  'and are kept as NULL');
select lives_ok($$select app.set_shortcut_binding('Gateway', 'help', 'Shift+F1')$$, 'Gateway bindings are separate');

-- The shape checks: the registry decides the rest in the app.
select throws_ok($$select app.set_shortcut_binding('Atlas', 'Go Home', 'G H')$$, '23514', null,
  'a shortcut id outside the registry shape is refused');
select throws_ok($$select app.set_shortcut_binding('Atlas', 'go.places', 'G H J')$$, '23514', null,
  'keys of more than two steps are refused');
select throws_ok($$update app.shortcut_bindings set shortcut_id = 'go.assets' where shortcut_id = 'go.safety'$$,
  'XR001', 'shortcut_binding_immutable: A binding keeps its shortcut; reset it and bind the other shortcut.',
  'a binding never moves to another shortcut');

-- Nobody else sees them, and nobody writes a binding for someone else.
select pg_temp.as_user('alice');
select is((select count(*)::int from app.shortcut_bindings), 0, 'the owner of his org reads none of his bindings');
select lives_ok(format($$insert into app.shortcut_bindings (person_id, shell, shortcut_id, keys)
  values (%L, 'Atlas', 'go.home', 'G X')$$, pg_temp.id('dave')), 'a binding written for someone else');
select is((select person_id from app.shortcut_bindings where keys = 'G X'), pg_temp.id('alice'),
  'becomes the writer''s own: nobody writes another person''s binding');
select pg_temp.as_user('nina');
select lives_ok($$select app.set_shortcut_binding('Atlas', 'go.home', 'G Q')$$,
  'a person with no org keeps bindings too, which follow them into any org');

-- Reset one, then every one.
select pg_temp.as_user('dave');
select is(app.reset_shortcut_bindings('Atlas', 'go.home'), 1, 'resetting one shortcut returns it to the default');
select is(app.reset_shortcut_bindings('Atlas'), 2, 'resetting the shell resets the rest of his Atlas bindings');
select is((select count(*)::int from app.shortcut_bindings where deleted_at is null), 1,
  'his Gateway binding stays');

select * from finish();
rollback;
