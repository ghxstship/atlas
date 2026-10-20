/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// KIOSK_DEVICE_KEY and KIOSK_PIN_1 to KIOSK_PIN_4 are read by name through given(), since they may be unset.
// Kiosk setup for supervisor-kiosk: when the run passes no KIOSK_DEVICE_KEY, the Demo Admin registers a
// kiosk over the API (app.register_kiosk_device, as Atlas's kiosk settings do) and sets a fresh four-digit
// kiosk PIN for the Demo Field Tech (app.set_kiosk_pin). A key and PIN passed in KIOSK_DEVICE_KEY and
// KIOSK_PIN_1 to KIOSK_PIN_4 are used as they are. Leaves { status, key, pin: [d1, d2, d3, d4] } in
// output.kiosk. The PIN never has a 0, so it can never equal the wrong PIN the flow enters (0000).
// Maestro runs scripts in Rhino, so this file is ES5.
var ORG_ID = "01920000-0000-7000-8000-000000000001";
var PROJECT_ID = "01920000-0000-7000-8000-000000001001";
var TECH_MEMBERSHIP_ID = "01920000-0000-7000-8000-00000000a106";
var startedAt = new Date().getTime();

// The named variable when the run passed it, else null; an unset name is not an error.
function given(name) {
  var value = eval("typeof " + name + ' === "undefined" ? null : ' + name);
  return typeof value === "string" && value !== "" ? value : null;
}

if (given("KIOSK_DEVICE_KEY") !== null) {
  output.kiosk = {
    status: 200,
    key: given("KIOSK_DEVICE_KEY"),
    pin: [given("KIOSK_PIN_1"), given("KIOSK_PIN_2"), given("KIOSK_PIN_3"), given("KIOSK_PIN_4")],
  };
} else {
  var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: XOS_DEMO_PASSWORD }),
  });
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + json(auth.body).access_token,
    "Content-Type": "application/json",
    "Content-Profile": "app",
  };
  var device = http.post(SUPABASE_URL + "/rest/v1/rpc/register_kiosk_device", {
    headers: headers,
    body: JSON.stringify({
      p_org_id: ORG_ID,
      p_name: "Maestro kiosk " + new Date().getTime(),
      p_project_id: PROJECT_ID,
    }),
  });
  var pin = [];
  for (var i = 0; i < 4; i += 1) pin.push(String(1 + Math.floor(Math.random() * 9)));
  var set = http.post(SUPABASE_URL + "/rest/v1/rpc/set_kiosk_pin", {
    headers: headers,
    body: JSON.stringify({ p_membership_id: TECH_MEMBERSHIP_ID, p_pin: pin.join("") }),
  });
  var rows = device.status === 200 ? json(device.body) : [];
  output.kiosk = {
    status:
      device.status === 200 && set.status < 300
        ? 200
        : device.status === 200
          ? set.status
          : device.status,
    key: rows.length > 0 ? rows[0].device_key : null,
    pin: pin,
    body: device.status === 200 ? set.body : device.body,
  };
}

// Wakes the kiosk-punch Edge Function before the flow times the kiosk: a cold local edge runtime can take
// longer to boot than the app waits for an answer. An empty body is refused (422) once the function runs;
// the punches themselves are sent by the app. Tried for up to two minutes.
var warm = 0;
var warmUntil = new Date().getTime() + 120000;
while (warm !== 422 && new Date().getTime() < warmUntil) {
  try {
    warm = http.post(SUPABASE_URL + "/functions/v1/kiosk-punch", {
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: "{}",
    }).status;
  } catch (error) {
    warm = 0;
    output.kiosk.warmError = String(error);
  }
}
output.kiosk.warm = warm;
// Punches from this run are the ones made after this moment (a minute back, for clock drift).
output.kiosk.since = new Date(startedAt - 60000).toISOString();
