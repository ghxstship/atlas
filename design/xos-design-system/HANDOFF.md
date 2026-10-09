# XOS Design System Handoff to Claude Code

How this design system moves into the XOS monorepo for full-stack implementation under Build Prompt v1.6, Sections 5, 6, 11 and 19. Agent A05 owns the design system workspaces (`design/`, `packages/tokens`, `packages/ui`, `packages/ui-native`, `packages/icons`, Storybook). Agent A01 owns the canon migrations. Every other agent consumes these and never hard-codes a color, size, stroke, duration or string.

## 1. Kickoff for the orchestrator

Wave 1 input for A05 (Claude Design to Claude Code) and A01:

1. Export this artifact into `design/xos-design-system/` unchanged, and the XOS 4.0 Screens canvas into `design/xos-screens/`. They are the visual reference and the fixture set. `design/` holds Claude Design exports only (ADR 0005, item 5), so the finish guard and Prettier skip it; everything copied out of it into `packages/` or `supabase/` passes both.
2. Copy `tokens.json` to `design/tokens.json`, the path Section 11.5 names for the token export.
3. Copy the production sources to the workspace paths in section 2, then run the build order in section 5.
4. Freeze the contract set (tokens, ICU keys, prop contracts in `components/index.d.ts`, canon schema) at the end of Wave 1, as Section 19.2 requires. Changes after the freeze need an ADR.
5. Wire the CI gates in section 6 before any component lands.
6. Record decisions D1 to D19 (README, Decisions log) as ADRs numbered after the latest in `docs/adr` (0009 onward as of 2026-10-09), so later agents inherit them.

## 2. File map

| Artifact path | Repo path | Owner | Role |
| --- | --- | --- | --- |
| `tokens.json` | `design/tokens.json`, `design/xos-design-system/tokens.json`, `packages/tokens/xos.tokens.json` | A05 | Source of truth for values, usage notes and themes (169 tokens); input to the contrast gate and to regenerating the DTCG files. |
| `export/tokens/base.tokens.json` | `packages/tokens/tokens/base.tokens.json` | A05 | DTCG tokens shared by every theme (type, space, radius, stroke, motion, layout, z order, density, weights). |
| `export/tokens/theme.dark.tokens.json`, `theme.light.tokens.json`, `theme.sunlight.tokens.json` | `packages/tokens/tokens/` | A05 | DTCG color tokens per theme. |
| `export/tokens/name-map.json` | `packages/tokens/tokens/name-map.json` | A05 | Reference name to spec name, one to one. |
| `export/build-tokens.mjs` | `packages/tokens/build-tokens.mjs` | A05 | `node build-tokens.mjs` builds `dist/css/base.css` and `dist/css/theme.{theme}.css` (scoped by `[data-theme]`) and `dist/native/base.js` and `theme.{theme}.js` for Expo. Verified with Style Dictionary 5.6.0 (ADR 0001 pin) and 4.3.0. |
| `export/check-contrast.js`, `export/contrast-pairs.json` | `packages/tokens/scripts/` | A05 | Contrast gate; also run by the white-label theme editor before saving. |
| `export/tailwind.preset.js` | `packages/config/tailwind/preset.js` | Orchestrator | Maps every token to a CSS variable, including `borderWidth` and `outlineWidth` from the stroke tokens with a `stroke-` prefix (`border-stroke-accent`), so no width class collides with a color class. Tailwind 4.3.3 (ADR 0001 pin) loads it through `@config`; the loading pattern is in the file header. Verified with 4.3.3 and 3.4.17. |
| `export/i18n/en-US.json`, `es-US.json` | Merged into `packages/i18n/messages/en-US.json` and `es-US.json` | A05 | 319 ICU messages each, identical keys and arguments (Section 19.6 requires both catalogs). The repo catalogs are nested JSON and each agent writes under its own namespace (ADR 0004), so these flat keys merge as nested keys under `ui`: `feedback.hint` becomes `ui.feedback.hint`, and the `packages/ui` message helper prefixes `ui.`. Under `ui` no key collides with the existing `shell` and `nav` namespaces (checked 2026-10-09; a top-level merge would collide on `nav.breadcrumb`). |
| `export/i18n/en-XA.json`, `ar-XB.json` | `packages/i18n/messages/pseudo/`, nested under `ui` the same way | A05 | Pseudo-locales for expansion and right-to-left testing. Development and CI only; not added to the shipped `locales` list. |
| `export/icons.json` | `packages/icons/src/map.json` | A05 | Lucide names for departments, phases, record kinds and states. |
| `export/qa/*` | `packages/testing/qa/` | A24 | Responsive and anatomy audit (section 6, gate 5). `packages/testing` is A24's path (ADR 0004). |
| `components/bundle.css` | `packages/ui/src/styles/reference.css` | A05 | Reference only; port rules into component styles using Tailwind classes. Keep the base reset, breakpoint rules and coarse-pointer rules. |
| `components/<Name>/README.md` | `packages/ui/src/<Name>/README.md` | A05 | Props, behavior, accessibility, responsive and content rules per component. |
| `components/index.d.ts` | `packages/ui/src/types/reference.d.ts` | A05 | Prop contracts (`tsc --strict` clean on TypeScript 6.0.3 with React 19.3 types, the ADR 0001 pins). Production components keep these names and shapes. |
| `components/<Name>/preview.html` | `design/xos-design-system/components/` | A05, A24 | Visual fixtures for Storybook stories and screenshot baselines. |
| `export/canon/0100_xpms_canon.sql`, `0101_xpms_canon_seed.sql` | Reference model for `supabase/migrations/0100` to `0199` | A01 | Canon tables in third normal form, schema `xpms`, with the Bible and Playbook seed. A01 keeps every table, key, constraint and view and writes the migrations to ADR 0002: lowercase, schema-qualified names with no session `search_path` and functions set to `search_path = ''`; `comment on` every table and column; rate amounts as `bigint` minor units with a `char(3)` currency; em dash check constraints on verbiage columns; Postgres 17. `xpms` is created by `0001_foundation.sql`. Canon rows come from the importer in `canon/import`; the seed file is the importer's expected output. |
| `export/canon/contract_engagement.sql` | Contract for `supabase/migrations/0200-0299` (A02), `0300-0499` (A03), `0700-0799` (A28) | A02, A03, A28 | Organization, venue, project, person, counterparty, labor agreement and engagement, with the compliance trigger. Organization and person already exist as `app.organizations` and `app.people` (0202); A02 adds the organization type column there in a new 02xx migration, and A03 and A28 point their keys at those tables. Owners add full columns, RLS and audit in their own ranges and keep every column, key and rule here. |
| `export/canon/fixture_csmia26.sql`, `checks.sql` | `supabase/tests/`, as pgTAP suites prefixed with the migration they cover (ADR 0004) | A01, A28 | Demo fixture and the compliance checks that must pass after every migration. |
| `export/canon/migration-report.txt` | `canon/reports/`, regenerated by the importer (the folder is ignored by git) | A01 | Every Playbook row whose stored value the rulings change. The committed copy stays in `design/xos-design-system/export/canon/`. |
| `assets/Brand/*` | `packages/ui/src/brand/defaults/` | A05 | White-label slot defaults. Replace when platform marks are set. |

## 3. Name translation

Reference names in this artifact and production names differ only by prefix and separator. `name-map.json` is the single lookup.

| Reference (artifact) | Spec | Production CSS | Tailwind |
| --- | --- | --- | --- |
| `--bg-canvas` | `color.bg.canvas` | `--color-bg-canvas` | `bg-bg-canvas` |
| `--text-secondary` | `color.text.secondary` | `--color-text-secondary` | `text-text-secondary` |
| `--accent-text` | `color.accent.text` | `--color-accent-text` | `text-accent-text` |
| `--border-control` | `color.border.control` | `--color-border-control` | `border-border-control` |
| `--stroke-accent` | `stroke.width.accent` | `--stroke-width-accent` | `border-stroke-accent` (width; `border-accent` is the accent color) |
| `--duration-fast` | `motion.duration.fast` | `--motion-duration-fast` | `duration-fast` |

Spacing keys in the preset are pixel values (`p-12` is 12 px) so code matches the spec scale.

## 4. Production library mapping

The reference components are dependency-free React so they render in Claude Design. Production builds each one on the Section 5 library below and keeps the reference prop names, markup roles, keyboard model and responsive rules.

| Reference components | Production basis |
| --- | --- |
| Dialog, Drawer, SidePeek, Popover, HoverCard, Tooltip, DropdownMenu, ContextMenu, Select, Checkbox, Radio, Switch, Slider, Tabs, Accordion, SegmentedControl | Radix Primitives |
| CommandMenu, Combobox, MultiSelect, OrgSwitcher | cmdk on Radix Popover |
| DataTable, RecordList, Board, TreeView, BulkActionBar, ReconciliationTable | TanStack Table and TanStack Virtual (10,000 rows at 60 fps), inside ScrollRegion |
| SpreadsheetGrid, BudgetGrid, CoordinateMatrix, AccessGridMatrix | Glide Data Grid (web), with the reference ARIA grid model as the accessible fallback |
| Chart, StatTile sparkline, Timeline, ResourceSchedule | Visx (web), Victory Native (Compass) |
| RichTextEditor, DiffViewer | Tiptap with Yjs |
| MapView | MapLibre GL |
| QuickAdd, DatePicker natural language | chrono-node |
| QRCode, CredentialBadge | qrcode-generator 1.4.4 (same library as the reference) |
| Icon and glyphs | lucide-react 1.53.0 (web) and lucide-react-native 1.53.0 (Compass), the ADR 0001 pins; every glyph name resolves in 1.53.0 |
| All strings | next-intl (web), i18next (Compass), same ICU catalogs |
| Compass components | `packages/ui-native` on Expo, same tokens via Style Dictionary native output |

## 5. Build order

1. `packages/tokens`: `node build-tokens.mjs` (Style Dictionary 5.6.0) and the contrast gate, both in CI.
2. Canon (A01): migrations 0100 onward from the reference model under ADR 0002, then the canon checks as pgTAP suites against the contract tables as A02, A03 and A28 land them.
3. `packages/config`: Tailwind preset, ESLint and Stylelint rules that ban raw color, size, stroke and duration values outside `packages/tokens`.
4. `packages/i18n` (en-US, es-US, pseudo-locales) and `packages/icons`.
5. `packages/ui`: base reset and breakpoint rules, foundations (Button, Input, Icon, chips), then overlays, then data components inside ScrollRegion, then XOS, Gateway and White Label.
6. `packages/ui-native`: Compass components.
7. Storybook with one story per preview, then screenshot baselines from the previews in all three themes at the section 6 viewports.
8. App shells (Atlas, Gateway, Compass) from the Templates and the Section 11.5 screen designs.

## 6. CI gates

Every pull request that touches `packages/tokens`, `packages/ui` or `packages/ui-native` must pass:

1. Contrast gate: `node scripts/check-contrast.js xos.tokens.json scripts/contrast-pairs.json` from `packages/tokens`, with 0 failing pairs.
2. axe-core: zero findings on every story in Dark, Light and Sunlight.
3. Right to left: every story renders in `ar-XB` with no overlap and no physical CSS properties (Stylelint `liberty/use-logical-spec`).
4. Expansion: every story renders in `en-XA` with no clipped text at its declared width.
5. Responsive matrix: `packages/testing/qa/raudit.js` over every story in the Playwright `chromium`, `firefox` and `webkit` projects at 320, 375, 390, 412, 430, 640, 768, 1024, 1280, 1440, 1536 and 1920 px, with touch emulation below 1280. Zero page overflow, escaping elements, clipped text, overlapping text or targets, distorted images or text under 11 px. Targets 24 px on fine pointers, 44 px on coarse pointers and 48 pt on Compass surfaces (`xos-compass`, `raudit` option `min: 48`), except the D18 exceptions. Run the same audit over the Section 11.5 screens at their board sizes.
6. Token conformance: every font size, weight, padding, gap, radius, stroke width and color resolves to a token, except the D18 exceptions.
7. Strings lint: no user-visible literal outside the ICU catalogs, and en-US and es-US keep identical keys and arguments.
8. Reduced motion: every animation has a `prefers-reduced-motion` path.
9. Types: `tsc --strict` on `packages/ui` against the reference contracts.
10. Canon: the canon pgTAP suites pass against the migrated database (`supabase test db`).
11. CSS support: `doiuse` over the compiled CSS for the last two Chrome, Edge, Firefox, Safari and Samsung Internet versions, Firefox ESR and iOS Safari 16.4 or later reports nothing beyond the accepted progressive enhancements (pointer cursors and textarea resize on touch, scrollbar styling, `touch-action` on desktop Safari, `@page` on early iOS).

## 7. Canon resolutions

All canon items are resolved (decisions D3 and D11 to D19 in the README). The tables ship as an executable spec, loaded and checked in PostgreSQL 16; the repo runs Postgres 17 (ADR 0001), and A01 ports them under ADR 0002.

| Item | Ruling | Third normal form result |
| --- | --- | --- |
| 1. Grade names | Use the prompt. | `grade` rows Base, Elevated, Premium. Bible tab 34 labels are superseded. |
| 2. Labor Rate Card codes | Use the Playbook. | `role` (Roles Library) owns code and title. `rate_card` stores only its own facts and references the role. Department derives from the code, so 9000.50.01 to 9000.50.04 sit in 9000 Technology. |
| 3. Rate card GL postings | Derive. | No row stores a GL account. `gl_account` holds one account per class and type; postings resolve by class. LRC-008 to LRC-011 move from 5500 to 5900. If those roles belong in Production, recode them to 5000 rather than overriding the GL. |
| 4. Overtime multipliers | Normalize. | `overtime_rule` stores numeric multipliers once; rate cards reference OTR-001 or OTR-002. 24 text values ("1.5x") are parsed. |
| 5. Emergency codes | Global; normalize. | Codes, protocols and steps carry no organization, project or agency. Steps name services; `jurisdiction_agency` names the agency per Bible jurisdiction, reached through the project's venue. LAPD, LAFD and MDFR references in 10 protocols become service tokens. The Regulatory Agency enumeration moves to the same table; the Emergency Radio Code enumeration is retired. |
| 6. Sunlight theme | Derived from Light. | Decision D3. |
| 7. Employment and engagement types | Separate the facts; Retainer is always 1099. | `worker_classification`, `pay_basis` and `arrangement` replace both lists, with allowed combinations as tables. Rate cards are keyed by role, classification, pay basis and arrangement. `engagement` stores only hire-specific facts. Rules XOS-ENG-1 to XOS-ENG-5. |
| 8. Volunteers | Nonprofit and Public Agency only. | `organization_type` and `classification_organization_type`; rule XOS-ENG-6 rejects a volunteer engagement on a For-Profit organization's project. |
| 9. Jurisdictions | Follow the Bible. | `jurisdiction` holds the tab 11 rows with each fact once: country derives from the ID, unit system and currency are stored on the country and inherited, and code sets are rows of `jurisdiction_code_set`; `jurisdiction_resolved` returns tab 11 exactly. Wage-and-hour minimums (`wage_hour_rule`, federal 40-hour week at 1.5) inherit down the jurisdiction chain; an unpopulated jurisdiction returns no answer. |

Role disciplines and ranks are lists (`role_discipline`, `role_rank`) that roles reference. Rules for every other canon list follow the same pattern: a value lives in exactly one table, lists that grow are lookup tables rather than enums, display formats ("1.5x", "Gate 3 · Advance") are rendered and never stored, and canon values are never invented.

## 8. Section 11.5 Claude Design deliverables

| Item | Deliverable | State |
| --- | --- | --- |
| 1 | XOS Design System: tokens, type, color in all themes, spacing, radius, stroke, iconography, the full Section 11.4 component inventory with default, hover, focus, active, disabled, loading and error states (ControlStates), token export | Complete. This artifact. |
| 2 | Atlas screens at 1440, 1280 and 1024 px | Complete. 27 screens at 1440 px plus 1280 and 1024 px size sheets, in the XOS 4.0 Screens canvas (https://claude.ai/artifact/1ABYio7VVU94z2yTbEEXwV). |
| 3 | Compass screens at 390 by 844 and 430 by 932 pt, plus a 10 to 11 in tablet | Complete. 15 screens at 390 by 844, with 430 by 932 and tablet size sheets and the three scan modes. |
| 4 | Gateway screens at desktop and phone widths | Complete. 28 screens at 1440 px, all eight external persona homes, token pages, and phone size sheets. |
| 5 | Shell experience flows with tap and keystroke counts | Complete. Clock in, scan, incident, Up Next, payment and requirements flows with counts, each drawn step by step and as a clickable prototype (Play, then Next and Back); role-default sidebars for seven personas; Atlas phone bottom bar; Gateway five-destination bar on desktop and phone. |
| 6 | White-label preview of the same screens under two sample tenant brands | Complete. Atlas Home, Gateway Home and Compass Today under Northwind Live and Harbor Light Events, token-only. |

Wave 2 module work can start from this artifact alone: every screen in items 2 to 6 is composed from these components and Templates, and Section 11.5 lets the prompt win where a screen and the prompt disagree. Items 2 to 6 are complete in the XOS 4.0 Screens canvas; every board carries a note with interaction and keyboard shortcuts, responsive behavior, and accessibility (focus order, landmarks, announcements). Use them as the screenshot baselines for A06, A17 and A27.

### Screen traceability

Every Section 11.5 line maps to boards in the XOS 4.0 Screens canvas. Board names are the `.dc.html` file names.

| Item | Prompt line | Boards |
| --- | --- | --- |
| 2 | Sign in and MFA | AtlasSignIn, AtlasMfa |
| 2 | Org onboarding | AtlasOnboarding |
| 2 | Home | AtlasHome |
| 2 | Project overview with gate readiness | AtlasProject |
| 2 | Scope tree | AtlasScope |
| 2 | Schedule timeline | AtlasSchedule |
| 2 | Records list and board | AtlasRecords, AtlasBoard |
| 2 | Record side peek | AtlasPeek |
| 2 | Budget grid | AtlasBudget |
| 2 | PO detail with three-way match | AtlasPurchaseOrder |
| 2 | Advance packet builder | AtlasAdvancing |
| 2 | Opportunities pipeline | AtlasPipeline |
| 2 | Crew schedule | AtlasCrew |
| 2 | Timesheet approval | AtlasTimesheets |
| 2 | Incident CAD dispatch board | AtlasDispatch |
| 2 | Access Grid | AtlasAccessGrid |
| 2 | Canon browser | AtlasCanon |
| 2 | Coordinate matrix report | AtlasMatrix |
| 2 | Settings: members and roles, white label, security, billing, data and privacy | AtlasMembers, AtlasWhiteLabel, AtlasSecurity, AtlasBilling, AtlasPrivacy |
| 2 | Command menu | AtlasCommand |
| 2 | Empty, error and refusal states | AtlasStates |
| 2 | 1280 and 1024 px | AtlasSheet1280A to E, AtlasSheet1024A to E |
| 3 | Today | CompassToday |
| 3 | Clock in with geofence states | CompassClock |
| 3 | Kiosk mode | CompassKiosk |
| 3 | Shift detail and swap | CompassShift |
| 3 | Task with checklist and photo | CompassTask |
| 3 | Quick incident | CompassIncident |
| 3 | Inspection runner | CompassInspection |
| 3 | Scan (asset, receiving, credential) | CompassScan, CompassSheetScanModes |
| 3 | Run of show live | CompassShow |
| 3 | Day sheet | CompassDaySheet |
| 3 | Emergency codes | CompassCodes |
| 3 | Radio channels | CompassRadio |
| 3 | Offline queue | CompassOffline |
| 3 | Profile and certifications | CompassProfile |
| 3 | 430 by 932 pt and 10 to 11 in tablet | CompassSheet430A to C, CompassSheetTabletA to C |
| 4 | Home and Opportunities (browse, detail, saved, alerts) | GatewayHome, GatewayExplore, GatewayOpportunity, GatewaySaved |
| 4 | Application, bid sheet and agency slate | GatewayApply, GatewayBid, GatewaySlate |
| 4 | Applications and offers with accept, counter and decline | GatewayApplications, GatewayOffer |
| 4 | Onboarding packet | GatewayOnboarding |
| 4 | Engagement Overview for the eight role types | GatewayClient, GatewayVendor, GatewayContractor, GatewayCrew, GatewayStaff, GatewayArtist, GatewayRepresentative, GatewaySponsor |
| 4 | Schedule, Documents with signing, Money with invoice submission | GatewaySchedule, GatewayDocuments, GatewayMoney |
| 4 | Messages | GatewayMessages |
| 4 | Profile editor with per-field visibility, public profile and EPK, company account with team | GatewayProfile, GatewayPublicProfile, GatewayCompany |
| 4 | Settings with consents and payout details | GatewaySettings |
| 4 | Token advance and signing flows with account claim | GatewayAdvanceToken, GatewaySignToken |
| 4 | Phone widths | GatewaySheetPhoneA to D |
| 5 | Clock-in states, continuous scan, three-step incident, Gateway Up Next, payment tracker, requirements check | FlowClock, FlowScan, FlowIncident, FlowUpNext, FlowPayment, FlowRequirements; clickable: ProtoClock, ProtoScan, ProtoIncident, ProtoUpNext, ProtoPayment, ProtoRequirements |
| 5 | Atlas role-default sidebars | FlowSidebars |
| 5 | Atlas phone bottom bar; Gateway five-destination bar on desktop and phone | FlowAtlasPhone, FlowGatewayDesktop, FlowGatewayPhone |
| 6 | Same three screens under two tenant brands | WLAtlasNorthwind, WLAtlasHarbor, WLGatewayNorthwind, WLGatewayHarbor, WLCompassNorthwind, WLCompassHarbor |

## 9. Lineage

An earlier lineage (Poseidon, last commit 2026-09-14) used Discover and Design gates, banned a `status` field and spelled "Cancelled". This system follows v1.6 and the current Bible (Scope, Engage, Advance; Canceled). Compatible Poseidon rules were adopted: logical properties, `color-scheme`, text-on-color tokens, target tokens and never approximating regulated safety symbols.

Platform brand marks are deferred; the white-label slots carry the layout until they are set.
