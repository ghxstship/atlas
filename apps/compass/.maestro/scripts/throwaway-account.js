/* global http, json, output, SUPABASE_URL, SUPABASE_ANON_KEY, XOS_DEMO_PASSWORD */
// Journey 38 setup: creates a throwaway account through the auth sign-up endpoint, as Gateway's sign-up
// page does, on an example.com address no seed uses. Local stacks confirm sign-ups at once. Leaves
// { status, email } in output.throwaway. Maestro runs scripts in Rhino, so this file is ES5.
var email = "maestro-delete-" + new Date().getTime() + "@example.com";
var res = http.post(SUPABASE_URL + "/auth/v1/signup", {
  headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: email,
    password: XOS_DEMO_PASSWORD,
    data: { full_name: "Maestro Throwaway" },
  }),
});
output.throwaway = { status: res.status, email: email, id: json(res.body).id };
