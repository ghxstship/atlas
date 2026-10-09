# XOS Design System

The shared design language for Atlas 4.0, Gateway 4.0 and Compass 4.0. Calm, dense, keyboard-first and fast: dark by default with a full light theme, restrained color, crisp 1 px borders, small legible type and generous use of the command menu.

Source: XOS 4.0 Build Prompt v1.6, Section 11 (2026-10-08), with canon from the XOS 4.0 Bible and the Standard Library. This system is the Claude Design deliverable named in Section 11.5, item 1, and is ready for export to `design/` and the `packages/*` workspaces; see HANDOFF.md for the file map, production library mapping and CI gates. `tokens.json` is the source of truth for `packages/tokens`; every white-label override operates on these tokens only. The aesthetic follows the Linear style as an original implementation and copies no Linear assets, icons, logos or brand colors.

## Principles

1. **Keyboard first.** Cmd or Ctrl+K opens the command menu everywhere. Every action has a shortcut, and `?` shows the shortcut sheet. G then a letter navigates between modules, C creates a record, J and K move through lists, X selects.
2. **Speed is a feature.** Interactive in under 1.5 s, 10,000-row lists at 60 fps, optimistic mutations within 100 ms. No blocking spinner for actions under 1 s.
3. **Density with clarity.** Base UI text is 13 px. Table rows are 36 px (`row-compact` 32 px, `row-comfortable` 44 px). Properties render as inline chips that edit in place.
4. **One record anatomy.** Title, kind and state; a 320 px property column; activity and comments; related records. Same layout in the side peek and the full page.
5. **Views over pages.** List, Board, Timeline, Calendar and Table on every collection, offered only when the data fits.
6. **Motion with purpose.** 120 to 200 ms, ease-out, and always respectful of `prefers-reduced-motion`.

## Content fundamentals

- **Casing.** Proper names, taxonomy labels, item names, enum display values and button labels are Title Case: Create Record, In Review, Line Array Package. Descriptions, help text and messages are sentence case and end with a period.
- **Ampersand.** Keep & in Title Case labels (Document & Asset Library). Write "and" in sentence-case prose.
- **Locale.** American English. Canceled, never Cancelled. License, authorization, program.
- **Punctuation.** No em dashes anywhere. Dimensions read 3 ft x 3 ft 2 in.
- **Plain words before codes.** Codes never appear alone. Gates read "Gate 3 · Advance", never "ADV". Disciplines read "Audio" with `5000.01` in a mono chip (PhaseChip, DepartmentChip, URIDChip).
- **Element, not atom.** The catalog unit is an element.
- **Silence rule.** A blank price is Unpriced and a zero is a claim. NULL never renders as $0.00 or an empty string. An opportunity with no posted compensation shows Rate on Request. Refusals render as `NO_ANSWER`, `UNRATIFIED` or `REFUSE` with a reason (RefusalNotice).
- **Buttons** are at most three words, verb first.
- **Empty states** are one sentence and one button: "No shifts yet. Post a crew call."
- **Errors** name the field, the problem and the fix in one sentence.
- **Coded lists** (GL accounts, disciplines, categories, criteria, cost centers, items, emergency codes) always sort in numeric order.

## Visual foundations

### Color

Three themes: Dark (first and default), Light (complete), and Sunlight, the Compass maximum-contrast theme with no translucency and thicker borders. System follows the OS and is the default for new users. Sunlight values are derived from Light (decision D3); every Sunlight text pair passes AA, with a 4.78:1 minimum. Each theme sets `color-scheme` so native controls, scrollbars and autofill match.

| Role | Tokens | Rule |
| --- | --- | --- |
| Grounds | `bg-canvas`, `bg-surface`, `bg-raised`, `bg-hover` | Canvas for pages, surface for sidebar and grouped regions, raised for cards, menus and dialogs, hover for hovered and selected rows. |
| Lines | `border-subtle`, `border-strong`, `border-control` | Subtle for every hairline, strong for dividers that need weight, control for the boundary of every input, checkbox, radio, switch and select (3:1 or higher). Elevation is border-first. |
| Text | `text-primary`, `text-secondary`, `text-tertiary` | Primary for content, secondary for labels and metadata, tertiary for input hint text and timestamps. |
| Accent | `accent-default`, `accent-text-on`, `focus-ring` | Accent is a fill: the one primary button, the active marker, selection. Focus is a 2 px `focus-ring` outline with 2 px offset. |
| Text on color | `accent-text`, `danger-text`, `warning-text`, `success-text` | The only tokens that color text with a hue: links, inline errors, status words. Each passes 4.5:1 on every ground in every theme. |
| Label on a fill | `accent-text-on`, `danger-text-on` | Text and icons on an accent or danger fill. `danger-text-on` is the canvas color, so it passes 4.5:1 on `danger` in every theme. |
| Signal | `danger`, `warning`, `success` | Fills and icons. Always paired with an icon or shape; text uses the matching `-text` token. |

**Record states** pair a shape with a hue so state never relies on color alone (StateIcon, StateChip):

| State | Icon | Token |
| --- | --- | --- |
| Proposed | Dashed circle | `state-proposed` (Neutral) |
| Ready | Empty circle | `state-ready` (Neutral strong) |
| Scheduled | Clock circle | `state-scheduled` (Blue) |
| Active | Half circle | `state-active` (Accent) |
| Blocked | Octagon | `state-blocked` (Danger) |
| In Review | Eye circle | `state-in-review` (Violet) |
| Complete | Check circle | `state-complete` (Success) |
| Deferred | Pause circle | `state-deferred` (Warning) |
| Canceled | Slashed circle | `state-canceled` (Tertiary) |

**Data visualization.** Categorical series use `viz-cat-1` to `viz-cat-7` in that order, an Okabe-Ito order themed per ground (dark steps are deepened so every hue clears 3:1 against `bg-canvas`). Any remainder beyond seven series rolls into one Other series in `viz-other` (#999999), always drawn last; gray never sits beside a hue as a peer. The palette passes the dataviz validator for lightness spread, CVD separation (protan, deutan, tritan) and ground contrast in all three themes. Sequential scales use `viz-seq-1` to `viz-seq-9`, a nine-step OKLCH ramp of the accent. Diverging scales use `viz-div-1` to `viz-div-7`, blue to orange through neutral, for variance and budget versus actual. Every bar series also carries a texture pattern and every line series a marker shape, compact axis ticks use `Intl.NumberFormat` (`notation: compact`), and every chart has a table view (Chart).

**Emergency code swatches.** `ecode-red` through `ecode-amber` (13 hues plus `ecode-adam`) are the swatches for the Standard Library Emergency Codes. EmergencyCodeCard always prints the code word and number beside the swatch; color never stands alone, and the swatch is never restyled to approximate a regulated safety symbol.

**Utility colors.** `viz-ink` is text on light chart fills in every theme. `paper` and `paper-ink` render printed pages in file previews. `camera-bg` and `camera-ink` are the Compass viewfinder in every theme.

**Other modes.** Forced colors: components switch to system colors and keep borders and focus. Sunlight (Compass): maximum contrast, no translucency, thicker borders. Print: records, lists and reports on US Letter and A4 with no navigation chrome.

### Contrast

The contrast gate (`export/check-contrast.js` over `export/contrast-pairs.json`) checks 294 pairs across Dark, Light and Sunlight and fails the build on any pair under WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text, icons and control boundaries. Current result: 294 pass, 0 fail. The findings open in earlier versions are resolved in the Decisions log below.

### Typography

- **Inter** (variable, SIL OFL) for all UI text, with tabular numerals (`.xos-num`) in tables and money.
- **JetBrains Mono** (SIL OFL) for URIDs, codes, item IDs, record keys and URNs.
- Scale (px): 11, 12, 13 (base), 14, 16, 20, 24, 32. Line height 1.45 for body, 1.2 for headings.
- Atlas base is `text-13`; Gateway base is `text-14` at comfortable density; Compass body is `text-16` and must stay legible at 200 percent font scale.
- Weights: `weight-regular` 400 for body, `weight-medium` 500 for labels and buttons, `weight-semibold` 600 for headings. `weight-bold` 700 is reserved for the BrandMark monogram (decision D2).
- Both families are loaded from Google Fonts; no font files are bundled.

### Spacing, radius, elevation

- 4 px base with steps `space-2` through `space-64` (2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64).
- Radius: `radius-chip` 4 px, `radius-control` 6 px, `radius-card` 8 px, `radius-dialog` 12 px.
- Elevation is border-first. `shadow-menu` and `shadow-dialog` are the only shadows, each with the 1 px `border-subtle` ring built in.
- Stroke widths: `stroke-hairline` 1 px for every border and divider, `stroke-focus` 2 px for focus rings and Sunlight controls, `stroke-accent` 3 px for severity and live edges, `stroke-swatch` 4 px for the emergency code edge, `stroke-stripe` 12 px for the credential stripe. No other border width exists.
- Opacity: `opacity-disabled` 0.48, scrim 0.64 dark and 0.40 light, hover overlay 0.06, pressed overlay 0.10.

### Layout and layering

- Breakpoints `bp-sm` 640 through `bp-3xl` 1920. Below `bp-lg` the sidebar becomes a drawer; below `bp-md` the side peek opens full screen and Atlas shows a bottom bar (Home, Inbox, Search, My Work, Menu).
- Sidebar 240 px (56 collapsed, resizable 200 to 360); side peek 560 px (440 to 960); reading 720, form 640, wide 1200; 12 columns with 16 px gutters, 24 px from lg up.
- Z order: base 0, sticky 100, sidebar 200, header 300, dropdown 1000, popover 1100, peek 1200, dialog 1300, command menu 1400, toast 1500, tooltip 1600.
- Density: web controls 24, 28 (default), 32 px. Targets: `target-fine` 24 px minimum on pointer devices (WCAG 2.5.8), `target-coarse` 44 px under `@media (pointer: coarse)`, Compass minimum 48 pt.
- Direction: every style uses logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: end`), so right-to-left locales mirror with `dir="rtl"` and no extra CSS.

### Motion

Durations `duration-fast` 120 ms (hover, press, chips), `duration-base` 160 ms (menus, popovers, tooltips), `duration-slow` 200 ms (side peek, drawers, toasts), `duration-deliberate` 280 ms (dialogs, route transitions). Easing `easing-standard`, `easing-enter`, `easing-exit`. Native springs `spring-default`, `spring-snappy`, `spring-gentle`. Animate transform and opacity only. Under reduced motion, movement becomes an 80 ms opacity fade (`duration-reduced`) or nothing.

## Iconography

- Every icon comes from **lucide-react** (ISC license; 0.460.0 renders these previews, production pins 1.53.0 and every name used here resolves in both), loaded as `components/lib/lucide-react.min.js` with global `LucideReact`. `Icon` takes any Lucide name in PascalCase (`Hammer`) or kebab-case (`chevron-right`) and draws it at 1.5 stroke.
- Sizes: web 16 px default (`icon-12` to `icon-24`); Compass 20, 24 (default) and 28.
- **XOS glyphs** are Lucide icons assigned to the canon, exported as `XOS.glyphs` and drawn by DepartmentGlyph, PhaseGlyph and RecordKindGlyph:

| Departments | Phases | Record kinds |
| --- | --- | --- |
| 0000 Executive: Briefcase | Gate 1 Scope: Crosshair | Work: Build Construction, Rehearsal Repeat, Shift CalendarClock, Strike PackageX, Task SquareCheck, Training GraduationCap |
| 1000 Creative: Palette | Gate 2 Engage: Handshake | Artifact: Document FileText, Supply Package |
| 2000 Talent: MicVocal | Gate 3 Advance: ClipboardCheck | Commitment: Booking CalendarCheck, Contract FileSignature, Payment Banknote, Recruitment UserPlus |
| 3000 Marketing: Megaphone | Gate 4 Procure: ShoppingCart | Control: Approval Stamp, Compliance ShieldCheck, Deadline AlarmClock, Decision Split, Inspection ScanSearch, Permit BadgeCheck |
| 4000 Environment: Tent | Gate 5 Build: Hammer | Time: Distribution Send, Event Ticket, Goal Target, Meeting Users, Milestone Milestone, Report ChartColumn, Risk TriangleAlert, Timeline ChartGantt |
| 5000 Production: SlidersHorizontal | Gate 6 Install: Wrench | |
| 6000 Operations: ClipboardList | Gate 7 Operate: Play | |
| 7000 Experience: Sparkles | Gate 8 Amplify: Share2 | |
| 8000 Hospitality: ConciergeBell | Gate 9 Close: Archive | |
| 9000 Technology: Cpu | | |

- Glyphs always sit beside their plain name; codes stay in mono chips.
- The nine record state icons (StateIcon) are drawn by this system, not Lucide, because they need filled and half-filled shapes.
- Every icon-only control has a tooltip with its label and shortcut.

## Brand marks

The platform marks are not set yet. Every surface renders brand through **BrandMark**, so marks drop in without layout changes:

- With logo files, BrandMark shows the light or dark file for the current theme.
- Without them, it shows a monogram tile in `accent-default` with the name in Inter. This is what renders today.
- The **Brand** asset group holds the white-label slots: Logo Light and Logo Dark (160 x 40), Favicon (32 x 32), App Icon (1024 x 1024) and Splash Screen (1290 x 2796). BrandSlot draws the same slots in White Label settings.

## White label

A tenant may override `accent-default` and optionally a neutral tint, the font family (from an approved list of open-licensed fonts) and the radius scale. Every override is token-based, and the theme editor blocks any combination that fails WCAG 2.2 AA. The radius override offers two presets whose values are all on the radius scale: Default (`radius-control` 6 px, `radius-card` 8 px, `radius-chip` 4 px) and Rounded (8, 12 and 6 px).

## Token names

Two names exist for every token, mapped one to one in `export/tokens/name-map.json`:

- **Reference names** (this artifact, `tokens.json`, `bundle.css`): hyphenated with no prefix, `bg-canvas`, `text-primary`, `duration-fast`, read as `var(--bg-canvas)`.
- **Spec names** (Section 11.3 and production): dotted, `color.bg.canvas`, `color.text.primary`, `motion.duration.fast`. Style Dictionary emits them as `--color-bg-canvas` in `packages/tokens` and Tailwind exposes them as `bg-bg-canvas`, `text-text-primary` and so on through the preset.

## Decisions log

Every open item from earlier versions is resolved here. Each choice favors the WCAG 2.2 AA floor, open standards (DTCG tokens, ICU messages, logical CSS) and an override path for white label.

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Contrast is enforced by token, not by usage rule. Added `border-control` (#67686F dark, #8E8F93 light, #17181C sunlight; 3.04, 3.02 and 17.74:1 minimum) and `accent-text` (#8B92F5, #4F57D9, #3F47C9; 5.62, 4.95, 5.70:1), `danger-text` (#EF5A5A, #C83535, #A82828; 4.69, 4.55, 5.62:1), `warning-text` (#E5A23B, #9C5F00, #7A4D00; 7.14, 4.51, 5.84:1) and `success-text` (#3FB97A, #037D43, #146B3C; 6.30, 4.55, 5.27:1). The Section 11.3 fill values are unchanged. | Usage rules ("never put tertiary on hover") cannot be linted; tokens can. Fills keep the spec look while text and boundaries pass. |
| D2 | `text-tertiary` moves from #858892 to #878A94 (dark) and #6B6E76 to #6A6D75 (light), the smallest shifts that clear 4.5:1 on `bg-hover` (4.55 and 4.51:1). Weights ratified at 400, 500, 600, with 700 for the monogram only. | Input hint text and timestamps sit on hovered rows constantly. Two hex steps are imperceptible. |
| D3 | Sunlight is a full third theme derived from Light: opaque grounds, 2 px control borders, darker text-on-color. Recorded here as the owner-approvable ADR; the gate holds it to AA like the others. | Compass outdoor use needs it now; deriving from Light keeps one source. |
| D4 | Categorical viz is themed and capped at seven hues plus `viz-other`. The spec's eighth step (#999999) becomes the Other bucket. | The spec order failed CVD and ground-contrast checks with gray adjacent to pink and yellow too light on light grounds. |
| D5 | All CSS uses logical properties and every preview sets `lang`. Pseudo-locales `en-XA` (accented, bracketed and padded about 60 percent longer) and `ar-XB` (right to left) ship with the messages. | Section 5 requires next-intl and i18next with ICU; layouts must survive expansion and mirroring before translation starts. |
| D6 | UI strings live in one ICU catalog (`export/i18n/en-US.json` and `es-US.json`, 319 messages each, as Section 19.6 requires) read through `XOS.t(key, values)`; `XOS.configure({locale, messages})` swaps catalogs. | Same keys move unchanged into `packages/i18n`. |
| D7 | Coarse-pointer targets (44 px), `color-scheme` per theme, forced-colors and print styles are part of the base CSS. | Platform defaults stay correct without per-component work. |
| D8 | Emergency code swatches are tokens (`ecode-*`) with the code word always printed. | Codes come from the Standard Library and differ by jurisdiction; color alone cannot carry them. |
| D9 | Preview data comes from canon: G3 criteria verbatim, Labor Rate Cards, catalog items in `{URID}-{ORG}-{SEQ}` form, Emergency Codes and Radio Channels. Tenant is the fictional Northwind Live. | Previews double as acceptance fixtures. |
| D10 | Platform brand marks stay as white-label slots (BrandMark, BrandSlot, Brand assets) until the marks are set. | Per owner direction; no layout depends on the final art. |
| D11 | Grades are Base, Elevated and Premium, per the build prompt. Labels are rows in the `grade` table, never hard-coded. | Owner ruling. The Bible tab 34 labels (Basic, Standard, Premium) are superseded. |
| D12 | Role codes and job titles follow the Playbook Roles Library. Rate cards reference a role code and never repeat its title. | Owner ruling; one home for each title. |
| D13 | GL posting is derived: a role code or URID posts to its class's one account of the requested type in GL Accounts. No row stores a GL account. BudgetGrid takes `accounts`; `XOS.glForCode` resolves; the `rate_card_resolved` view does the same in the database. | Third normal form: the account depends on the class, not on the row. Mispostings become impossible rather than reviewable. |
| D14 | Overtime and double-time multipliers are numbers on an overtime rule (OTR-001 Standard Overtime 1.5 and 2.0, OTR-002 Exempt 1.0 and 1.0) that rate cards reference. "1.5x" is display formatting (the `multiplier` column type). | Third normal form: 35 rate cards shared two pairs, and 24 stored them as text. |
| D15 | Emergency codes and protocols are global. Protocol steps name services (`{fire}`, `{ems}`, `{lawEnforcement}`, `{bombSquad}`, `{federal}`); the venue's jurisdiction supplies the agencies through `jurisdiction_agency`, which also replaces the Regulatory Agency enumeration. EmergencyCodeCard takes `authorities`. | Owner ruling that codes are global, kept in third normal form: agency names depend on the jurisdiction, not on the code. |
| D16 | Engagement Type and Employment Type are retired. Their facts are separate tables: worker classification (Employee, Independent Contractor, Vendor-Supplied, Unpaid Intern, Volunteer), pay basis (Day Rate, Flat Fee, Hourly, Salary), arrangement (Per Engagement, Retainer), and, on each engagement, employment status, FLSA status and labor agreement. Allowed combinations are tables; Retainer is Independent Contractor only. Country documents (W-4, I-9, W-2, W-9, 1099-NEC) and wage-and-hour minimums by labor region are rows. Five cross-table rules (XOS-ENG-1 to XOS-ENG-5) are enforced by the database. Wage-and-hour minimums hang off the Bible tab 11 jurisdiction hierarchy. | Each old label bundled classification, pay and schedule, and classification decides payroll, tax forms and overtime law. Owner ruling: Retainer is always 1099. |
| D17 | Volunteer is permitted only for Nonprofit and Public Agency organizations (`classification_organization_type`, rule XOS-ENG-6). GHXSTSHIP Industries LLC is For-Profit, so its projects cannot engage volunteers. | Owner ruling. Federal wage law generally does not allow unpaid volunteers at for-profit employers. |
| D18 | Responsive and cross-engine rules are part of the base CSS: wide data scrolls inside ScrollRegion, never the page; WhiteLabelPreview, Calendar headers and TopNav reflow by breakpoint, while RecordRow and gate criteria reflow by the width of their own list (container queries) so a list in a half-width column reflows too; scroll columns (the shell sidebar and body, and `xos-scroll-col`) keep each child at its own size; Compass surfaces (`xos-compass`) raise every target to `touch-min` (48 pt); coarse pointers get 44 px targets (invisible `::before` hit areas for dense controls); a browser-default reset matches the Tailwind preflight production uses; calendar rows use CSS subgrid instead of `display: contents`. Accepted exceptions: calendar day cells are 37 by 44 px at 320 px wide (seven columns cannot fit 44; WCAG 2.5.8 AA is met); the Accordion body indent is a sum of tokens (12 + 14 + 6 px, which is 32 px) aligning text under the title; WhiteLabelPreview renders a sample tenant's accent and radius by design; the Cover card is presentation art. | WCAG 1.4.10 Reflow, 2.5.8 Target Size and production parity. Verified in Chromium and WebKit (see Verification). |
| D19 | Canon tables ship in agent A01's `xpms` schema as migrations 0100 (schema) and 0101 (seed); tables owned by other agents ship as a separate engagement contract with a CSMIA26 fixture. Jurisdictions hold the Bible tab 11 rows in third normal form, and `jurisdiction_resolved` returns the tab exactly (US, US-FL, US-FL-MIAMI-DADE populated; GB, MX, AE, SA declared and refusing), and agency names follow canon (Miami Fire-Rescue, Miami Police Department). | Build prompt Section 19.1 ownership and migration ranges; canon values are never invented. |

The canon tables behind D11 to D16 ship as `export/canon/0100_xpms_canon.sql`, `0101_xpms_canon_seed.sql` and `checks.sql` (loaded and verified in PostgreSQL 16), with `migration-report.txt` listing every Playbook row the rulings change. They are the reference model agent A01 implements under the repo's ADR 0002 on Postgres 17. See HANDOFF.md section 7.

Spec names map to tokens by replacing dots with hyphens and dropping the `color.` prefix: `color.bg.canvas` is `bg-canvas`, `color.text.primary` is `text-primary`, `color.accent.text-on` is `accent-text-on`, `color.focus.ring` is `focus-ring`, `motion.duration.fast` is `duration-fast`.

## Components

142 components and 11 page templates, covering the full Section 11.4 inventory plus views, navigation, glyph and white-label components:

| Group | Components |
| --- | --- |
| Actions | Button, IconButton, Kbd, Link |
| Forms | Input, Textarea, Select, Combobox, MultiSelect, Checkbox, Radio, Switch, Slider, NumberInput, CurrencyInput, DatePicker, DateRangePicker, TimePicker, FileDrop |
| Feedback | Toast, UndoToast, InlineAlert, Banner, ProgressBar, Skeleton, EmptyState, ErrorState, RefusalNotice, NotificationCenter, OnboardingChecklist, WhatsNew, FeedbackWidget, ShortcutEditor, HelpPanel |
| Overlays | Dialog, Drawer, SidePeek, Popover, HoverCard, Tooltip, ContextMenu, DropdownMenu, CommandMenu, ShortcutSheet |
| Navigation | Sidebar, TopNav, TabBar, Tabs, Breadcrumbs, Pagination, SegmentedControl |
| Layout | AppShell, PageHeader, SplitView, Card, Accordion, Divider, Stepper, ResizablePanel, ScrollRegion |
| Identity | Avatar, AvatarStack, Badge, PresenceIndicator, CredentialBadge, QRCode |
| Iconography | Icon, StateIcon, DepartmentGlyph, PhaseGlyph, RecordKindGlyph |
| Chips | StateChip, PhaseChip, DepartmentChip, URIDChip, RecordKindChip, PropertyChip, Tag |
| Views | RecordRow, RecordList, Gallery, ResourceSchedule, OrgChart |
| Data display | DataTable, Money, Board, Timeline, Calendar, TreeView, BulkActionBar, DiffViewer, ActivityFeedItem, FilePreviewer, MapView, Chart, StatTile |
| Editing | RichTextEditor, SpreadsheetGrid, FilterBuilder, QuickAdd, ColorPicker |
| XOS | GateReadinessPanel, CoordinateMatrix, BudgetGrid, ProvenanceBadge, AssertionRankBadge, StalenessIndicator, ReconciliationTable, RunOfShowLive, AccessGridMatrix, EmergencyCodeCard, RadioChannelTable |
| Compass | ClockButton, ScanSheet, OfflineBanner, QuickIncidentSheet, ChecklistRunner, ShiftCard, DaySheetView, SignaturePad, PhotoCapture, LiveActivity, ForceUpdateScreen, SyncConflictSheet, UpNextCard |
| Gateway | OpportunityCard, OpportunityFilters, ApplicationForm, BidSheet, AgencySlate, ProfileEditor, EPKViewer, AvailabilityCalendar, OnboardingPacket, EngagementTimeline, RatingDialog, PayoutDetailsForm, OrgSwitcher, PaymentTracker |
| White Label | BrandMark, BrandSlot, WhiteLabelPreview |

**Templates** (full-page compositions in the Templates group): Collection, Record, Split View, Dashboard, Settings, Wizard, Grid Editor, Document, Auth, Gateway Shell and System (error, offline, maintenance, force update). **ControlStates** shows every control in default, hover, focus, active, disabled, invalid and read-only states on one page.

These are web reference implementations. Compass components are shown at 390 px phone width in the Sunlight theme; `packages/ui-native` mirrors them with the same tokens. Preview data uses the fictional Northwind Live tenant with codes, criteria and items taken from canon (decision D9).

**Loading.** Load `tokens.css` (generated from `tokens.json`; colors scoped by `data-theme`), `components/bundle.css`, React 18 and ReactDOM 18, then `components/lib/react-alias.js` (sets the lowercase `react` global lucide-react expects), `components/lib/lucide-react.min.js`, `components/lib/qrcode-generator.js` (1.4.4, MIT, global `qrcode`, used by QRCode and CredentialBadge), and `components/bundle.js`. Components are on `window.XOS`; types are in `components/index.d.ts` (checked with `tsc --strict`). Helpers: `XOS.glyphs`, `XOS.t`, `XOS.configure`, `XOS.parseQuickAdd(text)`, `XOS.contrastRatio(a, b)`.

## Consuming this system

- **Namespace:** `XOS`. Components are on `window.XOS` (for example `XOS.Button`, `XOS.DataTable`, `XOS.Sidebar`); helpers are `XOS.t`, `XOS.configure`, `XOS.glyphs`, `XOS.glForCode`, `XOS.parseQuickAdd` and `XOS.contrastRatio`.
- **Stylesheets, in order:** `tokens.css`, then `components/bundle.css`.
- **Scripts, in order, after React 18 and ReactDOM 18:** `components/lib/react-alias.js`, `components/lib/lucide-react.min.js`, `components/lib/qrcode-generator.js`, `components/bundle.js`.
- **Theme:** set `data-theme` to `dark`, `light` or `sunlight` on the root of a screen. Compass screens use the same tokens; Sunlight is the outdoor option.
- **Props:** `components/index.d.ts` and each `components/<Name>/README.md`. Props that take nested elements (header actions, sidebar content) are composed in markup around the mounted components.

## Verification

Recorded 2026-10-09 against this build. The audit tools ship in `export/qa/`.

- **Responsive and anatomy, Chromium** (Blink: Chrome, Edge, Samsung Internet): 154 previews at 12 viewports (320, 375, 390, 412, 430, 640, 768, 1024, 1280, 1440, 1536, 1920 px) with touch emulation on phones and tablets; 2,310 page renders. Zero page overflow, escaping elements, clipped or squeezed text, overlapping text, overlapping targets, distorted images, text under 11 px or script errors. Targets meet 24 px on fine pointers, 44 px on coarse pointers and 48 pt on Compass surfaces everywhere except the D18 calendar exception at 320 px.
- **Responsive and anatomy, WebKit** (the Safari engine, WebKitGTK 2.52 through WebKitWebDriver): 154 previews at 320, 390, 768, 1024 and 1440 px; 770 page renders, zero findings.
- **Section 11.5 screens:** all 114 boards of the XOS 4.0 Screens canvas at their own sizes in Chromium and WebKit, with token conformance and axe-core: zero findings. Wide data (tables, boards, timelines) scrolls inside its own region on phones and at 1024 px, as D18 requires; no page scrolls sideways.
- **Firefox:** no Gecko build is reachable from this environment, so Firefox runs in the Claude Code CI matrix (HANDOFF section 6, gate 5). Static support check with `doiuse` across Chrome, Edge, Firefox (current and ESR), Safari, iOS Safari 16.4 and later and Samsung Internet: only progressive enhancements are reported (pointer cursors and textarea resize on touch, scrollbar styling, `touch-action` on desktop Safari, `@page` on early iOS). Container queries, used by RecordRow, gate criteria and the inbox, are supported by every browser in that list.
- **Token conformance** at 1440 px in Dark, Light and Sunlight: every font size, weight, padding, gap, radius, stroke width, text color and background resolves to a token, except the D18 exceptions.
- **Contrast gate:** 297 pairs across Dark, Light and Sunlight, 0 failing.
- **axe-core 4.10.2:** zero findings across 154 previews in Dark, Light and Sunlight (462 renders) and across the 114 screens. The right-to-left (`ar-XB`), expanded (`en-XA`) and Spanish (`es-US`) passes were recorded on 2026-10-08 and run again in CI gates 2 to 4.
- **Builds:** at the repo's ADR 0001 pins, `node build-tokens.mjs` (Style Dictionary 5.6.0; CSS and native, all themes) builds, Tailwind 4.3.3 compiles the preset through `@config` with every variable it references defined by that build and no utility class collisions, `components/index.d.ts` passes `tsc --strict` on TypeScript 6.0.3 with React 19.3 types, and every glyph name resolves in lucide-react 1.53.0. Earlier passes also built on Style Dictionary 4.3.0 and Tailwind 3.4.17.
- **Canon:** `0100_xpms_canon.sql`, `0101_xpms_canon_seed.sql`, `contract_engagement.sql` and `fixture_csmia26.sql` load in PostgreSQL 16, and `checks.sql` passes: every rule rejects its bad row, one valid engagement per permitted classification loads, `jurisdiction_resolved` returns Bible tab 11 exactly, and no inherited value is stored twice.
