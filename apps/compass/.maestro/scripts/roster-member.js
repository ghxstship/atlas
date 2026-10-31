/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// R8 setup for roster-member-today: a new person on Demo Staging Supply's crew (seed 0010) for a vendor engagement of
// the demo project, Active, with their entry accepted by the org and by themselves, a pending badge and a parking pass
// for their vehicle. Every step is an RPC or a REST write as the person whose step it is, as Gateway and Atlas make
// them: the demo vendor contact (the account's Owner) rosters, the demo Owner reviews, assigns and issues. Leaves
// { email, status, undo } in output.roster; status names the first step that failed, and undo is what
// roster-member-cleanup.js puts back when the flow completes (the demo project's parking offering, a parking category
// made for the run, the engagement). Maestro runs scripts in Rhino (ES5).
var ORG = "01920000-0000-7000-8000-000000000001";
var PROJECT = "01920000-0000-7000-8000-000000001001";
var ACCOUNT = "01920000-0000-7000-8000-000000000301";
var VENDOR_ENGAGEMENT = "01920000-0000-7000-8000-000000228402";

function signIn(email) {
  var res = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: XOS_DEMO_PASSWORD }),
  });
  return json(res.body).access_token;
}

function headers(token, profile) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "Content-Profile": profile,
    "Accept-Profile": profile,
    Prefer: "return=representation",
  };
}

function rpc(token, name, args) {
  var res = http.post(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    headers: headers(token, "app"),
    body: JSON.stringify(args),
  });
  if (res.status >= 300) throw new Error(name + " " + res.status + " " + res.body);
  return json(res.body);
}

function merge(a, b) {
  var out = {};
  for (var k in a) out[k] = a[k];
  for (var j in b) out[j] = b[j];
  return out;
}

function read(token, profile, path) {
  var res = http.get(SUPABASE_URL + "/rest/v1/" + path, { headers: headers(token, profile) });
  return json(res.body);
}

var stamp = new Date().getTime();
var email = "maestroroster" + stamp + "@example.com";
var status = "ok";
var undo = { engagement: null, parkingSet: false, parkingBefore: null, category: null };
try {
  status = "sign-up";
  var signUp = http.post(SUPABASE_URL + "/auth/v1/signup", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email,
      password: XOS_DEMO_PASSWORD,
      data: { full_name: "Maestro Roster Crew" },
    }),
  });
  var person = json(signUp.body).id || json(signUp.body).user.id;
  var crew = signIn(email);
  var vendor = signIn("vendor@example.com");
  var owner = signIn("owner@example.com");

  status = "membership";
  var membership = rpc(vendor, "add_account_member", {
    p_account_id: ACCOUNT,
    p_person_id: person,
    p_role: "Account Member",
  });
  rpc(crew, "accept_account_membership", { p_account_membership_id: membership });

  status = "engagement";
  var counterparty = read(
    owner,
    "app",
    "engagements?select=counterparty_id&id=eq." + VENDOR_ENGAGEMENT,
  )[0].counterparty_id;
  var made = http.post(SUPABASE_URL + "/rest/v1/engagements", {
    headers: headers(owner, "app"),
    body: JSON.stringify({
      project_id: PROJECT,
      person_id: "01920000-0000-7000-8000-000000000302",
      counterparty_id: counterparty,
      role_type: "Vendor",
      role_code: "9000.50.02",
      worker_classification: "VENDOR_SUPPLIED",
      pay_basis: "Day Rate",
      arrangement: "Per Engagement",
      start_date: "2027-06-04",
      end_date: "2027-06-06",
    }),
  });
  var engagement = json(made.body)[0].id;
  undo.engagement = engagement;

  status = "roster";
  var entry = rpc(vendor, "add_roster_entry", {
    p_engagement_id: engagement,
    p_person_id: person,
    p_role_code: "9000.50.02",
    p_arrival_starts_at: "2027-06-04T12:00:00Z",
    p_arrival_ends_at: "2027-06-04T14:00:00Z",
    p_arrival_time_zone: "America/New_York",
  });
  rpc(vendor, "submit_roster", { p_engagement_id: engagement });
  rpc(owner, "review_roster_entry", { p_roster_entry_id: entry, p_outcome: "Accepted" });
  rpc(crew, "respond_roster_entry", { p_roster_entry_id: entry, p_response: "Accepted" });

  status = "active";
  rpc(owner, "transition_engagement", {
    p_engagement_id: engagement,
    p_expected: "Onboarding",
    p_next: "Active",
    p_reason: "Ready for the Maestro run.",
  });

  status = "parking";
  var stored = read(
    owner,
    "app",
    "setting_values?select=value_text&setting_key=eq.offerings.parking&scope_kind=eq.Project&scope_id=eq." +
      PROJECT +
      "&deleted_at=is.null",
  );
  undo.parkingBefore = stored.length > 0 ? stored[0].value_text : null;
  if (undo.parkingBefore !== "provided") {
    rpc(owner, "set_setting", {
      p_org_id: ORG,
      p_setting_key: "offerings.parking",
      p_scope_kind: "Project",
      p_scope_id: PROJECT,
      p_value_text: "provided",
    });
    undo.parkingSet = true;
  }
  rpc(crew, "save_roster_vehicle", {
    p_roster_entry_id: entry,
    p_make: "Ford",
    p_model: "Transit",
    p_color: "White",
    p_plate: "MAE" + String(stamp).slice(-4),
    p_plate_region: "US-FL",
  });
  var categories = read(
    owner,
    "app",
    "credential_categories?select=id,category_kind&project_id=eq." + PROJECT,
  );
  var park = null;
  var badge = null;
  for (var i = 0; i < categories.length; i++) {
    if (categories[i].category_kind === "Parking" && park === null) park = categories[i].id;
    if (categories[i].category_kind === "Access" && badge === null) badge = categories[i].id;
  }
  if (park === null) {
    park = json(
      http.post(SUPABASE_URL + "/rest/v1/credential_categories", {
        headers: headers(owner, "app"),
        body: JSON.stringify({
          project_id: PROJECT,
          code: "MPARK",
          name: "Crew Parking",
          category_kind: "Parking",
        }),
      }).body,
    )[0].id;
    undo.category = park;
  }
  var vehicle = read(owner, "app", "roster_vehicles?select=id&roster_entry_id=eq." + entry);
  var need = {
    p_project_id: PROJECT,
    p_engagement_id: null,
    p_roster_entry_id: entry,
    p_asset_class_id: null,
    p_fulfillment_id: null,
    p_accommodation_block_id: null,
    p_service_kind: null,
    p_quantity: 1,
    p_needed_from: "2027-06-04T00:00:00Z",
    p_needed_to: "2027-06-07T00:00:00Z",
    p_time_zone: "America/New_York",
  };
  var pass = rpc(owner, "assign_allocation", merge(need, { p_credential_category_id: park }));
  rpc(owner, "issue_allocation", {
    p_event_id: "01920000-0000-7000-8700-" + String(stamp).slice(-12),
    p_allocation_id: pass,
    p_items: [{ roster_vehicle_id: vehicle.length > 0 ? vehicle[0].id : null }],
  });

  status = "badge";
  if (badge !== null)
    rpc(owner, "assign_allocation", merge(need, { p_credential_category_id: badge }));
  status = "ok";
} catch (e) {
  status = status + ": " + e.message;
}
output.roster = { email: email, status: status, undo: undo };
