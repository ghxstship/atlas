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
`unstable_rethrow` decides what passes through (redirect, not found, bailouts), and the path is the reset key.

Region wraps:

- Home's tiles (readiness, alerts, recent activity). Each tile's content is a function called inside its Region,
  so an error while building it stays in the tile.
- The record page's panels below the record's own fields: Summarize, the kind's fields, the checklist, assignments,
  related records, actuals, recurrence, field history, and comments and files.
- The shell peek's comments and files and related records, and the custom object peek's activity and comments.
- The comments and attachments of every collection kit panel (`collection-kit/collab.tsx`), around the server
  component that loads them, so a read that throws stays in the panel.

Region and RegionBoundary add under 1 KB of gzip route JavaScript where they render (about 0.3 and 0.7 KB). Of
the key pages Home renders them; the shell and the peek's host do not import them, and the shell peek's sections
load on demand. The two `ui.region` messages join the en-US `ui` catalog that every page carries. After the change
every key page is within budget (`budget:js`: Projects and Inbox 198 KB, Home 183 KB).

## Consequences

- A failing tile, panel or peek section no longer takes down its page: the rest renders and works.
- Every new directory of pages under a shell needs its `template.tsx`; the app's test names it.
- When A129's Dashboard template lands, its tiles render through `TemplateDashboard`; Home's tile helper keeps the
  Region, and the dashboard template's own tiles take one the same way.
- Gateway gains route transitions only; its pages already show `RegionError` for failed reads, and it has no
  record peek or dashboard tiles.
