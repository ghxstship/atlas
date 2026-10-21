/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL, XOS_DEMO_PASSWORD, DESCRIPTION */
// A92 "see it filed once": signs in as the submitter over the auth API and counts the expenses described as
// DESCRIPTION and the receipts filed with them (1490), as Atlas's expenses page reads them. Leaves
// { status, expenses, receipts, amount, state } in output.expense. Maestro runs scripts in Rhino, so this file
// is ES5.
var auth = http.post(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: XOS_DEMO_PASSWORD }),
});
var token = json(auth.body).access_token;
var headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: "Bearer " + token,
  "Accept-Profile": "app",
};
var res = http.get(
  SUPABASE_URL +
    "/rest/v1/expenses?select=id,amount_minor,expense_state&description=eq." +
    encodeURIComponent(DESCRIPTION),
  { headers: headers },
);
var rows = json(res.body);
var receipts = 0;
for (var i = 0; i < rows.length; i += 1) {
  var r = http.get(
    SUPABASE_URL + "/rest/v1/expense_receipts?select=id,media_uri&expense_id=eq." + rows[i].id,
    {
      headers: headers,
    },
  );
  receipts += json(r.body).length;
}
output.expense = {
  status: res.status,
  expenses: rows.length,
  receipts: receipts,
  amount: rows.length > 0 ? rows[0].amount_minor : null,
  state: rows.length > 0 ? rows[0].expense_state : null,
  body: res.body,
};
