/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// R12 teardown for clock-team, run from onFlowComplete: the lead clocks the team out, so no entry stays open on the
// demo project, and the demo Owner cancels the run's shifts and closes its engagement, from output.team.undo. Each
// step runs on its own, so one refusal does not leave the rest behind. Leaves { status } in output.teamCleanup.
// Maestro runs scripts in Rhino (ES5).
var PROJECT = "01920000-0000-7000-8000-000000001001";

function signIn(email) {
  var res = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: XOS_DEMO_PASSWORD }),
  });
  return json(res.body).access_token;
}

function rpc(token, name, args) {
  var res = http.post(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Content-Profile": "app",
    },
    body: JSON.stringify(args),
  });
  if (res.status >= 300) throw new Error(name + " " + res.status + " " + res.body);
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () {
    return Math.floor(Math.random() * 16).toString(16);
  });
}

var team = output.team || {};
var undo = team.undo || {};
var failed = [];
var shifts = undo.shifts || [];
if (team.email && shifts.length > 0) {
  try {
    var punches = [];
    for (var i = 0; i < shifts.length; i++) punches.push({ punch_id: uuid(), shift_id: shifts[i] });
    rpc(signIn(team.email), "record_supervisor_punches", {
      p_batch_id: uuid(),
      p_project_id: PROJECT,
      p_punch_kind: "Out",
      p_device_time: new Date().toISOString(),
      p_punches: punches,
    });
  } catch (e) {
    failed.push("clock out: " + e.message);
  }
}
var owner = signIn("owner@example.com");
for (var s = 0; s < shifts.length; s++) {
  try {
    rpc(owner, "transition_shift", {
      p_shift_id: shifts[s],
      p_expected: "Published",
      p_next: "Canceled",
      p_reason: "Maestro run finished.",
    });
  } catch (e) {
    failed.push("shift: " + e.message);
  }
}
if (undo.engagement) {
  try {
    rpc(owner, "transition_engagement", {
      p_engagement_id: undo.engagement,
      p_expected: "Active",
      p_next: "Closing",
      p_reason: "Maestro run finished.",
    });
  } catch (e) {
    failed.push("engagement: " + e.message);
  }
}
output.teamCleanup = { status: failed.length === 0 ? "ok" : failed.join("; ") };
