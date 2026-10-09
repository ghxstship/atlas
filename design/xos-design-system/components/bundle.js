/* @ds-bundle: {"format":4,"namespace":"XOS","components":[{"name":"Button"},{"name":"IconButton"},{"name":"Kbd"},{"name":"Input"},{"name":"CurrencyInput"},{"name":"Money"},{"name":"Checkbox"},{"name":"Switch"},{"name":"SegmentedControl"},{"name":"Tabs"},{"name":"Breadcrumbs"},{"name":"Icon"},{"name":"StateIcon"},{"name":"StateChip"},{"name":"PhaseChip"},{"name":"DepartmentChip"},{"name":"URIDChip"},{"name":"PropertyChip"},{"name":"Tag"},{"name":"ProvenanceBadge"},{"name":"AssertionRankBadge"},{"name":"RefusalNotice"},{"name":"InlineAlert"},{"name":"Toast"},{"name":"EmptyState"},{"name":"ProgressBar"},{"name":"Skeleton"},{"name":"Avatar"},{"name":"AvatarStack"},{"name":"Tooltip"},{"name":"DataTable"},{"name":"CommandMenu"},{"name":"Dialog"},{"name":"Sidebar"},{"name":"ClockButton"},{"name":"DepartmentGlyph"},{"name":"PhaseGlyph"},{"name":"RecordKindGlyph"},{"name":"RecordKindChip"},{"name":"BrandMark"},{"name":"BrandSlot"},{"name":"WhiteLabelPreview"},{"name":"Link"},{"name":"Textarea"},{"name":"Select"},{"name":"Combobox"},{"name":"MultiSelect"},{"name":"Radio"},{"name":"Slider"},{"name":"NumberInput"},{"name":"DatePicker"},{"name":"DateRangePicker"},{"name":"TimePicker"},{"name":"FileDrop"},{"name":"Banner"},{"name":"ErrorState"},{"name":"DropdownMenu"},{"name":"ContextMenu"},{"name":"Popover"},{"name":"HoverCard"},{"name":"Drawer"},{"name":"SidePeek"},{"name":"ShortcutSheet"},{"name":"Pagination"},{"name":"PageHeader"},{"name":"Card"},{"name":"Divider"},{"name":"Accordion"},{"name":"Stepper"},{"name":"ResizablePanel"},{"name":"SplitView"},{"name":"AppShell"},{"name":"Badge"},{"name":"PresenceIndicator"},{"name":"Board"},{"name":"Timeline"},{"name":"Calendar"},{"name":"TreeView"},{"name":"RichTextEditor"},{"name":"SpreadsheetGrid"},{"name":"FilterBuilder"},{"name":"QuickAdd"},{"name":"ColorPicker"},{"name":"BulkActionBar"},{"name":"DiffViewer"},{"name":"ActivityFeedItem"},{"name":"FilePreviewer"},{"name":"MapView"},{"name":"GateReadinessPanel"},{"name":"CoordinateMatrix"},{"name":"BudgetGrid"},{"name":"StalenessIndicator"},{"name":"ReconciliationTable"},{"name":"RunOfShowLive"},{"name":"AccessGridMatrix"},{"name":"EmergencyCodeCard"},{"name":"RadioChannelTable"},{"name":"UndoToast"},{"name":"NotificationCenter"},{"name":"OnboardingChecklist"},{"name":"WhatsNew"},{"name":"FeedbackWidget"},{"name":"ShortcutEditor"},{"name":"ScanSheet"},{"name":"OfflineBanner"},{"name":"QuickIncidentSheet"},{"name":"ChecklistRunner"},{"name":"ShiftCard"},{"name":"DaySheetView"},{"name":"SignaturePad"},{"name":"PhotoCapture"},{"name":"LiveActivity"},{"name":"ForceUpdateScreen"},{"name":"SyncConflictSheet"},{"name":"OpportunityCard"},{"name":"OpportunityFilters"},{"name":"ApplicationForm"},{"name":"BidSheet"},{"name":"AgencySlate"},{"name":"ProfileEditor"},{"name":"EPKViewer"},{"name":"AvailabilityCalendar"},{"name":"OnboardingPacket"},{"name":"EngagementTimeline"},{"name":"RatingDialog"},{"name":"PayoutDetailsForm"},{"name":"OrgSwitcher"},{"name":"RecordRow"},{"name":"RecordList"},{"name":"Gallery"},{"name":"ResourceSchedule"},{"name":"OrgChart"},{"name":"Chart"},{"name":"StatTile"},{"name":"HelpPanel"},{"name":"QRCode"},{"name":"CredentialBadge"},{"name":"UpNextCard"},{"name":"PaymentTracker"},{"name":"TabBar"},{"name":"TopNav"},{"name":"ScrollRegion"}]} */
(function () {

  var React = window.React;
  var h = React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
  function rest(props, omit) { var o = {}; for (var k in props) if (omit.indexOf(k) < 0) o[k] = props[k]; return o; }

  /* Copy and formatting. Every user-facing string comes from the catalog; packages/i18n supplies other locales. */
  var LOCALE = "en-US";
  var MESSAGES = {
     "access.allowed": "{cat} in {zone}: allowed",
     "access.credential": "Credential",
     "access.denied": "{cat} in {zone}: denied",
     "action.cancel": "Cancel",
     "action.clear": "Clear",
     "action.close": "Close",
     "action.copyLink": "Copy Link",
     "action.dismiss": "Dismiss",
     "action.done": "Done",
     "action.download": "Download",
     "action.later": "Later",
     "action.reset": "Reset",
     "action.retry": "Retry",
     "action.save": "Save",
     "action.saved": "Saved",
     "action.send": "Send",
     "action.snooze": "Snooze",
     "action.start": "Start",
     "action.undo": "Undo",
     "action.view": "View",
     "apply.available": "I'm available on every listed date",
     "apply.draftSaved": "Draft saved",
     "apply.shared": "What {org} will see",
     "apply.submit": "Submit Application",
     "apply.title": "Apply: {role}",
     "assertion.aria": "{label}, rank {rank} of 4",
     "availability.available": "Available",
     "availability.booked": "Booked",
     "avatar.more": "{n} more",
     "badge.brightness": "Raise brightness",
     "badge.label": "Credential for {name}",
     "badge.qr": "Credential code {key}",
     "badge.valid": "Valid {from} to {to}",
     "badge.wallet": "Add to Wallet",
     "badge.zones": "Zones",
     "bid.extended": "Extended",
     "bid.item": "Item",
     "bid.line": "Line",
     "bid.lines": "Bid lines",
     "bid.qty": "Qty",
     "bid.sealed": "Sealed bid",
     "bid.sealedBody": "Bids stay sealed until {deadline}. No bidder sees another bid.",
     "bid.total": "Bid Total",
     "bid.unit": "Unit",
     "bid.unitPrice": "Unit Price",
     "board.add": "New Record",
     "budget.amount": "Amount",
     "budget.costCenter": "Cost Center",
     "budget.gl": "GL Account",
     "budget.grade": "Grade",
     "budget.line": "Line",
     "budget.qty": "Qty",
     "budget.rate": "Rate",
     "budget.unmapped": "Unmapped Account",
     "budget.urid": "URID",
     "bulk.clear": "Clear selection",
     "bulk.label": "Bulk actions",
     "bulk.selected": "{n} selected",
     "calendar.agenda": "Agenda",
     "calendar.day": "Day",
     "calendar.month": "Month",
     "calendar.more": "+{n} more",
     "calendar.range": "Range",
     "calendar.week": "Week",
     "camera.viewfinder": "Camera viewfinder",
     "chart.chart": "Chart",
     "chart.legend": "Legend",
     "chart.noValue": "No value",
     "chart.other": "Other",
     "chart.table": "Table",
     "chart.tableHint": "Switch to Table for every value.",
     "chart.view": "View",
     "chip.remove": "Remove {label}",
     "clock.break": "Break",
     "clock.endBreak": "End Break",
     "clock.out": "Clock Out",
     "color.blocked": "This color can't be saved until every check passes.",
     "color.hex": "{label} hex value",
     "color.invalid": "Enter a hex color such as #4F57D9.",
     "command.label": "Command menu",
     "command.results": "Results",
     "conflict.keep": "Keep Selected",
     "conflict.server": "Saved on Server",
     "conflict.title": "Resolve Conflict",
     "conflict.yours": "Yours",
     "contact.call": "Call {name}",
     "contact.message": "Message {name}",
     "contrast.fail": "Fails AA",
     "contrast.pass": "Passes AA",
     "contrast.ratio": "{r}:1",
     "count.of": "{n} of {total}",
     "count.step": "Step {n} of {total}",
     "date.choose": "Choose date",
     "date.chooseRange": "Choose dates",
     "date.days": "{n} days",
     "date.nextMonth": "Next month",
     "date.pick": "Pick a date",
     "date.prevMonth": "Previous month",
     "date.rangeTo": "to",
     "daysheet.contacts": "Contacts",
     "daysheet.now": "Now",
     "diff.after": "After",
     "diff.before": "Before",
     "diff.field": "Field",
     "ecode.authorities": "Local authorities",
     "ecode.role.bombSquad": "Bomb Squad",
     "ecode.role.ems": "EMS",
     "ecode.role.federal": "Federal",
     "ecode.role.fire": "Fire",
     "ecode.role.lawEnforcement": "Law Enforcement",
     "ecode.service.bombSquad": "the local bomb squad",
     "ecode.service.ems": "emergency medical services",
     "ecode.service.federal": "federal authorities",
     "ecode.service.fire": "the local fire department",
     "ecode.service.lawEnforcement": "local law enforcement",
     "engagement.stages": "Engagement stages",
     "feedback.hint": "Describe what you expected and what you saw.",
     "feedback.privacy": "Only what you choose here is sent. Nothing else is captured.",
     "feedback.question": "What happened?",
     "feedback.screenshot": "Attach a screenshot of this page",
     "feedback.thanks": "Thanks. The platform team will read this.",
     "feedback.title": "Send Feedback",
     "file.drop": "Drop files",
     "file.kb": "{n} KB",
     "file.orBrowse": "or browse",
     "file.page": "Page {n}",
     "file.zoomIn": "Zoom in",
     "file.zoomOut": "Zoom out",
     "filter.add": "Add Filter",
     "filter.label": "Filters",
     "filter.remove": "Remove filter {field}",
     "fmt.multiplier": "{n}x",
     "gate.allMet": "All blocking criteria met.",
     "gate.blocking": "Blocking",
     "gate.criteriaMet": "Criteria met",
     "gate.metCount": "{met} of {total} met",
     "gate.openMany": "{n} blocking criteria open.",
     "gate.openOne": "{n} blocking criterion open.",
     "gate.readiness": "Gate readiness",
     "grid.derived": "Derived from canon. Edit the source record to change it.",
     "grid.hint": "Arrow keys move, Enter edits, Delete clears to Unpriced, paste from Excel fills the range.",
     "grid.row": "Row",
     "help.ask": "Ask a question about this page",
     "help.assistant": "Assistant",
     "help.contact": "Contact Support",
     "help.forThisPage": "For this page",
     "help.learnMore": "Learn more",
     "help.search": "Search help",
     "help.shortcuts": "Shortcuts",
     "help.title": "Help",
     "help.whatsNew": "What's New",
     "inbox.fyi": "For Your Information",
     "inbox.label": "Inbox",
     "inbox.needsYou": "Needs You",
     "incident.help": "Critical types use hold to confirm. Reports queue offline and send when you reconnect.",
     "incident.title": "Report Incident",
     "inspection.addPhoto": "Add Photo",
     "inspection.fail": "Fail",
     "inspection.pass": "Pass",
     "inspection.whatFailed": "What failed?",
     "key.esc": "Esc",
     "key.space": "Space",
     "link.newTab": "Opens in a new tab",
     "list.noMatch": "No match. Try another word.",
     "live.label": "Live Activity",
     "matrix.cell": "{row}, {col}: {n} records",
     "matrix.empty": "{row}, {col}: none",
     "menu.actions": "Actions",
     "menu.more": "More Actions",
     "money.blankHelp": "Blank means unpriced. Enter 0 only for a confirmed zero.",
     "money.rateOnRequest": "Rate on Request",
     "money.unpriced": "Unpriced",
     "nav.account": "Account menu for {name}",
     "nav.breadcrumb": "Breadcrumb",
     "nav.main": "Main",
     "nav.next": "Next",
     "nav.pagination": "Pagination",
     "nav.previous": "Previous",
     "number.decrease": "Decrease",
     "number.increase": "Increase",
     "offline.queued": "{n} queued",
     "opp.apply": "Apply",
     "opp.missing": "Missing: {list}",
     "opp.qualified": "You meet every requirement",
     "opp.search": "Search opportunities",
     "org.marketplace": "Browse Marketplace",
     "org.vacant": "Vacant",
     "org.verified": "Verified organization",
     "packet.expired": "Expired",
     "packet.minutes": "{n} min",
     "packet.minutesLeft": "About {n} min left",
     "packet.required": "Required",
     "packet.review": "In Review",
     "packet.title": "Onboarding Packet",
     "packet.todo": "To Do",
     "packet.verified": "Verified",
     "packet.verifiedCount": "{n} of {total} verified",
     "panel.resize": "Resize panel",
     "pay.approved": "Approved",
     "pay.expected": "Expected {date}",
     "pay.label": "Payment for {key}",
     "pay.paid": "Paid",
     "pay.scheduled": "Scheduled",
     "pay.submitted": "Submitted",
     "payout.account": "Account Number",
     "payout.accountHelp": "Encrypted on entry. Only the last four digits are shown after saving.",
     "payout.checking": "Checking",
     "payout.routing": "Routing Number",
     "payout.routingHint": "9 digits",
     "payout.save": "Save Securely",
     "payout.savings": "Savings",
     "payout.title": "Payout Details",
     "payout.type": "Account Type",
     "peek.openFull": "Open full page",
     "phase.gate": "Gate {n}",
     "phase.gateName": "Gate {n} · {name}",
     "photo.annotate": "Annotate",
     "photo.n": "Photo {n}",
     "photo.take": "Take photo",
     "presence.editing": "{n} editing",
     "presence.viewing": "{n} viewing",
     "profile.complete": "{n}% complete",
     "profile.title": "Profile",
     "provenance.rank": "Provenance rank {rank}",
     "provenance.source": "Source",
     "quickAdd.label": "Quick add",
     "radio.assignment": "Assignment",
     "radio.channel": "Channel",
     "radio.notes": "Notes",
     "radio.zone": "Zone",
     "rating.comment": "Public comment",
     "rating.label": "Rating",
     "rating.release": "Both ratings are released together once both are in, or after 14 days.",
     "rating.star": "{n} star",
     "rating.stars": "{n} stars",
     "rating.submit": "Submit Rating",
     "rating.title": "Rate {name}",
     "recon.capability": "Venue Capability",
     "recon.notDeclared": "Not declared",
     "recon.requirement": "Requirement",
     "recon.result": "Result",
     "record.untitled": "Untitled",
     "resource.doubleBooked": "Double-booked",
     "resource.person": "Person",
     "result.gap": "Gap",
     "result.met": "Met",
     "result.unknown": "Unknown",
     "ros.go": "Go",
     "ros.label": "Run of show",
     "ros.live": "Live",
     "ros.nextIn": "Next cue in",
     "rte.bold": "Bold",
     "rte.bullets": "Bulleted list",
     "rte.checklist": "Checklist",
     "rte.hint": "Type / for blocks, @ to mention, # to link a record.",
     "rte.italic": "Italic",
     "rte.link": "Link",
     "rte.mention": "Mention",
     "rte.table": "Table",
     "rte.toolbar": "Formatting",
     "scan.asset": "Asset",
     "scan.credential": "Credential",
     "scan.mode": "Scan mode",
     "scan.nfc": "Read NFC",
     "scan.receiving": "Receiving",
     "scan.torch": "Torch",
     "scroll.region": "Scrollable content",
     "shell.menu": "Open navigation",
     "shortcutEditor.action": "Action",
     "shortcutEditor.change": "Change",
     "shortcutEditor.edit": "Edit",
     "shortcutEditor.press": "Press Keys",
     "shortcutEditor.shortcut": "Shortcut",
     "shortcuts.title": "Keyboard Shortcuts",
     "signature.area": "Signature area. Draw with a finger, stylus or mouse.",
     "slate.filled": "Positions filled",
     "slate.include": "Include {name}",
     "slate.positions": "{n} of {total} positions",
     "slate.submit": "Submit Slate",
     "slate.title": "Staff Slate",
     "stale.basis": "evidence date",
     "stale.current": "Current",
     "stale.degraded": "Degraded One Step",
     "stale.expired": "Expired",
     "stale.modeled": "Modeled",
     "stale.months": "{n} mo",
     "stale.title": "{n} months since {basis}",
     "tabbar.badge": "{n} new",
     "table.total": "Total",
     "timeline.critical": "critical path",
     "timeline.dependsOn": "Depends on",
     "timeline.end": "End",
     "timeline.key": "Key",
     "timeline.milestone": "milestone",
     "timeline.record": "Record",
     "timeline.start": "Start",
     "timeline.state": "State",
     "tooltip.withShortcut": "{label} ({shortcut})",
     "update.action": "Update",
     "update.title": "Update Required",
     "upnext.bring": "Bring",
     "upnext.calendar": "Add to Calendar",
     "upnext.call": "Call time",
     "upnext.contact": "Contact",
     "upnext.directions": "Directions",
     "upnext.label": "Up Next",
     "upnext.parking": "Parking",
     "upnext.when": "When",
     "upnext.where": "Where",
     "view.cards": "Cards",
     "view.label": "View",
     "view.map": "Map",
     "visibility.application": "On Apply",
     "visibility.private": "Private",
     "visibility.public": "Public",
     "whatsNew.changelog": "Changelog",
     "whatsNew.title": "What's New",
     "widget.label": "Home screen widget",
     "widget.nextShift": "Next shift"
    };
  function t(key, vars) {
    var s = MESSAGES[key];
    if (s === undefined) return key;
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? vars[k] : m; }) : s;
  }
  var tt = t;
  function configure(opts) { if (opts.locale) LOCALE = opts.locale; if (opts.messages) Object.assign(MESSAGES, opts.messages); }
  function fmtNumber(n) { return new Intl.NumberFormat(LOCALE).format(n); }
  function fmtCurrency(n, currency) { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: currency || "USD" }).format(n); }
  function weekStart() { try { var l = new Intl.Locale(LOCALE), w = l.getWeekInfo ? l.getWeekInfo() : l.weekInfo; return w ? w.firstDay % 7 : 0; } catch (e) { return 0; } }
  var RTL_ICONS = /^(ChevronRight|ChevronLeft|ArrowUpRight|ArrowRight|ArrowLeft|Undo2|Send|ExternalLink|chevron-right|chevron-left|undo)$/;

  /* Icons come from lucide-react (window.LucideReact) at 1.5 stroke. */
  var ICON_ALIAS = { more: "Ellipsis", alert: "TriangleAlert", "check-circle": "CircleCheck", pin: "MapPin", home: "House", undo: "Undo2" };
  function pascal(n) { return n.split("-").map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(""); }
  function lucide(name) { var L = window.LucideReact || {}; return L[ICON_ALIAS[name] || (/^[A-Z]/.test(name) ? name : pascal(name))] || null; }
  function Icon(props) {
    var size = props.size || 16, C = lucide(props.name);
    var a11y = props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": "true" };
    if (!C) return h("span", Object.assign({ className: "xos-icon", style: { width: size, height: size } }, a11y));
    return h(C, Object.assign({ className: cx("xos-icon", RTL_ICONS.test(props.name) && "xos-flip-rtl", props.className), size: size, strokeWidth: props.strokeWidth || 1.5, absoluteStrokeWidth: false, style: props.color ? { color: props.color } : undefined }, a11y));
  }

  /* Record state icons: shape carries meaning, hue reinforces it. */
  var STATE_COLOR = { proposed: "--state-proposed", ready: "--state-ready", scheduled: "--state-scheduled", active: "--state-active", blocked: "--state-blocked", "in-review": "--state-in-review", complete: "--state-complete", deferred: "--state-deferred", canceled: "--state-canceled" };
  function stateShape(state) {
    var ring = function (extra) { return h("circle", Object.assign({ cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }, extra || {})); };
    switch (state) {
      case "proposed": return [ring({ key: "r", strokeDasharray: "2.2 2.2" })];
      case "ready": return [ring({ key: "r" })];
      case "scheduled": return [ring({ key: "r" }), h("path", { key: "h", d: "M8 5v3.25l2 1.25", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })];
      case "active": return [ring({ key: "r" }), h("path", { key: "f", d: "M8 4.5a3.5 3.5 0 0 1 0 7z", fill: "currentColor" })];
      case "blocked": return [h("path", { key: "o", d: "M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z", fill: "currentColor" }), h("path", { key: "b", d: "M5.5 8h5", stroke: "var(--bg-canvas)", strokeWidth: 1.5, strokeLinecap: "round" })];
      case "in-review": return [ring({ key: "r" }), h("path", { key: "e", d: "M4.75 8s1.25-2 3.25-2s3.25 2 3.25 2s-1.25 2-3.25 2s-3.25-2-3.25-2z", fill: "none", stroke: "currentColor", strokeWidth: 1.25 }), h("circle", { key: "p", cx: 8, cy: 8, r: 0.9, fill: "currentColor" })];
      case "complete": return [h("circle", { key: "c", cx: 8, cy: 8, r: 6.75, fill: "currentColor" }), h("path", { key: "k", d: "M5.25 8.25l1.75 1.75l3.5-4", fill: "none", stroke: "var(--bg-canvas)", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })];
      case "deferred": return [ring({ key: "r" }), h("path", { key: "p", d: "M6.75 5.75v4.5M9.25 5.75v4.5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })];
      case "canceled": return [ring({ key: "r" }), h("path", { key: "s", d: "M4 12l8-8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })];
      default: return [ring({ key: "r" })];
    }
  }
  function StateIcon(props) {
    var size = props.size || 14;
    return h("svg", { className: "xos-icon", width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", style: { color: "var(" + (STATE_COLOR[props.state] || "--text-secondary") + ")" } }, stateShape(props.state));
  }
  function StateChip(props) {
    var Tag = props.onClick ? "button" : "span";
    return h(Tag, { className: "xos-chip", onClick: props.onClick, type: props.onClick ? "button" : undefined },
      h(StateIcon, { state: props.state }), props.compact ? null : h("span", null, props.label));
  }

  function Kbd(props) { return h("kbd", { className: "xos-kbd" }, props.children); }

  function Button(props) {
    var variant = props.variant || "secondary";
    var size = props.size || "md";
    var other = rest(props, ["variant", "size", "loading", "icon", "shortcut", "className", "children"]);
    if (props.loading) { other["aria-busy"] = "true"; other["aria-disabled"] = "true"; }
    return h("button", Object.assign({ type: "button" }, other, { className: cx("xos-btn", "xos-btn-" + variant, size !== "md" && "xos-btn-" + size, props.className) }),
      props.loading ? h("svg", { className: "xos-icon xos-spin", width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true" }, h("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeDasharray: "28 10", strokeLinecap: "round" })) : (props.icon ? h(Icon, { name: props.icon, size: 14 }) : null),
      props.children,
      props.shortcut ? h(Kbd, null, props.shortcut) : null);
  }
  function IconButton(props) {
    var other = rest(props, ["icon", "label", "shortcut", "variant"]);
    return h("button", Object.assign({ type: "button", "aria-label": props.label, title: props.shortcut ? t("tooltip.withShortcut", { label: props.label, shortcut: props.shortcut }) : props.label }, other, { className: cx("xos-btn", "xos-iconbtn", "xos-btn-" + (props.variant || "ghost")) }), h(Icon, { name: props.icon }));
  }

  var uid = 0;
  function Input(props) {
    var id = props.id || "xos-in-" + (++uid);
    var other = rest(props, ["label", "help", "error", "id", "width"]);
    var described = props.error ? id + "-err" : props.help ? id + "-help" : undefined;
    return h("div", { className: "xos-field", style: props.width !== undefined ? { width: props.width } : undefined },
      props.label ? h("label", { className: "xos-label", htmlFor: id }, props.label) : null,
      h("input", Object.assign({ id: id, className: "xos-input", "aria-invalid": props.error ? "true" : undefined, "aria-describedby": described }, other)),
      props.error ? h("div", { className: "xos-error", id: id + "-err" }, h(Icon, { name: "alert", size: 12 }), props.error) : props.help ? h("div", { className: "xos-help", id: id + "-help" }, props.help) : null);
  }

  function formatMoney(amount, currency) { return fmtCurrency(amount, currency); }
  function Money(props) {
    if (props.amount === null || props.amount === undefined) return h("span", { className: "xos-unpriced" }, props.unpricedLabel || t("money.unpriced"));
    return h("span", { className: "xos-num" }, formatMoney(props.amount, props.currency));
  }
  function CurrencyInput(props) {
    var id = props.id || "xos-cur-" + (++uid);
    var isNull = props.value === null || props.value === undefined;
    return h("div", { className: "xos-field" },
      props.label ? h("label", { className: "xos-label", htmlFor: id }, props.label) : null,
      h("div", { className: "xos-currency" },
        h("input", { id: id, className: "xos-input xos-num", inputMode: "decimal", style: { flex: 1, textAlign: "end" }, placeholder: props.unpricedLabel || t("money.unpriced"), defaultValue: isNull ? "" : String(props.value), onChange: props.onChange }),
        h("span", { className: "xos-cur" }, props.currency || "USD")),
      h("div", { className: "xos-help" }, props.help || (isNull ? t("money.blankHelp") : "")));
  }

  function Checkbox(props) {
    var other = rest(props, ["label"]);
    return h("label", { className: "xos-check" }, h("input", Object.assign({ type: "checkbox" }, other)), props.label);
  }
  function Switch(props) {
    var other = rest(props, ["label"]);
    return h("label", { className: "xos-check xos-switch" }, h("input", Object.assign({ type: "checkbox", role: "switch" }, other)), props.label);
  }

  function SegmentedControl(props) {
    var s = React.useState(props.value || (props.options[0] && props.options[0].value));
    return h("div", { className: "xos-seg", role: "group", "aria-label": props.label },
      props.options.map(function (o) {
        return h("button", { key: o.value, type: "button", "aria-pressed": s[0] === o.value ? "true" : "false", onClick: function () { s[1](o.value); if (props.onChange) props.onChange(o.value); } }, o.icon ? h(Icon, { name: o.icon, size: 14 }) : null, o.label);
      }));
  }
  function Tabs(props) {
    var s = React.useState(props.value || (props.tabs[0] && props.tabs[0].value));
    return h("div", { className: "xos-tabs", role: "tablist", "aria-label": props.label },
      props.tabs.map(function (tab) {
        return h("button", { key: tab.value, type: "button", role: "tab", className: "xos-tab", "aria-selected": s[0] === tab.value ? "true" : "false", tabIndex: s[0] === tab.value ? 0 : -1, onClick: function () { s[1](tab.value); if (props.onChange) props.onChange(tab.value); } },
          tab.label, tab.count !== undefined ? h("span", { className: "xos-count xos-num" }, tab.count) : null);
      }));
  }
  function Breadcrumbs(props) {
    var n = props.items.length;
    return h("nav", { "aria-label": t("nav.breadcrumb") }, h("ol", { className: "xos-crumbs" },
      props.items.map(function (it, i) {
        var last = i === n - 1;
        return h("li", { key: i }, last ? h("span", { "aria-current": "page" }, it.label) : h("a", { href: it.href || "#" }, it.label), last ? null : h(Icon, { name: "chevron-right", size: 12 }));
      })));
  }

  /* Plain words before codes: name first, code in a mono chip. */
  function CodeChip(name, code, lead) {
    return h("span", { className: "xos-chip" }, lead || null, h("span", null, name), h("span", { className: "xos-chip-code" }, code));
  }
  function PhaseChip(props) {
    return h("span", { className: "xos-chip", title: props.code }, h("span", null, t("phase.gate", { n: props.gate })), h("span", { className: "xos-sep" }, "·"), h("span", null, props.name));
  }
  function DepartmentChip(props) { return CodeChip(props.name, props.code); }
  function URIDChip(props) { return CodeChip(props.name, props.urid); }
  function PropertyChip(props) {
    var Tag = props.onClick ? "button" : "span";
    return h(Tag, { className: "xos-chip", type: props.onClick ? "button" : undefined, onClick: props.onClick },
      props.icon ? h(Icon, { name: props.icon, size: 14, color: "var(--text-secondary)" }) : null,
      props.label ? h("span", { className: "xos-prop-label" }, props.label) : null,
      h("span", null, props.value));
  }
  function Tag(props) {
    return h("span", { className: cx("xos-tag", "xos-tag-" + (props.tone || "neutral")) }, h("span", { className: "xos-tag-dot", "aria-hidden": "true" }), props.children);
  }

  function Pips(rank, max) {
    var out = [];
    for (var i = 1; i <= max; i++) out.push(h("span", { key: i, className: cx("xos-pip", i <= rank && "xos-pip-on") }));
    return h("span", { className: cx("xos-pips", "xos-rank-" + rank), "aria-hidden": "true" }, out);
  }
  function ProvenanceBadge(props) {
    return h("span", { className: "xos-chip", title: t("provenance.rank", { rank: props.rank }) }, h("span", { className: "xos-prop-label" }, t("provenance.source")), h("span", null, props.source), h("span", { className: "xos-chip-code" }, String(props.rank)));
  }
  function AssertionRankBadge(props) {
    return h("span", { className: "xos-chip", "aria-label": t("assertion.aria", { label: props.label, rank: props.rank }) }, Pips(props.rank, 4), h("span", null, props.label));
  }

  function RefusalNotice(props) {
    return h("div", { className: "xos-alert xos-refusal", role: "status" },
      h(Icon, { name: "info", color: "var(--text-secondary)" }),
      h("div", { className: "xos-col", style: { gap: "var(--space-4)" } },
        h("div", { className: "xos-row", style: { gap: "var(--space-6)" } }, h("span", { className: "xos-refusal-value" }, props.outcome), h("span", { className: "xos-alert-title" }, props.title)),
        h("div", { className: "xos-alert-body" }, props.reason),
        props.actionLabel ? h("div", null, h(Button, { size: "sm", onClick: props.onAction }, props.actionLabel)) : null));
  }
  var TONE_ICON = { info: "info", success: "check-circle", warning: "alert", danger: "alert" };
  function InlineAlert(props) {
    var tone = props.tone || "info";
    return h("div", { className: cx("xos-alert", "xos-alert-" + tone), role: tone === "danger" ? "alert" : "status" },
      h(Icon, { name: TONE_ICON[tone] }),
      h("div", { className: "xos-col", style: { gap: "var(--space-2)" } }, props.title ? h("div", { className: "xos-alert-title" }, props.title) : null, h("div", { className: "xos-alert-body" }, props.children)));
  }
  function Toast(props) {
    return h("div", { className: "xos-toast", role: "status" },
      h("span", null, props.message),
      props.actionLabel ? h(Button, { size: "sm", variant: "ghost", icon: props.actionIcon, onClick: props.onAction, shortcut: props.shortcut }, props.actionLabel) : null);
  }
  function EmptyState(props) {
    return h("div", { className: "xos-empty" }, props.icon ? h(Icon, { name: props.icon, size: 24 }) : null, h("p", null, props.sentence), h(Button, { variant: "primary", onClick: props.onAction, shortcut: props.shortcut }, props.actionLabel));
  }
  function ProgressBar(props) {
    var pct = Math.max(0, Math.min(100, props.value));
    return h("div", { className: "xos-progress" },
      h("div", { className: "xos-progress-head" }, h("span", null, props.label), h("span", { className: "xos-num" }, pct + "%")),
      h("div", { className: "xos-progress-track", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": props.label }, h("div", { className: "xos-progress-fill", style: { width: pct + "%" } })));
  }
  function Skeleton(props) { return h("span", { className: "xos-skel", "aria-hidden": "true", style: { width: props.width || 160, height: props.height || 12 } }); }

  function initials(name) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (p) { return p[0].toUpperCase(); }).join(""); }
  function Avatar(props) { return h("span", { className: cx("xos-avatar", props.size === "lg" && "xos-avatar-lg"), title: props.name, role: "img", "aria-label": props.name }, initials(props.name)); }
  function AvatarStack(props) {
    var max = props.max || 3, names = props.names, shown = names.slice(0, max), extra = names.length - shown.length;
    return h("span", { className: "xos-stack" }, shown.map(function (n) { return h(Avatar, { key: n, name: n }); }), extra > 0 ? h("span", { className: "xos-avatar xos-avatar-more xos-num", "aria-label": t("avatar.more", { n: extra }) }, "+" + extra) : null);
  }
  function Tooltip(props) {
    return h("span", { className: "xos-tooltip", role: "tooltip" }, props.label, props.shortcut ? props.shortcut.split(" ").map(function (k, i) { return h(Kbd, { key: i }, k); }) : null);
  }

  function DataTable(props) {
    var cols = props.columns;
    function cell(c, row) {
      var v = row[c.key];
      if (c.type === "money") return h(Money, { amount: v, currency: c.currency });
      if (c.type === "state") return h("span", { className: "xos-row", style: { gap: "var(--space-6)", flexWrap: "nowrap" } }, h(StateIcon, { state: v.state }), v.label);
      if (c.type === "code") return h("span", { className: "xos-code" }, v);
      if (c.type === "number") return v === null || v === undefined ? "" : h("span", { className: "xos-num" }, v);
      return v;
    }
    var right = function (c) { return c.type === "money" || c.type === "number"; };
    return h("table", { className: cx("xos-table", props.density && props.density !== "default" && "xos-table-" + props.density) },
      props.caption ? h("caption", { style: { textAlign: "start", padding: "0 0 var(--space-8)", fontWeight: 600 } }, props.caption) : null,
      h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { key: c.key, scope: "col", className: right(c) ? "xos-right" : undefined }, c.label); }))),
      h("tbody", null, props.rows.map(function (r, i) { return h("tr", { key: i }, cols.map(function (c) { return h("td", { key: c.key, className: cx(right(c) && "xos-right", c.wrap && "xos-td-wrap") || undefined }, cell(c, r)); })); })),
      props.totals ? h("tfoot", null, h("tr", null, cols.map(function (c) { return h("td", { key: c.key, className: right(c) ? "xos-right" : undefined }, c.key in props.totals ? cell(c, props.totals) : (c === cols[0] ? props.totalsLabel || t("table.total") : "")); }))) : null);
  }

  function CommandMenu(props) {
    return h("div", { className: "xos-cmd", role: "dialog", "aria-label": t("command.label") },
      h("div", { className: "xos-cmd-input" }, h(Icon, { name: "search", color: "var(--text-secondary)" }), h("span", { className: props.query ? "xos-q" : "xos-q xos-muted" }, props.query || props.placeholder), h(Kbd, null, t("key.esc"))),
      h("div", { role: "listbox", "aria-label": t("command.results") }, props.groups.map(function (g) {
        return h("div", { key: g.label, className: "xos-cmd-group", role: "group", "aria-label": g.label }, h("div", { className: "xos-cmd-head", "aria-hidden": "true" }, g.label),
          g.items.map(function (it, i) {
            return h("div", { key: i, role: "option", className: "xos-cmd-item", "aria-selected": it.selected ? "true" : "false" },
              it.state ? h(StateIcon, { state: it.state }) : h(Icon, { name: it.icon || "chevron-right" }),
              h("span", null, it.label), it.code ? h("span", { className: "xos-code xos-muted" }, it.code) : null,
              it.shortcut ? h("span", { className: "xos-hint" }, it.shortcut.split(" ").map(function (k, j) { return h(Kbd, { key: j }, k); })) : null);
          }));
      })));
  }
  function Dialog(props) {
    return h("div", { className: "xos-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "xos-dlg-t" },
      h("header", null, h("h2", { id: "xos-dlg-t" }, props.title)),
      h("div", { className: "xos-dialog-body" }, props.children),
      h("footer", null, props.actions));
  }
  function Sidebar(props) {
    return h("nav", { className: "xos-sidebar", "aria-label": props.label || t("nav.main") },
      props.groups.map(function (g, gi) {
        return h("div", { key: gi, className: g.label ? "xos-nav-group" : undefined },
          g.label ? h("h4", null, h(Icon, { name: g.collapsed ? "chevron-right" : "chevron-down", size: 12 }), g.label) : null,
          g.collapsed ? null : g.items.map(function (it) {
            return h("button", { key: it.label, type: "button", className: "xos-nav-item", "aria-current": it.label === props.active ? "page" : undefined },
              it.icon ? h(Icon, { name: it.icon }) : null, it.label, it.badge !== undefined ? h("span", { className: "xos-badge xos-num" }, it.badge) : null);
          }));
      }));
  }
  function ClockButton(props) {
    var state = props.state || "out";
    return h("div", { className: "xos-col", style: { alignItems: "stretch", maxWidth: 358 } },
      props.geofence ? h("span", { className: "xos-geo" }, h(Icon, { name: "pin", size: 16, color: props.geofenceOk ? "var(--success)" : "var(--warning)" }), props.geofence) : null,
      h("button", { type: "button", className: cx("xos-clock", "xos-clock-" + state), "aria-disabled": state === "blocked" ? "true" : undefined, onClick: props.onClick },
        props.timer ? h("span", { className: "xos-timer" }, props.timer) : null,
        h("span", null, props.label),
        props.detail ? h("small", null, props.detail) : null));
  }

  var EXPORTS = {
    configure: configure, t: t,
    Button: Button, IconButton: IconButton, Kbd: Kbd, Input: Input, CurrencyInput: CurrencyInput, Money: Money, Checkbox: Checkbox, Switch: Switch,
    SegmentedControl: SegmentedControl, Tabs: Tabs, Breadcrumbs: Breadcrumbs, Icon: Icon, StateIcon: StateIcon, StateChip: StateChip,
    PhaseChip: PhaseChip, DepartmentChip: DepartmentChip, URIDChip: URIDChip, PropertyChip: PropertyChip, Tag: Tag,
    ProvenanceBadge: ProvenanceBadge, AssertionRankBadge: AssertionRankBadge, RefusalNotice: RefusalNotice, InlineAlert: InlineAlert,
    Toast: Toast, EmptyState: EmptyState, ProgressBar: ProgressBar, Skeleton: Skeleton, Avatar: Avatar, AvatarStack: AvatarStack,
    Tooltip: Tooltip, DataTable: DataTable, CommandMenu: CommandMenu, Dialog: Dialog, Sidebar: Sidebar, ClockButton: ClockButton
  };


  /* XOS glyphs: Lucide icons assigned to the 10 departments, 9 phases and 26 record kinds. */
  var DEPARTMENT_GLYPH = { "0000": "Briefcase", "1000": "Palette", "2000": "MicVocal", "3000": "Megaphone", "4000": "Tent", "5000": "SlidersHorizontal", "6000": "ClipboardList", "7000": "Sparkles", "8000": "ConciergeBell", "9000": "Cpu" };
  var PHASE_GLYPH = { SCP: "Crosshair", ENG: "Handshake", ADV: "ClipboardCheck", PRC: "ShoppingCart", BLD: "Hammer", INS: "Wrench", OPR: "Play", AMP: "Share2", CLS: "Archive" };
  var RECORD_KIND_GLYPH = {
    Build: "Construction", Rehearsal: "Repeat", Shift: "CalendarClock", Strike: "PackageX", Task: "SquareCheck", Training: "GraduationCap",
    Document: "FileText", Supply: "Package",
    Booking: "CalendarCheck", Contract: "FileSignature", Payment: "Banknote", Recruitment: "UserPlus",
    Approval: "Stamp", Compliance: "ShieldCheck", Deadline: "AlarmClock", Decision: "Split", Inspection: "ScanSearch", Permit: "BadgeCheck",
    Distribution: "Send", Event: "Ticket", Goal: "Target", Meeting: "Users", Milestone: "Milestone", Report: "ChartColumn", Risk: "TriangleAlert", Timeline: "ChartGantt"
  };
  function DepartmentGlyph(props) { return h(Icon, { name: DEPARTMENT_GLYPH[props.code] || "Circle", size: props.size, label: props.label, color: props.color }); }
  function PhaseGlyph(props) { return h(Icon, { name: PHASE_GLYPH[props.code] || "Circle", size: props.size, label: props.label, color: props.color }); }
  function RecordKindGlyph(props) { return h(Icon, { name: RECORD_KIND_GLYPH[props.kind] || "Circle", size: props.size, label: props.label, color: props.color }); }

  /* Chips now lead with their glyph. */
  function PhaseChipG(props) {
    return h("span", { className: "xos-chip", title: props.code },
      props.code ? h(PhaseGlyph, { code: props.code, size: 14, color: "var(--text-secondary)" }) : null,
      h("span", null, t("phase.gate", { n: props.gate })), h("span", { className: "xos-sep" }, "·"), h("span", null, props.name));
  }
  function DepartmentChipG(props) {
    return h("span", { className: "xos-chip" }, h(DepartmentGlyph, { code: props.code, size: 14, color: "var(--text-secondary)" }), h("span", null, props.name), h("span", { className: "xos-chip-code" }, props.code));
  }
  function RecordKindChip(props) {
    return h("span", { className: "xos-chip" }, h(RecordKindGlyph, { kind: props.kind, size: 14, color: "var(--text-secondary)" }), h("span", null, props.label || props.kind));
  }

  /* White label: a tenant mark slot with a token-driven fallback. */
  function BrandMark(props) {
    var size = props.size || "md";
    var heights = { sm: 20, md: 28, lg: 40 };
    var hgt = heights[size] || 28;
    if (props.logoLight || props.logoDark) {
      return h("span", { className: "xos-brand" },
        props.logoDark ? h("img", { className: "xos-brand-dark", src: props.logoDark, alt: props.name, height: hgt }) : null,
        props.logoLight ? h("img", { className: "xos-brand-light", src: props.logoLight, alt: props.name, height: hgt }) : null);
    }
    var mono = (props.monogram || props.name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2)).toUpperCase();
    return h("span", { className: cx("xos-brand", "xos-brand-" + size), role: "img", "aria-label": props.name },
      h("span", { className: "xos-brand-tile", "aria-hidden": "true", style: { width: hgt, height: hgt } }, mono),
      props.iconOnly ? null : h("span", { className: "xos-brand-name", "aria-hidden": "true" }, props.name));
  }
  function BrandSlot(props) {
    return h("figure", { className: "xos-slot" },
      // width and height are the delivery size in pixels; the frame is drawn in proportion, at most 160 by 148.
      (function () { var k = Math.min(1, 160 / props.width, 148 / props.height); return h("div", { className: "xos-slot-frame", style: { width: Math.round(props.width * k), height: Math.round(props.height * k) } }, h(Icon, { name: "Image", size: 20 }), h("span", { className: "xos-num" }, props.width + " x " + props.height)); })(),
      h("figcaption", null, h("strong", null, props.label), h("span", null, props.formats)));
  }
  function WhiteLabelPreview(props) {
    return h("div", { className: "xos-wl" }, props.brands.map(function (b) {
      var style = {};
      for (var k in b.tokens) style["--" + k] = b.tokens[k];
      return h("div", { key: b.name, className: "xos-wl-pane", style: style, "data-theme": b.theme },
        h("div", { className: "xos-wl-bar" }, h(BrandMark, { name: b.name, size: "sm" }), h("span", { className: "xos-muted xos-wl-domain", title: b.domain }, b.domain)),
        h("div", { className: "xos-wl-body" },
          props.sample));
    }));
  }

  Object.assign(EXPORTS, {
    DepartmentGlyph: DepartmentGlyph, PhaseGlyph: PhaseGlyph, RecordKindGlyph: RecordKindGlyph,
    PhaseChip: PhaseChipG, DepartmentChip: DepartmentChipG, RecordKindChip: RecordKindChip,
    BrandMark: BrandMark, BrandSlot: BrandSlot, WhiteLabelPreview: WhiteLabelPreview,
    glyphs: { departments: DEPARTMENT_GLYPH, phases: PHASE_GLYPH, recordKinds: RECORD_KIND_GLYPH }
  });


  /* Shared field shell */
  function Field(props, control) {
    var id = props.id;
    return h("div", { className: "xos-field", style: props.width ? { width: props.width } : undefined },
      props.label ? h("label", { className: "xos-label", htmlFor: id, id: id + "-label" }, props.label) : null,
      control,
      props.error ? h("div", { className: "xos-error", id: id + "-err" }, h(Icon, { name: "alert", size: 12 }), props.error) : props.help ? h("div", { className: "xos-help", id: id + "-help" }, props.help) : null);
  }
  function fid(p, pre) { return p.id || pre + "-" + (++uid); }

  function Link(props) {
    var other = rest(props, ["external", "children"]);
    return h("a", Object.assign({ className: "xos-link" }, other, props.external ? { target: "_blank", rel: "noopener noreferrer" } : {}), props.children, props.external ? h(Icon, { name: "ExternalLink", size: 12, label: t("link.newTab") }) : null);
  }
  function Textarea(props) {
    var id = fid(props, "xos-ta"), other = rest(props, ["label", "help", "error", "id", "width"]);
    return Field(Object.assign({}, props, { id: id }), h("textarea", Object.assign({ id: id, className: "xos-input xos-textarea", rows: 3, "aria-invalid": props.error ? "true" : undefined }, other)));
  }
  function Select(props) {
    var id = fid(props, "xos-sel");
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-select" },
      h("select", { id: id, className: "xos-input", defaultValue: props.value, onChange: props.onChange, disabled: props.disabled },
        props.placeholder ? h("option", { value: "", disabled: true }, props.placeholder) : null,
        props.options.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); })),
      h(Icon, { name: "ChevronsUpDown", size: 14 })));
  }

  function useListbox(options, initialOpen) {
    var q = React.useState(""), open = React.useState(!!initialOpen), act = React.useState(0);
    var list = options.filter(function (o) { return o.label.toLowerCase().indexOf(q[0].toLowerCase()) >= 0; });
    return { q: q, open: open, act: act, list: list };
  }
  function OptionRow(o, selected, active, onPick) {
    return h("div", { key: o.value, role: "option", "aria-selected": selected ? "true" : "false", className: cx("xos-opt", active && "xos-opt-active"), onMouseDown: function (e) { e.preventDefault(); onPick(o); } },
      o.icon ? h(Icon, { name: o.icon, size: 14 }) : null, h("span", null, o.label), o.code ? h("span", { className: "xos-code xos-muted" }, o.code) : null,
      selected ? h(Icon, { name: "Check", size: 14, className: "xos-opt-check" }) : null);
  }
  function Combobox(props) {
    var id = fid(props, "xos-cb"), s = useListbox(props.options, props.defaultOpen), val = React.useState(props.value);
    var current = props.options.filter(function (o) { return o.value === val[0]; })[0];
    function pick(o) { val[1](o.value); s.q[1](""); s.open[1](false); if (props.onChange) props.onChange(o.value); }
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-combo" },
      h("input", { id: id, className: "xos-input", role: "combobox", "aria-expanded": s.open[0] ? "true" : "false", "aria-controls": id + "-list", "aria-autocomplete": "list",
        placeholder: current ? current.label : props.placeholder, value: s.q[0],
        onFocus: function () { s.open[1](true); }, onBlur: function () { if (!props.defaultOpen) s.open[1](false); },
        onChange: function (e) { s.q[1](e.target.value); s.open[1](true); s.act[1](0); },
        onKeyDown: function (e) {
          if (e.key === "ArrowDown") { e.preventDefault(); s.act[1](Math.min(s.act[0] + 1, s.list.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); s.act[1](Math.max(s.act[0] - 1, 0)); }
          if (e.key === "Enter" && s.list[s.act[0]]) { e.preventDefault(); pick(s.list[s.act[0]]); }
          if (e.key === "Escape") s.open[1](false);
        } }),
      h(Icon, { name: "ChevronsUpDown", size: 14 }),
      s.open[0] ? h("div", { className: "xos-listbox", role: "listbox", id: id + "-list" },
        s.list.length ? s.list.map(function (o, i) { return OptionRow(o, o.value === val[0], i === s.act[0], pick); }) : h("div", { className: "xos-opt xos-muted" }, props.noMatch || t("list.noMatch"))) : null));
  }
  function MultiSelect(props) {
    var id = fid(props, "xos-ms"), s = useListbox(props.options, props.defaultOpen), val = React.useState(props.value || []);
    function toggle(o) { var v = val[0].indexOf(o.value) >= 0 ? val[0].filter(function (x) { return x !== o.value; }) : val[0].concat([o.value]); val[1](v); if (props.onChange) props.onChange(v); }
    var chosen = props.options.filter(function (o) { return val[0].indexOf(o.value) >= 0; });
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-combo" },
      h("div", { className: "xos-input xos-multi", onClick: function () { s.open[1](true); } },
        chosen.map(function (o) { return h("span", { key: o.value, className: "xos-chip" }, o.label, h("button", { type: "button", className: "xos-chip-x", "aria-label": t("chip.remove", { label: o.label }), onClick: function (e) { e.stopPropagation(); toggle(o); } }, h(Icon, { name: "X", size: 12 }))); }),
        h("input", { id: id, className: "xos-multi-input", role: "combobox", "aria-expanded": s.open[0] ? "true" : "false", "aria-controls": id + "-list", placeholder: chosen.length ? "" : props.placeholder, value: s.q[0],
          onFocus: function () { s.open[1](true); }, onBlur: function () { if (!props.defaultOpen) s.open[1](false); },
          onChange: function (e) { s.q[1](e.target.value); },
          onKeyDown: function (e) { if (e.key === "Backspace" && !s.q[0] && chosen.length) toggle(chosen[chosen.length - 1]); } })),
      s.open[0] ? h("div", { className: "xos-listbox", role: "listbox", "aria-multiselectable": "true", id: id + "-list" },
        s.list.map(function (o, i) { return OptionRow(o, val[0].indexOf(o.value) >= 0, false, toggle); })) : null));
  }
  function Radio(props) {
    var name = props.name || "xos-radio-" + (++uid);
    return h("fieldset", { className: "xos-fieldset" }, h("legend", { className: "xos-label" }, props.label),
      props.options.map(function (o) {
        return h("label", { key: o.value, className: "xos-check xos-radio" },
          h("input", { type: "radio", name: name, value: o.value, defaultChecked: props.value === o.value, onChange: props.onChange }),
          h("span", { className: "xos-col", style: { gap: 0 } }, h("span", null, o.label), o.help ? h("span", { className: "xos-help" }, o.help) : null));
      }));
  }
  function Slider(props) {
    var id = fid(props, "xos-sl"), v = React.useState(props.value);
    return Field(Object.assign({}, props, { id: id, label: null }), h("div", { className: "xos-col", style: { gap: "var(--space-6)" } },
      h("div", { className: "xos-progress-head" }, h("label", { htmlFor: id, className: "xos-label" }, props.label), h("output", { htmlFor: id, className: "xos-num" }, v[0] + (props.unit ? " " + props.unit : ""))),
      h("input", { id: id, type: "range", className: "xos-slider", min: props.min, max: props.max, step: props.step || 1, value: v[0], onChange: function (e) { v[1](+e.target.value); if (props.onChange) props.onChange(+e.target.value); },
        style: { "--fill": ((v[0] - props.min) / (props.max - props.min) * 100) + "%" } })));
  }
  function NumberInput(props) {
    var id = fid(props, "xos-num"), v = React.useState(props.value === undefined ? null : props.value), step = props.step || 1;
    function set(n) { v[1](n); if (props.onChange) props.onChange(n); }
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-number" },
      h("button", { type: "button", className: "xos-btn xos-btn-ghost xos-iconbtn", "aria-label": t("number.decrease"), onClick: function () { set((v[0] || 0) - step); } }, h(Icon, { name: "Minus", size: 14 })),
      h("input", { id: id, className: "xos-input xos-num", inputMode: "decimal", value: v[0] === null ? "" : v[0], placeholder: props.placeholder, onChange: function (e) { set(e.target.value === "" ? null : +e.target.value); } }),
      props.unit ? h("span", { className: "xos-cur" }, props.unit) : null,
      h("button", { type: "button", className: "xos-btn xos-btn-ghost xos-iconbtn", "aria-label": t("number.increase"), onClick: function () { set((v[0] || 0) + step); } }, h(Icon, { name: "Plus", size: 14 }))));
  }

  /* Dates */
  function monthTitle(y, m) { return new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" }).format(new Date(y, m, 1)); }
  function dowNames() { var f = new Intl.DateTimeFormat(LOCALE, { weekday: "short" }), ws = weekStart(), out = []; for (var i = 0; i < 7; i++) out.push(f.format(new Date(2026, 1, 1 + ((ws + i) % 7)))); return out; }
  function iso(y, m, d) { return y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }
  function parseIso(s) { var p = s.split("-"); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }
  function fmtDate(s) { if (!s) return ""; var p = parseIso(s); return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric" }).format(new Date(p.y, p.m, p.d)); }
  function MonthGrid(props) {
    var y = props.year, m = props.month, first = (new Date(y, m, 1).getDay() - weekStart() + 7) % 7, days = new Date(y, m + 1, 0).getDate(), cells = [];
    for (var i = 0; i < first; i++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    var weeks = []; for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return h("table", { className: "xos-month", role: "grid", "aria-label": monthTitle(y, m) },
      h("thead", null, h("tr", null, dowNames().map(function (x) { return h("th", { key: x, scope: "col" }, x); }))),
      h("tbody", null, weeks.map(function (wk, wi) {
        return h("tr", { key: wi }, wk.map(function (d, di) {
          if (!d) return h("td", { key: di });
          var key = iso(y, m, d), mark = props.mark ? props.mark(key) : null;
          return h("td", { key: di }, h("button", { type: "button", className: cx("xos-day", mark && "xos-day-" + mark), "aria-pressed": mark === "selected" || mark === "edge" ? "true" : undefined, onClick: props.onPick ? function () { props.onPick(key); } : undefined }, d));
        }));
      })));
  }
  function CalendarHead(y, m, set) {
    return h("div", { className: "xos-cal-head" },
      h("button", { type: "button", className: "xos-btn xos-btn-ghost xos-iconbtn", "aria-label": t("date.prevMonth"), onClick: function () { set(m === 0 ? [y - 1, 11] : [y, m - 1]); } }, h(Icon, { name: "ChevronLeft" })),
      h("strong", null, monthTitle(y, m)),
      h("button", { type: "button", className: "xos-btn xos-btn-ghost xos-iconbtn", "aria-label": t("date.nextMonth"), onClick: function () { set(m === 11 ? [y + 1, 0] : [y, m + 1]); } }, h(Icon, { name: "ChevronRight" })));
  }
  function DatePicker(props) {
    var id = fid(props, "xos-dp"), v = React.useState(props.value), base = parseIso(props.value || props.month || "2026-10-01"), ym = React.useState([base.y, base.m]), open = React.useState(!!props.defaultOpen);
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-combo" },
      h("button", { id: id, type: "button", className: "xos-input xos-trigger", "aria-haspopup": "dialog", "aria-expanded": open[0] ? "true" : "false", onClick: function () { open[1](!open[0]); } },
        h(Icon, { name: "Calendar", size: 14 }), h("span", { className: v[0] ? "" : "xos-muted" }, v[0] ? fmtDate(v[0]) : props.placeholder || t("date.pick"))),
      open[0] ? h("div", { className: "xos-popover xos-cal", role: "dialog", "aria-label": t("date.choose") }, CalendarHead(ym[0][0], ym[0][1], ym[1]),
        h(MonthGrid, { year: ym[0][0], month: ym[0][1], mark: function (k) { return k === v[0] ? "selected" : k === props.today ? "today" : null; }, onPick: function (k) { v[1](k); if (props.onChange) props.onChange(k); if (!props.defaultOpen) open[1](false); } })) : null));
  }
  function DateRangePicker(props) {
    var id = fid(props, "xos-drp"), r = React.useState([props.start, props.end]), base = parseIso(props.start || "2026-10-01"), ym = React.useState([base.y, base.m]), open = React.useState(!!props.defaultOpen);
    function mark(k) { var a = r[0][0], b = r[0][1]; if (k === a || k === b) return "edge"; if (a && b && k > a && k < b) return "range"; return null; }
    function pick(k) { var a = r[0][0], b = r[0][1]; var n = !a || (a && b) ? [k, null] : k < a ? [k, a] : [a, k]; r[1](n); if (n[1] && props.onChange) props.onChange(n); }
    var nights = r[0][0] && r[0][1] ? Math.round((new Date(r[0][1]) - new Date(r[0][0])) / 86400000) : null;
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-combo" },
      h("button", { id: id, type: "button", className: "xos-input xos-trigger", "aria-expanded": open[0] ? "true" : "false", onClick: function () { open[1](!open[0]); } },
        h(Icon, { name: "CalendarRange", size: 14 }), h("span", null, fmtDate(r[0][0]) + (r[0][1] ? " " + t("date.rangeTo") + " " + fmtDate(r[0][1]) : "")), nights !== null ? h("span", { className: "xos-muted xos-num", style: { marginInlineStart: "auto" } }, t("date.days", { n: nights + 1 })) : null),
      open[0] ? h("div", { className: "xos-popover xos-cal", role: "dialog", "aria-label": t("date.chooseRange") }, CalendarHead(ym[0][0], ym[0][1], ym[1]), h(MonthGrid, { year: ym[0][0], month: ym[0][1], mark: mark, onPick: pick })) : null));
  }
  function TimePicker(props) {
    var id = fid(props, "xos-tp"), opts = [], step = props.step || 15;
    for (var mins = 0; mins < 1440; mins += step) { var hh = Math.floor(mins / 60), mm = mins % 60, v = String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0"); opts.push({ value: v, label: new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" }).format(new Date(2026, 0, 1, hh, mm)) }); }
    return Field(Object.assign({}, props, { id: id }), h("div", { className: "xos-row", style: { gap: "var(--space-6)", flexWrap: "nowrap" } },
      h("div", { className: "xos-select", style: { flex: 1 } }, h("select", { id: id, className: "xos-input", defaultValue: props.value, onChange: props.onChange }, opts.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); })), h(Icon, { name: "Clock", size: 14 })),
      h("span", { className: "xos-chip", title: props.timeZone }, h(Icon, { name: "Globe", size: 12 }), props.zoneLabel)));
  }
  function FileDrop(props) {
    var over = React.useState(false), files = React.useState(props.files || []);
    function add(list) { var n = files[0].concat(Array.prototype.map.call(list, function (f) { return { name: f.name, size: f.size }; })); files[1](n); if (props.onFiles) props.onFiles(list); }
    var inputId = "xos-fd-" + (++uid);
    return h("div", { className: "xos-field", style: { width: props.width || 360 } },
      props.label ? h("span", { className: "xos-label" }, props.label) : null,
      h("label", { htmlFor: inputId, className: cx("xos-drop", over[0] && "xos-drop-over"),
        onDragOver: function (e) { e.preventDefault(); over[1](true); }, onDragLeave: function () { over[1](false); },
        onDrop: function (e) { e.preventDefault(); over[1](false); add(e.dataTransfer.files); } },
        h(Icon, { name: "Upload", size: 20 }), h("span", null, h("strong", null, t("file.drop")), " " + t("file.orBrowse")), h("span", { className: "xos-help" }, props.hint),
        h("input", { id: inputId, type: "file", multiple: true, accept: props.accept, className: "xos-sr", onChange: function (e) { add(e.target.files); } })),
      files[0].length ? h("ul", { className: "xos-files" }, files[0].map(function (f, i) { return h("li", { key: i }, h(Icon, { name: "File", size: 14 }), h("span", null, f.name), h("span", { className: "xos-muted xos-num" }, t("file.kb", { n: fmtNumber(Math.max(1, Math.round(f.size / 1024))) }))); })) : null);
  }

  Object.assign(EXPORTS, { Link: Link, Textarea: Textarea, Select: Select, Combobox: Combobox, MultiSelect: MultiSelect, Radio: Radio, Slider: Slider, NumberInput: NumberInput, DatePicker: DatePicker, DateRangePicker: DateRangePicker, TimePicker: TimePicker, FileDrop: FileDrop });


  function Banner(props) {
    var tone = props.tone || "info";
    return h("div", { className: cx("xos-banner", "xos-banner-" + tone), role: tone === "danger" ? "alert" : "status" },
      h(Icon, { name: props.icon || { info: "Info", success: "CircleCheck", warning: "TriangleAlert", danger: "OctagonAlert" }[tone] }),
      h("span", null, props.children),
      props.actionLabel ? h(Button, { size: "sm", onClick: props.onAction }, props.actionLabel) : null,
      props.onDismiss ? h(IconButton, { icon: "X", label: t("action.dismiss"), onClick: props.onDismiss }) : null);
  }
  function ErrorState(props) {
    return h("div", { className: "xos-empty" }, h(Icon, { name: "CircleAlert", size: 24, color: "var(--danger)" }),
      h("strong", { style: { fontSize: 16 } }, props.title), h("p", null, props.sentence),
      h("div", { className: "xos-row" }, h(Button, { variant: "primary", icon: "RefreshCw", onClick: props.onRetry }, props.actionLabel || t("action.retry"))),
      props.reference ? h("span", { className: "xos-code xos-muted" }, props.reference) : null);
  }

  /* Overlays */
  function Menu(props) {
    return h("div", { className: "xos-menu", role: "menu", "aria-label": props.label }, props.items.map(function (it, i) {
      if (it.separator) return h("div", { key: i, role: "separator", className: "xos-menu-sep" });
      if (it.heading) return h("div", { key: i, className: "xos-menu-head" }, it.heading);
      return h("div", { key: i, role: "menuitem", tabIndex: -1, className: cx("xos-cmd-item", it.danger && "xos-menu-danger"), "data-active": it.active ? "" : undefined },
        it.icon ? h(Icon, { name: it.icon }) : null, h("span", null, it.label),
        it.shortcut ? h("span", { className: "xos-hint" }, it.shortcut.split(" ").map(function (k, j) { return h(Kbd, { key: j }, k); })) : it.submenu ? h(Icon, { name: "ChevronRight", size: 14, className: "xos-hint" }) : null);
    }));
  }
  function DropdownMenu(props) {
    var open = React.useState(!!props.defaultOpen);
    return h("div", { className: "xos-combo", style: { display: "inline-block" } },
      h(Button, { icon: props.icon, "aria-haspopup": "menu", "aria-expanded": open[0] ? "true" : "false", onClick: function () { open[1](!open[0]); } }, props.label, h(Icon, { name: "ChevronDown", size: 14 })),
      open[0] ? h("div", { className: "xos-anchor" }, h(Menu, { label: props.label, items: props.items })) : null);
  }
  function ContextMenu(props) { return h(Menu, { label: props.label || t("menu.actions"), items: props.items }); }
  function Popover(props) {
    return h("div", { className: "xos-popover xos-pop", role: "dialog", "aria-label": props.title },
      props.title ? h("div", { className: "xos-pop-head" }, h("strong", null, props.title)) : null,
      h("div", { className: "xos-pop-body" }, props.children),
      props.learnMore ? h("a", { className: "xos-link", href: props.learnMore }, t("help.learnMore"), h(Icon, { name: "ArrowUpRight", size: 12 })) : null);
  }
  function HoverCard(props) {
    return h("div", { className: "xos-popover xos-hover", role: "tooltip" },
      h("div", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(RecordKindGlyph, { kind: props.kind, size: 14, color: "var(--text-secondary)" }), h("span", { className: "xos-code xos-muted" }, props.recordKey)),
      h("strong", null, props.title),
      h("div", { className: "xos-row" }, h(StateChip, { state: props.state, label: props.stateLabel }), h(PropertyChip, { icon: "User", value: props.owner }), h(PropertyChip, { icon: "Calendar", value: props.next })));
  }
  function Drawer(props) {
    return h("div", { className: cx("xos-drawer", "xos-drawer-" + (props.side || "right")), role: "dialog", "aria-label": props.title },
      h("header", { className: "xos-drawer-head" }, h("strong", null, props.title), h(IconButton, { icon: "X", label: t("action.close"), shortcut: t("key.esc"), onClick: props.onClose })),
      h("div", { className: "xos-drawer-body" }, props.children),
      props.footer ? h("footer", { className: "xos-drawer-foot" }, props.footer) : null);
  }
  function PropertyList(props) {
    return h("dl", { className: "xos-props" }, props.items.map(function (p) {
      return h(React.Fragment, { key: p.label }, h("dt", null, p.label), h("dd", null, p.value));
    }));
  }
  function SidePeek(props) {
    return h("div", { className: "xos-peek", role: "dialog", "aria-label": props.title },
      h("header", { className: "xos-peek-bar" },
        h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(RecordKindGlyph, { kind: props.kind, size: 14, color: "var(--text-secondary)" }), h("span", { className: "xos-muted" }, props.kind), h("span", { className: "xos-code xos-muted" }, props.recordKey)),
        h("span", { className: "xos-row", style: { gap: "var(--space-2)" } }, h(IconButton, { icon: "Maximize2", label: t("peek.openFull") }), h(IconButton, { icon: "Link2", label: t("action.copyLink") }), h(IconButton, { icon: "X", label: t("action.close"), shortcut: t("key.esc") }))),
      h("div", { className: "xos-peek-body" },
        h("h2", { className: "xos-peek-title" }, props.title),
        h("div", { className: "xos-row" }, h(StateChip, { state: props.state, label: props.stateLabel, onClick: function () {} }), props.chips),
        props.properties ? h(PropertyList, { items: props.properties }) : null,
        props.children));
  }
  function ShortcutSheet(props) {
    return h("div", { className: "xos-dialog xos-sheet", role: "dialog", "aria-label": t("shortcuts.title"), style: { width: 640 } },
      h("header", null, h("h2", null, props.title || t("shortcuts.title"))),
      h("div", { className: "xos-sheet-grid" }, props.groups.map(function (g) {
        return h("section", { key: g.label }, h("h3", null, g.label), g.items.map(function (it) {
          return h("div", { key: it.label, className: "xos-sheet-row" }, h("span", null, it.label), h("span", { className: "xos-row", style: { gap: "var(--space-2)" } }, it.keys.split(" ").map(function (k, i) { return h(Kbd, { key: i }, k); })));
        }));
      })));
  }

  function Pagination(props) {
    return h("nav", { className: "xos-row xos-pager", "aria-label": t("nav.pagination") },
      h("span", { className: "xos-muted xos-num" }, props.summary),
      h(Button, { size: "sm", icon: "ChevronLeft", disabled: !props.hasPrev, onClick: props.onPrev }, t("nav.previous")),
      h(Button, { size: "sm", disabled: !props.hasNext, onClick: props.onNext }, t("nav.next"), h(Icon, { name: "ChevronRight", size: 14 })));
  }

  /* Layout */
  function PageHeader(props) {
    return h("header", { className: "xos-pagehead" },
      h("div", { className: "xos-row", style: { gap: "var(--space-8)" } }, props.glyph ? h(Icon, { name: props.glyph, color: "var(--text-secondary)" }) : null, h("h1", null, props.title), props.count !== undefined ? h("span", { className: "xos-muted xos-num" }, props.count) : null),
      h("div", { className: "xos-row" }, props.views || null, props.actions || null));
  }
  function Card(props) {
    return h("section", { className: cx("xos-card", props.interactive && "xos-card-int") },
      props.title ? h("header", { className: "xos-card-head" }, h("strong", null, props.title), props.meta ? h("span", { className: "xos-muted" }, props.meta) : null) : null,
      h("div", { className: "xos-card-body" }, props.children),
      props.footer ? h("footer", { className: "xos-card-foot" }, props.footer) : null);
  }
  function Divider(props) {
    return props.label ? h("div", { className: "xos-divider xos-divider-label", role: "separator" }, h("span", null, props.label)) : h("hr", { className: "xos-divider" });
  }
  function Accordion(props) {
    return h("div", { className: "xos-accordion" }, props.items.map(function (it) {
      return h("details", { key: it.title, open: it.open }, h("summary", null, h(Icon, { name: "ChevronRight", size: 14, className: "xos-acc-chev" }), h("span", null, it.title), it.meta ? h("span", { className: "xos-muted", style: { marginInlineStart: "auto" } }, it.meta) : null), h("div", { className: "xos-acc-body" }, it.content));
    }));
  }
  function Stepper(props) {
    return h("ol", { className: "xos-stepper" }, props.steps.map(function (s, i) {
      var st = i < props.current ? "done" : i === props.current ? "current" : "todo";
      return h("li", { key: s, className: "xos-step-" + st, "aria-current": st === "current" ? "step" : undefined },
        h("span", { className: "xos-step-dot" }, st === "done" ? h(Icon, { name: "Check", size: 12 }) : i + 1), h("span", null, s));
    }));
  }
  function ResizablePanel(props) {
    var w = React.useState(props.initial), min = props.min, max = props.max;
    function clamp(n) { return Math.max(min, Math.min(max, n)); }
    function down(e) {
      var start = e.clientX, sw = w[0];
      function move(ev) { w[1](clamp(sw + (props.side === "left" ? start - ev.clientX : ev.clientX - start))); }
      function up() { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }
    return h("div", { className: "xos-resizable", style: { width: w[0] } },
      h("div", { className: "xos-resizable-body" }, props.children),
      h("div", { className: "xos-handle", role: "separator", "aria-orientation": "vertical", "aria-valuenow": w[0], "aria-valuemin": min, "aria-valuemax": max, "aria-label": props.label || t("panel.resize"), tabIndex: 0, onPointerDown: down,
        onKeyDown: function (e) { if (e.key === "ArrowLeft") w[1](clamp(w[0] - 16)); if (e.key === "ArrowRight") w[1](clamp(w[0] + 16)); } }));
  }
  function SplitView(props) {
    return h("div", { className: "xos-split" },
      h("div", { className: "xos-split-list", role: "listbox", "aria-label": props.label }, props.items.map(function (it, i) {
        return h("div", { key: i, role: "option", "aria-selected": i === props.selected ? "true" : "false", className: "xos-split-item" },
          it.state ? h(StateIcon, { state: it.state }) : null, h("div", { className: "xos-col", style: { gap: 0, minWidth: 0 } }, h("strong", null, it.title), h("span", { className: "xos-muted" }, it.meta)));
      })),
      h("div", { className: "xos-split-detail" }, props.detail));
  }
  /* Below the lg breakpoint the sidebar becomes a drawer opened from the header; below md the mobile navigation shows as a bottom bar. */
  function AppShell(props) {
    var open = React.useState(false);
    React.useEffect(function () {
      if (!open[0]) return undefined;
      function key(e) { if (e.key === "Escape") open[1](false); }
      document.addEventListener("keydown", key); return function () { document.removeEventListener("keydown", key); };
    }, [open[0]]);
    return h("div", { className: "xos-shell", "data-open": open[0] ? "true" : undefined },
      h("div", { className: "xos-shell-side", id: "xos-shell-side" }, props.brand ? h("div", { className: "xos-shell-brand" }, props.brand) : null, props.sidebar),
      open[0] ? h("button", { type: "button", className: "xos-shell-scrim", "aria-label": t("action.close"), onClick: function () { open[1](false); } }) : null,
      h("main", { className: "xos-shell-main" },
        h("div", { className: cx("xos-shell-head", !props.header && "xos-shell-head-bare") },
          h("span", { className: "xos-shell-menu" }, h(IconButton, { icon: "Menu", label: t("shell.menu"), "aria-expanded": open[0] ? "true" : "false", "aria-controls": "xos-shell-side", onClick: function () { open[1](!open[0]); } })),
          props.header ? h("div", { className: "xos-shell-headbody" }, props.header) : null),
        h("div", { className: "xos-shell-body" }, props.children),
        props.mobileNav ? h("div", { className: "xos-shell-bottom" }, props.mobileNav) : null));
  }

  /* Identity */
  function Badge(props) {
    return h("span", { className: cx("xos-badge-pill", "xos-badge-" + (props.tone || "neutral")), "aria-label": props.label }, props.count > 99 ? "99+" : props.count);
  }
  function PresenceIndicator(props) {
    return h("span", { className: "xos-presence", "aria-label": props.names.join(", ") + ", " + t(props.verb === "editing" ? "presence.editing" : "presence.viewing", { n: props.names.length }) },
      h("span", { className: "xos-stack" }, props.names.slice(0, 3).map(function (n) { return h("span", { key: n, className: "xos-presence-av" }, h(Avatar, { name: n }), h("span", { className: "xos-live", "aria-hidden": "true" })); })),
      h("span", { className: "xos-muted" }, t(props.verb === "editing" ? "presence.editing" : "presence.viewing", { n: props.names.length })));
  }

  Object.assign(EXPORTS, { Banner: Banner, ErrorState: ErrorState, DropdownMenu: DropdownMenu, ContextMenu: ContextMenu, Popover: Popover, HoverCard: HoverCard, Drawer: Drawer, SidePeek: SidePeek, ShortcutSheet: ShortcutSheet, Pagination: Pagination,
    PageHeader: PageHeader, Card: Card, Divider: Divider, Accordion: Accordion, Stepper: Stepper, ResizablePanel: ResizablePanel, SplitView: SplitView, AppShell: AppShell, Badge: Badge, PresenceIndicator: PresenceIndicator });


  function Board(props) {
    return h("div", { className: "xos-board" }, props.columns.map(function (c) {
      return h("section", { key: c.state, className: "xos-board-col", "aria-label": c.label },
        h("header", null, h(StateIcon, { state: c.state }), h("strong", null, c.label), h("span", { className: "xos-muted xos-num" }, c.cards.length)),
        c.cards.map(function (k) {
          return h("article", { key: k.key, className: "xos-board-card", tabIndex: 0 },
            h("div", { className: "xos-row", style: { gap: "var(--space-6)", justifyContent: "space-between" } }, h("span", { className: "xos-code xos-muted" }, k.key), k.owner ? h(Avatar, { name: k.owner }) : null),
            h("span", null, k.title),
            k.meta ? h("span", { className: "xos-muted", style: { fontSize: "12px" } }, k.meta) : null,
            h("div", { className: "xos-row", style: { gap: "var(--space-4)" } }, k.kind ? h(RecordKindChip, { kind: k.kind }) : null, k.due ? h(PropertyChip, { icon: "Calendar", value: k.due }) : null));
        }),
        props.readOnly ? null : h("button", { type: "button", className: "xos-board-add" }, h(Icon, { name: "Plus", size: 14 }), props.addLabel || t("board.add")));
    }));
  }

  function Timeline(props) {
    var dayW = props.dayWidth || 32, rowH = 36, n = props.days.length, labelW = 220;
    var W = n * dayW;
    var deps = [];
    props.rows.forEach(function (r, i) {
      if (r.dependsOn === undefined) return;
      var a = props.rows[r.dependsOn];
      var x1 = (a.end + 1) * dayW, y1 = r.dependsOn * rowH + rowH / 2, x2 = r.start * dayW, y2 = i * rowH + rowH / 2;
      var sx = Math.min(x1 - 8, x2 - 4); deps.push(h("path", { key: i, d: "M" + sx + " " + (y1 + 10) + " V" + y2 + " H" + (x2 - 2), className: "xos-tl-dep", markerEnd: "url(#xos-arrow)" }));
    });
    /* The drawing is hidden from assistive technology; the table below is its text alternative. */
    function dayLabel(i) { var d = props.days[i]; return d ? d.dow + " " + d.date : ""; }
    var alt = h("div", { className: "xos-sr" }, h("table", null, h("caption", null, props.label),
      h("thead", null, h("tr", null, [t("timeline.key"), t("timeline.record"), t("timeline.state"), t("timeline.start"), t("timeline.end"), t("timeline.dependsOn")].map(function (x) { return h("th", { key: x, scope: "col" }, x); }))),
      h("tbody", null, props.rows.map(function (r) { return h("tr", { key: r.key }, h("td", null, r.key), h("td", null, r.title + (r.milestone ? " (" + t("timeline.milestone") + ")" : "") + (r.critical ? " (" + t("timeline.critical") + ")" : "")), h("td", null, r.stateLabel || r.state), h("td", null, dayLabel(r.start)), h("td", null, dayLabel(r.end)), h("td", null, r.dependsOn !== undefined ? props.rows[r.dependsOn].key : "")); }))));
    return h("figure", { className: "xos-tl-fig", "aria-label": props.label }, alt, h("div", { className: "xos-tl", "aria-hidden": "true" },
      h("div", { className: "xos-tl-labels", style: { width: labelW } },
        h("div", { className: "xos-tl-corner" }, props.label),
        props.rows.map(function (r) { return h("div", { key: r.key, className: "xos-tl-label" }, h(StateIcon, { state: r.state }), h("span", { className: "xos-code xos-muted" }, r.key), h("span", null, r.title)); })),
      h("div", { className: "xos-tl-scroll" },
        h("div", { className: "xos-tl-days", style: { width: W } }, props.days.map(function (d, i) { return h("div", { key: i, className: cx("xos-tl-day", d.weekend && "xos-tl-we"), style: { width: dayW } }, h("span", null, d.dow), h("strong", { className: "xos-num" }, d.date)); })),
        h("div", { className: "xos-tl-grid", style: { width: W, height: props.rows.length * rowH } },
          props.days.map(function (d, i) { return d.weekend ? h("div", { key: i, className: "xos-tl-wecol", style: { insetInlineStart: i * dayW, width: dayW } }) : null; }),
          props.rows.map(function (r, i) {
            var top = i * rowH;
            var out = [];
            if (r.baselineStart !== undefined) out.push(h("div", { key: "b", className: "xos-tl-base", style: { insetInlineStart: r.baselineStart * dayW, width: (r.baselineEnd - r.baselineStart + 1) * dayW, top: top + 26 } }));
            if (r.milestone) out.push(h("div", { key: "m", className: "xos-tl-ms", style: { insetInlineStart: r.start * dayW + dayW / 2 - 6, top: top + 12 }, title: r.title }));
            else out.push(h("div", { key: "r", className: cx("xos-tl-bar", r.critical && "xos-tl-crit", "xos-tl-" + r.state), style: { insetInlineStart: r.start * dayW + 2, width: (r.end - r.start + 1) * dayW - 4, top: top + 8 }, title: r.title }, r.progress !== undefined ? h("span", { className: "xos-tl-prog", style: { width: r.progress + "%" } }) : null));
            return h(React.Fragment, { key: r.key }, out);
          }),
          (props.gates || []).map(function (g) { return h("div", { key: g.label, className: "xos-tl-gate", style: { insetInlineStart: g.day * dayW } }, h("span", null, g.label)); }),
          props.today !== undefined ? h("div", { className: "xos-tl-today", style: { insetInlineStart: props.today * dayW + dayW / 2 } }) : null,
          h("svg", { className: "xos-tl-svg", width: W, height: props.rows.length * rowH, "aria-hidden": "true" },
            h("defs", null, h("marker", { id: "xos-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, h("path", { d: "M0 0 L8 4 L0 8 z", className: "xos-tl-arrow" }))),
            deps)))));
  }

  function weeksOf(cells) { var w = []; for (var i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7)); return w; }
  function Calendar(props) {
    var by = {};
    props.events.forEach(function (e) { (by[e.date] = by[e.date] || []).push(e); });
    // month is the first day of the month as an ISO date, the same contract as AvailabilityCalendar.
    var pm = parseIso(props.month), y = pm.y, m = pm.m, first = (new Date(y, m, 1).getDay() - weekStart() + 7) % 7, days = new Date(y, m + 1, 0).getDate(), cells = [];
    for (var i = 0; i < first; i++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    return h("div", { className: "xos-calview" },
      h("div", { className: "xos-cal-head" }, h("strong", { style: { fontSize: 16 } }, monthTitle(y, m)), h(SegmentedControl, { label: t("calendar.range"), value: "month", options: [{ value: "day", label: t("calendar.day") }, { value: "week", label: t("calendar.week") }, { value: "month", label: t("calendar.month") }, { value: "agenda", label: t("calendar.agenda") }] })),
      h("div", { className: "xos-calgrid", role: "grid", "aria-label": monthTitle(y, m) },
        h("div", { role: "row", className: "xos-calrow" }, dowNames().map(function (x) { return h("div", { key: x, className: "xos-calgrid-dow", role: "columnheader" }, x); })),
        weeksOf(cells).map(function (wk, wi) { return h("div", { key: wi, role: "row", className: "xos-calrow" }, wk.map(function (d, j) { var i = wi * 7 + j;
          var key = d ? iso(y, m, d) : null, evs = key ? by[key] || [] : [];
          return h("div", { key: i, role: "gridcell", className: cx("xos-calcell", !d && "xos-calcell-off", key === props.today && "xos-calcell-today") },
            d ? h("span", { className: "xos-num xos-calnum" }, d) : null,
            evs.slice(0, 3).map(function (e, j) { return h("div", { key: j, className: "xos-calev" }, h(StateIcon, { state: e.state, size: 12 }), h("span", null, e.label)); }),
            evs.length > 3 ? h("span", { className: "xos-muted" }, t("calendar.more", { n: evs.length - 3 })) : null);
        })); })));
  }

  function TreeNode(n, depth, path) {
    var open = React.useState(n.expanded !== false);
    var kids = n.children || [];
    return h("li", { role: "treeitem", "aria-expanded": kids.length ? (open[0] ? "true" : "false") : undefined, "aria-selected": n.selected ? "true" : "false" },
      h("div", { className: cx("xos-tree-row", n.selected && "xos-tree-sel"), style: { paddingInlineStart: 8 + depth * 16 }, onClick: function () { if (kids.length) open[1](!open[0]); } },
        kids.length ? h(Icon, { name: open[0] ? "ChevronDown" : "ChevronRight", size: 14 }) : h("span", { style: { width: 14, display: "inline-block" } }),
        n.icon ? h(Icon, { name: n.icon, size: 14, color: "var(--text-secondary)" }) : null,
        h("span", null, n.label), n.meta ? h("span", { className: "xos-muted", style: { marginInlineStart: "auto" } }, n.meta) : null),
      kids.length && open[0] ? h("ul", { role: "group" }, kids.map(function (c, i) { return h(TreeNodeC, { key: i, node: c, depth: depth + 1 }); })) : null);
  }
  function TreeNodeC(p) { return TreeNode(p.node, p.depth); }
  function TreeView(props) { return h("ul", { className: "xos-tree", role: "tree", "aria-label": props.label }, props.nodes.map(function (n, i) { return h(TreeNodeC, { key: i, node: n, depth: 0 }); })); }

  /* Editing */
  function RichTextEditor(props) {
    function cmd(c, v) { document.execCommand(c, false, v); }
    var tools = [["Bold", "bold", t("rte.bold"), "⌘B"], ["Italic", "italic", t("rte.italic"), "⌘I"], ["List", "insertUnorderedList", t("rte.bullets")], ["ListChecks", "insertUnorderedList", t("rte.checklist")], ["Link2", "createLink", t("rte.link")], ["AtSign", null, t("rte.mention")], ["Table", null, t("rte.table")]];
    return h("div", { className: "xos-rte" },
      h("div", { className: "xos-rte-bar", role: "toolbar", "aria-label": t("rte.toolbar") }, tools.map(function (tool) {
        return h("button", { key: tool[2], type: "button", className: "xos-btn xos-btn-ghost xos-iconbtn", "aria-label": tool[2], title: tool[3] ? tt("tooltip.withShortcut", { label: tool[2], shortcut: tool[3] }) : tool[2], onMouseDown: function (e) { e.preventDefault(); if (tool[1]) cmd(tool[1], tool[1] === "createLink" ? "#" : undefined); } }, h(Icon, { name: tool[0] }));
      }), props.presence ? h("span", { style: { marginInlineStart: "auto" } }, props.presence) : null),
      h("div", { className: "xos-rte-body", contentEditable: true, suppressContentEditableWarning: true, role: "textbox", "aria-multiline": "true", "aria-label": props.label, dangerouslySetInnerHTML: { __html: props.html } }),
      h("div", { className: "xos-rte-foot xos-muted" }, t("rte.hint")));
  }

  function SpreadsheetGrid(props) {
    var cols = props.columns, data = React.useState(props.rows.map(function (r) { return Object.assign({}, r); })), sel = React.useState([0, 1]), edit = React.useState(null);
    function totals(key) { var any = false, sum = 0, blank = false; data[0].forEach(function (r) { if (r[key] === null || r[key] === undefined || r[key] === "") blank = true; else { sum += +r[key]; any = true; } }); return blank ? null : any ? sum : null; }
    function key(e) {
      var r = sel[0][0], c = sel[0][1];
      if (edit[0]) return;
      var mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, 1] }[e.key];
      if (mv) { e.preventDefault(); sel[1]([Math.max(0, Math.min(data[0].length - 1, r + mv[0])), Math.max(0, Math.min(cols.length - 1, c + mv[1]))]); }
      if (e.key === "Enter" && editable(cols[c])) { e.preventDefault(); edit[1]([r, c]); }
      if ((e.key === "Backspace" || e.key === "Delete") && editable(cols[c])) { var d = data[0].slice(); d[r] = Object.assign({}, d[r]); d[r][cols[c].key] = null; data[1](d); }
    }
    function isNum(c) { return c.type === "money" || c.type === "number" || c.type === "multiplier"; }
    function editable(c) { return c.editable && !c.derive; }
    function val(c, row) { return c.derive ? c.derive(row) : row[c.key]; }
    function commit(r, c, v) { var d = data[0].slice(); d[r] = Object.assign({}, d[r]); d[r][cols[c].key] = v === "" ? null : (isNum(cols[c]) ? +String(v).replace(/x$/i, "") : v); data[1](d); edit[1](null); }
    function show(col, v) {
      if (col.type === "money") return h(Money, { amount: v === undefined ? null : v, currency: col.currency });
      if (v === null || v === undefined) return "";
      if (col.type === "multiplier") return h("span", { className: "xos-num" }, t("fmt.multiplier", { n: new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(v) }));
      if (col.type === "code") return h("span", { className: "xos-code" }, v);
      return v;
    }
    return h("div", { className: "xos-sheetgrid" },
      h("table", { className: "xos-table xos-grid-table", role: "grid", tabIndex: 0, "aria-label": props.label, onKeyDown: key },
        h("thead", null, h("tr", null, h("th", { className: "xos-grid-rownum", scope: "col" }, h("span", { className: "xos-sr" }, t("grid.row"))), cols.map(function (c) { return h("th", { key: c.key, scope: "col", className: isNum(c) ? "xos-right" : undefined, style: c.width ? { width: c.width } : undefined }, c.label); }))),
        h("tbody", null, data[0].map(function (row, ri) {
          return h("tr", { key: ri }, h("td", { className: "xos-grid-rownum xos-num" }, ri + 1), cols.map(function (c, ci) {
            var on = sel[0][0] === ri && sel[0][1] === ci, editing = edit[0] && edit[0][0] === ri && edit[0][1] === ci;
            return h("td", { key: c.key, role: "gridcell", "aria-selected": on ? "true" : "false", className: cx(on && "xos-cell-on", isNum(c) ? "xos-right" : null, !editable(c) && "xos-cell-ro", c.derive && "xos-cell-derived"), title: c.derive ? t("grid.derived") : undefined,
              onClick: function () { sel[1]([ri, ci]); }, onDoubleClick: function () { if (editable(c)) edit[1]([ri, ci]); } },
              editing ? h("input", { autoFocus: true, className: "xos-cell-input xos-num", defaultValue: row[c.key] === null ? "" : row[c.key], onBlur: function (e) { commit(ri, ci, e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") commit(ri, ci, e.target.value); if (e.key === "Escape") edit[1](null); e.stopPropagation(); } }) : show(c, val(c, row)),
              on && !editing && editable(c) ? h("span", { className: "xos-fill-handle", "aria-hidden": "true" }) : null);
          }));
        })),
        h("tfoot", null, h("tr", null, h("td", { className: "xos-grid-rownum" }), cols.map(function (c, i) { return h("td", { key: c.key, className: c.type === "money" ? "xos-right" : undefined }, c.total ? h(Money, { amount: totals(c.key), currency: c.currency }) : i === 0 ? props.totalsLabel || t("table.total") : ""); })))),
      h("div", { className: "xos-grid-hint xos-muted" }, t("grid.hint")));
  }

  function FilterBuilder(props) {
    var f = React.useState(props.filters);
    return h("div", { className: "xos-row xos-filters", role: "group", "aria-label": t("filter.label") },
      f[0].map(function (x, i) {
        return h("span", { key: i, className: "xos-chip xos-filter" }, h("span", { className: "xos-prop-label" }, x.field), h("span", { className: "xos-muted" }, x.op), h("strong", null, x.value),
          h("button", { type: "button", className: "xos-chip-x", "aria-label": t("filter.remove", { field: x.field }), onClick: function () { f[1](f[0].filter(function (_, j) { return j !== i; })); } }, h(Icon, { name: "X", size: 12 })));
      }),
      h(Button, { size: "sm", variant: "ghost", icon: "ListFilter" }, props.addLabel || t("filter.add")),
      f[0].length ? h(Button, { size: "sm", variant: "ghost", onClick: function () { f[1]([]); } }, t("action.clear")) : null,
      props.saveLabel ? h(Button, { size: "sm", icon: "Bookmark" }, props.saveLabel) : null);
  }

  var QA_RULES = [
    [/@([A-Za-z][\w.-]*)/g, "person", "User"], [/#([\w-]+)/g, "tag", "Hash"], [/\/([A-Za-z]+)/g, "kind", "Shapes"], [/~([\w-]+)/g, "scope", "MapPin"],
    [/\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?|today|tomorrow|next week)\b/gi, "date", "Calendar"]
  ];
  function parseQuickAdd(text) {
    var tokens = [], title = text;
    QA_RULES.forEach(function (r) { title = title.replace(r[0], function (m, g) { tokens.push({ type: r[1], value: g, icon: r[2] }); return ""; }); });
    return { title: title.replace(/\s+/g, " ").trim(), tokens: tokens };
  }
  function QuickAdd(props) {
    var txt = React.useState(props.value || ""), p = parseQuickAdd(txt[0]);
    return h("div", { className: "xos-qa" },
      h("div", { className: "xos-qa-input" }, h(Icon, { name: "Plus", color: "var(--text-secondary)" }), h("input", { className: "xos-qa-field", "aria-label": props.label || t("quickAdd.label"), placeholder: props.placeholder, value: txt[0], onChange: function (e) { txt[1](e.target.value); } }), h(Kbd, null, "↵")),
      txt[0] ? h("div", { className: "xos-row xos-qa-chips", "aria-live": "polite" }, h("span", { className: "xos-qa-title" }, p.title || t("record.untitled")),
        p.tokens.map(function (k, i) { return h("span", { key: i, className: "xos-chip" }, h(Icon, { name: k.icon, size: 12, color: "var(--text-secondary)" }), k.type === "kind" ? h(RecordKindGlyph, { kind: k.value, size: 12 }) : null, k.value); })) : null);
  }

  function lum(hex) { var c = hex.replace("#", ""); if (c.length === 3) c = c.split("").map(function (x) { return x + x; }).join(""); return [0, 2, 4].map(function (i) { var v = parseInt(c.substr(i, 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function ColorPicker(props) {
    var v = React.useState(props.value);
    var valid = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v[0]);
    return h("div", { className: "xos-field", style: { width: 320 } },
      h("span", { className: "xos-label" }, props.label),
      h("div", { className: "xos-row", style: { flexWrap: "nowrap" } },
        h("input", { type: "color", className: "xos-swatch", "aria-label": props.label + " swatch", value: valid && v[0].length === 7 ? v[0] : "#000000", onChange: function (e) { v[1](e.target.value.toUpperCase()); } }),
        h("input", { className: "xos-input xos-code", style: { flex: 1 }, "aria-label": t("color.hex", { label: props.label }), value: v[0], "aria-invalid": valid ? undefined : "true", onChange: function (e) { v[1](e.target.value); } })),
      valid ? h("div", { className: "xos-col", style: { gap: "var(--space-4)" } }, props.checks.map(function (c) {
        var r = contrast(c.fgIsValue ? v[0] : c.fg, c.fgIsValue ? c.bg : v[0]), pass = r >= (c.min || 4.5);
        return h("div", { key: c.label, className: "xos-row", style: { justifyContent: "space-between" } }, h("span", { className: "xos-muted" }, c.label),
          h("span", { className: "xos-row", style: { gap: "var(--space-4)" } }, h("span", { className: "xos-num" }, t("contrast.ratio", { r: r.toFixed(2) })), h(Icon, { name: pass ? "CircleCheck" : "CircleX", size: 14, color: pass ? "var(--success)" : "var(--danger)" }), h("span", null, pass ? t("contrast.pass") : t("contrast.fail"))));
      })) : h("div", { className: "xos-error" }, h(Icon, { name: "alert", size: 12 }), t("color.invalid")),
      valid && props.checks.some(function (c) { return contrast(c.fgIsValue ? v[0] : c.fg, c.fgIsValue ? c.bg : v[0]) < (c.min || 4.5); }) ? h("div", { className: "xos-help" }, t("color.blocked")) : null);
  }

  function BulkActionBar(props) {
    return h("div", { className: "xos-bulk", role: "toolbar", "aria-label": t("bulk.label") },
      h("span", { className: "xos-num" }, t("bulk.selected", { n: fmtNumber(props.count) })),
      h("span", { className: "xos-bulk-sep" }),
      props.actions.slice(0, 5).map(function (a) { return h(Button, { key: a.label, size: "sm", variant: "ghost", icon: a.icon, shortcut: a.shortcut }, a.label); }),
      h(IconButton, { icon: "Ellipsis", label: t("menu.more") }),
      h(IconButton, { icon: "X", label: t("bulk.clear"), shortcut: t("key.esc") }));
  }
  function DiffViewer(props) {
    return h("table", { className: "xos-table xos-diff" },
      props.caption ? h("caption", null, props.caption) : null,
      h("thead", null, h("tr", null, h("th", { scope: "col" }, t("diff.field")), h("th", { scope: "col" }, t("diff.before")), h("th", { scope: "col" }, t("diff.after")))),
      h("tbody", null, props.rows.map(function (r) {
        return h("tr", { key: r.field }, h("td", { className: "xos-muted" }, r.field), h("td", null, h("del", { className: "xos-del" }, r.before)), h("td", null, h("ins", { className: "xos-ins" }, r.after)));
      })));
  }
  function ActivityFeedItem(props) {
    return h("article", { className: "xos-feed" }, h(Avatar, { name: props.actor }),
      h("div", { className: "xos-col", style: { gap: "var(--space-4)", flex: 1 } },
        h("div", null, h("strong", null, props.actor), " ", h("span", { className: "xos-muted" }, props.action), " ", props.target ? h("span", { className: "xos-code" }, props.target) : null, h("span", { className: "xos-muted" }, " · " + props.time)),
        props.comment ? h("div", { className: "xos-feed-comment" }, props.comment) : null,
        props.reactions ? h("div", { className: "xos-row", style: { gap: "var(--space-4)" } }, props.reactions.map(function (r) { return h("button", { key: r.icon, type: "button", className: "xos-chip", "aria-label": r.label + " " + r.count }, h(Icon, { name: r.icon, size: 12 }), h("span", { className: "xos-num" }, r.count)); })) : null));
  }
  function FilePreviewer(props) {
    return h("div", { className: "xos-filepv" },
      h("div", { className: "xos-filepv-bar" }, h(Icon, { name: props.icon || "FileText", color: "var(--text-secondary)" }), h("strong", null, props.name), h("span", { className: "xos-muted" }, props.meta),
        h("span", { className: "xos-row", style: { marginInlineStart: "auto", gap: "var(--space-2)" } }, h(IconButton, { icon: "ZoomOut", label: t("file.zoomOut") }), h("span", { className: "xos-num xos-muted" }, props.zoom || "100%"), h(IconButton, { icon: "ZoomIn", label: t("file.zoomIn") }), h(IconButton, { icon: "Download", label: t("action.download") }))),
      h("div", { className: "xos-filepv-body" },
        h("div", { className: "xos-filepv-thumbs" }, Array.apply(null, Array(props.pages)).map(function (_, i) { return h("button", { key: i, type: "button", className: cx("xos-filepv-thumb", i === (props.page || 0) && "xos-filepv-thumb-on"), "aria-label": t("file.page", { n: i + 1 }) }, h("span", { className: "xos-num" }, i + 1)); })),
        h("div", { className: "xos-filepv-page" }, props.children)));
  }
  function MapView(props) {
    return h("figure", { className: "xos-map" },
      h("svg", { viewBox: "0 0 " + props.width + " " + props.height, role: "img", "aria-label": props.label },
        props.zones.map(function (z) { return h("g", { key: z.label }, h("rect", { x: z.x, y: z.y, width: z.w, height: z.h, rx: 6, className: "xos-map-zone" }), h("text", { x: z.x + 8, y: z.y + 18, className: "xos-map-label" }, z.label)); }),
        props.geofence ? h("circle", { cx: props.geofence.x, cy: props.geofence.y, r: props.geofence.r, className: "xos-map-fence" }) : null,
        props.pins.map(function (p, i) { return h("g", { key: i, transform: "translate(" + p.x + " " + p.y + ")" }, h("circle", { r: 9, className: "xos-map-pin xos-map-pin-" + (p.tone || "accent") }), h("text", { y: 3.5, textAnchor: "middle", className: "xos-map-pinnum" }, i + 1)); })),
      h("figcaption", null, h("ol", { className: "xos-map-legend" }, props.pins.map(function (p, i) { return h("li", { key: i }, h("span", { className: "xos-num" }, i + 1), p.label); }))));
  }

  Object.assign(EXPORTS, { Board: Board, Timeline: Timeline, Calendar: Calendar, TreeView: TreeView, RichTextEditor: RichTextEditor, SpreadsheetGrid: SpreadsheetGrid, FilterBuilder: FilterBuilder, QuickAdd: QuickAdd, ColorPicker: ColorPicker,
    BulkActionBar: BulkActionBar, DiffViewer: DiffViewer, ActivityFeedItem: ActivityFeedItem, FilePreviewer: FilePreviewer, MapView: MapView, parseQuickAdd: parseQuickAdd, contrastRatio: contrast });


  function GateReadinessPanel(props) {
    var c = props.criteria, met = c.filter(function (x) { return x.result === "met"; }).length;
    var blockers = c.filter(function (x) { return x.blocking && x.result !== "met"; });
    var ICON = { met: ["CircleCheck", "var(--success)", t("result.met")], gap: ["CircleX", "var(--danger)", t("result.gap")], unknown: ["CircleHelp", "var(--warning)", t("result.unknown")] };
    return h("section", { className: "xos-card xos-gate", "aria-label": t("gate.readiness") },
      h("header", { className: "xos-card-head" },
        h("span", { className: "xos-row", style: { gap: "var(--space-8)" } }, h(PhaseGlyph, { code: props.code, color: "var(--text-secondary)" }), h("strong", null, t("phase.gateName", { n: props.gate, name: props.name }))),
        h("span", { className: "xos-muted xos-num" }, t("gate.metCount", { met: met, total: c.length }))),
      h("div", { className: "xos-card-body" },
        h("div", { className: "xos-progress-track", role: "progressbar", "aria-valuenow": met, "aria-valuemax": c.length, "aria-label": t("gate.criteriaMet") }, h("div", { className: "xos-progress-fill", style: { width: (met / c.length * 100) + "%", background: "var(--success)" } })),
        h("ul", { className: "xos-criteria" }, c.map(function (x) {
          var ic = ICON[x.result];
          return h("li", { key: x.code },
            h(Icon, { name: ic[0], color: ic[1], label: ic[2] }),
            x.code ? h("span", { className: "xos-code xos-muted" }, x.code) : null,
            h("span", { className: "xos-criteria-label" }, x.label),
            x.blocking ? h(Tag, { tone: x.result === "met" ? "neutral" : "danger" }, t("gate.blocking")) : null,
            x.evidence ? h("span", { className: "xos-chip" }, h(Icon, { name: "Paperclip", size: 12 }), x.evidence) : x.result !== "met" && x.action ? h(Button, { size: "sm" }, x.action) : null);
        }))),
      h("footer", { className: "xos-card-foot" },
        h("span", { className: "xos-muted" }, blockers.length ? t(blockers.length === 1 ? "gate.openOne" : "gate.openMany", { n: blockers.length }) : t("gate.allMet")),
        h(Button, { variant: "primary", disabled: blockers.length > 0, shortcut: "⌘↵" }, props.nextLabel)));
  }

  function CoordinateMatrix(props) {
    var max = 0; for (var k in props.cells) max = Math.max(max, props.cells[k]);
    function step(v) { return v ? Math.min(9, 2 + Math.round(v / max * 6)) : 0; }
    return h("div", { className: "xos-matrix-wrap" }, h("table", { className: "xos-matrix" },
      h("caption", null, props.label),
      h("thead", null, h("tr", null, h("th", { scope: "col", className: "xos-matrix-corner" }, props.corner),
        props.cols.map(function (c) { return h("th", { key: c.code, scope: "col", title: c.name }, h(PhaseGlyph, { code: c.code, size: 14, color: "var(--text-secondary)" }), h("span", { className: "xos-num" }, c.gate)); }))),
      h("tbody", null, props.rows.map(function (r) {
        return h("tr", { key: r.code }, h("th", { scope: "row" }, h(DepartmentGlyph, { code: r.code, size: 14, color: "var(--text-secondary)" }), h("span", null, r.name), h("span", { className: "xos-code xos-muted" }, r.code)),
          props.cols.map(function (c) {
            var v = props.cells[r.code + "|" + c.code], s = step(v);
            return h("td", { key: c.code }, v ? h("button", { type: "button", className: "xos-matrix-cell xos-num", "data-step": s, style: { background: "var(--viz-seq-" + s + ")", color: s >= 6 ? "var(--accent-text-on)" : "var(--viz-ink)" }, "aria-label": t("matrix.cell", { row: r.name, col: c.name, n: fmtNumber(v) }) }, fmtNumber(v)) : h("span", { className: "xos-matrix-empty" }, h("span", { className: "xos-sr" }, t("matrix.empty", { row: r.name, col: c.name }))));
          }));
      }))));
  }

  /* GL posting is derived, never stored: the class of a role code or URID (its first segment) selects the one account of the requested type for that class. */
  function classOf(code) { return code ? String(code).split(".")[0] : null; }
  function glForCode(code, accounts, type) {
    var c = classOf(code), ty = type || "Expense";
    for (var i = 0; i < (accounts || []).length; i++) { var a = accounts[i]; if (a.classCode === c && a.type === ty) return a; }
    return null;
  }
  function BudgetGrid(props) {
    var g = React.useState(props.grade || "base");
    var groups = [], idx = {};
    props.lines.forEach(function (l) {
      var a = glForCode(l.urid, props.accounts, props.accountType), k = a ? a.code : "~";
      if (!(k in idx)) { idx[k] = groups.length; groups.push({ gl: a ? a.code : null, account: a ? a.name : t("budget.unmapped"), lines: [] }); }
      groups[idx[k]].lines.push(l);
    });
    groups.sort(function (a, b) { var x = a.gl || "~", y = b.gl || "~"; return x < y ? -1 : x > y ? 1 : 0; });
    function blank(v) { return v === null || v === undefined; }
    function rate(l) { return l[g[0]]; }
    /* Amount is derived, never stored: quantity times the rate for the selected grade. A blank input yields a blank amount. */
    function amount(l) { var r = rate(l); if (blank(r)) return null; if (l.qty === undefined) return r; return blank(l.qty) ? null : l.qty * r; }
    function sum(lines) { var s = 0, any = false; for (var i = 0; i < lines.length; i++) { var v = amount(lines[i]); if (blank(v)) return null; s += v; any = true; } return any ? s : null; }
    var all = [].concat.apply([], groups.map(function (x) { return x.lines; }));
    var qtyCols = all.some(function (l) { return l.qty !== undefined; });
    var heads = [t("budget.gl"), t("budget.costCenter"), t("budget.urid"), t("budget.line")].concat(qtyCols ? [t("budget.qty"), t("budget.rate")] : []).concat([t("budget.amount")]);
    var lead = heads.length - 1;
    return h("div", { className: "xos-col" },
      h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h(SegmentedControl, { label: t("budget.grade"), value: g[0], onChange: g[1], options: props.grades }), h("span", { className: "xos-muted" }, props.scopeLabel)),
      h("table", { className: "xos-table xos-budget" },
        h("thead", null, h("tr", null, heads.map(function (x, i) { return h("th", { key: x, scope: "col", className: i >= 4 ? "xos-right" : undefined }, x); }))),
        groups.map(function (grp) {
          return h("tbody", { key: grp.gl || "unmapped" },
            h("tr", { className: "xos-budget-group" }, h("td", { colSpan: lead }, grp.gl ? h("span", { className: "xos-code" }, grp.gl) : h(Icon, { name: "TriangleAlert", size: 14, color: "var(--warning)" }), " ", h("strong", null, grp.account)), h("td", { className: "xos-right" }, h("strong", null, h(Money, { amount: sum(grp.lines) })))),
            grp.lines.map(function (l, i) {
              return h("tr", { key: i }, h("td", null), h("td", { className: "xos-code xos-muted" }, l.cc), h("td", null, h("span", { className: "xos-code" }, l.urid)),
                h("td", null, l.name, l.type ? h("span", { className: "xos-muted" }, " \u00b7 " + l.type) : null),
                qtyCols ? h("td", { className: "xos-right xos-num" }, blank(l.qty) ? "" : fmtNumber(l.qty), l.unit ? h("span", { className: "xos-muted" }, " " + l.unit) : null) : null,
                qtyCols ? h("td", { className: "xos-right" }, h(Money, { amount: rate(l) })) : null,
                h("td", { className: "xos-right" }, h(Money, { amount: amount(l) })));
            }));
        }),
        h("tfoot", null, h("tr", null, h("td", { colSpan: lead }, t("table.total")), h("td", { className: "xos-right" }, h(Money, { amount: sum(all) }))))));
  }

  function StalenessIndicator(props) {
    var m = props.months, s = m >= 36 ? [t("stale.expired"), "Clock", "var(--danger)", 0] : m >= 24 ? [t("stale.modeled"), "Clock", "var(--warning)", 1] : m >= 12 ? [t("stale.degraded"), "Clock", "var(--warning)", 2] : [t("stale.current"), "Clock", "var(--success)", 3];
    return h("span", { className: "xos-chip", title: t("stale.title", { n: m, basis: props.basis || t("stale.basis") }) },
      h(Icon, { name: s[1], size: 14, color: s[2] }), h("span", null, s[0]), h("span", { className: "xos-muted xos-num" }, t("stale.months", { n: m })));
  }

  function ReconciliationTable(props) {
    var RES = { Met: ["CircleCheck", "var(--success)", t("result.met")], Gap: ["CircleX", "var(--danger)", t("result.gap")], Unknown: ["CircleHelp", "var(--warning)", t("result.unknown")] };
    var counts = { Met: 0, Gap: 0, Unknown: 0 }; props.rows.forEach(function (r) { counts[r.result]++; });
    return h("div", { className: "xos-col" },
      h("div", { className: "xos-row" }, Object.keys(counts).map(function (k) { return h("span", { key: k, className: "xos-chip" }, h(Icon, { name: RES[k][0], size: 14, color: RES[k][1] }), RES[k][2], h("span", { className: "xos-num xos-muted" }, counts[k])); })),
      h("table", { className: "xos-table" },
        h("thead", null, h("tr", null, h("th", { scope: "col" }, t("recon.requirement")), h("th", { scope: "col" }, t("recon.capability")), h("th", { scope: "col" }, t("recon.result")))),
        h("tbody", null, props.rows.map(function (r, i) {
          return h("tr", { key: i }, h("td", null, r.requirement), h("td", { className: r.capability ? undefined : "xos-muted" }, r.capability || t("recon.notDeclared")),
            h("td", null, h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: RES[r.result][0], size: 14, color: RES[r.result][1] }), RES[r.result][2])));
        }))));
  }

  function fmtClock(s) { var neg = s < 0; s = Math.abs(s); var m = Math.floor(s / 60), x = s % 60; return (neg ? "+" : "") + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0"); }
  function RunOfShowLive(props) {
    var cur = React.useState(props.current), left = React.useState(props.nextInSeconds);
    React.useEffect(function () { var timer = setInterval(function () { left[1](function (v) { return v - 1; }); }, 1000); return function () { clearInterval(timer); }; }, []);
    function go() { cur[1](Math.min(cur[0] + 1, props.cues.length - 1)); left[1](props.cues[Math.min(cur[0] + 1, props.cues.length - 1)].durationSeconds || 0); }
    return h("section", { className: cx("xos-ros", props.showMode && "xos-ros-show"), tabIndex: 0, "aria-label": t("ros.label"), onKeyDown: function (e) { if (e.key === " ") { e.preventDefault(); go(); } } },
      h("header", { className: "xos-ros-head" },
        h("div", { className: "xos-col", style: { gap: 0 } }, h("span", { className: "xos-muted" }, t("ros.nextIn")), h("strong", { className: cx("xos-num xos-ros-clock", left[0] <= 30 && "xos-ros-soon"), "aria-live": "polite" }, fmtClock(left[0]))),
        h(Button, { variant: "primary", shortcut: t("key.space"), onClick: go }, t("ros.go"))),
      h("ol", { className: "xos-ros-list" }, props.cues.map(function (c, i) {
        var st = i < cur[0] ? "done" : i === cur[0] ? "live" : "next";
        return h("li", { key: c.number, className: "xos-ros-" + st, "aria-current": st === "live" ? "true" : undefined },
          h("span", { className: "xos-code" }, c.number), h("span", { className: "xos-num xos-muted" }, c.time),
          h("span", { className: "xos-ros-title" }, c.title), c.dept ? h(DepartmentGlyph, { code: c.dept, size: 14, color: "var(--text-secondary)" }) : null,
          st === "live" ? h(Tag, { tone: "accent" }, t("ros.live")) : null);
      })));
  }

  function AccessGridMatrix(props) {
    var g = React.useState(props.grants);
    function on(c, z) { return g[0].indexOf(c + "|" + z) >= 0; }
    function toggle(c, z) { var k = c + "|" + z; g[1](on(c, z) ? g[0].filter(function (x) { return x !== k; }) : g[0].concat([k])); }
    return h("table", { className: "xos-matrix xos-access" }, h("caption", null, props.label),
      h("thead", null, h("tr", null, h("th", { scope: "col", className: "xos-matrix-corner" }, t("access.credential")), props.zones.map(function (z) { return h("th", { key: z, scope: "col" }, z); }))),
      h("tbody", null, props.categories.map(function (c) {
        return h("tr", { key: c.name }, h("th", { scope: "row" }, h("span", { className: "xos-swatchdot", style: { background: "var(--viz-cat-" + c.color + ")" } }), c.name),
          props.zones.map(function (z) { var y = on(c.name, z); return h("td", { key: z }, h("button", { type: "button", className: cx("xos-access-cell", y && "xos-access-on"), "aria-pressed": y ? "true" : "false", "aria-label": t(y ? "access.allowed" : "access.denied", { cat: c.name, zone: z }), onClick: function () { toggle(c.name, z); } }, h(Icon, { name: y ? "Check" : "Minus", size: 14 }))); }));
      })));
  }

  /* Emergency codes and their protocols are global. Steps name a service as {fire}, {ems}, {lawEnforcement}, {bombSquad} or {federal}; the project's jurisdiction supplies the agency. Without one, the generic service name renders. */
  var ECODE_SERVICES = ["fire", "ems", "lawEnforcement", "bombSquad", "federal"];
  function resolveStep(step, authorities) {
    return step.replace(/\{(\w+)\}/g, function (m, k) {
      if (ECODE_SERVICES.indexOf(k) < 0) return m;
      var a = (authorities || []).filter(function (x) { return x.service === k; })[0];
      return a ? a.agency : t("ecode.service." + k);
    });
  }
  function EmergencyCodeCard(props) {
    var used = ECODE_SERVICES.filter(function (k) { return props.steps.some(function (s) { return s.indexOf("{" + k + "}") >= 0; }); });
    var auth = (props.authorities || []).filter(function (a) { return used.indexOf(a.service) >= 0; }).sort(function (a, b) { return ECODE_SERVICES.indexOf(a.service) - ECODE_SERVICES.indexOf(b.service); });
    return h("article", { className: "xos-ecode", style: { "--ecode": "var(--" + (props.swatch || "ecode-red") + ")" } },
      h("header", null, h("span", { className: "xos-ecode-swatch", "aria-hidden": "true" }), h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", null, props.code), h("span", null, props.name)), props.recordKey ? h("span", { className: "xos-code xos-muted", style: { marginInlineStart: "auto" } }, props.recordKey) : null),
      props.domain ? h("span", { className: "xos-label" }, props.domain) : null,
      h("ol", null, props.steps.map(function (s, i) { return h("li", { key: i }, resolveStep(s, props.authorities)); })),
      auth.length ? h("dl", { className: "xos-ecode-auth", "aria-label": t("ecode.authorities") }, auth.map(function (a) {
        return h("div", { key: a.service }, h("dt", null, t("ecode.role." + a.service)), h("dd", null, a.agency, a.contact ? h("span", { className: "xos-num xos-muted" }, " \u00b7 " + a.contact) : null));
      })) : null,
      props.channel ? h("footer", null, h(Icon, { name: "Radio", size: 14 }), h("span", null, props.channel)) : null);
  }
  function RadioChannelTable(props) {
    var rows = props.channels.slice().sort(function (a, b) { return (a.zone - b.zone) || (a.channel - b.channel); });
    return h("table", { className: "xos-table" }, props.caption ? h("caption", { style: { textAlign: "start", fontWeight: 600, paddingBottom: 8 } }, props.caption) : null,
      h("thead", null, h("tr", null, [t("radio.zone"), t("radio.channel"), t("radio.assignment"), t("radio.notes")].map(function (x) { return h("th", { key: x, scope: "col" }, x); }))),
      h("tbody", null, rows.map(function (c) {
        return h("tr", { key: c.zone + "." + c.channel }, h("td", { className: "xos-num" }, c.zone), h("td", null, h("span", { className: "xos-chip-code" }, c.channel)), h("td", null, h("strong", null, c.assignment)), h("td", { className: "xos-muted xos-td-wrap" }, c.notes));
      })));
  }

  /* Help and notifications */
  function UndoToast(props) {
    var left = React.useState(props.seconds || 8);
    React.useEffect(function () { var timer = setInterval(function () { left[1](function (v) { return v > 0 ? v - 1 : 0; }); }, 1000); return function () { clearInterval(timer); }; }, []);
    return h("div", { className: "xos-toast", role: "status" },
      h("span", null, props.message),
      h(Button, { size: "sm", variant: "ghost", icon: "Undo2", shortcut: "⌘Z", onClick: props.onUndo }, t("action.undo")),
      h("span", { className: "xos-toast-timer", "aria-hidden": "true", style: { "--p": (left[0] / (props.seconds || 8)) } }));
  }
  function NotificationCenter(props) {
    var tab = React.useState("needs");
    var list = tab[0] === "needs" ? props.needsYou : props.fyi;
    return h("section", { className: "xos-notif", "aria-label": t("inbox.label") },
      h("div", { className: "xos-notif-head" }, h(Tabs, { label: t("inbox.label"), value: "needs", onChange: tab[1], tabs: [{ value: "needs", label: t("inbox.needsYou"), count: props.needsYou.length }, { value: "fyi", label: t("inbox.fyi"), count: props.fyi.length }] })),
      h("ul", null, list.map(function (n, i) {
        return h("li", { key: i, className: "xos-notif-item" }, n.kind ? h(RecordKindGlyph, { kind: n.kind, color: "var(--text-secondary)" }) : h(Icon, { name: "Bell" }),
          h("div", { className: "xos-col xos-notif-text", style: { gap: 0 } }, h("span", null, n.title), h("span", { className: "xos-muted" }, n.meta)),
          n.action ? h(Button, { size: "sm", shortcut: n.actionKey }, n.action) : null,
          h(IconButton, { icon: "Check", label: t("action.done"), shortcut: "E" }), h(IconButton, { icon: "AlarmClock", label: t("action.snooze"), shortcut: "H" }));
      })));
  }
  function OnboardingChecklist(props) {
    var done = props.steps.filter(function (s) { return s.done; }).length;
    return h(Card, { title: props.title, meta: t("count.of", { n: done, total: props.steps.length }) },
      h("div", { className: "xos-progress-track" }, h("div", { className: "xos-progress-fill", style: { width: (done / props.steps.length * 100) + "%" } })),
      h("ol", { className: "xos-checklist" }, props.steps.map(function (s) {
        return h("li", { key: s.label, className: s.done ? "xos-done" : undefined }, h(Icon, { name: s.done ? "CircleCheck" : "Circle", color: s.done ? "var(--success)" : "var(--text-tertiary)" }), h("span", null, s.label), !s.done && s.action ? h(Button, { size: "sm" }, s.action) : null);
      })));
  }
  function WhatsNew(props) {
    return h("section", { className: "xos-card", "aria-label": t("whatsNew.title") }, h("header", { className: "xos-card-head" }, h("strong", null, t("whatsNew.title")), h(Link, { href: props.changelogHref }, t("whatsNew.changelog"))),
      h("div", { className: "xos-card-body xos-col" }, props.entries.map(function (e) {
        return h("article", { key: e.title, className: "xos-col", style: { gap: "var(--space-4)" } }, h("div", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Tag, { tone: e.tone || "accent" }, e.label), h("span", { className: "xos-muted" }, e.date)), h("strong", null, e.title), h("span", { className: "xos-muted" }, e.body));
      })));
  }
  function FeedbackWidget(props) {
    var sent = React.useState(false);
    return h(Card, { title: t("feedback.title"), footer: sent[0] ? h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: "CircleCheck", color: "var(--success)" }), t("feedback.thanks")) : h(React.Fragment, null, h(Button, { variant: "ghost" }, t("action.cancel")), h(Button, { variant: "primary", onClick: function () { sent[1](true); } }, t("action.send"))) },
      h(Textarea, { label: t("feedback.question"), placeholder: t("feedback.hint"), width: "100%" }),
      h(Checkbox, { label: t("feedback.screenshot") }),
      h("span", { className: "xos-help" }, t("feedback.privacy")));
  }
  function ShortcutEditor(props) {
    return h("table", { className: "xos-table" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, t("shortcutEditor.action")), h("th", { scope: "col" }, t("shortcutEditor.shortcut")), h("th", { scope: "col" }, h("span", { className: "xos-sr" }, t("shortcutEditor.edit"))))),
      h("tbody", null, props.rows.map(function (r) {
        return h("tr", { key: r.action }, h("td", null, r.action),
          h("td", null, h("span", { className: "xos-row", style: { gap: "var(--space-2)" } }, r.keys.split(" ").map(function (k, i) { return h(Kbd, { key: i }, k); }), r.conflict ? h("span", { className: "xos-error", style: { marginInlineStart: 8 } }, h(Icon, { name: "alert", size: 12 }), r.conflict) : null)),
          h("td", { className: "xos-right" }, h(Button, { size: "sm", variant: "ghost" }, r.recording ? t("shortcutEditor.press") : t("shortcutEditor.change")), r.custom ? h(Button, { size: "sm", variant: "ghost" }, t("action.reset")) : null));
      })));
  }

  Object.assign(EXPORTS, { GateReadinessPanel: GateReadinessPanel, CoordinateMatrix: CoordinateMatrix, BudgetGrid: BudgetGrid, StalenessIndicator: StalenessIndicator, ReconciliationTable: ReconciliationTable, RunOfShowLive: RunOfShowLive, AccessGridMatrix: AccessGridMatrix, EmergencyCodeCard: EmergencyCodeCard, RadioChannelTable: RadioChannelTable, glForCode: glForCode,
    UndoToast: UndoToast, NotificationCenter: NotificationCenter, OnboardingChecklist: OnboardingChecklist, WhatsNew: WhatsNew, FeedbackWidget: FeedbackWidget, ShortcutEditor: ShortcutEditor });


  /* Compass: phone-first, 48 pt targets, one primary action. */
  // Compass surface. `frame` adds the documentation phone frame used by previews; product screens never pass it.
  function Phone(props) { return h("div", { className: cx("xos-compass", props.frame && "xos-phone"), "data-theme": props.sunlight ? "sunlight" : undefined, style: props.frame && props.height ? { minHeight: props.height } : undefined }, props.children); }
  function SheetFrame(props) {
    return h("div", { className: "xos-sheetf", role: "dialog", "aria-label": props.title },
      h("span", { className: "xos-grabber", "aria-hidden": "true" }),
      h("header", { className: "xos-sheetf-head" }, h("strong", null, props.title), props.step ? h("span", { className: "xos-muted xos-num" }, props.step) : null),
      props.children);
  }
  function ScanSheet(props) {
    return h(Phone, { frame: props.frame }, h("div", { className: "xos-scan" },
      h("div", { className: "xos-scan-top" }, h(SegmentedControl, { label: t("scan.mode"), value: props.mode, options: [{ value: "asset", label: t("scan.asset") }, { value: "receiving", label: t("scan.receiving") }, { value: "credential", label: t("scan.credential") }] })),
      h("div", { className: "xos-scan-view", "aria-label": t("camera.viewfinder") }, h("span", { className: "xos-scan-reticle" }), h("span", { className: "xos-scan-hint" }, props.hint)),
      h("div", { className: "xos-scan-foot" },
        props.last ? h("div", { className: cx("xos-scan-result", props.last.ok ? "xos-scan-ok" : "xos-scan-bad"), role: "status" }, h(Icon, { name: props.last.ok ? "CircleCheck" : "CircleX", size: 24 }),
          h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", null, props.last.title), h("span", { className: "xos-code" }, props.last.code))) : null,
        h("div", { className: "xos-row", style: { justifyContent: "space-between" } },
          h("span", null, h("strong", { className: "xos-num", style: { fontSize: 24 } }, props.count), " " + props.countLabel),
          h("span", { className: "xos-row", style: { gap: "var(--space-8)" } }, h(IconButton, { icon: "Nfc", label: t("scan.nfc") }), h(IconButton, { icon: "Flashlight", label: t("scan.torch") }))),
        h(Button, { variant: "primary", size: "lg", className: "xos-block" }, props.doneLabel))));
  }
  function OfflineBanner(props) {
    return h("div", { className: "xos-offline", role: "status" }, h(Icon, { name: "WifiOff", size: 16 }),
      h("span", null, props.message), h("span", { className: "xos-chip xos-num" }, t("offline.queued", { n: props.queued })), props.onView ? h(Button, { size: "sm", variant: "ghost", onClick: props.onView }, t("action.view")) : null);
  }
  function QuickIncidentSheet(props) {
    return h(Phone, { frame: props.frame }, h(SheetFrame, { title: t("incident.title"), step: t("count.step", { n: 1, total: 3 }) },
      h("div", { className: "xos-incident-grid" }, props.types.map(function (type) {
        return h("button", { key: type.label, type: "button", className: cx("xos-incident-type", type.critical && "xos-incident-crit") }, h(Icon, { name: type.icon, size: 28 }), h("span", null, type.label));
      })),
      h("div", { className: "xos-row xos-muted", style: { gap: "var(--space-6)" } }, h(Icon, { name: "MapPin", size: 16 }), props.location),
      h("p", { className: "xos-help" }, t("incident.help"))));
  }
  function ChecklistRunner(props) {
    var it = props.items[props.index];
    var done = props.items.filter(function (x) { return x.result; }).length;
    return h(Phone, { frame: props.frame }, h("div", { className: "xos-runner" },
      h("div", { className: "xos-progress-head" }, h("strong", null, props.title), h("span", { className: "xos-num" }, t("count.of", { n: props.index + 1, total: props.items.length }))),
      h("div", { className: "xos-progress-track" }, h("div", { className: "xos-progress-fill", style: { width: (done / props.items.length * 100) + "%" } })),
      h("article", { className: "xos-runner-card" }, h("span", { className: "xos-code xos-muted" }, it.code), h("strong", { style: { fontSize: 20, lineHeight: 1.2 } }, it.label), it.help ? h("span", { className: "xos-muted" }, it.help) : null,
        it.result === "fail" ? h("div", { className: "xos-col" }, h(Button, { icon: "Camera", size: "lg" }, t("inspection.addPhoto")), h(Textarea, { label: t("inspection.whatFailed"), width: "100%" })) : null),
      h("div", { className: "xos-runner-actions" },
        h("button", { type: "button", className: cx("xos-big", "xos-big-fail", it.result === "fail" && "xos-big-on"), "aria-pressed": it.result === "fail" ? "true" : "false" }, h(Icon, { name: "X", size: 28 }), t("inspection.fail")),
        h("button", { type: "button", className: cx("xos-big", "xos-big-pass", it.result === "pass" && "xos-big-on"), "aria-pressed": it.result === "pass" ? "true" : "false" }, h(Icon, { name: "Check", size: 28 }), t("inspection.pass")))));
  }
  function ShiftCard(props) {
    return h("article", { className: "xos-shift" },
      h("header", null, h(StateChip, { state: props.state, label: props.stateLabel }), props.countdown ? h("span", { className: "xos-num xos-muted" }, props.countdown) : null),
      h("strong", { style: { fontSize: 16 } }, props.role),
      h("div", { className: "xos-col", style: { gap: "var(--space-6)" } },
        h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: "Calendar", size: 16, color: "var(--text-secondary)" }), props.date),
        h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: "Clock", size: 16, color: "var(--text-secondary)" }), h("span", { className: "xos-num" }, props.time)),
        h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: "MapPin", size: 16, color: "var(--text-secondary)" }), props.place)),
      h("footer", null, props.actions));
  }
  function DaySheetView(props) {
    return h(Phone, { frame: props.frame }, h("div", { className: "xos-daysheet" },
      h("header", null, h("span", { className: "xos-muted" }, props.date), h("strong", { style: { fontSize: 20 } }, props.title), h("span", { className: "xos-muted" }, props.venue)),
      h("ol", { className: "xos-daysheet-list" }, props.entries.map(function (e, i) {
        return h("li", { key: i, className: e.now ? "xos-daysheet-now" : undefined }, h("span", { className: "xos-num" }, e.time), h("span", null, e.label), e.now ? h(Tag, { tone: "accent" }, t("daysheet.now")) : null);
      })),
      h("section", null, h("h4", { className: "xos-label" }, t("daysheet.contacts")), props.contacts.map(function (c) {
        return h("div", { key: c.name, className: "xos-row xos-contact" }, h(Avatar, { name: c.name }), h("div", { className: "xos-col", style: { gap: 0, flex: 1 } }, h("strong", null, c.name), h("span", { className: "xos-muted" }, c.role)), h(IconButton, { icon: "Phone", label: t("contact.call", { name: c.name }), variant: "secondary" }), h(IconButton, { icon: "MessageSquare", label: t("contact.message", { name: c.name }), variant: "secondary" }));
      }))));
  }
  function SignaturePad(props) {
    var ref = React.useRef(null), drawn = React.useState(false);
    React.useEffect(function () {
      var c = ref.current, ctx = c.getContext("2d"), down = false;
      var ink = getComputedStyle(c).color;
      ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = ink;
      function pos(e) { var r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; }
      c.onpointerdown = function (e) { down = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]); drawn[1](true); };
      c.onpointermove = function (e) { if (!down) return; var p = pos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); };
      c.onpointerup = c.onpointerleave = function () { down = false; };
    }, []);
    return h("div", { className: "xos-field", style: { width: 360 } }, h("span", { className: "xos-label" }, props.label),
      h("canvas", { ref: ref, className: "xos-sigpad", width: 720, height: 240, role: "img", "aria-label": t("signature.area") }),
      h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h("span", { className: "xos-help" }, props.attestation),
        h(Button, { size: "sm", variant: "ghost", onClick: function () { var c = ref.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); drawn[1](false); } }, t("action.clear"))));
  }
  function PhotoCapture(props) {
    return h(Phone, { frame: props.frame }, h("div", { className: "xos-scan" },
      h("div", { className: "xos-scan-view xos-photo-view", role: "img", "aria-label": t("camera.viewfinder") }, h("span", { className: "xos-scan-hint" }, props.hint)),
      h("div", { className: "xos-scan-foot" },
        h("div", { className: "xos-row" }, Array.apply(null, Array(props.count)).map(function (_, i) { return h("span", { key: i, className: "xos-thumb", role: "img", "aria-label": t("photo.n", { n: i + 1 }) }, h(Icon, { name: "Image", size: 16 })); })),
        h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h(IconButton, { icon: "PenLine", label: t("photo.annotate"), variant: "secondary" }),
          h("button", { type: "button", className: "xos-shutter", "aria-label": t("photo.take") }), h(Button, { variant: "primary" }, t("action.done"))))));
  }
  function LiveActivity(props) {
    return h("div", { className: "xos-col" },
      h("div", { className: "xos-live-act", role: "group", "aria-label": t("live.label") },
        h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(Icon, { name: props.onBreak ? "Coffee" : "Clock", size: 16, color: props.onBreak ? "var(--warning)" : "var(--success)" }), h("strong", null, props.label)), h("span", { className: "xos-num", style: { fontSize: 24, fontWeight: 600 } }, props.elapsed)),
        h("span", { className: "xos-muted" }, props.place),
        h("div", { className: "xos-row", style: { flexWrap: "nowrap" } }, h(Button, { size: "lg", className: "xos-block" }, t(props.onBreak ? "clock.endBreak" : "clock.break")), h(Button, { size: "lg", variant: "primary", className: "xos-block" }, t("clock.out")))),
      h("div", { className: "xos-widget", role: "group", "aria-label": t("widget.label") }, h("span", { className: "xos-muted" }, t("widget.nextShift")), h("strong", null, props.nextShift), h("span", { className: "xos-num" }, props.nextTime)));
  }
  function ForceUpdateScreen(props) {
    return h(Phone, { frame: props.frame, height: 420 }, h("div", { className: "xos-system" }, h(Icon, { name: "Smartphone", size: 28, color: "var(--text-secondary)" }),
      h("strong", { style: { fontSize: 20 } }, t("update.title")), h("p", { className: "xos-muted" }, props.message),
      h("span", { className: "xos-code xos-muted" }, props.version), h(Button, { variant: "primary", size: "lg", className: "xos-block" }, t("update.action"))));
  }
  function SyncConflictSheet(props) {
    return h(Phone, { frame: props.frame }, h(SheetFrame, { title: t("conflict.title") },
      h("p", { className: "xos-muted", style: { margin: 0 } }, props.message),
      h("span", { className: "xos-label" }, props.field),
      [[t("conflict.yours"), props.mine, props.mineMeta], [t("conflict.server"), props.theirs, props.theirsMeta]].map(function (o, i) {
        return h("label", { key: i, className: "xos-conflict" }, h("input", { type: "radio", name: "xos-conflict", defaultChecked: i === 0 }), h("div", { className: "xos-col", style: { gap: 0 } }, h("span", { className: "xos-muted" }, o[0] + " · " + o[2]), h("strong", null, o[1])));
      }),
      h(Button, { variant: "primary", size: "lg", className: "xos-block" }, t("conflict.keep"))));
  }

  /* Gateway */
  function OpportunityCard(props) {
    var req = props.requirements;
    return h("article", { className: "xos-opp" },
      h("header", { className: "xos-row", style: { justifyContent: "space-between" } },
        h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(BrandMark, { name: props.org, size: "sm", iconOnly: true }), h("span", null, props.org), props.verified ? h(Icon, { name: "BadgeCheck", size: 14, color: "var(--state-scheduled)", label: t("org.verified") }) : null),
        h(IconButton, { icon: "Bookmark", label: props.saved ? t("action.saved") : t("action.save") })),
      h("strong", { className: "xos-opp-role" }, props.role),
      h("div", { className: "xos-opp-line" }, h("strong", { className: "xos-num" }, props.pay || t("money.rateOnRequest")), h("span", null, props.date), h("span", null, props.place)),
      h("div", { className: cx("xos-opp-req", req.missing.length ? "xos-opp-miss" : "xos-opp-ok") },
        h(Icon, { name: req.missing.length ? "CircleAlert" : "CircleCheck", size: 14 }),
        h("span", null, req.missing.length ? t("opp.missing", { list: new Intl.ListFormat(LOCALE).format(req.missing) }) : t("opp.qualified"))),
      h("footer", { className: "xos-row", style: { justifyContent: "space-between" } }, h("span", { className: "xos-muted" }, props.deadline), h(Button, { variant: "primary" }, props.missingAction && req.missing.length ? props.missingAction : t("opp.apply"))));
  }
  function OpportunityFilters(props) {
    var on = React.useState(props.active || []);
    return h("div", { className: "xos-row", role: "group", "aria-label": t("filter.label") },
      h("div", { className: "xos-qa-input", style: { width: 240 } }, h(Icon, { name: "Search", color: "var(--text-secondary)" }), h("input", { className: "xos-qa-field", placeholder: props.placeholder, "aria-label": t("opp.search") })),
      props.chips.map(function (c) { var a = on[0].indexOf(c) >= 0; return h("button", { key: c, type: "button", className: cx("xos-fchip", a && "xos-fchip-on"), "aria-pressed": a ? "true" : "false", onClick: function () { on[1](a ? on[0].filter(function (x) { return x !== c; }) : on[0].concat([c])); } }, a ? h(Icon, { name: "Check", size: 12 }) : null, c); }),
      h(SegmentedControl, { label: t("view.label"), value: "cards", options: [{ value: "cards", label: t("view.cards"), icon: "LayoutGrid" }, { value: "map", label: t("view.map"), icon: "Map" }] }));
  }
  function VIS() { return [{ value: "private", label: t("visibility.private") }, { value: "application", label: t("visibility.application") }, { value: "public", label: t("visibility.public") }]; }
  function ApplicationForm(props) {
    return h(Card, { title: t("apply.title", { role: props.role }), meta: props.org, footer: h(React.Fragment, null, h("span", { className: "xos-muted", style: { marginInlineEnd: "auto" } }, t("apply.draftSaved")), h(Button, { variant: "primary" }, t("apply.submit"))) },
      h("span", { className: "xos-label" }, t("apply.shared", { org: props.org })),
      h("ul", { className: "xos-share" }, props.shared.map(function (s) { return h("li", { key: s.label }, h(Checkbox, { label: s.label, defaultChecked: s.on })); })),
      props.questions.map(function (q) { return h(Textarea, { key: q, label: q, width: "100%", rows: 2 }); }),
      h(Checkbox, { label: t("apply.available") }));
  }
  function BidSheet(props) {
    return h("div", { className: "xos-col" },
      h(InlineAlert, { tone: "info", title: t("bid.sealed") }, t("bid.sealedBody", { deadline: props.deadline })),
      h(SpreadsheetGrid, { label: t("bid.lines"), columns: [{ key: "line", label: t("bid.line"), type: "code", width: 64 }, { key: "item", label: t("bid.item") }, { key: "unit", label: t("bid.unit"), width: 72 }, { key: "qty", label: t("bid.qty"), type: "number", width: 64 }, { key: "price", label: t("bid.unitPrice"), type: "money", editable: true, total: false }, { key: "ext", label: t("bid.extended"), type: "money", total: true }], rows: props.lines, totalsLabel: t("bid.total") }));
  }
  function AgencySlate(props) {
    var sel = props.roster.filter(function (r) { return r.selected; }).length;
    return h(Card, { title: t("slate.title"), meta: t("slate.positions", { n: sel, total: props.positions }), footer: h(Button, { variant: "primary", disabled: sel === 0 }, t("slate.submit")) },
      h(ProgressBar, { label: t("slate.filled"), value: Math.round(sel / props.positions * 100) }),
      h("ul", { className: "xos-slate" }, props.roster.map(function (r) {
        return h("li", { key: r.name }, h(Checkbox, { label: "", defaultChecked: r.selected, "aria-label": t("slate.include", { name: r.name }) }), h(Avatar, { name: r.name }), h("div", { className: "xos-col", style: { gap: 0, flex: 1 } }, h("strong", null, r.name), h("span", { className: "xos-muted" }, r.role)),
          r.certs.map(function (c) { return h("span", { key: c.label, className: "xos-chip" }, h(Icon, { name: c.ok ? "BadgeCheck" : "CircleAlert", size: 12, color: c.ok ? "var(--success)" : "var(--warning)" }), c.label); }));
      })));
  }
  function ProfileEditor(props) {
    var strength = props.strength;
    return h(Card, { title: t("profile.title"), meta: t("profile.complete", { n: strength }) },
      h(ProgressBar, { label: props.nextStep, value: strength }),
      props.fields.map(function (f) {
        return h("div", { key: f.label, className: "xos-profile-row" }, h("div", { className: "xos-col", style: { gap: 0, flex: 1, minWidth: 0 } }, h("span", { className: "xos-label" }, f.label), h("span", null, f.value)),
          h(SegmentedControl, { label: f.label + " visibility", value: f.visibility, options: VIS() }));
      }));
  }
  function EPKViewer(props) {
    return h("section", { className: "xos-epk" },
      h("header", { className: "xos-row" }, h(Avatar, { name: props.artist, size: "lg" }), h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", { style: { fontSize: 20 } }, props.artist), h("span", { className: "xos-muted" }, props.headline)),
        h("span", { className: "xos-row", style: { marginInlineStart: "auto", gap: "var(--space-4)" } }, props.badges.map(function (b) { return h("span", { key: b, className: "xos-chip" }, h(Icon, { name: "BadgeCheck", size: 12, color: "var(--success)" }), b); }))),
      h("div", { className: "xos-epk-grid" }, props.media.map(function (m, i) {
        return h("button", { key: i, type: "button", className: "xos-epk-tile", style: { background: "var(--viz-seq-" + (9 - (i % 4)) + ")" }, "aria-label": m.label }, h(Icon, { name: m.type === "video" ? "Play" : m.type === "audio" ? "AudioLines" : "Image", size: 20 }), h("span", null, m.label));
      })),
      h("p", { className: "xos-muted", style: { margin: 0 } }, props.bio),
      h("div", { className: "xos-row" }, props.links.map(function (l) { return h(Link, { key: l.label, href: l.href, external: true }, l.label); })));
  }
  function AvailabilityCalendar(props) {
    var p = parseIso(props.month);
    return h("div", { className: "xos-col", style: { width: 300 } },
      h("div", { className: "xos-cal-head" }, h("strong", null, monthTitle(p.y, p.m))),
      h(MonthGrid, { year: p.y, month: p.m, mark: function (k) { return props.booked.indexOf(k) >= 0 ? "booked" : props.available.indexOf(k) >= 0 ? "avail" : null; } }),
      h("div", { className: "xos-row xos-muted" }, h("span", { className: "xos-row", style: { gap: 4 } }, h("span", { className: "xos-legend xos-day-avail" }), t("availability.available")), h("span", { className: "xos-row", style: { gap: 4 } }, h("span", { className: "xos-legend xos-day-booked" }), t("availability.booked"))));
  }
  function OnboardingPacket(props) {
    var done = props.items.filter(function (i) { return i.state === "verified"; }).length;
    var mins = props.items.filter(function (i) { return i.state === "todo"; }).reduce(function (a, i) { return a + i.minutes; }, 0);
    var ST = { verified: ["CircleCheck", "var(--success)", t("packet.verified")], review: ["Eye", "var(--state-in-review)", t("packet.review")], todo: ["Circle", "var(--text-tertiary)", t("packet.todo")], expired: ["CircleAlert", "var(--danger)", t("packet.expired")] };
    return h(Card, { title: t("packet.title"), meta: t("packet.minutesLeft", { n: mins }) },
      h(ProgressBar, { label: t("packet.verifiedCount", { n: done, total: props.items.length }), value: Math.round(done / props.items.length * 100) }),
      h("ul", { className: "xos-checklist" }, props.items.map(function (i) {
        var s = ST[i.state];
        return h("li", { key: i.label }, h(Icon, { name: s[0], color: s[1], label: s[2] }), h("div", { className: "xos-col", style: { gap: 0, flex: 1 } }, h("span", null, i.label), h("span", { className: "xos-muted" }, i.note || t("packet.minutes", { n: i.minutes }))),
          i.blocking ? h(Tag, { tone: "neutral" }, t("packet.required")) : null, i.state === "todo" ? h(Button, { size: "sm" }, i.action || t("action.start")) : null);
      })));
  }
  function EngagementTimeline(props) {
    return h("ol", { className: "xos-engtl", "aria-label": t("engagement.stages") }, props.stages.map(function (s, i) {
      var st = i < props.current ? "done" : i === props.current ? "current" : "todo";
      return h("li", { key: s.label, className: "xos-engtl-" + st, "aria-current": st === "current" ? "step" : undefined },
        h("span", { className: "xos-step-dot" }, st === "done" ? h(Icon, { name: "Check", size: 12 }) : i + 1),
        h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", null, s.label), h("span", { className: "xos-muted" }, s.date || s.owner)));
    }));
  }
  function RatingDialog(props) {
    var r = React.useState(props.value || 0);
    return h(Dialog, { title: t("rating.title", { name: props.counterpart }), actions: [h(Button, { key: "a", variant: "ghost" }, t("action.later")), h(Button, { key: "b", variant: "primary", disabled: !r[0] }, t("rating.submit"))] },
      h("div", { className: "xos-col" },
        h("div", { className: "xos-stars", role: "radiogroup", "aria-label": t("rating.label") }, [1, 2, 3, 4, 5].map(function (n) {
          return h("button", { key: n, type: "button", role: "radio", "aria-checked": r[0] === n ? "true" : "false", "aria-label": t(n === 1 ? "rating.star" : "rating.stars", { n: n }), className: cx("xos-star", n <= r[0] && "xos-star-on"), onClick: function () { r[1](n); } }, h(Icon, { name: "Star", size: 24 }));
        })),
        h(Textarea, { label: t("rating.comment"), width: "100%", rows: 2 }),
        h("span", { className: "xos-help" }, t("rating.release"))));
  }
  function PayoutDetailsForm(props) {
    return h(Card, { title: t("payout.title"), meta: props.rail, footer: h(Button, { variant: "primary", icon: "Lock" }, t("payout.save")) },
      props.onFile ? h("div", { className: "xos-row xos-chip", style: { height: 32 } }, h(Icon, { name: "Landmark", size: 14 }), h("span", null, props.onFile.bank), h("span", { className: "xos-code" }, "•••• " + props.onFile.last4)) : null,
      h(Input, { label: t("payout.routing"), inputMode: "numeric", autoComplete: "off", placeholder: t("payout.routingHint") }),
      h(Input, { label: t("payout.account"), inputMode: "numeric", autoComplete: "off", type: "password", help: t("payout.accountHelp") }),
      h(Select, { label: t("payout.type"), value: "checking", options: [{ value: "checking", label: t("payout.checking") }, { value: "savings", label: t("payout.savings") }] }));
  }
  function OrgSwitcher(props) {
    return h("div", { className: "xos-orgsw" },
      h("button", { type: "button", className: "xos-orgsw-trigger", "aria-haspopup": "menu", "aria-expanded": "true" }, h(BrandMark, { name: props.current, size: "sm" }), h(Icon, { name: "ChevronsUpDown", size: 14, color: "var(--text-secondary)" })),
      h("div", { className: "xos-menu", role: "menu" },
        h("div", { className: "xos-menu-head" }, props.heading),
        props.orgs.map(function (o) {
          return h("div", { key: o.name, role: "menuitemradio", "aria-checked": o.name === props.current ? "true" : "false", className: "xos-cmd-item", "data-active": o.name === props.current ? "" : undefined },
            h(BrandMark, { name: o.name, size: "sm", iconOnly: true }), h("div", { className: "xos-col", style: { gap: 0 } }, h("span", null, o.name), h("span", { className: "xos-muted" }, o.role)),
            o.name === props.current ? h(Icon, { name: "Check", size: 14, className: "xos-hint" }) : o.badge ? h(Badge, { count: o.badge, tone: "accent", className: "xos-hint" }) : null);
        }),
        h("div", { role: "separator", className: "xos-menu-sep" }),
        h("div", { role: "menuitem", className: "xos-cmd-item" }, h(Icon, { name: "Compass" }), h("span", null, t("org.marketplace")))));
  }

  Object.assign(EXPORTS, { ScanSheet: ScanSheet, OfflineBanner: OfflineBanner, QuickIncidentSheet: QuickIncidentSheet, ChecklistRunner: ChecklistRunner, ShiftCard: ShiftCard, DaySheetView: DaySheetView, SignaturePad: SignaturePad, PhotoCapture: PhotoCapture, LiveActivity: LiveActivity, ForceUpdateScreen: ForceUpdateScreen, SyncConflictSheet: SyncConflictSheet,
    OpportunityCard: OpportunityCard, OpportunityFilters: OpportunityFilters, ApplicationForm: ApplicationForm, BidSheet: BidSheet, AgencySlate: AgencySlate, ProfileEditor: ProfileEditor, EPKViewer: EPKViewer, AvailabilityCalendar: AvailabilityCalendar, OnboardingPacket: OnboardingPacket, EngagementTimeline: EngagementTimeline, RatingDialog: RatingDialog, PayoutDetailsForm: PayoutDetailsForm, OrgSwitcher: OrgSwitcher });


  /* List row: every row answers "what now" with state, owner, next date and next action. */
  function RecordRow(props) {
    return h("div", { className: "xos-rrow", role: "row", "aria-selected": props.selected ? "true" : undefined, tabIndex: 0 },
      h("span", { role: "gridcell", className: "xos-rrow-state" }, h(StateIcon, { state: props.state }), h("span", { className: "xos-sr" }, props.stateLabel)),
      h("span", { role: "gridcell", className: "xos-code xos-muted" }, props.recordKey),
      h("span", { role: "gridcell", className: "xos-rrow-title" }, props.kind ? h(RecordKindGlyph, { kind: props.kind, size: 14, color: "var(--text-secondary)" }) : null, h("span", null, props.title)),
      h("span", { role: "gridcell", className: "xos-rrow-chips" }, props.chips || null),
      h("span", { role: "gridcell", className: "xos-rrow-next xos-num" }, props.next ? h(React.Fragment, null, h(Icon, { name: "Calendar", size: 14, color: "var(--text-secondary)" }), props.next) : null),
      h("span", { role: "gridcell" }, props.owner ? h(Avatar, { name: props.owner }) : null),
      h("span", { role: "gridcell", className: "xos-rrow-action" }, props.actionLabel ? h(Button, { size: "sm", shortcut: props.actionKey, onClick: props.onAction }, props.actionLabel) : null));
  }
  function RecordList(props) {
    return h("div", { className: "xos-rlist", role: "grid", "aria-label": props.label }, props.children);
  }
  function Gallery(props) {
    return h("div", { className: "xos-gallery", role: "list", "aria-label": props.label, style: props.min ? { "--min": props.min + "px" } : undefined },
      React.Children.toArray(props.children).filter(function (c) { return !(typeof c === "string" && !c.trim()); }).map(function (c, i) { return h("div", { role: "listitem", key: c && c.key != null ? c.key : i }, c); }));
  }

  /* Resource schedule: people by day, with double bookings flagged in place. */
  function ResourceSchedule(props) {
    return h("table", { className: "xos-table xos-rsched" }, h("caption", null, props.label),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, t("resource.person")), props.days.map(function (d) { return h("th", { key: d.key, scope: "col", className: d.weekend ? "xos-rsched-we" : undefined }, h("span", { className: "xos-muted" }, d.dow), " ", h("span", { className: "xos-num" }, d.date)); }))),
      h("tbody", null, props.people.map(function (p) {
        return h("tr", { key: p.name }, h("th", { scope: "row" }, h("span", { className: "xos-row", style: { gap: "var(--space-8)", flexWrap: "nowrap" } }, h(Avatar, { name: p.name }), h("span", { className: "xos-col", style: { gap: 0 } }, h("span", null, p.name), h("span", { className: "xos-muted" }, p.role)))),
          props.days.map(function (d) {
            var s = (p.shifts || []).filter(function (x) { return x.day === d.key; });
            var clash = s.length > 1;
            return h("td", { key: d.key, className: cx(d.weekend && "xos-rsched-we", clash && "xos-rsched-clash") },
              s.map(function (x, i) { return h("span", { key: i, className: "xos-rsched-shift" }, h(StateIcon, { state: x.state, size: 12 }), h("span", { className: "xos-num" }, x.time)); }),
              clash ? h("span", { className: "xos-rsched-flag" }, h(Icon, { name: "TriangleAlert", size: 12 }), t("resource.doubleBooked")) : null);
          }));
      })));
  }

  /* Org chart: reporting lines as a nested list. */
  function OrgNode(n) {
    return h("li", { key: n.name + n.role },
      h("div", { className: "xos-org-card" }, n.name ? h(Avatar, { name: n.name }) : h("span", { className: "xos-avatar xos-avatar-more", "aria-hidden": "true" }, h(Icon, { name: "UserPlus", size: 12 })),
        h("span", { className: "xos-col", style: { gap: 0 } }, h("strong", null, n.name || t("org.vacant")), h("span", { className: "xos-muted" }, n.role), n.code ? h("span", { className: "xos-code xos-muted" }, n.code) : null)),
      n.reports && n.reports.length ? h("ul", null, n.reports.map(OrgNode)) : null);
  }
  function OrgChart(props) { return h("div", { className: "xos-orgchart", role: "group", "aria-label": props.label }, h("ul", null, OrgNode(props.root))); }

  /* Charts: one y-axis, thin marks, legend for two or more series, a table view always one click away. */
  var MARKERS = ["circle", "square", "triangle", "diamond", "cross", "circle-open", "square-open"];
  function markerPath(kind, x, y) {
    var r = 4.5;
    switch (kind) {
      case "square": return h("rect", { x: x - r, y: y - r, width: r * 2, height: r * 2, rx: 1 });
      case "triangle": return h("path", { d: "M" + x + " " + (y - r - 1) + " L" + (x + r + 1) + " " + (y + r) + " L" + (x - r - 1) + " " + (y + r) + " Z" });
      case "diamond": return h("path", { d: "M" + x + " " + (y - r - 1) + " L" + (x + r + 1) + " " + y + " L" + x + " " + (y + r + 1) + " L" + (x - r - 1) + " " + y + " Z" });
      case "cross": return h("path", { d: "M" + (x - r) + " " + y + " H" + (x + r) + " M" + x + " " + (y - r) + " V" + (y + r), className: "xos-mk-stroke" });
      case "circle-open": return h("circle", { cx: x, cy: y, r: r, className: "xos-mk-open" });
      case "square-open": return h("rect", { x: x - r, y: y - r, width: r * 2, height: r * 2, rx: 1, className: "xos-mk-open" });
      default: return h("circle", { cx: x, cy: y, r: r });
    }
  }
  function niceMax(v) { if (v <= 0) return 1; var e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
  function Chart(props) {
    // Seven categorical colors at most: from the eighth series on, the sixth and later fold into one Other series (blank where any part is blank).
    var series = props.series.length > 7 ? props.series.slice(0, 6).concat([{ name: t("chart.other"), other: true, values: props.categories.map(function (c, i) { var sum = 0; for (var k = 6; k < props.series.length; k++) { var v = props.series[k].values[i]; if (v === null || v === undefined) return null; sum += v; } return sum; }) }]) : props.series;
    function color(s, si) { return s.other ? "var(--viz-other)" : "var(--viz-cat-" + (si + 1) + ")"; }
    var view = React.useState("chart"), hover = React.useState(null);
    var W = props.width || 640, H = props.height || 260, pl = 60, pr = props.type === "line" && series.length <= 4 ? 96 : 16, pt = 12, pb = 32;
    var iw = W - pl - pr, ih = H - pt - pb, cats = props.categories, n = cats.length;
    var all = []; series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null && v !== undefined) all.push(v); }); });
    var max = niceMax(Math.max.apply(null, all.concat([0]))), ticks = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return f * max; });
    function y(v) { return pt + ih - (v / max) * ih; }
    var fmt = props.format === "money" ? function (v) { return fmtCurrency(v, props.currency); } : fmtNumber;
    var tickFmt = function (v) { return new Intl.NumberFormat(LOCALE, props.format === "money" ? { style: "currency", currency: props.currency || "USD", notation: "compact", maximumFractionDigits: 1 } : { notation: "compact", maximumFractionDigits: 1 }).format(v); };
    var uidRef = React.useRef(null); if (uidRef.current === null) uidRef.current = "xos-tex-" + (++uid);
    var band = iw / n, sc = series.length, gap = 2, bw = Math.min(28, (band * 0.7 - gap * (sc - 1)) / sc);
    var marks = [];
    if (props.type === "line") {
      series.forEach(function (s, si) {
        var pts = []; s.values.forEach(function (v, i) { if (v !== null && v !== undefined) pts.push([pl + band * i + band / 2, y(v), v, i]); });
        marks.push(h("g", { key: s.name, className: "xos-series", style: { "--c": color(s, si) } },
          h("polyline", { points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "), className: "xos-line" + (si % 2 ? " xos-line-dash" : "") }),
          pts.map(function (p) { return h("g", { key: p[3], className: "xos-mk", role: "img", tabIndex: 0, onMouseEnter: function () { hover[1]({ x: p[0], y: p[1], s: s.name, c: cats[p[3]], v: p[2] }); }, onFocus: function () { hover[1]({ x: p[0], y: p[1], s: s.name, c: cats[p[3]], v: p[2] }); }, onMouseLeave: function () { hover[1](null); }, onBlur: function () { hover[1](null); }, "aria-label": s.name + ", " + cats[p[3]] + ": " + fmt(p[2]) }, markerPath(MARKERS[si], p[0], p[1]), h("circle", { cx: p[0], cy: p[1], r: 12, className: "xos-hit" })); }),
          pr > 16 && pts.length ? h("text", { x: pts[pts.length - 1][0] + 10, y: pts[pts.length - 1][1] + 4, className: "xos-dlabel" }, s.name) : null));
      });
    } else {
      series.forEach(function (s, si) {
        marks.push(h("g", { key: s.name, className: "xos-series", style: { "--c": color(s, si) } }, s.values.map(function (v, i) {
          if (v === null || v === undefined) return null;
          var x = pl + band * i + (band - (bw * sc + gap * (sc - 1))) / 2 + si * (bw + gap), top = y(v), hgt = pt + ih - top, r = Math.min(4, hgt);
          var d = "M" + x + " " + (pt + ih) + " V" + (top + r) + " Q" + x + " " + top + " " + (x + r) + " " + top + " H" + (x + bw - r) + " Q" + (x + bw) + " " + top + " " + (x + bw) + " " + (top + r) + " V" + (pt + ih) + " Z";
          return h("g", { key: i, className: "xos-mk", role: "img", tabIndex: 0, onMouseEnter: function () { hover[1]({ x: x + bw / 2, y: top, s: s.name, c: cats[i], v: v }); }, onFocus: function () { hover[1]({ x: x + bw / 2, y: top, s: s.name, c: cats[i], v: v }); }, onMouseLeave: function () { hover[1](null); }, onBlur: function () { hover[1](null); }, "aria-label": s.name + ", " + cats[i] + ": " + fmt(v) },
            h("path", { d: d, className: "xos-bar" + (si % 2 ? " xos-bar-tex" : ""), style: si % 2 ? { fill: "url(#" + uidRef.current + "-" + si + ")" } : undefined }), h("rect", { x: x - 2, y: pt, width: bw + 4, height: ih, className: "xos-hit" }));
        })));
      });
    }
    var tableView = h("table", { className: "xos-table" }, h("caption", { className: "xos-sr" }, props.title),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, props.categoryLabel), series.map(function (s) { return h("th", { key: s.name, scope: "col", className: "xos-right" }, s.name); }))),
      h("tbody", null, cats.map(function (c, i) { return h("tr", { key: c }, h("th", { scope: "row" }, c), series.map(function (s) { var v = s.values[i]; return h("td", { key: s.name, className: "xos-right" }, v === null || v === undefined ? h("span", { className: "xos-unpriced" }, t("chart.noValue")) : h("span", { className: "xos-num" }, fmt(v))); })); })));
    return h("figure", { className: "xos-chart" },
      h("div", { className: "xos-chart-head" }, h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", null, props.title), props.subtitle ? h("span", { className: "xos-muted" }, props.subtitle) : null),
        h(SegmentedControl, { label: t("chart.view"), value: "chart", onChange: view[1], options: [{ value: "chart", label: t("chart.chart"), icon: "ChartColumn" }, { value: "table", label: t("chart.table"), icon: "Table" }] })),
      series.length > 1 ? h("ul", { className: "xos-legend-list", "aria-label": t("chart.legend") }, series.map(function (s, si) { return h("li", { key: s.name, style: { "--c": color(s, si) } }, h("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", className: "xos-series" }, props.type === "line" ? markerPath(MARKERS[si], 7, 7) : h("rect", { x: 1, y: 1, width: 12, height: 12, rx: 3, className: si % 2 ? "xos-bar xos-bar-tex" : "xos-bar" })), s.name); })) : null,
      view[0] === "table" ? tableView : h("div", { className: "xos-chart-plot" },
        h("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", role: "group", "aria-label": props.title + ". " + t("chart.tableHint") },
          h("defs", null, series.map(function (s, si) { return si % 2 ? h("pattern", { key: si, id: uidRef.current + "-" + si, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)", style: { "--c": color(s, si) } }, h("rect", { width: 6, height: 6, className: "xos-tex-bg" }), h("line", { x1: 0, y1: 0, x2: 0, y2: 6, className: "xos-tex-line" })) : null; })),
          ticks.map(function (tv) { return h("g", { key: tv }, h("line", { x1: pl, x2: W - pr, y1: y(tv), y2: y(tv), className: tv === 0 ? "xos-axis" : "xos-grid" }), h("text", { x: pl - 8, y: y(tv) + 4, className: "xos-tick", textAnchor: "end" }, tickFmt(tv))); }),
          cats.map(function (c, i) { return h("text", { key: c, x: pl + band * i + band / 2, y: H - 10, className: "xos-tick", textAnchor: "middle" }, c); }),
          marks),
        hover[0] ? h("div", { className: "xos-tip", role: "status", style: { insetInlineStart: (hover[0].x / W * 100) + "%", insetBlockStart: (hover[0].y / H * 100) + "%" } }, h("strong", null, hover[0].s), h("span", { className: "xos-muted" }, hover[0].c), h("span", { className: "xos-num" }, fmt(hover[0].v))) : null));
  }

  function StatTile(props) {
    var dir = props.delta === undefined || props.delta === null ? null : props.delta > 0 ? "up" : props.delta < 0 ? "down" : "flat";
    return h("section", { className: "xos-stat", "aria-label": props.label },
      h("span", { className: "xos-label" }, props.label),
      h("strong", { className: "xos-stat-value xos-num" }, props.format === "money" ? h(Money, { amount: props.value }) : props.value === null || props.value === undefined ? h("span", { className: "xos-unpriced" }, t("chart.noValue")) : fmtNumber(props.value)),
      dir ? h("span", { className: cx("xos-stat-delta", props.goodWhen && ((props.goodWhen === "up") === (dir === "up")) ? "xos-good" : dir !== "flat" ? "xos-bad" : null) },
        h(Icon, { name: dir === "up" ? "ArrowUp" : dir === "down" ? "ArrowDown" : "Minus", size: 14 }), h("span", { className: "xos-num" }, (props.delta > 0 ? "+" : "") + fmtNumber(props.delta) + (props.deltaUnit || "")), props.deltaLabel ? h("span", { className: "xos-muted" }, props.deltaLabel) : null) : null,
      props.caption ? h("span", { className: "xos-muted" }, props.caption) : null);
  }

  /* Help */
  function HelpPanel(props) {
    return h("aside", { className: "xos-helppanel", "aria-label": t("help.title") },
      h("header", { className: "xos-drawer-head" }, h("strong", null, t("help.title")), h(IconButton, { icon: "X", label: t("action.close"), shortcut: "Esc" })),
      h("div", { className: "xos-help-body" },
        h("div", { className: "xos-qa-input" }, h(Icon, { name: "Search", color: "var(--text-secondary)" }), h("input", { className: "xos-qa-field", placeholder: t("help.search"), "aria-label": t("help.search") })),
        h("section", null, h("h3", { className: "xos-label" }, t("help.forThisPage")), h("ul", { className: "xos-help-list" }, props.articles.map(function (a) { return h("li", { key: a }, h(Link, { href: "#" }, a)); }))),
        h("section", null, h("h3", { className: "xos-label" }, t("help.shortcuts")), props.shortcuts.map(function (s) { return h("div", { key: s.label, className: "xos-sheet-row" }, h("span", null, s.label), h("span", { className: "xos-row", style: { gap: "var(--space-2)" } }, s.keys.split(" ").map(function (k, i) { return h(Kbd, { key: i }, k); }))); })),
        props.assistant ? h("section", null, h("h3", { className: "xos-label" }, t("help.assistant")), h("div", { className: "xos-qa-input" }, h(Icon, { name: "Sparkles", color: "var(--text-secondary)" }), h("input", { className: "xos-qa-field", placeholder: t("help.ask"), "aria-label": t("help.ask") }))) : null,
        h("div", { className: "xos-row" }, h(Button, { icon: "Megaphone" }, t("help.whatsNew")), h(Button, { icon: "LifeBuoy" }, t("help.contact")))));
  }

  /* Compass and Gateway */
  function QRCode(props) {
    var q = window.qrcode;
    if (!q) return h("span", { className: "xos-qr", role: "img", "aria-label": props.label });
    var code = q(0, "M"); code.addData(props.value); code.make();
    var n = code.getModuleCount(), cells = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (code.isDark(r, c)) cells.push("M" + (c + 4) + " " + (r + 4) + "h1v1h-1z");
    return h("svg", { className: "xos-qr", viewBox: "0 0 " + (n + 8) + " " + (n + 8), width: props.size || 160, height: props.size || 160, role: "img", "aria-label": props.label, shapeRendering: "crispEdges" },
      h("rect", { width: n + 8, height: n + 8, className: "xos-qr-bg" }), h("path", { d: cells.join(""), className: "xos-qr-ink" }));
  }
  function CredentialBadge(props) {
    return h("article", { className: "xos-badge-card", style: { "--cat": "var(--viz-cat-" + props.categoryColor + ")" }, "aria-label": t("badge.label", { name: props.name }) },
      h("div", { className: "xos-badge-stripe" }, h("span", null, props.category)),
      h("div", { className: "xos-badge-body" },
        h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h(BrandMark, { name: props.org, size: "sm" }), h("span", { className: "xos-code xos-muted" }, props.credentialKey)),
        h("div", { className: "xos-row", style: { flexWrap: "nowrap", gap: "var(--space-12)" } }, h(Avatar, { name: props.name, size: "lg" }), h("div", { className: "xos-col", style: { gap: 0 } }, h("strong", { style: { fontSize: 20, lineHeight: 1.2 } }, props.name), h("span", { className: "xos-muted" }, props.role))),
        h("div", { className: "xos-badge-qr" }, h(QRCode, { value: props.payload, label: t("badge.qr", { key: props.credentialKey }), size: 168 })),
        h("div", { className: "xos-col", style: { gap: "var(--space-4)" } }, h("span", { className: "xos-label" }, t("badge.zones")), h("div", { className: "xos-row", style: { gap: "var(--space-4)" } }, props.zones.map(function (z) { return h("span", { key: z, className: "xos-chip" }, z); }))),
        h("span", { className: "xos-muted xos-num" }, t("badge.valid", { from: props.validFrom, to: props.validTo })),
        h("div", { className: "xos-row", style: { flexWrap: "nowrap" } }, h(Button, { icon: "Wallet", className: "xos-block" }, t("badge.wallet")), h(IconButton, { icon: "SunMedium", label: t("badge.brightness"), variant: "secondary" }))));
  }
  function UpNextCard(props) {
    return h("article", { className: "xos-upnext", "aria-label": t("upnext.label") },
      h("header", { className: "xos-row", style: { justifyContent: "space-between" } }, h("span", { className: "xos-row", style: { gap: "var(--space-6)" } }, h(BrandMark, { name: props.org, size: "sm", iconOnly: true }), h("span", { className: "xos-label" }, t("upnext.label"))), h("span", { className: "xos-upnext-count xos-num" }, props.countdown)),
      h("strong", { className: "xos-upnext-title" }, props.title),
      h("dl", { className: "xos-props xos-upnext-props" },
        h("dt", null, t("upnext.when")), h("dd", { className: "xos-num" }, props.when),
        h("dt", null, t("upnext.call")), h("dd", { className: "xos-num" }, props.callTime),
        h("dt", null, t("upnext.where")), h("dd", null, props.address),
        props.parking ? h(React.Fragment, null, h("dt", null, t("upnext.parking")), h("dd", null, props.parking)) : null,
        props.contact ? h(React.Fragment, null, h("dt", null, t("upnext.contact")), h("dd", null, props.contact)) : null),
      props.bring && props.bring.length ? h("div", { className: "xos-col", style: { gap: "var(--space-4)" } }, h("span", { className: "xos-label" }, t("upnext.bring")), h("ul", { className: "xos-upnext-bring" }, props.bring.map(function (b) { return h("li", { key: b }, h(Icon, { name: "Check", size: 14, color: "var(--success)" }), b); }))) : null,
      h("footer", { className: "xos-row" }, h(Button, { variant: "primary", icon: "Navigation" }, t("upnext.directions")), h(Button, { icon: "CalendarPlus" }, t("upnext.calendar")), h(Button, { icon: "Wallet" }, t("badge.wallet"))));
  }
  function PaymentTracker(props) {
    var steps = [t("pay.submitted"), t("pay.approved"), t("pay.scheduled"), t("pay.paid")];
    return h("section", { className: "xos-paytrack", "aria-label": t("pay.label", { key: props.invoiceKey }) },
      h("div", { className: "xos-row", style: { justifyContent: "space-between" } }, h("div", { className: "xos-col", style: { gap: 0 } }, h("span", { className: "xos-code xos-muted" }, props.invoiceKey), h("strong", null, props.title)), h("strong", { className: "xos-num", style: { fontSize: 20 } }, h(Money, { amount: props.amount }))),
      h("ol", { className: "xos-paytrack-steps" }, steps.map(function (s, i) {
        var st = i < props.current ? "done" : i === props.current ? "current" : "todo";
        return h("li", { key: s, className: "xos-pt-" + st, "aria-current": st === "current" ? "step" : undefined },
          h("span", { className: "xos-step-dot" }, st === "done" ? h(Icon, { name: "Check", size: 12 }) : i + 1), h("span", { className: "xos-col", style: { gap: 0 } }, h("span", null, s), h("span", { className: "xos-muted xos-num" }, props.dates[i] || (st === "todo" && props.expected && i === props.current + 1 ? t("pay.expected", { date: props.expected }) : ""))));
      })));
  }

  /* Navigation shells */
  function TabBar(props) {
    return h("nav", { className: cx("xos-tabbar", props.compass && "xos-tabbar-compass"), "aria-label": props.label },
      props.items.map(function (it) {
        var on = it.label === props.active, center = props.centerLabel === it.label;
        return h("a", { key: it.label, href: "#", className: cx("xos-tabbar-item", center && "xos-tabbar-center"), "aria-current": on ? "page" : undefined },
          h("span", { className: "xos-tabbar-icon" }, h(Icon, { name: it.icon, size: props.compass ? 24 : 20 }), it.badge ? h(Badge, { count: it.badge, tone: "danger", label: t("tabbar.badge", { n: it.badge }) }) : null),
          h("span", null, it.label));
      }));
  }
  function TopNav(props) {
    return h("header", { className: "xos-topnav" },
      h("div", { className: "xos-row", style: { gap: "var(--space-24)", flexWrap: "nowrap" } }, h(BrandMark, { name: props.brand, size: "sm" }),
        h("nav", { className: "xos-topnav-links", "aria-label": props.label }, h("ul", { className: "xos-topnav-list" }, props.items.map(function (it) { return h("li", { key: it.label }, h("a", { href: "#", className: "xos-topnav-item", "aria-current": it.label === props.active ? "page" : undefined }, h(Icon, { name: it.icon, size: 16 }), it.label, it.badge ? h(Badge, { count: it.badge, tone: "accent", label: t("tabbar.badge", { n: it.badge }) }) : null)); })))),
      h("div", { className: "xos-row", style: { gap: "var(--space-8)", flexWrap: "nowrap" } }, h(IconButton, { icon: "Search", label: t("command.label"), shortcut: "⌘ K" }), h(IconButton, { icon: "CircleHelp", label: t("help.title"), shortcut: "?" }), h("button", { type: "button", className: "xos-topnav-avatar", "aria-haspopup": "menu", "aria-label": t("nav.account", { name: props.person }) }, h(Avatar, { name: props.person }))));
  }

  Object.assign(EXPORTS, { RecordRow: RecordRow, RecordList: RecordList, Gallery: Gallery, ResourceSchedule: ResourceSchedule, OrgChart: OrgChart, Chart: Chart, StatTile: StatTile, HelpPanel: HelpPanel, QRCode: QRCode, CredentialBadge: CredentialBadge, UpNextCard: UpNextCard, PaymentTracker: PaymentTracker, TabBar: TabBar, TopNav: TopNav });


  /* Responsive layer. Wide data components scroll inside a labeled region instead of widening the page.
     The region joins the tab order only while it actually overflows, so keyboard users can scroll it and nobody else pays a tab stop. */
  function ScrollRegion(props) {
    var ref = React.useRef(null), over = React.useState(false);
    React.useLayoutEffect(function () {
      var el = ref.current; if (!el) return undefined;
      function measure() { over[1](el.scrollWidth > el.clientWidth + 1); }
      measure();
      if (typeof ResizeObserver === "undefined") return undefined;
      var ro = new ResizeObserver(measure); ro.observe(el); return function () { ro.disconnect(); };
    }, []);
    return h("div", { ref: ref, className: "xos-scrollx", role: "region", "aria-label": props.label, tabIndex: over[0] ? 0 : undefined }, props.children);
  }
  function scrollable(C) {
    var W = function (p) { return h(ScrollRegion, { label: p.label || p.caption || p.title || t("scroll.region") }, h(C, p)); };
    W.displayName = C.name || "Scrollable";
    return W;
  }
  ["DataTable", "BudgetGrid", "ReconciliationTable", "AccessGridMatrix", "RadioChannelTable", "ShortcutEditor", "ResourceSchedule", "DiffViewer", "CoordinateMatrix", "OrgChart", "Timeline"].forEach(function (k) { EXPORTS[k] = scrollable(EXPORTS[k]); });
  Object.assign(EXPORTS, { ScrollRegion: ScrollRegion });

  window.XOS = Object.assign(window.XOS || {}, EXPORTS);
})();
