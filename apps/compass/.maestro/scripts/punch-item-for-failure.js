/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, PROMPT */
// Journey 17, "see the punch record created": signs in as the inspector over the auth API and reads the
// punch items opened by failed inspection results, the way Atlas's punch list does. Leaves the count of
// punch records titled "Correct <PROMPT>" in output.punch.count.
// Maestro runs scripts in Rhino, so this file sticks to ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
// The walk's upload can still be in flight when the flow gets here (the queue banner reads empty before the
// queued result shows in it), so the read is retried for up to 30 seconds until the punch record is there.
function readPunch() {
  var res = http.get(
    SUPABASE_URL +
      "/rest/v1/punch_items?select=id,inspection_result_id,records!punch_items_record_id_fkey(title)&inspection_result_id=not.is.null",
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
        "Accept-Profile": "app",
      },
    },
  );
  var rows = res.status === 200 ? json(res.body) : [];
  var count = 0;
  for (var i = 0; i < rows.length; i += 1) {
    var record = rows[i].records;
    if (record && record.title && record.title.indexOf(PROMPT) >= 0) count += 1;
  }
  return { status: res.status, count: count, body: res.body };
}

var deadline = new Date().getTime() + 30000;
var punch = readPunch();
while (punch.status === 200 && punch.count < 1 && new Date().getTime() < deadline) {
  // Maestro's script runtime has no timer; wait a second between reads.
  var until = new Date().getTime() + 1000;
  while (new Date().getTime() < until) {
    /* wait */
  }
  punch = readPunch();
}
output.punch = punch;
