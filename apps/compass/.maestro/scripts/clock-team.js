/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// R12 setup for clock-team (G-126): a staffing agency made for the run wins a Staff engagement of the demo project,
// Active, with two staff on its roster, both accepted by the org and by themselves, and placed by the agency's lead on
// two published shifts of today. Every step is an RPC or a REST write as the person whose step it is: the lead makes
// the account and rosters, each staff member confirms and accepts, the demo Owner engages, reviews and allocates the
// slots. Leaves { email, status, undo } in output.team; status names the first step that failed, and undo is what
// clock-team-cleanup.js puts back when the flow completes (the engagement and its shifts). Maestro runs scripts in
// Rhino (ES5).
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

function insert(token, table, row) {
  var res = http.post(SUPABASE_URL + "/rest/v1/" + table, {
    headers: headers(token),
    body: JSON.stringify(row),
  });
  if (res.status >= 300) throw new Error(table + " " + res.status + " " + res.body);
  return json(res.body)[0].id;
}

function signUp(email, name) {
  var res = http.post(SUPABASE_URL + "/auth/v1/signup", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: XOS_DEMO_PASSWORD, data: { full_name: name } }),
  });
  return json(res.body).id || json(res.body).user.id;
}

var stamp = new Date().getTime();
var email = "maestrolead" + stamp + "@example.com";
var status = "ok";
var undo = { engagement: null, shifts: [] };
try {
  status = "sign-up";
  signUp(email, "Maestro Agency Lead");
  var staff = [
    { email: "maestrostaffone" + stamp + "@example.com", name: "Maestro Staff One" },
    { email: "maestrostafftwo" + stamp + "@example.com", name: "Maestro Staff Two" },
  ];
  for (var s = 0; s < staff.length; s++) staff[s].person = signUp(staff[s].email, staff[s].name);
  var lead = signIn(email);
  var owner = signIn("owner@example.com");

  status = "account";
  var account = rpc(lead, "create_external_account", {
    p_name: "Maestro Staffing " + String(stamp).slice(-4),
    p_slug: "maestro-staffing-" + stamp,
  });
  for (var m = 0; m < staff.length; m++) {
    var membership = rpc(lead, "add_account_member", {
      p_account_id: account,
      p_person_id: staff[m].person,
      p_role: "Account Member",
    });
    rpc(signIn(staff[m].email), "accept_account_membership", {
      p_account_membership_id: membership,
    });
  }

  status = "engagement";
  var counterparty = rpc(owner, "create_counterparty", {
    p_org_id: ORG,
    p_vendor_id: null,
    p_customer_id: null,
    p_organization_id: account,
  });
  var engagement = insert(owner, "engagements", {
    project_id: PROJECT,
    counterparty_id: counterparty,
    role_type: "Staff",
    role_code: "5000.51.02",
    worker_classification: "INDEPENDENT_CONTRACTOR",
    pay_basis: "Day Rate",
    arrangement: "Per Engagement",
    start_date: "2027-06-04",
    end_date: "2027-06-06",
  });
  undo.engagement = engagement;

  status = "roster";
  var entries = [];
  for (var r = 0; r < staff.length; r++) {
    entries.push(
      rpc(lead, "add_roster_entry", {
        p_engagement_id: engagement,
        p_person_id: staff[r].person,
        p_role_code: "5000.51.02",
      }),
    );
  }
  rpc(lead, "submit_roster", { p_engagement_id: engagement });
  for (var a = 0; a < staff.length; a++) {
    rpc(owner, "review_roster_entry", { p_roster_entry_id: entries[a], p_outcome: "Accepted" });
    rpc(signIn(staff[a].email), "respond_roster_entry", {
      p_roster_entry_id: entries[a],
      p_response: "Accepted",
    });
  }
  rpc(owner, "transition_engagement", {
    p_engagement_id: engagement,
    p_expected: "Onboarding",
    p_next: "Active",
    p_reason: "Ready for the Maestro run.",
  });

  status = "shifts";
  var now = new Date().getTime();
  for (var k = 0; k < staff.length; k++) {
    var shift = insert(owner, "shifts", {
      project_id: PROJECT,
      engagement_id: engagement,
      role_code: "5000.51.02",
      starts_at: new Date(now - 30 * 60000).toISOString(),
      ends_at: new Date(now + 6 * 3600000).toISOString(),
      time_zone: "America/New_York",
    });
    undo.shifts.push(shift);
  }
  rpc(owner, "publish_shifts", {
    p_shift_ids: undo.shifts,
    p_reason: "Agency slots for the Maestro run.",
  });
  for (var p = 0; p < staff.length; p++) {
    rpc(lead, "assign_roster_shift", { p_shift_id: undo.shifts[p], p_roster_entry_id: entries[p] });
  }
  status = "ok";
} catch (e) {
  status = status + ": " + e.message;
}
output.team = { email: email, status: status, undo: undo };
