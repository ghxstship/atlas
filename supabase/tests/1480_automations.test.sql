-- pgTAP: automations (A91, RRR-136, finding A65-010, ADR 0047). The evaluator and validators against the vectors shared
-- with packages/schemas (packages/schemas/src/automations/vectors.json, embedded below; the schemas tests fail when the
-- copies differ), then writing automations with their conditions and actions: who may, plan gating, ownership, row level
-- security, the fit of actions to the trigger, the dry run and deleting.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(38);

create temporary table vectors (doc jsonb not null);
grant select on vectors to public;
insert into vectors values ($vectors$
{
  "$comment": "Shared vectors of the automation evaluator and validators (ADR 0047). packages/schemas runs them through evaluate.ts and the Zod schema; supabase/tests/1480_automations.test.sql embeds the same JSON and runs them through private.automation_conditions_match and the refusal functions. The schemas tests fail when the two copies differ.",
  "event": {"id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "type": "record.created", "occurred_at": "2026-10-21T12:00:00+00:00", "project_id": "0192f1e2-7c3a-7b4d-9e8f-000000000001", "subject": {"table": "records", "id": "0192f1e2-7c3a-7b4d-9e8f-000000000002"}, "data": {"record_kind": "Task", "record_subtype": null, "record_number": 42, "record_state": "Proposed", "title": "Install Main Stage Truss", "amount": 10.5, "delta": -3, "flag": true, "code": "10", "tags": ["Vendor", "Crew"], "nested": {"x": {"y": "deep"}}, "list": [{"name": "first"}], "accented": "é", "upper_accented": "ÉCOLE", "emoji": "😀"}},
  "matches": [
    {"name": "an empty all holds", "conditions": {"all": []}, "expected": true},
    {"name": "an empty any holds", "conditions": {"any": []}, "expected": true},
    {"name": "eq compares strings exactly", "conditions": {"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}]}, "expected": true},
    {"name": "eq on strings is case-sensitive", "conditions": {"all": [{"field": "data.record_kind", "operator": "eq", "value": "task"}]}, "expected": false},
    {"name": "ne holds for a different string", "conditions": {"all": [{"field": "data.record_kind", "operator": "ne", "value": "Build"}]}, "expected": true},
    {"name": "ne is false on a missing field", "conditions": {"all": [{"field": "data.missing", "operator": "ne", "value": "Build"}]}, "expected": false},
    {"name": "eq is false on a missing field", "conditions": {"all": [{"field": "data.missing", "operator": "eq", "value": "Build"}]}, "expected": false},
    {"name": "eq is false on JSON null", "conditions": {"all": [{"field": "data.record_subtype", "operator": "eq", "value": "Build"}]}, "expected": false},
    {"name": "eq compares numbers numerically", "conditions": {"all": [{"field": "data.record_number", "operator": "eq", "value": "42"}]}, "expected": true},
    {"name": "eq ignores trailing zeros of a decimal", "conditions": {"all": [{"field": "data.amount", "operator": "eq", "value": "10.50"}]}, "expected": true},
    {"name": "eq of a number with non-numeric text is false", "conditions": {"all": [{"field": "data.record_number", "operator": "eq", "value": "forty-two"}]}, "expected": false},
    {"name": "eq of a number with an exponent is false", "conditions": {"all": [{"field": "data.record_number", "operator": "eq", "value": "4.2e1"}]}, "expected": false},
    {"name": "eq compares booleans with true", "conditions": {"all": [{"field": "data.flag", "operator": "eq", "value": "true"}]}, "expected": true},
    {"name": "eq compares booleans with false", "conditions": {"all": [{"field": "data.flag", "operator": "eq", "value": "false"}]}, "expected": false},
    {"name": "eq on booleans needs lower case", "conditions": {"all": [{"field": "data.flag", "operator": "eq", "value": "TRUE"}]}, "expected": false},
    {"name": "eq on an object is false", "conditions": {"all": [{"field": "data.nested", "operator": "eq", "value": "x"}]}, "expected": false},
    {"name": "ne on an object is true", "conditions": {"all": [{"field": "data.nested", "operator": "ne", "value": "x"}]}, "expected": true},
    {"name": "eq on an array is false", "conditions": {"all": [{"field": "data.tags", "operator": "eq", "value": "Crew"}]}, "expected": false},
    {"name": "lt compares numbers", "conditions": {"all": [{"field": "data.record_number", "operator": "lt", "value": "100"}]}, "expected": true},
    {"name": "gt compares numbers", "conditions": {"all": [{"field": "data.record_number", "operator": "gt", "value": "100"}]}, "expected": false},
    {"name": "gte holds at the boundary", "conditions": {"all": [{"field": "data.record_number", "operator": "gte", "value": "42"}]}, "expected": true},
    {"name": "lte below the value is false", "conditions": {"all": [{"field": "data.record_number", "operator": "lte", "value": "41"}]}, "expected": false},
    {"name": "negative numbers compare", "conditions": {"all": [{"field": "data.delta", "operator": "lt", "value": "-2"}]}, "expected": true},
    {"name": "eq on a negative number", "conditions": {"all": [{"field": "data.delta", "operator": "eq", "value": "-3"}]}, "expected": true},
    {"name": "lt on a number with non-numeric text is false", "conditions": {"all": [{"field": "data.record_number", "operator": "lt", "value": "many"}]}, "expected": false},
    {"name": "lt on a boolean is false", "conditions": {"all": [{"field": "data.flag", "operator": "lt", "value": "z"}]}, "expected": false},
    {"name": "lt on a missing field is false", "conditions": {"all": [{"field": "data.missing", "operator": "lt", "value": "z"}]}, "expected": false},
    {"name": "lt compares strings by code point", "conditions": {"all": [{"field": "data.record_state", "operator": "lt", "value": "Ready"}]}, "expected": true},
    {"name": "upper case sorts before lower case", "conditions": {"all": [{"field": "data.record_state", "operator": "gt", "value": "proposed"}]}, "expected": false},
    {"name": "numeric-looking strings compare as text", "conditions": {"all": [{"field": "data.code", "operator": "lt", "value": "9"}]}, "expected": true},
    {"name": "a dated string compares as text", "conditions": {"all": [{"field": "occurred_at", "operator": "gte", "value": "2026-10-01"}]}, "expected": true},
    {"name": "non-ASCII sorts by code point", "conditions": {"all": [{"field": "data.accented", "operator": "gt", "value": "z"}]}, "expected": true},
    {"name": "astral characters sort by code point, not UTF-16 unit", "conditions": {"all": [{"field": "data.emoji", "operator": "gt", "value": "�"}]}, "expected": true},
    {"name": "in matches one of the values", "conditions": {"all": [{"field": "data.record_kind", "operator": "in", "value": "Build, Task"}]}, "expected": true},
    {"name": "in skips empty values", "conditions": {"all": [{"field": "data.record_kind", "operator": "in", "value": "Build,,Strike"}]}, "expected": false},
    {"name": "in compares numbers numerically", "conditions": {"all": [{"field": "data.record_number", "operator": "in", "value": "1, 42"}]}, "expected": true},
    {"name": "in compares booleans", "conditions": {"all": [{"field": "data.flag", "operator": "in", "value": "false,true"}]}, "expected": true},
    {"name": "contains finds text with ASCII case folded", "conditions": {"all": [{"field": "data.title", "operator": "contains", "value": "main STAGE"}]}, "expected": true},
    {"name": "contains does not fold non-ASCII letters", "conditions": {"all": [{"field": "data.upper_accented", "operator": "contains", "value": "école"}]}, "expected": false},
    {"name": "contains finds an array element", "conditions": {"all": [{"field": "data.tags", "operator": "contains", "value": "Crew"}]}, "expected": true},
    {"name": "contains on an array compares elements exactly", "conditions": {"all": [{"field": "data.tags", "operator": "contains", "value": "crew"}]}, "expected": false},
    {"name": "contains on a number is false", "conditions": {"all": [{"field": "data.record_number", "operator": "contains", "value": "4"}]}, "expected": false},
    {"name": "is_null without a value holds for JSON null", "conditions": {"all": [{"field": "data.record_subtype", "operator": "is_null"}]}, "expected": true},
    {"name": "is_null true holds for a missing field", "conditions": {"all": [{"field": "data.missing", "operator": "is_null", "value": "true"}]}, "expected": true},
    {"name": "is_null false holds for a present field", "conditions": {"all": [{"field": "data.record_kind", "operator": "is_null", "value": "false"}]}, "expected": true},
    {"name": "is_null is false for a present field", "conditions": {"all": [{"field": "data.record_kind", "operator": "is_null"}]}, "expected": false},
    {"name": "is_null false is false for JSON null", "conditions": {"all": [{"field": "data.record_subtype", "operator": "is_null", "value": "false"}]}, "expected": false},
    {"name": "paths read nested objects", "conditions": {"all": [{"field": "data.nested.x.y", "operator": "eq", "value": "deep"}]}, "expected": true},
    {"name": "digit segments index arrays", "conditions": {"all": [{"field": "data.list.0.name", "operator": "eq", "value": "first"}]}, "expected": true},
    {"name": "digit segments index arrays of strings", "conditions": {"all": [{"field": "data.tags.1", "operator": "eq", "value": "Crew"}]}, "expected": true},
    {"name": "an index past the end is missing", "conditions": {"all": [{"field": "data.tags.5", "operator": "is_null"}]}, "expected": true},
    {"name": "a path through a string is missing", "conditions": {"all": [{"field": "data.title.x", "operator": "is_null"}]}, "expected": true},
    {"name": "subject.table names the subject", "conditions": {"all": [{"field": "subject.table", "operator": "eq", "value": "records"}]}, "expected": true},
    {"name": "type names the event", "conditions": {"all": [{"field": "type", "operator": "eq", "value": "record.created"}]}, "expected": true},
    {"name": "all fails when one condition fails", "conditions": {"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}, {"field": "data.flag", "operator": "eq", "value": "false"}]}, "expected": false},
    {"name": "any holds when one condition holds", "conditions": {"any": [{"field": "data.record_kind", "operator": "eq", "value": "Build"}, {"field": "data.flag", "operator": "eq", "value": "true"}]}, "expected": true},
    {"name": "any fails when every condition fails", "conditions": {"any": [{"field": "data.record_kind", "operator": "eq", "value": "Build"}, {"field": "data.flag", "operator": "eq", "value": "false"}]}, "expected": false},
    {"name": "a nested any inside all", "conditions": {"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}, {"any": [{"field": "data.record_state", "operator": "eq", "value": "Ready"}, {"field": "data.record_state", "operator": "eq", "value": "Proposed"}]}]}, "expected": true},
    {"name": "a nested all inside any", "conditions": {"any": [{"field": "data.record_kind", "operator": "eq", "value": "Build"}, {"all": [{"field": "data.record_number", "operator": "gt", "value": "40"}, {"field": "data.flag", "operator": "eq", "value": "true"}]}]}, "expected": true},
    {"name": "a failing nested group fails all", "conditions": {"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}, {"any": [{"field": "data.record_state", "operator": "eq", "value": "Ready"}, {"field": "data.record_state", "operator": "eq", "value": "Active"}]}]}, "expected": false}
  ],
  "valid": [
    {"name": "empty all", "conditions": {"all": []}},
    {"name": "empty any", "conditions": {"any": []}},
    {"name": "each operator", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "1"}, {"field": "data.x", "operator": "ne", "value": "1"}, {"field": "data.x", "operator": "lt", "value": "1"}, {"field": "data.x", "operator": "lte", "value": "1"}, {"field": "data.x", "operator": "gt", "value": "1"}, {"field": "data.x", "operator": "gte", "value": "1"}, {"field": "data.x", "operator": "in", "value": "1"}, {"field": "data.x", "operator": "contains", "value": "1"}, {"field": "data.x", "operator": "is_null"}]}},
    {"name": "is_null with false", "conditions": {"all": [{"field": "data.x", "operator": "is_null", "value": "false"}]}},
    {"name": "value null with is_null", "conditions": {"all": [{"field": "data.x", "operator": "is_null", "value": null}]}},
    {"name": "an empty eq value", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": ""}]}},
    {"name": "a group one level deep", "conditions": {"all": [{"field": "type", "operator": "eq", "value": "record.created"}, {"any": [{"field": "data.a", "operator": "eq", "value": "1"}, {"field": "data.b", "operator": "eq", "value": "2"}]}]}},
    {"name": "eight path segments", "conditions": {"all": [{"field": "a.b.c.d.e.f.g.h", "operator": "eq", "value": "1"}]}},
    {"name": "twenty conditions and groups", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "0"}, {"field": "data.x", "operator": "eq", "value": "1"}, {"field": "data.x", "operator": "eq", "value": "2"}, {"field": "data.x", "operator": "eq", "value": "3"}, {"field": "data.x", "operator": "eq", "value": "4"}, {"field": "data.x", "operator": "eq", "value": "5"}, {"field": "data.x", "operator": "eq", "value": "6"}, {"field": "data.x", "operator": "eq", "value": "7"}, {"field": "data.x", "operator": "eq", "value": "8"}, {"field": "data.x", "operator": "eq", "value": "9"}, {"field": "data.x", "operator": "eq", "value": "10"}, {"field": "data.x", "operator": "eq", "value": "11"}, {"field": "data.x", "operator": "eq", "value": "12"}, {"field": "data.x", "operator": "eq", "value": "13"}, {"field": "data.x", "operator": "eq", "value": "14"}, {"field": "data.x", "operator": "eq", "value": "15"}, {"field": "data.x", "operator": "eq", "value": "16"}, {"field": "data.x", "operator": "eq", "value": "17"}, {"any": [{"field": "data.y", "operator": "eq", "value": "1"}]}]}},
    {"name": "a 1000-character value", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}
  ],
  "invalid": [
    {"name": "not an object", "conditions": [{"field": "data.x", "operator": "eq", "value": "1"}]},
    {"name": "both all and any", "conditions": {"all": [], "any": []}},
    {"name": "neither all nor any", "conditions": {"match": "all"}},
    {"name": "all is not a list", "conditions": {"all": {}}},
    {"name": "a condition with an extra key", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "1", "note": "x"}]}},
    {"name": "a field with upper case", "conditions": {"all": [{"field": "Data.x", "operator": "eq", "value": "1"}]}},
    {"name": "a field starting with a digit", "conditions": {"all": [{"field": "1data", "operator": "eq", "value": "1"}]}},
    {"name": "a field with nine segments", "conditions": {"all": [{"field": "a.b.c.d.e.f.g.h.i", "operator": "eq", "value": "1"}]}},
    {"name": "a field with an empty segment", "conditions": {"all": [{"field": "data..x", "operator": "eq", "value": "1"}]}},
    {"name": "an unknown operator", "conditions": {"all": [{"field": "data.x", "operator": "like", "value": "1"}]}},
    {"name": "a numeric value", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": 5}]}},
    {"name": "eq without a value", "conditions": {"all": [{"field": "data.x", "operator": "eq"}]}},
    {"name": "eq with a null value", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": null}]}},
    {"name": "is_null with yes", "conditions": {"all": [{"field": "data.x", "operator": "is_null", "value": "yes"}]}},
    {"name": "in with no values", "conditions": {"all": [{"field": "data.x", "operator": "in", "value": " , "}]}},
    {"name": "a 1001-character value", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}},
    {"name": "an empty group", "conditions": {"all": [{"any": []}]}},
    {"name": "a group two levels deep", "conditions": {"all": [{"any": [{"all": [{"field": "data.x", "operator": "eq", "value": "1"}]}]}]}},
    {"name": "a group with an extra key", "conditions": {"all": [{"any": [{"field": "data.x", "operator": "eq", "value": "1"}], "all": []}]}},
    {"name": "twenty-one conditions and groups", "conditions": {"all": [{"field": "data.x", "operator": "eq", "value": "0"}, {"field": "data.x", "operator": "eq", "value": "1"}, {"field": "data.x", "operator": "eq", "value": "2"}, {"field": "data.x", "operator": "eq", "value": "3"}, {"field": "data.x", "operator": "eq", "value": "4"}, {"field": "data.x", "operator": "eq", "value": "5"}, {"field": "data.x", "operator": "eq", "value": "6"}, {"field": "data.x", "operator": "eq", "value": "7"}, {"field": "data.x", "operator": "eq", "value": "8"}, {"field": "data.x", "operator": "eq", "value": "9"}, {"field": "data.x", "operator": "eq", "value": "10"}, {"field": "data.x", "operator": "eq", "value": "11"}, {"field": "data.x", "operator": "eq", "value": "12"}, {"field": "data.x", "operator": "eq", "value": "13"}, {"field": "data.x", "operator": "eq", "value": "14"}, {"field": "data.x", "operator": "eq", "value": "15"}, {"field": "data.x", "operator": "eq", "value": "16"}, {"field": "data.x", "operator": "eq", "value": "17"}, {"field": "data.x", "operator": "eq", "value": "18"}, {"any": [{"field": "data.y", "operator": "eq", "value": "1"}]}]}},
    {"name": "a field that is not text", "conditions": {"all": [{"field": 7, "operator": "eq", "value": "1"}]}}
  ],
  "validActions": [
    {"name": "create_task", "actions": [{"type": "create_task", "title": "Call the venue about {{data.title}}", "phase_code": "SCP", "xyz": "Y"}]},
    {"name": "create_task with every field", "actions": [{"type": "create_task", "title": "Call the venue", "project_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "phase_code": "SCP", "xyz": "X", "due_in_days": 0}]},
    {"name": "create_task with null project and due", "actions": [{"type": "create_task", "title": "Call the venue", "project_id": null, "phase_code": "SCP", "xyz": "Z", "due_in_days": null}]},
    {"name": "update_status", "actions": [{"type": "update_status", "to_state": "Complete"}]},
    {"name": "update_status to Blocked with a note", "actions": [{"type": "update_status", "to_state": "Blocked", "note": "Waiting on the rigging plot"}]},
    {"name": "assign", "actions": [{"type": "assign", "assignee_person_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"}]},
    {"name": "add_comment", "actions": [{"type": "add_comment", "body": "Thanks, {{data.title}} is on the list."}]},
    {"name": "notify with a body", "actions": [{"type": "notify", "recipient_person_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "title": "New task", "body": "{{data.title}}"}]},
    {"name": "notify without a body", "actions": [{"type": "notify", "recipient_person_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "title": "New task"}]},
    {"name": "call_webhook", "actions": [{"type": "call_webhook", "webhook_endpoint_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"}]},
    {"name": "ten actions", "actions": [{"type": "add_comment", "body": "0"}, {"type": "add_comment", "body": "1"}, {"type": "add_comment", "body": "2"}, {"type": "add_comment", "body": "3"}, {"type": "add_comment", "body": "4"}, {"type": "add_comment", "body": "5"}, {"type": "add_comment", "body": "6"}, {"type": "add_comment", "body": "7"}, {"type": "add_comment", "body": "8"}, {"type": "add_comment", "body": "9"}]}
  ],
  "invalidActions": [
    {"name": "no actions", "actions": []},
    {"name": "eleven actions", "actions": [{"type": "add_comment", "body": "0"}, {"type": "add_comment", "body": "1"}, {"type": "add_comment", "body": "2"}, {"type": "add_comment", "body": "3"}, {"type": "add_comment", "body": "4"}, {"type": "add_comment", "body": "5"}, {"type": "add_comment", "body": "6"}, {"type": "add_comment", "body": "7"}, {"type": "add_comment", "body": "8"}, {"type": "add_comment", "body": "9"}, {"type": "add_comment", "body": "10"}]},
    {"name": "not a list", "actions": {"type": "add_comment", "body": "x"}},
    {"name": "an unknown type", "actions": [{"type": "send_email", "body": "x"}]},
    {"name": "an extra key", "actions": [{"type": "add_comment", "body": "x", "title": "y"}]},
    {"name": "create_task without a phase", "actions": [{"type": "create_task", "title": "Call the venue", "xyz": "Y"}]},
    {"name": "create_task with a bad phase", "actions": [{"type": "create_task", "title": "Call the venue", "phase_code": "scp", "xyz": "Y"}]},
    {"name": "create_task with xyz W", "actions": [{"type": "create_task", "title": "Call the venue", "phase_code": "SCP", "xyz": "W"}]},
    {"name": "create_task due in 366 days", "actions": [{"type": "create_task", "title": "Call the venue", "phase_code": "SCP", "xyz": "Y", "due_in_days": 366}]},
    {"name": "create_task due in a fraction of a day", "actions": [{"type": "create_task", "title": "Call the venue", "phase_code": "SCP", "xyz": "Y", "due_in_days": 1.5}]},
    {"name": "create_task due in negative days", "actions": [{"type": "create_task", "title": "Call the venue", "phase_code": "SCP", "xyz": "Y", "due_in_days": -1}]},
    {"name": "create_task without a title", "actions": [{"type": "create_task", "phase_code": "SCP", "xyz": "Y"}]},
    {"name": "create_task with a blank title", "actions": [{"type": "create_task", "title": "   ", "phase_code": "SCP", "xyz": "Y"}]},
    {"name": "create_task with a 201-character title", "actions": [{"type": "create_task", "title": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "phase_code": "SCP", "xyz": "Y"}]},
    {"name": "update_status to an unknown state", "actions": [{"type": "update_status", "to_state": "Done"}]},
    {"name": "update_status to Deferred without a note", "actions": [{"type": "update_status", "to_state": "Deferred"}]},
    {"name": "assign without an assignee", "actions": [{"type": "assign"}]},
    {"name": "assign with a malformed id", "actions": [{"type": "assign", "assignee_person_id": "not-an-id"}]},
    {"name": "assign with an upper-case id", "actions": [{"type": "assign", "assignee_person_id": "0192F1E2-7C3A-7B4D-9E8F-1A2B3C4D5E6F"}]},
    {"name": "add_comment with an empty body", "actions": [{"type": "add_comment", "body": ""}]},
    {"name": "add_comment with a 2001-character body", "actions": [{"type": "add_comment", "body": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]},
    {"name": "notify without a title", "actions": [{"type": "notify", "recipient_person_id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"}]},
    {"name": "notify without a recipient", "actions": [{"type": "notify", "title": "New task"}]},
    {"name": "call_webhook without an endpoint", "actions": [{"type": "call_webhook"}]}
  ]
}
$vectors$::jsonb);

create temporary table n (key text primary key, id uuid);
grant select, insert, update on n to public;

-- The evaluator and the validators agree with packages/schemas --------------------------------------------------------
select is_empty($$select v ->> 'name' from vectors, jsonb_array_elements(doc -> 'matches') v
  where private.automation_conditions_match(v -> 'conditions', doc -> 'event') is distinct from (v ->> 'expected')::boolean$$,
  'the SQL evaluator agrees with every shared match vector');
select is_empty($$select v ->> 'name' from vectors, jsonb_array_elements(doc -> 'valid') v
  where private.automation_conditions_refusal(v -> 'conditions') is not null$$,
  'every valid conditions vector passes the SQL validator');
select is_empty($$select v ->> 'name' from vectors, jsonb_array_elements(doc -> 'invalid') v
  where private.automation_conditions_refusal(v -> 'conditions') is null$$,
  'every invalid conditions vector is refused');
select is_empty($$select v ->> 'name' from vectors, jsonb_array_elements(doc -> 'validActions') v
  where private.automation_actions_refusal(v -> 'actions') is not null$$,
  'every valid actions vector passes the SQL validator');
select is_empty($$select v ->> 'name' from vectors, jsonb_array_elements(doc -> 'invalidActions') v
  where private.automation_actions_refusal(v -> 'actions') is null$$,
  'every invalid actions vector is refused');

-- Who writes automations ------------------------------------------------------------------------------------------------
create function pg_temp.save(p_conditions jsonb, p_actions jsonb, p_trigger text default 'record.created') returns uuid
language sql as $$
  select app.save_automation(pg_temp.id('org_a'), null, 'Welcome new tasks', 'Comments on every new task.', p_trigger,
    p_conditions, p_actions, true)
$$;

create temporary table docs (key text primary key, doc jsonb);
grant select on docs to public;
insert into docs values
  ('conditions', '{"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"},
                           {"any": [{"field": "data.record_state", "operator": "eq", "value": "Proposed"},
                                    {"field": "data.record_state", "operator": "eq", "value": "Ready"}]}]}'),
  ('actions', jsonb_build_array(
    jsonb_build_object('type', 'add_comment', 'body', 'Picked up {{data.title}}.'),
    jsonb_build_object('type', 'notify', 'recipient_person_id', pg_temp.id('carol'), 'title', 'New task: {{data.title}}')));

select pg_temp.as_user('dave');
select throws_ok($$select pg_temp.save((select doc from docs where key = 'conditions'), (select doc from docs where key = 'actions'))$$,
  '42501', null, 'a member without org.automations.write cannot create an automation');
select pg_temp.as_user('carol');
select throws_ok($$select pg_temp.save((select doc from docs where key = 'conditions'), (select doc from docs where key = 'actions'))$$,
  '42501', null, 'nor can a manager');

select pg_temp.as_user('bob');
select lives_ok($$insert into n values ('auto', pg_temp.save((select doc from docs where key = 'conditions'), (select doc from docs where key = 'actions')))$$,
  'an admin creates an automation with conditions and actions');
select is((select concat_ws(':', a.owner_person_id = pg_temp.id('bob'), a.enabled, a.condition_match) from app.automations a
           where a.id = (select id from n where key = 'auto')), 't:t:all', 'it runs as its creator and is on');
select is((select count(*)::integer from app.automation_conditions c where c.automation_id = (select id from n where key = 'auto')
           and c.deleted_at is null), 4, 'conditions are rows: a condition, a group and the two conditions in it');
select is((select count(*)::integer from app.automation_actions c where c.automation_id = (select id from n where key = 'auto')
           and c.deleted_at is null), 2, 'actions are rows');
select is(app.automation_definition((select id from n where key = 'auto')) -> 'conditions', (select doc from docs where key = 'conditions'),
  'the stored conditions read back as the document that was saved');
select is(app.automation_definition((select id from n where key = 'auto')) -> 'actions', (select doc from docs where key = 'actions'),
  'the stored actions read back as the document that was saved');
select throws_ok($$insert into app.automations (org_id, name, trigger_event_type, owner_person_id)
  values (pg_temp.id('org_a'), 'Direct', 'record.created', pg_temp.id('bob'))$$, '42501', null,
  'automations are written only through the RPCs');

select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.automations), 0, 'another org cannot read the automation');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.automations), 0, 'nor can a member without org.automations.write');

-- Validation and fit to the trigger -------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_like($$select pg_temp.save('{"all": [{"field": "Data.x", "operator": "eq", "value": "1"}]}', (select doc from docs where key = 'actions'))$$,
  'automation_conditions_invalid%', 'invalid conditions are refused with the validator''s reason');
select throws_like($$select pg_temp.save('{"all": []}', '[{"type": "update_status", "to_state": "Complete"}]', 'project.state_changed')$$,
  'automation_action_needs_record%', 'changing a status needs a trigger whose subject is a record');
select throws_like($$select pg_temp.save('{"all": []}', '[{"type": "add_comment", "body": "Hello"}]', 'ai_settings.changed')$$,
  'automation_action_needs_commentable_subject%', 'commenting needs a subject that takes comments');
select throws_like($$select pg_temp.save('{"all": []}', jsonb_build_array(jsonb_build_object('type', 'assign', 'assignee_person_id', pg_temp.id('xavier'))))$$,
  'automation_person_not_member%', 'an assignee must be a member of the org');
select throws_like($$select pg_temp.save('{"all": []}', jsonb_build_array(jsonb_build_object('type', 'notify', 'recipient_person_id', pg_temp.id('xavier'), 'title', 'Hi')))$$,
  'automation_person_not_member%', 'so must a recipient');
select throws_like($$select pg_temp.save('{"all": []}', jsonb_build_array(jsonb_build_object('type', 'call_webhook', 'webhook_endpoint_id', gen_random_uuid())))$$,
  'automation_webhook_unknown%', 'a webhook action names one of the org''s endpoints');
select throws_like($$select pg_temp.save('{"all": []}', '[{"type": "add_comment", "body": "Hello"}]', 'record.vanished')$$,
  'automation_trigger_unknown%', 'the trigger comes from the event catalog');
select lives_ok($$insert into n values ('hook', (select e.webhook_endpoint_id from app.create_webhook_endpoint(pg_temp.id('org_a'),
  'https://hooks.northwind.test/automations', array['record.created'], 'Automation target') e))$$, 'setup: a webhook endpoint');
select lives_ok($$select pg_temp.save('{"all": []}', jsonb_build_array(jsonb_build_object('type', 'call_webhook', 'webhook_endpoint_id', (select id from n where key = 'hook')),
  jsonb_build_object('type', 'create_task', 'title', 'Review {{data.title}}', 'project_id', pg_temp.id('prj_a'), 'phase_code', 'SCP', 'xyz', 'Y', 'due_in_days', 2)))$$,
  'webhook and create_task actions save with the org''s endpoint and project');

-- Plan gating: Pro and above; without the feature, read-only ----------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_like($$select app.save_automation(pg_temp.id('org_b'), null, 'Harbor', null, 'record.created', '{"all": []}',
  '[{"type": "add_comment", "body": "Hello"}]', false)$$, 'plan_feature_required%', 'an org on Access cannot create automations');

-- Ownership follows whoever changes what it does ----------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$select app.save_automation(pg_temp.id('org_a'), (select id from n where key = 'auto'), null, null, null,
  '{"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}]}', null, null)$$, 'the owner changes the conditions');
select is((select owner_person_id from app.automations where id = (select id from n where key = 'auto')), pg_temp.id('alice'),
  'and becomes the person it runs as');
select pg_temp.as_user('bob');
select lives_ok($$select app.set_automation_enabled((select id from n where key = 'auto'), false)$$, 'an admin turns it off');
select is((select concat_ws(':', owner_person_id = pg_temp.id('alice'), enabled) from app.automations where id = (select id from n where key = 'auto')),
  't:f', 'turning it off does not change who it runs as');
select throws_like($$select app.save_automation(pg_temp.id('org_a'), (select id from n where key = 'auto'), 'Renamed', null, null, null, null, null,
  '2000-01-01T00:00:00Z')$$, 'automation_changed%', 'a stale version is refused');

-- The dry run -----------------------------------------------------------------------------------------------------------
select is(app.test_automation((select id from n where key = 'auto'), '{"type": "record.created", "data": {"record_kind": "Task"}}') ->> 'matched',
  'true', 'a sample event that meets the conditions matches');
select is(app.test_automation((select id from n where key = 'auto'), '{"type": "record.created", "data": {"record_kind": "Build"}}') -> 'conditions' -> 0 -> 'actual',
  '"Build"'::jsonb, 'the dry run shows the value each condition found');
select is(app.sample_automation_event(pg_temp.id('org_a'), 'record.replanned') -> 'subject' ->> 'table', 'records',
  'without an event of the type, the sample is an empty body naming the subject');

-- Without the feature (a downgrade) the automation can be turned off, not on --------------------------------------------
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('bob');
select throws_like($$select app.set_automation_enabled((select id from n where key = 'auto'), true)$$, 'plan_feature_required%',
  'after a downgrade an automation cannot be turned on');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_a');

-- Deleting and the nesting guard ----------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$select app.delete_automation((select id from n where key = 'auto'))$$, 'an admin deletes the automation');
select throws_ok($$select app.automation_definition((select id from n where key = 'auto'))$$, '42501', null, 'a deleted automation is gone');
select pg_temp.as_platform();
select throws_like($$insert into app.automation_conditions (automation_id, parent_condition_id, position, group_match)
  select c.automation_id, c.id, 9, 'all' from app.automation_conditions c where c.group_match is not null limit 1$$,
  'automation_condition_nesting%', 'groups nest one level');

select * from finish();
rollback;
