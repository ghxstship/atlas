# ADR 0088: Search in Gateway and on Compass Today

- Status: Accepted
- Date: 2026-10-27
- Decider: A126 (RRR-171), trace row S11.10-02
- Migrations: 2190

## Context

Section 11.10 item 1 puts search first in every shell: Cmd or Ctrl+K, and a search field on every
phone Home, finding records, people, pages, settings and actions. A87 (ADR 0043) built it for Atlas
over one org, with `app.global_search` reading under the caller's row level security. Gateway's menu
still listed pages only, and Compass had no search. ADR 0043 left both as follow-ups.

Neither fits A87's shape. A Gateway user is an external party who works with several orgs at once,
and reads engagement data only through the owner-rights `api_external` projections (Section 8.7),
never through row level security on the app tables. A Compass user is often offline.

## Decisions

### 1. Gateway searches the person, not an org, with a definer function

`app.gateway_search(query, org, limit)` is `SECURITY DEFINER`. An invoker function would find
nothing, because external parties have no read policy on `app.engagements` and its children. The
function applies the same Section 8.7 helpers the projections apply, so it returns exactly what the
person reads in Gateway:

- engagements in their engagement area (`private.my_engagement_ids('engagement')`);
- documents of engagements whose documents area is open;
- threads of their engagements and the org-level conversations they are the party of
  (`private.party_side_open`), one result per thread, carrying the message that matched best;
- opportunities they applied to, and opportunities open to them in an org they already work with,
  applied to or talk to.

The last rule is the "orgs the person has a relationship with" boundary. The marketplace stays on
Explore, and search does not turn into a second marketplace search. Nothing returns for a caller who is
not signed in, and an org member with no external relationship gets nothing: staff search in Atlas.
On an org's custom domain Gateway passes that org, and only its rows return (Section 4.4.7).

### 2. Same grammar and ranking as A87

The request is the structured one `@xos/data/search-query` builds: words (each also a prefix),
quoted phrases, exclusions and types. Raw text never reaches the tsquery syntax. Two private helpers,
`private.search_request_tsquery` and `private.search_request_exclusions`, build the tsqueries. The
ranking is ADR 0043's: `ts_rank_cd` over a `simple` tsvector, the title weighted above the body,
times a recency factor with a 45-day decay. Atlas's record operators (status, assignee and the
others) do not apply to Gateway and are left out of the request.

Each person's set is small: their own engagements and threads. So the function filters to it first
and needs no new index.

### 3. Gateway's menu and Home share one server action

`searchGateway` (`apps/gateway/lib/shell/search-actions.ts`) answers both. It returns the
matching actions (verbs on pages the person can open), their rows from `app.gateway_search`, and
personal settings. Each setting opens its section at the field, through `#setting-<key>`. The
command menu (`components/shell/gateway-command.tsx`) loads with the shell overlays on first use, so
cmdk and the search stay out of every page's JavaScript. Pages still filter in the browser, and a
page whose name holds the whole query still comes first, so Enter opens it as before. The Home field
lists the same results under it as the person types. Enter, and the last link, still search Explore,
and without JavaScript the form does that alone.

### 4. Compass searches the device

Today's search (`src/screens/TodaySearch.tsx`) reads the offline store, never the network, so it
works with no signal. It covers the person's shifts, tasks (open onboarding items, deliverables and
shared Task records), records (shared records, purchase orders and incidents), people (the roster),
reference (SOPs, emergency codes, radio channels and zones) and actions their access allows. The store
is read only while something is typed. `src/domain/search.ts` ranks with the same grammar. A code typed
in full ranks first, title words count above body words, and a closeness factor applies with a 45-day
decay. Atlas decays on age; a field worker's next shift matters as much as their last, so Compass
counts the distance from now either way.

## Consequences

- One person-scoped search to keep in step with the `api_external` projections. When a projection's
  row filter changes, `app.gateway_search` changes with it; the pgTAP test (2190) pins the scoping.
- Gateway search has no semantic half. The documents an external party reads are titles, and
  gte-small adds little there.
- Compass finds only what the device holds. A record that never synced to the device is not found
  until it does.
