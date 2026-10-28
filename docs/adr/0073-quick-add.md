# ADR 0073: Quick Add

- Status: Accepted
- Date: 2026-10-24
- Decider: A116 (RRR-161), trace rows S11.7-06 and S11.4-02 (QuickAdd part)
- Resolves: the quick add part of finding A65-006
- Migrations: none

## Context

Section 11.7 says typing in any create field parses date phrases ("Friday 8am"), `@person`, `#tag`, `/kind` and
`~scope`, and shows the parsed tokens as chips before saving. `QuickAdd` with chrono-node existed in `packages/ui`,
but no create field used it (A65-006). It parsed English only, on the device's clock, and kept every token whether
or not it named anything.

Three facts of the data model shape the decisions below:

- **Records have no free-form tags.** A record's classification is its canon category (`urid`, Section 3.6), which
  also fixes its XYZ schema-family tag. Shifts are classified by their canon role (`role_code`). This package adds no
  migration.
- **Records and shifts belong to a project.** A scope node (`app.scope_nodes`) belongs to exactly one project, and
  every project has an engagement root coded `{KEY}-E01`.
- **Times typed into a create form are the project's local times.** The New record sheet and the New shift drawer
  read their date fields in the project's zone.

## Decisions

### 1. What each token sets

| Token     | Record (records and tasks)                                                                                | Shift                                               |
| --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Date      | One date: when it is due. A range: when it starts and ends.                                               | Its call and end. Without an end time: eight hours. |
| `@person` | The owner: an org member the caller can read. `@me` is them.                                              | The person: a membership the caller can read.       |
| `#tag`    | The canon category, by URID or name. It also gives the XYZ tag.                                           | The canon role, by code or job title.               |
| `/kind`   | The record kind, by canon name or its label in the person's language, among the kinds the page creates.   | Nothing: a shift has one kind.                      |
| `~scope`  | The scope node, by code, by name, or by project key for the engagement root. Its project is the record's. | The same, and its project is the shift's.           |

- A day with no time is due at 17:00, starts at 08:00 and ends at 17:00. A shift's day with no time is called at
  08:00, as the New shift drawer defaults.
- A line sets one of each token. A second date, person, tag, kind or scope stays in the title as typed.
- A shift has no title. Words that are not tokens refuse the save with a hint to name the role with `#`, rather
  than being dropped.

Alternatives rejected: a new tags table for records (no migration in this package, and no spec section defines
record tags); reading `#` as the record subtype (subtypes are kind-scoped and would change meaning with `/kind`).

### 2. Where a token may resolve, and who decides

- `resolveQuickAddAction` (`apps/atlas/lib/quick-add/actions.ts`) reads every list with the caller's own client:
  members through `listPeopleRefs` or `listCrewMembers`, scope nodes through `listScopeNodes`, kept to projects
  `listProjectRefs` returns. Row level security therefore decides what can be offered. A person or scope the caller
  cannot read is never a candidate, and its token stays in the title as text.
- The caller must hold the capability that creates what the line describes (`work.record.write` or
  `crew.shift.write`).
- On a project's pages (a project tab, the project filter, or a Create menu opened under `/p/{KEY}`), scope
  candidates come from that project only.
- Matching runs one rule at a time and stops at the first that matches anything: an exact code, a whole name, any
  word of a name, the start of a name. One match resolves. Several offer a choice of up to eight in the chip. None
  leaves the token as text.
- The create actions check the ids again: the owner or person must be in the caller's list, the category or role in
  canon, and the scope in a readable project. A scope in another project than the page's is refused, not moved.
  The database still decides every write.

### 3. Dates: the person's language, the org's calendar, the project's clock

- `parseQuickAdd` uses chrono's Spanish parser for `es-*` locales and its English parser otherwise. It imports
  `chrono-node/en` and `chrono-node/es` only, about 18 KB gzipped.
- Relative phrases count from the org's calendar (`locale.time_zone` at the org, as `getOrgTimeZone` reads it). A
  project tab or a filtered page uses that project's zone, as the page's own "today" does.
- The parser returns the wall clock: the day, and the time when one was named. The server turns it into an
  instant in the zone of the project the record or shift lands in, so "8am" is 8:00 at the venue, as the create
  forms read typed times. A phrase that names its own zone ("9pm EST") is read on the line's zone instead.
- A time skipped by a daylight saving change reads as the same time after it. A repeated time reads as its first
  occurrence.

### 4. Ambiguous tokens

- A sigil counts only at the start of a word, so `dana@example.com`, `and/or` and `w/crew` stay text. A person or
  kind starts with a letter, and a tag starts with a letter or is a URID, so `Dock #1` stays text.
- Short words that are dates and ordinary words stay text on their own: `Sun`, `sat`, `wed`, `may`, `night` in
  English, and `mar`, `dom`, `sol` in Spanish. With a time or a number ("Sun 8am", "mar 3") they parse.
- Numeric dates follow the locale: month first in English, day first in Spanish. The other order, and `24/7`, stay
  text.
- "Day after tomorrow" and "pasado mañana", which chrono reads as tomorrow, read as two days on.
- The word that only joins a date to the title ("by", "at", "el", "a") leaves with the date.

### 5. Where quick add lives

- `packages/ui`: `parseQuickAdd`, the `useQuickAdd` hook (parse, a resolver called once per token after typing
  pauses for 250 ms, dismissed tokens, chosen candidates), `QuickAddChips` and `QuickAdd`. `@xos/ui/quick-add`
  exports the server-safe part (token shapes, keys, folding unresolved tokens back, zoned instants) without chrono.
- Atlas: the inline row of every record collection (All records, By kind, Milestones, Calendar, Timeline, and the
  project Work and Schedule tabs) and of Crew Shifts and Schedule, plus the Create menu.
- In the Create menu the search field is the title field. A line with any token shows its chips and a single
  action that creates a Task (or the `/kind`) and opens it. Plain words still filter the menu's kinds, and offer
  the quick add action only when no kind matches, so C, a kind's name and Enter open that kind's create flow as
  before.
- The rows load through `next/dynamic` for people who may create there, so the parser stays out of the route's first
  JavaScript (ADR 0027). The Create menu already loads the first time it opens.
- Quick add adds no message to the shared `ui` catalog. That catalog is compiled into every page's first JavaScript,
  and on batch-c 32f29903 it was 55 characters short of 10,000, the size at which the compiler emits it as
  `JSON.parse` with quoted keys: about 190 bytes more on every route, while Projects had 141 bytes left of its
  200 KB budget. The chips' sentences (a chip's name, the announcement, the candidate list) come from the app as
  `copy`, from `work.quickAdd` in Atlas, which reaches the page with its messages. Without `copy`, chips are named
  as typed and the announcement lists the title and the chips, so no untranslated sentence appears.

### 6. Accessibility

- Each chip's remove button and candidate list are reachable with Tab. Removing a chip turns its token back into
  text and returns focus to the field.
- Chips are named by what they set ("Owner: Dana Kim", "When: Fri, Oct 9, 8:00 AM"); their remove buttons read
  "Remove Owner: Dana Kim" through the existing `chip.remove` message. A status region announces the title and
  fields once typing pauses for 600 ms, and the new record's key after saving.

## Consequences

- Plain create is unchanged: the New record sheet, the New shift drawer and the Create menu's kind entries work as
  before, and a line with no tokens in a row creates a record of the page's kind with only its title.
- Spanish copy and parsing ship with en-US. Beta locales parse dates with the English parser until chrono's parser
  for their language is added the same way.
- A record created from a line is Proposed, like one created from the sheet. Phase, subtype and URID by number stay
  in the sheet and the record.
