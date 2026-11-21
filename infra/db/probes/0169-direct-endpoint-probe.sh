#!/usr/bin/env bash
# ADR 0169, work package 0: the direct-endpoint probe.
#
# Sends a handful of requests to one Supabase project through PostgREST, Storage and Realtime and prints one line
# per fact the ADR needs. A person runs it against STAGING after applying 0169-direct-endpoint-probe.sql there.
# infra/db/probes/README.md says how, and what each line means.
#
# Input comes from the environment only. The script takes no arguments, reads no file, and never prints a key
# or a token:
#
#   PROBE_SUPABASE_URL      the project URL, https://<ref>.supabase.co (http is accepted for 127.0.0.1 only)
#   PROBE_PUBLISHABLE_KEY   the project's publishable key
#   PROBE_ACCESS_TOKEN      the access token of a signed-in test person
#   PROBE_APP_TOKEN         optional: an OAuth app token that the same session authorized (question 5)
#
# Needs bash, curl and Node.js 22 or later (for JSON and the Realtime websocket).
#
# Exit status: 0 the probe ran and printed its lines; 2 bad input or a missing tool; 3 the probe objects are not
# installed on that project, or the token was refused.

set -euo pipefail
umask 077

fail() {
  printf 'probe: %s\n' "$1" >&2
  exit "${2:-2}"
}

case "$-" in
  *x*) fail "shell tracing is on (set -x) and would print the token. Turn it off and run again." ;;
esac

[ "$#" -eq 0 ] || fail "this script takes no arguments. Set PROBE_SUPABASE_URL, PROBE_PUBLISHABLE_KEY and PROBE_ACCESS_TOKEN in the environment."

command -v curl >/dev/null 2>&1 || fail "curl is not installed."
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. The probe needs version 22 or later."
node -e 'process.exit(typeof WebSocket === "function" && typeof fetch === "function" ? 0 : 1)' ||
  fail "this Node.js has no built-in WebSocket. The probe needs version 22 or later."

URL="${PROBE_SUPABASE_URL:-}"
KEY="${PROBE_PUBLISHABLE_KEY:-}"
TOKEN="${PROBE_ACCESS_TOKEN:-}"
APP_TOKEN="${PROBE_APP_TOKEN:-}"

[ -n "$URL" ] || fail "PROBE_SUPABASE_URL is not set."
[ -n "$KEY" ] || fail "PROBE_PUBLISHABLE_KEY is not set."
[ -n "$TOKEN" ] || fail "PROBE_ACCESS_TOKEN is not set."

URL="${URL%/}"
if ! [[ "$URL" =~ ^https://[a-z0-9.-]+$ || "$URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  fail "PROBE_SUPABASE_URL must be https://<host> with no path. Plain http is accepted for 127.0.0.1 and localhost only."
fi

# The hosted project named xos-atlas-staging is production (infra/runbooks/promote-to-production.md). Staging is
# a branch with a ref of its own. The probe never runs against production.
PRODUCTION_REF="fquuqnzlpobaawucczgq"
case "$URL" in
  *"$PRODUCTION_REF"*) fail "PROBE_SUPABASE_URL is the production project. The probe runs on the staging branch only." ;;
esac

# Keys and tokens are base64url, dots and underscores. Anything else is refused before it reaches a request.
secret_shape='^[A-Za-z0-9._~+/=-]+$'
[[ "$KEY" =~ $secret_shape ]] || fail "PROBE_PUBLISHABLE_KEY has characters a key never has."
[[ "$TOKEN" =~ $secret_shape ]] || fail "PROBE_ACCESS_TOKEN has characters a token never has."
if [ -n "$APP_TOKEN" ]; then
  [[ "$APP_TOKEN" =~ $secret_shape ]] || fail "PROBE_APP_TOKEN has characters a token never has."
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/probe-0169.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Addresses from the documentation ranges (RFC 5737). No machine has them, so they can only come from this script.
SPOOF_FORWARDED="203.0.113.77"
SPOOF_REAL_IP="203.0.113.78"

# A header value the size of the planned attestation header: 256 hex characters. Not a secret.
MARK="$(od -An -N128 -tx1 /dev/urandom | tr -d ' \n')"
RUN="run$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

line() {
  printf '%-34s %s\n' "$1" "$2"
}

# call <token> <method> <path> <json body or ""> <output prefix> [extra header]...
# The key and the token reach curl on its standard input, never on its command line. Responses hold neither.
call() {
  local token="$1" method="$2" path="$3" body="$4" out="$5"
  shift 5
  local header code
  code="$(
    {
      printf 'url = "%s%s"\n' "$URL" "$path"
      printf 'request = "%s"\n' "$method"
      printf 'header = "apikey: %s"\n' "$KEY"
      printf 'header = "Authorization: Bearer %s"\n' "$token"
      for header in "$@"; do
        printf 'header = "%s"\n' "$header"
      done
      if [ -n "$body" ]; then
        printf 'data = "%s"\n' "${body//\"/\\\"}"
      fi
    } | curl --silent --show-error --max-time 30 --config - \
      --output "$out.body" --dump-header "$out.headers" --write-out '%{http_code}' 2>"$out.error"
  )" || code="000"
  printf '%s' "$code" >"$out.status"
  [ -f "$out.body" ] || : >"$out.body"
  [ -f "$out.headers" ] || : >"$out.headers"
}

rest() {
  # rest <token> <mode> <output prefix> [extra header]...
  local token="$1" mode="$2" out="$3"
  shift 3
  call "$token" POST /rest/v1/rpc/probe_0169 "{\"mode\":\"$mode\"}" "$out" \
    "Content-Profile: api_public" "Content-Type: application/json" "$@"
}

# json <file> <dotted path>: prints the value at that path; strings bare, everything else as JSON; nothing if absent.
json() {
  node -e '
    const fs = require("fs");
    let value;
    try { value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    for (const key of process.argv[2].split(".")) {
      if (value === null || typeof value !== "object" || !(key in value)) process.exit(0);
      value = value[key];
    }
    if (value === null || value === undefined) process.exit(0);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1" "$2"
}

# One line of a response body, cut to a length that fits a terminal, with no line breaks.
body_line() {
  tr -d '\r' <"$1" | tr '\n' ' ' | cut -c1-400
}

host="${URL#*://}"
line "target.host" "$host"
line "target.run" "$RUN"

# ----------------------------------------------------------------------------------------------------------
# Preflight: the probe function answers for this token.
# ----------------------------------------------------------------------------------------------------------
rest "$TOKEN" echo "$WORK/plain1" "X-Xos-Probe: $MARK"
status="$(cat "$WORK/plain1.status")"
line "rest.echo.status" "$status"
case "$status" in
  200) ;;
  000) fail "no answer from $host: $(body_line "$WORK/plain1.error")" 3 ;;
  401 | 403) fail "the project refused the token (HTTP $status). Sign the test person in again and set PROBE_ACCESS_TOKEN." 3 ;;
  404) fail "the probe function is not on this project (HTTP 404). Apply 0169-direct-endpoint-probe.sql to staging first, and check PROBE_SUPABASE_URL names staging." 3 ;;
  *) fail "unexpected HTTP $status from the probe function: $(body_line "$WORK/plain1.body")" 3 ;;
esac

line "rest.database_role" "$(json "$WORK/plain1.body" database_role)"
line "rest.header_names" "$(json "$WORK/plain1.body" header_names)"
line "rest.address_headers" "$(json "$WORK/plain1.body" address_headers | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    const headers = text ? JSON.parse(text) : {};
    delete headers["x-xos-probe"];
    process.stdout.write(JSON.stringify(headers));
  });
')"

# ----------------------------------------------------------------------------------------------------------
# Question 1: the forwarded address chain PostgREST hands the database, and how many trusted proxies follow the
# caller's own address in it.
# ----------------------------------------------------------------------------------------------------------
rest "$TOKEN" echo "$WORK/plain2"
rest "$TOKEN" echo "$WORK/spoof" "X-Forwarded-For: $SPOOF_FORWARDED" "X-Real-IP: $SPOOF_REAL_IP"

node -e '
  const fs = require("fs");
  const [work, spoofForwarded, spoofRealIp] = process.argv.slice(1);
  const line = (key, value) => console.log(key.padEnd(34) + " " + value);
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(`${work}/${name}.body`, "utf8")); } catch { return {}; }
  };
  const chain = (body) =>
    String((body.address_headers ?? {})["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const plain1 = chain(read("plain1"));
  const plain2 = chain(read("plain2"));
  const spoofBody = read("spoof");
  const spoof = chain(spoofBody);
  const realIpPlain = (read("plain1").address_headers ?? {})["x-real-ip"] ?? "";
  const realIpSpoof = (spoofBody.address_headers ?? {})["x-real-ip"] ?? "";

  line("Q1.chain.plain", plain1.join(", ") || "(none)");
  line("Q1.chain.plain_again", plain2.join(", ") || "(none)");
  line("Q1.chain.spoofed", spoof.join(", ") || "(none)");
  line("Q1.x_real_ip.plain", realIpPlain || "(none)");
  line("Q1.x_real_ip.spoofed", realIpSpoof || "(none)");

  let verdict;
  let own = "";
  let hops = -1;
  if (plain1.length === 0) {
    verdict = "not-proven: no X-Forwarded-For reaches the database";
  } else if (plain1.length !== plain2.length || plain1[0] !== plain2[0]) {
    verdict = "not-proven: two identical requests gave chains of different length or a different first address";
  } else {
    own = plain1[0];
    hops = plain1.length - 1;
    const place = spoof.length - 1 - hops;
    if (place < 0 || spoof[place] !== own) {
      verdict = "not-proven: a client-sent X-Forwarded-For moved or replaced the address at the trusted place";
      hops = -1;
    } else if (spoof.includes(spoofForwarded) && spoof.indexOf(spoofForwarded) >= place) {
      verdict = "not-proven: the client-sent address sits at or right of the trusted place";
      hops = -1;
    } else {
      verdict = spoof.includes(spoofForwarded)
        ? "consistent: the gateway appends; client-sent entries stay on the left"
        : "consistent: the gateway replaces a client-sent chain";
    }
  }
  line("Q1.own_address", own || "(unknown)");
  line("Q1.trusted_proxy_hops", hops >= 0 ? String(hops) : "(unknown)");
  line("Q1.verdict", verdict);
  line("Q1.x_real_ip.verdict",
    !realIpPlain ? "absent"
      : realIpSpoof === spoofRealIp ? "client-controlled: a client-sent X-Real-IP reaches the database"
      : realIpSpoof === realIpPlain ? "set by the gateway; a client-sent value is replaced"
      : "unclear: it changed between requests");
  fs.writeFileSync(`${work}/own`, hops >= 0 ? own : "");
  fs.writeFileSync(`${work}/hops`, hops >= 0 ? String(hops) : "");
' "$WORK" "$SPOOF_FORWARDED" "$SPOOF_REAL_IP"

OWN="$(cat "$WORK/own")"
HOPS="$(cat "$WORK/hops")"

# ----------------------------------------------------------------------------------------------------------
# Question 2: a custom request header reaches the database through the gateway and PostgREST.
# ----------------------------------------------------------------------------------------------------------
seen="$(json "$WORK/plain1.body" address_headers.x-xos-probe)"
if [ "$seen" = "$MARK" ]; then
  line "Q2.custom_header" "reached: 256 characters sent, the same 256 read in the database"
elif [ -n "$seen" ]; then
  line "Q2.custom_header" "altered: ${#MARK} characters sent, ${#seen} read in the database"
else
  line "Q2.custom_header" "not-reached: the database saw no X-Xos-Probe header"
fi

# ----------------------------------------------------------------------------------------------------------
# Question 3a: what a storage.objects policy can read. Each request asks one yes or no question in the object
# name. The policy never admits the object: a yes comes back as "KeyAlreadyExists", a no as "AccessDenied".
# ----------------------------------------------------------------------------------------------------------
storage_ask() {
  # storage_ask <question> <output name> [extra header]...
  local question="$1" out="$WORK/storage.$2"
  shift 2
  call "$TOKEN" POST "/storage/v1/object/probe-0169/$question" "x" "$out" \
    "Content-Type: text/plain" "X-Xos-Probe: $MARK" "$@"
  local code
  code="$(json "$out.body" code)"
  [ -n "$code" ] || code="$(json "$out.body" error)"
  case "$code" in
    KeyAlreadyExists | Duplicate) printf 'yes' ;;
    AccessDenied | Unauthorized) printf 'no' ;;
    *) printf 'unanswered (HTTP %s: %s)' "$(cat "$out.status")" "$(body_line "$out.body")" ;;
  esac
}

storage_open="$(storage_ask open open)"
storage_closed="$(storage_ask closed closed)"
if [ "$storage_open" = "yes" ] && [ "$storage_closed" = "no" ]; then
  line "Q3a.storage.policy_evaluated" "yes"
  line "Q3a.storage.headers" "$(storage_ask headers headers)"
  line "Q3a.storage.claims" "$(storage_ask claims claims)"
  line "Q3a.storage.claim.session_id" "$(storage_ask claim:session_id claim-session)"
  line "Q3a.storage.claim.aal" "$(storage_ask claim:aal claim-aal)"
  line "Q3a.storage.x_forwarded_for" "$(storage_ask header:x-forwarded-for xff)"
  line "Q3a.storage.x_real_ip" "$(storage_ask header:x-real-ip real-ip)"
  line "Q3a.storage.custom_header" "$(storage_ask header:x-xos-probe custom)"
  if [ -n "$OWN" ]; then
    storage_place="none"
    for place in 0 1 2 3; do
      if [ "$(storage_ask "xff:$place:$OWN" "place$place")" = "yes" ]; then
        storage_place="$place"
        break
      fi
    done
    line "Q3a.storage.own_address_hops" "$storage_place"
    if [ "$storage_place" = "none" ]; then
      line "Q3a.storage.holds_when_spoofed" "unanswered (the caller's address is not in the chain)"
    else
      line "Q3a.storage.holds_when_spoofed" "$(storage_ask "xff:$storage_place:$OWN" spoofed "X-Forwarded-For: $SPOOF_FORWARDED")"
    fi
    line "Q3a.storage.x_real_ip_is_own" "$(storage_ask "is:x-real-ip:$OWN" real-ip-own)"
  else
    line "Q3a.storage.own_address_hops" "unanswered (question 1 gave no address to look for)"
    line "Q3a.storage.holds_when_spoofed" "unanswered (question 1 gave no address to look for)"
    line "Q3a.storage.x_real_ip_is_own" "unanswered (question 1 gave no address to look for)"
  fi
else
  line "Q3a.storage.policy_evaluated" "no: open=$storage_open closed=$storage_closed"
fi

# ----------------------------------------------------------------------------------------------------------
# Questions 3b and 3c: what a realtime.messages policy can read when a private channel is joined, and what a
# table policy can read when Realtime decides whether to deliver a Postgres change.
# The websocket URL carries the publishable key, as every Supabase client sends it. The token travels inside
# the join message.
# ----------------------------------------------------------------------------------------------------------
PROBE_SUPABASE_URL="$URL" PROBE_PUBLISHABLE_KEY="$KEY" PROBE_ACCESS_TOKEN="$TOKEN" \
  PROBE_RUN="$RUN" PROBE_OWN="$OWN" PROBE_SPOOF="$SPOOF_FORWARDED" node --input-type=module - <<'REALTIME' || line "Q3b.realtime" "unanswered (the websocket client stopped early)"
const url = process.env.PROBE_SUPABASE_URL;
const key = process.env.PROBE_PUBLISHABLE_KEY;
const token = process.env.PROBE_ACCESS_TOKEN;
const run = process.env.PROBE_RUN;
const own = process.env.PROBE_OWN;
const spoofed = process.env.PROBE_SPOOF;
const line = (name, value) => console.log(name.padEnd(34) + " " + value);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const address = `${url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
const replies = new Map();
const delivered = new Set();
let subscribed = null;
let reference = 0;

// connect(headers): one websocket. Node's WebSocket takes request headers as an option, which a browser cannot.
const connect = async (headers) => {
  const socket = headers ? new WebSocket(address, { headers }) : new WebSocket(address);
  socket.addEventListener("message", (message) => {
    let frame;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return;
    }
    if (frame.event === "phx_reply" && replies.has(frame.ref)) {
      replies.get(frame.ref)(frame.payload ?? {});
      replies.delete(frame.ref);
    } else if (frame.event === "system" && frame.payload?.extension === "postgres_changes") {
      subscribed = frame.payload.status === "ok" ? "ok" : `error: ${String(frame.payload.message ?? "").slice(0, 200)}`;
    } else if (frame.event === "postgres_changes") {
      const record = frame.payload?.data?.record;
      if (record?.run === run) delivered.add(record.question);
    }
  });
  const opened = await Promise.race([
    new Promise((resolve) => socket.addEventListener("open", () => resolve("open"))),
    new Promise((resolve) => socket.addEventListener("error", () => resolve("error"))),
    pause(15000).then(() => "timeout"),
  ]);
  return opened === "open" ? socket : opened;
};

const socket = await connect();
if (typeof socket === "string") {
  line("Q3b.realtime.policy_evaluated", `unanswered (the websocket did not open: ${socket})`);
  line("Q3c.changes.subscribed", "unanswered (the websocket did not open)");
  process.exit(0);
}

const join = (through, topic, config) =>
  new Promise((resolve) => {
    const ref = String(++reference);
    replies.set(ref, resolve);
    through.send(JSON.stringify({ topic, event: "phx_join", payload: { config, access_token: token }, ref, join_ref: ref }));
    setTimeout(() => {
      if (replies.delete(ref)) resolve({ status: "timeout" });
    }, 15000);
  });

const base = { broadcast: { ack: false, self: false }, presence: { key: "", enabled: false }, postgres_changes: [] };
const ask = async (question, through = socket) => {
  const reply = await join(through, `realtime:probe-0169:${question}`, { ...base, private: true });
  if (reply.status === "ok") return "yes";
  const reason = String(reply.response?.reason ?? reply.status ?? "");
  if (/do not have permissions to read/i.test(reason)) return "no";
  return `unanswered (${reason.slice(0, 200) || "no reason given"})`;
};

const open = await ask("open");
const closed = await ask("closed");
if (open === "yes" && closed === "no") {
  line("Q3b.realtime.policy_evaluated", "yes");
  line("Q3b.realtime.headers", await ask("headers"));
  line("Q3b.realtime.claims", await ask("claims"));
  line("Q3b.realtime.claim.session_id", await ask("claim:session_id"));
  line("Q3b.realtime.claim.aal", await ask("claim:aal"));
  line("Q3b.realtime.x_forwarded_for", await ask("header:x-forwarded-for"));
  line("Q3b.realtime.x_real_ip", await ask("header:x-real-ip"));
  if (own) {
    let place = "none";
    for (const candidate of [0, 1, 2, 3]) {
      if ((await ask(`xff:${candidate}:${own}`)) === "yes") {
        place = String(candidate);
        break;
      }
    }
    line("Q3b.realtime.own_address_hops", place);
    if (place === "none") {
      line("Q3b.realtime.holds_when_spoofed", "unanswered (the caller's address is not in the chain)");
    } else {
      const second = await connect({ "X-Forwarded-For": spoofed });
      if (typeof second === "string") {
        line("Q3b.realtime.holds_when_spoofed", `unanswered (a websocket with a client-sent chain did not open: ${second})`);
      } else {
        line("Q3b.realtime.holds_when_spoofed", await ask(`xff:${place}:${own}`, second));
        second.close();
      }
    }
    line("Q3b.realtime.x_real_ip_is_own", await ask(`is:x-real-ip:${own}`));
  } else {
    line("Q3b.realtime.own_address_hops", "unanswered (question 1 gave no address to look for)");
    line("Q3b.realtime.holds_when_spoofed", "unanswered (question 1 gave no address to look for)");
    line("Q3b.realtime.x_real_ip_is_own", "unanswered (question 1 gave no address to look for)");
  }
} else {
  line("Q3b.realtime.policy_evaluated", `no: open=${open} closed=${closed}`);
}

// Realtime starts reading a table some seconds after it joins the publication, and misses changes written before
// that. So the rows are written up to three times, each time on a fresh subscription, until the "open" row arrives.
let subscribedLine = "";
let written = "";
for (let attempt = 1; attempt <= 3 && !delivered.has("open"); attempt += 1) {
  subscribed = null;
  const changes = await join(socket, `realtime:probe-0169-changes-${attempt}`, {
    ...base,
    postgres_changes: [{ event: "INSERT", schema: "probe_0169", table: "changes" }],
    private: false,
  });
  if (changes.status !== "ok") {
    subscribedLine = `no: ${String(changes.response?.reason ?? changes.status).slice(0, 200)}`;
    break;
  }
  for (let waited = 0; subscribed === null && waited < 20000; waited += 250) await pause(250);
  subscribedLine = subscribed ?? "no: Realtime did not confirm the subscription within 20 seconds";
  if (subscribed !== "ok") break;
  const emitted = await fetch(`${url}/rest/v1/rpc/probe_0169`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Profile": "api_public",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "emit", run }),
  });
  written = emitted.ok ? `${(await emitted.json()).rows} (attempt ${attempt})` : `none (HTTP ${emitted.status})`;
  if (!emitted.ok) break;
  for (let waited = 0; waited < 12000 && !(delivered.has("open") && waited >= 4000); waited += 250) await pause(250);
}
line("Q3c.changes.subscribed", subscribedLine);
if (written) line("Q3c.changes.rows_written", written);
if (subscribedLine === "ok" && written && !written.startsWith("none")) {
  const verdict = (question) => (delivered.has(question) ? "yes" : "no");
  if (delivered.has("open") && !delivered.has("closed")) {
    line("Q3c.changes.policy_evaluated", "yes");
    line("Q3c.changes.headers", verdict("headers"));
    line("Q3c.changes.claims", verdict("claims"));
    line("Q3c.changes.claim.session_id", verdict("claim:session_id"));
    line("Q3c.changes.claim.aal", verdict("claim:aal"));
    line("Q3c.changes.claim.amr", verdict("claim:amr"));
    line("Q3c.changes.x_forwarded_for", verdict("header:x-forwarded-for"));
    line("Q3c.changes.x_real_ip", verdict("header:x-real-ip"));
  } else {
    line("Q3c.changes.policy_evaluated", `no: delivered=[${[...delivered].sort().join(", ")}]`);
  }
}
socket.close();
process.exit(0);
REALTIME

# ----------------------------------------------------------------------------------------------------------
# Question 4: the HTTP status and body of a request the database refuses whole with SQLSTATE PGRST.
# ----------------------------------------------------------------------------------------------------------
rest "$TOKEN" refuse "$WORK/refuse"
refuse_status="$(cat "$WORK/refuse.status")"
refuse_code="$(json "$WORK/refuse.body" code)"
refuse_hint="$(json "$WORK/refuse.body" hint)"
line "Q4.refusal.status" "$refuse_status"
line "Q4.refusal.body" "$(body_line "$WORK/refuse.body")"
line "Q4.refusal.content_type" "$(tr -d '\r' <"$WORK/refuse.headers" | grep -i '^content-type:' | head -n 1 | cut -d' ' -f2- || true)"
if grep -qi '^x-xos-probe-refusal:' "$WORK/refuse.headers"; then
  line "Q4.refusal.response_header" "passed through"
else
  line "Q4.refusal.response_header" "dropped"
fi
if [ "$refuse_status" = "401" ] && [ "$refuse_code" = "XS401" ] && [ "$refuse_hint" = "session_ended" ]; then
  line "Q4.verdict" "as-designed: HTTP 401 with code XS401 and the reason as hint"
elif [ "$refuse_status" = "401" ]; then
  line "Q4.verdict" "status-only: HTTP 401, but the body does not carry code XS401 and the hint"
else
  line "Q4.verdict" "different: the refusal did not arrive as HTTP 401"
fi

# ----------------------------------------------------------------------------------------------------------
# Question 5: the claims of the person's session token, and of an OAuth app token when one is given.
# ----------------------------------------------------------------------------------------------------------
claims_lines() {
  local prefix="$1" file="$2"
  line "$prefix.claim_names" "$(json "$file" claim_names)"
  line "$prefix.role" "$(json "$file" claims.role)"
  line "$prefix.aal" "$(json "$file" claims.aal)"
  line "$prefix.amr_methods" "$(json "$file" claims.amr_methods)"
  line "$prefix.amr_has_timestamps" "$(json "$file" claims.amr_has_timestamps)"
  line "$prefix.lifetime_seconds" "$(json "$file" claims.lifetime_seconds)"
  line "$prefix.session_id_present" "$(json "$file" claims.session_id_present)"
  line "$prefix.session_id_fingerprint" "$(json "$file" claims.session_id_fingerprint)"
  line "$prefix.session_row_exists" "$(json "$file" claims.session_row_exists)"
  line "$prefix.client_id_present" "$(json "$file" claims.client_id_present)"
}

claims_lines "Q5.session" "$WORK/plain1.body"

if [ -z "$APP_TOKEN" ]; then
  line "Q5.app" "skipped: PROBE_APP_TOKEN is not set or is empty"
  line "Q5.verdict" "unanswered: no app token was sent, so question 5 is still open; do step 4 of the README and run again"
else
  rest "$APP_TOKEN" echo "$WORK/app"
  app_status="$(cat "$WORK/app.status")"
  line "Q5.app.status" "$app_status"
  if [ "$app_status" = "200" ]; then
    claims_lines "Q5.app" "$WORK/app.body"
    session_print="$(json "$WORK/plain1.body" claims.session_id_fingerprint)"
    app_print="$(json "$WORK/app.body" claims.session_id_fingerprint)"
    if [ -z "$app_print" ]; then
      line "Q5.verdict" "no-session: the app token names no session"
    elif [ "$app_print" = "$session_print" ]; then
      line "Q5.verdict" "names-authorizing-session: the app token carries the session id of PROBE_ACCESS_TOKEN"
    else
      line "Q5.verdict" "other-session: the app token names a session that is not the one in PROBE_ACCESS_TOKEN"
    fi
  else
    line "Q5.app.body" "$(body_line "$WORK/app.body")"
    line "Q5.verdict" "unanswered: the app token did not reach the probe function, so question 5 is still open"
  fi
fi

# ----------------------------------------------------------------------------------------------------------
# What the answers select. README.md has the table.
# ----------------------------------------------------------------------------------------------------------
if [ -n "$HOPS" ]; then
  line "BRANCH.address_source" "edge is available: confirm Q1.own_address is your public address, then xos.trusted_proxy_hops = $HOPS"
else
  line "BRANCH.address_source" "pass: the hosted address chain is not proven"
fi
line "DONE" "now run 0169-direct-endpoint-probe.teardown.sql on the same database"
