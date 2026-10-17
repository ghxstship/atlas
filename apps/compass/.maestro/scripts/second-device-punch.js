/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, PROJECT_ID */
// Journey 10, "clocks in again on a second device": signs in as the same person over the auth API, as a
// second phone would, and sends a Clock In punch with its own punch id straight to app.record_punch.
// Needs SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD and PROJECT_ID.
// Leaves the server's answer in output.secondDevice for the flow to assert on.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
function uuid() {
  var hex = "0123456789abcdef";
  var s = "";
  for (var i = 0; i < 32; i += 1) s += hex.charAt(Math.floor(Math.random() * 16));
  return (
    s.slice(0, 8) +
    "-" +
    s.slice(8, 12) +
    "-4" +
    s.slice(13, 16) +
    "-a" +
    s.slice(17, 20) +
    "-" +
    s.slice(20)
  );
}

var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var punch = http.post(SUPABASE_URL + "/rest/v1/rpc/record_punch", {
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "Content-Profile": "app",
  },
  body: JSON.stringify({
    p_punch_id: uuid(),
    p_project_id: PROJECT_ID,
    p_punch_kind: "In",
    p_device_time: new Date().toISOString(),
    p_source: "Mobile",
  }),
});
output.secondDevice = { status: punch.status, body: punch.body };
