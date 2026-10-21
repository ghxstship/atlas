/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, ORG_ID, PROJECT_ID, STEP */
// Kiosk re-keying (A85, RRR-130), as an Admin does it in Atlas. Signs in over the auth API as EMAIL (an Admin
// with org.time_attendance.write) and, by STEP:
//   * retire:   retires the org's live kiosk seen most recently (the one the flow just punched on), so its
//               key stops working (migration 1171); leaves its id in output.kiosk.retired
//   * register: registers a new kiosk on PROJECT_ID and leaves its device key in output.kiosk.key. The key is
//               made by the database at run time and only typed into the app.
// Needs SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, ORG_ID, PROJECT_ID and STEP.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: "Bearer " + token,
  "Content-Type": "application/json",
  "Accept-Profile": "app",
  "Content-Profile": "app",
};
output.kiosk = output.kiosk || {};

if (STEP === "retire") {
  var since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  var seen = json(
    http.get(
      SUPABASE_URL +
        "/rest/v1/kiosk_devices?select=id&org_id=eq." +
        ORG_ID +
        "&deleted_at=is.null&last_seen_at=gt." +
        encodeURIComponent(since) +
        "&order=last_seen_at.desc&limit=1",
      { headers: headers },
    ).body,
  );
  if (seen.length !== 1) throw new Error("No kiosk of the org punched in the last 30 minutes");
  var retired = http.request(SUPABASE_URL + "/rest/v1/kiosk_devices?id=eq." + seen[0].id, {
    method: "PATCH",
    headers: headers,
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (retired.status >= 300) throw new Error("Retiring the kiosk failed: " + retired.status);
  output.kiosk.retired = seen[0].id;
} else if (STEP === "register") {
  var registered = http.post(SUPABASE_URL + "/rest/v1/rpc/register_kiosk_device", {
    headers: headers,
    body: JSON.stringify({
      p_org_id: ORG_ID,
      p_name: "Maestro Kiosk " + Date.now(),
      p_project_id: PROJECT_ID,
    }),
  });
  if (registered.status >= 300) throw new Error("Registering a kiosk failed: " + registered.status);
  output.kiosk.key = json(registered.body)[0].device_key;
} else {
  throw new Error("STEP must be retire or register");
}
