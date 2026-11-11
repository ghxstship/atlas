/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, ORG_ID, CATEGORY, CHANNEL */
// A111 settings-notifications, "checks they persist": signs in as the member over the auth API and reads what Atlas
// and Gateway read, not what the phone kept. The member's matrix in ORG_ID (app.my_notification_matrix, as Atlas Me
// shows it) gives whether CATEGORY reaches them on CHANNEL; app.notification_settings their quiet hours in that org
// (Atlas); app.person_notification_settings their own quiet hours (Gateway). The phone sends its queue in the
// background, so the reads are retried for up to 30 seconds until the queue has landed. Leaves
// { status, enabled, orgStart, orgEnd, ownStart, ownEnd } in output.notifications. Maestro runs scripts in Rhino, so
// this file is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var read = { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Accept-Profile": "app" };

function hhmm(time) {
  return typeof time === "string" ? time.slice(0, 5) : null;
}

function readAll() {
  var matrix = http.post(SUPABASE_URL + "/rest/v1/rpc/my_notification_matrix", {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      "Content-Profile": "app",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_org_id: ORG_ID }),
  });
  var org = http.get(
    SUPABASE_URL +
      "/rest/v1/notification_settings?select=quiet_hours_start,quiet_hours_end&deleted_at=is.null&org_id=eq." +
      ORG_ID,
    { headers: read },
  );
  var own = http.get(
    SUPABASE_URL +
      "/rest/v1/person_notification_settings?select=quiet_hours_start,quiet_hours_end&deleted_at=is.null",
    { headers: read },
  );
  var enabled = null;
  var cells = matrix.status === 200 ? json(matrix.body) : [];
  for (var i = 0; i < cells.length; i += 1) {
    if (cells[i].category_code === CATEGORY && cells[i].channel === CHANNEL)
      enabled = cells[i].enabled;
  }
  var orgRows = org.status === 200 ? json(org.body) : [];
  var ownRows = own.status === 200 ? json(own.body) : [];
  return {
    status: matrix.status === 200 && org.status === 200 && own.status === 200 ? 200 : matrix.status,
    enabled: enabled,
    orgStart: orgRows.length > 0 ? hhmm(orgRows[0].quiet_hours_start) : null,
    orgEnd: orgRows.length > 0 ? hhmm(orgRows[0].quiet_hours_end) : null,
    ownStart: ownRows.length > 0 ? hhmm(ownRows[0].quiet_hours_start) : null,
    ownEnd: ownRows.length > 0 ? hhmm(ownRows[0].quiet_hours_end) : null,
  };
}

var deadline = new Date().getTime() + 30000;
var saved = readAll();
while (
  saved.status === 200 &&
  (saved.enabled !== false || saved.orgStart === null || saved.ownStart === null) &&
  new Date().getTime() < deadline
) {
  // Maestro's script runtime has no timer; wait a second between reads.
  var until = new Date().getTime() + 1000;
  while (new Date().getTime() < until) {
    /* wait */
  }
  saved = readAll();
}
output.notifications = saved;
