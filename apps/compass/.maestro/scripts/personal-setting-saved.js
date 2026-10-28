/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, KEY, EXPECT */
// A111 settings flows, "checks it persists": signs in as the person over the auth API and reads their own value of
// the setting KEY for every org (app.personal_setting_values, as Atlas and Gateway resolve it). The phone sends its
// queue in the background, so the read is retried for up to 30 seconds until the value is EXPECT. Leaves
// { status, value } in output.setting, the value as text ("metric", "false", "2026-11-02"), or null. Maestro runs
// scripts in Rhino, so this file is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;

function readValue() {
  var res = http.get(
    SUPABASE_URL +
      "/rest/v1/personal_setting_values?select=value_text,value_boolean,value_integer" +
      "&org_id=is.null&deleted_at=is.null&setting_key=eq." +
      encodeURIComponent(KEY),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
        "Accept-Profile": "app",
      },
    },
  );
  var rows = res.status === 200 ? json(res.body) : [];
  var row = rows.length > 0 ? rows[0] : null;
  var value = null;
  if (row) {
    if (row.value_text !== null) value = row.value_text;
    else if (row.value_boolean !== null) value = String(row.value_boolean);
    else if (row.value_integer !== null) value = String(row.value_integer);
  }
  return { status: res.status, value: value };
}

var deadline = new Date().getTime() + 30000;
var setting = readValue();
while (setting.status === 200 && setting.value !== EXPECT && new Date().getTime() < deadline) {
  var until = new Date().getTime() + 1000;
  while (new Date().getTime() < until) {
    /* wait */
  }
  setting = readValue();
}
output.setting = setting;
