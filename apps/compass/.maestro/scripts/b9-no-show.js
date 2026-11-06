/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// B9 setup for b9-no-show: the demo Owner plans a shift on the demo project for a demo member, started an hour ago, and
// publishes it; the member accepts it and never clocks in, so they show as late on the Crew tab. Leaves { email, status,
// shiftId, name } in output.noShow. Maestro runs scripts in Rhino (ES5).
var PROJECT = "01920000-0000-7000-8000-000000001001";
var ORG = "01920000-0000-7000-8000-000000000001";
var WORKER = "01920000-0000-7000-8000-000000000104";

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
    Prefer: "return=representation",
  };
}

function rpc(token, name, args) {
  var res = http.post(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    headers: headers(token),
    body: JSON.stringify(args),
  });
  if (res.status >= 300) throw new Error(name + " " + res.status + " " + res.body);
  return json(res.body);
}

var state = { status: "starting", email: "owner@example.com" };
try {
  var owner = signIn("owner@example.com");
  var memberToken = signIn("field@example.com");
  var memberships = http.get(
    SUPABASE_URL + "/rest/v1/memberships?select=id&org_id=eq." + ORG + "&person_id=eq." + WORKER,
    { headers: headers(memberToken) },
  );
  var membership = json(memberships.body)[0].id;
  var now = Date.now();
  var made = http.post(SUPABASE_URL + "/rest/v1/shifts", {
    headers: headers(owner),
    body: JSON.stringify({
      org_id: ORG,
      project_id: PROJECT,
      membership_id: membership,
      starts_at: new Date(now - 3600000).toISOString(),
      ends_at: new Date(now + 6 * 3600000).toISOString(),
      time_zone: "America/New_York",
    }),
  });
  if (made.status >= 300) throw new Error("shift " + made.status + " " + made.body);
  var id = json(made.body)[0].id;
  state.status = "publish";
  rpc(owner, "publish_shifts", { p_shift_ids: [id] });
  state.status = "accept";
  rpc(memberToken, "accept_shift", { p_shift_id: id, p_reason: "Accepted for the flow." });
  state.status = "ok";
  state.shiftId = id;
} catch (error) {
  state.error = String(error);
}
output.noShow = state;
