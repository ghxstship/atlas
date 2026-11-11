# ADR 0118: Route View Transitions and Region Boundaries

- Status: Accepted
- Date: 2026-10-28
- Decider: A143 (RRR-206), trace row S11.7-11
- Migrations: none

## Context

Section 11.7 asks for streamed rendering with skeletons, prefetch, per-region error boundaries and View
Transitions. Atlas and Gateway had skeletons (`loading.tsx`), Next's link prefetch and an `error.tsx` per segment,
so an error anywhere in a page replaced the whole page region, and a navigation swapped the page with no motion
([A65-006](../../legal/qa/findings/A65-006.md)).

Two limits shape the answer. The key pages must stay under the 200 KB route JavaScript budget (ADR 0027), and
`/demo-productions/projects` and `/demo-productions/inbox` sit within 2 KB of it, so nothing can join the shell's
client code. And Next 16 with
React 19.3 supports view transitions without configuration: React's `<ViewTransition>` animates when a
transition, such as a navigation, inserts or removes it.

## Decisions

### 1. Route transitions live in templates, as server components

`@xos/ui/route-transition` exports `RouteTransition`, a `<ViewTransition>` whose `enter` and `exit` are the class
`xos-route` and whose `default` is `none`. It holds no state, so a server component renders it, and React already
ships the element's implementation, so no route gains JavaScript.

Every directory under Atlas's `app/[org]` and Gateway's `app/(shell)` with a page one level down or deeper has a
`template.tsx` that re-exports it (33 in Atlas, 9 in Gateway). Next remounts a template when the segment right below
it changes, so every change of path inside a shell remounts one: the page that leaves exits and the page that
arrives enters. Next remounts that segment's page on such a change anyway, so the template resets no state that was
kept before. `test/route-transitions.test.ts` in each app fails when a directory that needs a template lacks one, or
a template sits where nothing remounts.

Alternatives rejected:

- A client component in the shell keyed by the path. It adds route JavaScript to every key page, and a key on the
  whole path also remounts nested layouts (a project's tabs) on every tab change.
- One `<ViewTransition update>` around the page in the shell layout. It also animates on `router.refresh()`, search
  parameters and live list updates, freezing the page under the snapshot while someone types.

### 2. The motion comes from the tokens and stops under reduced motion

`styles/components.css` fades the leaving page out over `motion.duration.fast` with the exit easing, and fades the
arriving page in over `motion.duration.deliberate` (the route transition duration) with the enter easing, rising
`space.8`. `::view-transition` lets clicks through to the live page.

Under reduced motion no transition animates: `animation: none` on every view transition pseudo-element when the
device asks for reduced motion and `me.reduced_motion` is not `full`, and always when it is `reduce`. Unlike the
other components, which keep an 80 ms fade under reduced motion, a route change swaps at once, as Section 11.7 asks.
React still calls `startViewTransition`, which the CSS cannot prevent; with no animation the transition ends on the
next frame. The journey `e2e/a143-view-transitions.spec.ts` reads the animations the browser runs on the
pseudo-elements: some with motion, none under reduced motion.

### 3. RegionBoundary in packages/ui, Region in Atlas

`RegionBoundary` (`packages/ui`) is a class error boundary. An error while its children render replaces them with
`RegionError`: the danger icon, "This section did not load", "The rest of the page still works", and Retry
(`ui.region.*`, `ui.action.retry`, en-US and es-US). It takes:

- `onError`, called once per caught error;
- `onRetry(reset)`, so the app can fetch again and clear the error in one step;
- `passThrough`, errors that are control flow and go on to the boundary above, unreported;
- `resetKey`, which clears the error when it changes.

Atlas's `components/shell/region.tsx` (`Region`) gives it Next's behavior: `reportClientError` (ADR 0025) reports,
Retry runs `router.refresh()` and `reset` in one transition so a server component's error can recover too,
`unstable_rethrow` decides what passes through (redirect, not found, bailouts), and the path is the reset key. Its
children render inside a Suspense boundary: during the server render an error an async server child throws stops
there, the region renders again in the browser, and Region catches it, instead of the page going to `error.tsx`.

### 4. A failed read fails its region, not the page

A boundary catches only errors thrown while its children render. Most of Atlas's pages read every region's data in
one loader before rendering, and a loader's `must(...)` throws on any failed read, so a boundary alone would leave
one broken read taking down the page. The loaders that read several regions at once therefore return one
`RegionData<T>` per region (`lib/shell/region-data.ts`): the data, or `{ ok: false }`. `regionOf` and
`regionRead` catch a region's failed read, report it on the server through `observability.errors` (tagged
`source: region` and the region's name; the browser reporter skips server errors), and let Next's redirect and not
found through. `RegionFailed` shows the same alert and Retry for such a region, and `RegionContent` renders a
region's data inside a Region, or `RegionFailed` when its read failed; it builds the content as a child of the
Region, so an error while building it stays in the region too.

- Home (`lib/home/data.ts`): each tile reads on its own. Gate readiness feeds the readiness tile, the open blockers
  count and the alerts, so those three fail together; the project counts, today's count and recent activity fail
  alone. The dashboard grid (`components/dashboard/dashboard-grid.tsx`) puts every tile, the checklist and the plan
  included, in its own Region.
- The record page and the work peeks (`components/work/record-detail.tsx`): the kind's attribute values, the
  checklist, assignments, watch, related records with dependencies, actuals, recurrence, state history, replans,
  the punch note, and comments and files are each a region; the field history is worded inside its region. The
  record itself, its properties, its state moves and the edit form still read for the whole page, since without
  them there is no page to show.
- The shell's peek (`lib/shell/peek-actions.ts`): comments and files and related records each fail alone, and Retry
  reads the peek again. The custom object peek's comments do the same; its activity already showed "unavailable".
- The comments and attachments of every collection kit panel (`collection-kit/collab.tsx`) load in an async server
  component inside their Region.

`test/region.test.tsx` (Region with Next's own redirect and not found, the router and reporter replaced, and the
dashboard grid keeping its other tiles) and `test/region-loaders.test.ts` (Home, the record page and the shell peek
with one failing read each) cover Atlas.

Region and RegionBoundary add under 1 KB of gzip route JavaScript where they render (about 0.3 and 0.7 KB). Of
the key pages Home renders them; the shell and the peek's host do not import them, and the shell peek's sections
load on demand. The two `ui.region` messages join the en-US `ui` catalog that every page carries. After the change
every key page is within budget (`budget:js`: Projects and Inbox 198 KB, Home 183 KB).

## Consequences

- A failing tile, panel or peek section no longer takes down its page: the rest renders and works.
- Every new directory of pages under a shell needs its `template.tsx`; the app's test names it.
- A loader that reads another page's regions together returns `RegionData` per region the same way; a page that
  reads one thing keeps `must` and its `error.tsx`.
- Gateway gains route transitions only; its pages already show `RegionError` for failed reads, and it has no
  record peek or dashboard tiles.
