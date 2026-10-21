/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD, SINCE */
// supervisor-kiosk, "clocks a worker in": signs in as the Demo Admin and counts the Demo Field Tech's Kiosk
// punches made by a kiosk since SINCE (the kiosk's registration time, from scripts/kiosk-device.js). A
// kiosk that could not get an answer keeps the punch and sends it again, so the read is retried for up to
// 60 seconds. Leaves { status, count } in output.kioskPunch. Maestro runs scripts in Rhino, so this file
// is ES5.
var TECH_MEMBERSHIP_ID = "01920000-0000-7000-8000-00000000a106";
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@example.com", password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;

function readPunches() {
  var res = http.get(
    SUPABASE_URL +
      "/rest/v1/clock_punches?select=id,punch_kind&source=eq.Kiosk&kiosk_device_id=not.is.null" +
      "&membership_id=eq." +
      TECH_MEMBERSHIP_ID +
      "&created_at=gte." +
      encodeURIComponent(SINCE),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
        "Accept-Profile": "app",
      },
    },
  );
  return {
    status: res.status,
    count: res.status === 200 ? json(res.body).length : 0,
    body: res.body,
  };
}

var deadline = new Date().getTime() + 60000;
var punches = readPunches();
while (punches.status === 200 && punches.count < 1 && new Date().getTime() < deadline) {
  // Maestro's script runtime has no timer; wait a second between reads.
  var until = new Date().getTime() + 1000;
  while (new Date().getTime() < until) {
    /* wait */
  }
  punches = readPunches();
}
output.kioskPunch = punches;
