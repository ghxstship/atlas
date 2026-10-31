/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// R8 teardown for roster-member-today, run from onFlowComplete: puts back what roster-member.js changed on the shared
// demo project, as the demo Owner, from output.roster.undo. The vendor engagement made for the run is canceled, a
// parking category made for the run is removed, and the project's parking offering returns to its stored value, or to
// inheriting when it had none. Each step runs on its own, so one refusal does not leave the rest behind. Leaves
// { status } in output.rosterCleanup. Maestro runs scripts in Rhino (ES5).
var ORG = "01920000-0000-7000-8000-000000000001";
var PROJECT = "01920000-0000-7000-8000-000000001001";

function signIn(email) {
  var res = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: XOS_DEMO_PASSWORD }),
  });
  return json(res.body).access_token;
}

function headers(token) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "Content-Profile": "app",
    "Accept-Profile": "app",
  };
}

function rpc(token, name, args) {
  var res = http.post(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    headers: headers(token),
    body: JSON.stringify(args),
  });
  if (res.status >= 300) throw new Error(name + " " + res.status + " " + res.body);
}

var undo = output.roster && output.roster.undo ? output.roster.undo : {};
var failed = [];
var owner = signIn("owner@example.com");

if (undo.engagement) {
  try {
    rpc(owner, "transition_engagement", {
      p_engagement_id: undo.engagement,
      p_expected: "Active",
      p_next: "Canceled",
      p_reason: "Maestro run finished.",
    });
  } catch (e) {
    failed.push("engagement: " + e.message);
  }
}
if (undo.category) {
  var res = http.request(SUPABASE_URL + "/rest/v1/credential_categories?id=eq." + undo.category, {
    method: "PATCH",
    headers: headers(owner),
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (res.status >= 300) failed.push("category: " + res.status + " " + res.body);
}
if (undo.parkingSet) {
  try {
    if (undo.parkingBefore === null) {
      rpc(owner, "clear_setting", {
        p_org_id: ORG,
        p_setting_key: "offerings.parking",
        p_scope_kind: "Project",
        p_scope_id: PROJECT,
      });
    } else {
      rpc(owner, "set_setting", {
        p_org_id: ORG,
        p_setting_key: "offerings.parking",
        p_scope_kind: "Project",
        p_scope_id: PROJECT,
        p_value_text: undo.parkingBefore,
      });
    }
  } catch (e) {
    failed.push("parking: " + e.message);
  }
}
output.rosterCleanup = { status: failed.length === 0 ? "ok" : failed.join("; ") };
