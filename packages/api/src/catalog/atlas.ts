/**
 * Atlas modules (Section 4.2) other than Canon, Opportunities and Settings, which live in their
 * own catalog files.
 */
import { z } from "@hono/zod-openapi";
import {
  AccountingPeriodState,
  finance as fin,
  operations as ops,
  projects as prj,
  records as rec,
  safety as saf,
  workforce as wf,
} from "@xos/resource-schemas";
import {
  collectionAction,
  collectionQuery,
  itemAction,
  itemQuery,
  numericOrder,
  resource,
  transition,
  transitionBody,
} from "./define.ts";
import type { ResourceSpec } from "./types.ts";

const ledger = ["list", "get"] as const;
const noDelete = ["list", "get", "create", "update"] as const;

const approve = (what: string, rule: string) =>
  itemAction("approve", {
    summary: `Approve a ${what}`,
    description: `Records an approval decision on the ${what}. ${rule} Spend authority and separation of duties are enforced in the approval RPC; a refusal returns 422 and names the rule.`,
  });

export const atlasResources: readonly ResourceSpec[] = [
  // Home
  resource("Home", "/home", prj.HomeSummary, {
    verbs: [],
    actions: [
      collectionQuery("get", {
        segment: "summary",
        summary: "Get the home summary",
        description:
          "Returns the caller's org dashboard: open and blocked work, projects at risk at their next gate, unread alerts and committed spend as a NULL-aware total.",
      }),
    ],
  }),

  // Projects
  resource("Projects", "/projects", prj.Project, {
    actions: [
      transition("Project", ["Proposed", "Active"]),
      itemAction("passGate", {
        segment: "gate-transitions",
        summary: "Pass the current gate",
        description:
          "Moves the project to the next phase. Compare-and-set on `expected_phase_code`; refused with 422 when any blocking criterion lacks evidence. The database enforces the criteria.",
        body: prj.GateTransitionRequest,
      }),
      itemQuery("gateReadiness", {
        summary: "Get gate readiness",
        description: "Lists each criterion of the next gate with whether evidence satisfies it.",
        response: prj.GateReadiness.read,
        paged: true,
      }),
      itemAction("duplicate", {
        summary: "Duplicate a project",
        description:
          "Creates a copy of the project with its scope tree, optionally with its records.",
        status: 201,
      }),
    ],
  }),
  resource("Projects", "/scope-nodes", prj.ScopeNode),
  resource("Projects", "/project-phase-transitions", prj.ProjectPhaseTransition, {
    verbs: ledger,
    order: { by: ["transitioned_at"], numeric: false },
  }),
  resource("Projects", "/gate-evidence", prj.GateEvidence, { op: "gateEvidence" }),

  // Activity
  resource("Activity", "/activity-events", prj.ActivityEvent, {
    verbs: ledger,
    order: { by: ["occurred_at"], numeric: false },
  }),

  // Schedule
  resource("Schedule", "/schedule-baselines", rec.ScheduleBaseline, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Schedule", "/schedule-actuals", rec.ScheduleActual, { verbs: noDelete }),
  resource("Schedule", "/calendars", rec.Calendar),
  resource("Schedule", "/record-dependencies", rec.RecordDependency, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Schedule", "/record-recurrences", rec.RecordRecurrence),

  // Work: the record spine and work orders
  resource("Work", "/records", rec.RecordResource, {
    actions: [
      itemAction("transition", {
        segment: "transitions",
        summary: "Transition a record state",
        description:
          "Moves a record between the nine record states. Blocked requires `blocker_text`; Deferred requires `replan_reason`; from Scheduled onward every change is a logged replan. Canceled records are retained.",
        body: rec.RecordTransitionRequest,
      }),
      itemAction("duplicate", {
        summary: "Duplicate a record",
        description: "Creates a copy of the record, with or without its children.",
        status: 201,
      }),
      itemAction("archive", {
        summary: "Archive a record",
        description:
          "Hides the record from default views while keeping it searchable with a filter.",
      }),
    ],
  }),
  resource("Work", "/record-state-transitions", rec.RecordStateTransition, {
    verbs: ledger,
    order: { by: ["transitioned_at"], numeric: false },
  }),
  resource("Work", "/record-replans", rec.RecordReplan, {
    verbs: ledger,
    order: { by: ["replanned_at"], numeric: false },
  }),
  resource("Work", "/record-checklist-items", rec.RecordChecklistItem, {
    order: { by: ["position"], numeric: false },
  }),
  resource("Work", "/record-watchers", rec.RecordWatcher, { verbs: ["list", "create", "delete"] }),
  resource("Work", "/work-orders", rec.WorkOrder, {
    actions: [transition("Work Order", ["Proposed", "Active"])],
  }),
  resource("Work", "/work-order-bids", rec.WorkOrderBid, {
    verbs: noDelete,
    actions: [
      itemAction("award", {
        summary: "Award a work order bid",
        description: "Awards the work order to this bid and closes the other bids.",
      }),
    ],
  }),

  // Show
  resource("Show", "/run-of-show", rec.RunOfShow, { op: "runsOfShow", label: "run of show" }),
  resource("Show", "/cues", rec.Cue, {
    order: { by: ["position"], numeric: false },
    actions: [
      itemAction("fire", {
        summary: "Call a cue",
        description:
          "Marks the cue as called now and advances the live run of show to the next cue.",
      }),
    ],
  }),
  resource("Show", "/day-sheets", rec.DaySheet, {
    actions: [
      itemAction("publish", {
        summary: "Publish a day sheet",
        description: "Publishes the day sheet to its audience.",
      }),
    ],
  }),
  resource("Show", "/call-sheets", rec.CallSheet, {
    actions: [
      itemAction("publish", {
        summary: "Publish a call sheet",
        description: "Publishes the call sheet to the called crew.",
      }),
    ],
  }),

  // Knowledge
  resource("Knowledge", "/sops", ops.Sop, { label: "SOP" }),
  resource("Knowledge", "/sop-acknowledgments", ops.SopAcknowledgment, {
    verbs: ["list", "get", "create"],
    label: "SOP acknowledgment",
  }),
  resource("Knowledge", "/documents", ops.DocumentResource),
  resource("Knowledge", "/document-versions", ops.DocumentVersion, {
    verbs: ["list", "get", "create"],
  }),
  resource("Knowledge", "/verbiage-terms", ops.VerbiageTerm),

  // Places
  resource("Places", "/venues", ops.Venue),
  resource("Places", "/spaces", ops.Space),
  resource("Places", "/zones", ops.Zone),
  resource("Places", "/capability-documents", ops.CapabilityDocument, {
    actions: [
      itemAction("freeze", {
        summary: "Freeze a capability document",
        description:
          "Freezes the document so its content and validity window can no longer change.",
      }),
    ],
  }),
  resource("Places", "/site-plans", ops.SitePlan),
  resource("Places", "/site-plan-pins", ops.SitePlanPin),
  resource("Places", "/geofences", ops.Geofence),
  resource("Places", "/requirements", ops.Requirement),
  resource("Places", "/reconciliations", ops.Reconciliation, {
    verbs: ["list", "get", "create"],
  }),
  resource("Places", "/reconciliation-lines", ops.ReconciliationLine, { verbs: ledger }),

  // Logistics
  resource("Logistics", "/shipments", ops.Shipment, {
    actions: [transition("Shipment", ["Scheduled", "Active"])],
  }),
  resource("Logistics", "/shipment-lines", ops.ShipmentLine),
  resource("Logistics", "/dock-slots", ops.DockSlot, {
    actions: [
      itemAction("checkIn", {
        summary: "Check in at a dock slot",
        description: "Records the vehicle's check-in at the dock slot.",
      }),
    ],
  }),
  resource("Logistics", "/gate-queue", ops.GateQueueEntry, {
    op: "gateQueueEntries",
    verbs: noDelete,
    actions: [
      itemAction("release", {
        summary: "Release a vehicle",
        description: "Releases the vehicle from the gate queue to its dock.",
      }),
    ],
  }),
  resource("Logistics", "/marshalling-log", ops.MarshallingLogEntry, {
    op: "marshallingLogEntries",
    verbs: ["list", "get", "create"],
    order: { by: ["logged_at"], numeric: false },
  }),

  // Advancing
  resource("Advancing", "/advance-packets", ops.AdvancePacket, {
    actions: [
      itemAction("send", {
        summary: "Send an advance packet",
        description:
          "Sends the packet to every recipient. Recipients without an account receive a token link and access code.",
      }),
      transition("Advance", ["Active", "Complete"]),
    ],
  }),
  resource("Advancing", "/advance-sections", ops.AdvanceSection, {
    order: { by: ["position"], numeric: false },
  }),
  resource("Advancing", "/advance-recipients", ops.AdvanceRecipient, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Advancing", "/advance-submissions", ops.AdvanceSubmission, {
    verbs: ["list", "get", "create"],
  }),
  resource("Advancing", "/advance-promotions", ops.AdvancePromotion, {
    verbs: ["list", "get", "create"],
  }),
  resource("Advancing", "/riders", ops.Rider),
  resource("Advancing", "/rider-lines", ops.RiderLine),

  // Hospitality
  resource("Hospitality", "/fulfillments", ops.Fulfillment, {
    actions: [transition("Fulfillment", ["Quoted", "Committed"])],
  }),
  resource("Hospitality", "/fulfillment-lines", ops.FulfillmentLine),
  resource("Hospitality", "/beos", ops.Beo, { label: "BEO" }),
  resource("Hospitality", "/beo-lines", ops.BeoLine, { label: "BEO line" }),

  // Assets
  resource("Assets", "/asset-classes", ops.AssetClass),
  resource("Assets", "/asset-units", ops.AssetUnit, {
    actions: [
      transition("Asset", ["Active", "In Review"]),
      collectionAction("scan", {
        summary: "Resolve a scanned asset",
        description:
          "Resolves a scanned barcode, QR or NFC payload to an asset unit. An unknown code returns a 422 `NO_ANSWER` refusal.",
        body: ops.ScanRequest,
      }),
    ],
  }),
  resource("Assets", "/asset-lots", ops.AssetLot),
  resource("Assets", "/asset-identifiers", ops.AssetIdentifier, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Assets", "/asset-custody", ops.AssetCustody, {
    op: "assetCustodyEntries",
    verbs: ["list", "get", "create"],
    order: { by: ["recorded_at"], numeric: false },
  }),
  resource("Assets", "/asset-maintenance", ops.AssetMaintenance, { op: "assetMaintenanceEvents" }),
  resource("Assets", "/asset-damage", ops.AssetDamage, { op: "assetDamageReports" }),

  // People
  resource("People", "/role-assignments", wf.RoleAssignment),
  resource("People", "/requisitions", wf.Requisition, {
    actions: [
      transition("Requisition", ["Proposed", "Sourcing"]),
      approve("requisition", "Spend authority applies before an opportunity can be published."),
    ],
  }),
  resource("People", "/offers", wf.Offer, {
    verbs: noDelete,
    actions: [
      itemAction("send", {
        summary: "Send an offer",
        description: "Issues the offer terms to the person or organization.",
      }),
      itemAction("accept", {
        summary: "Accept an offer",
        description: "Accepts the offer as the offered party and creates the engagement.",
      }),
      itemAction("decline", {
        summary: "Decline an offer",
        description: "Declines the offer as the offered party.",
      }),
      itemAction("counter", {
        summary: "Counter an offer",
        description: "Returns counter terms to the org.",
        body: wf.Offer.update as z.ZodType,
      }),
    ],
  }),
  resource("People", "/agreements", wf.Agreement, {
    verbs: noDelete,
    actions: [
      itemAction("sign", {
        summary: "Sign an agreement",
        description:
          "Signs the agreement. A signed agreement cannot be revoked or unsigned; a second signature attempt is refused.",
      }),
    ],
  }),

  // Crew
  resource("Crew", "/shifts", wf.Shift, {
    order: { by: ["starts_at"], numeric: false },
    actions: [
      transition("Shift", ["Scheduled", "Active"]),
      itemAction("accept", {
        summary: "Accept a shift",
        description: "Accepts the shift as the assigned person.",
      }),
    ],
  }),
  resource("Crew", "/shift-swaps", wf.ShiftSwap, {
    verbs: ["list", "get", "create"],
    actions: [
      approve("shift swap", "A crew member cannot approve their own swap."),
      itemAction("decline", {
        summary: "Decline a shift swap",
        description: "Declines the swap request.",
      }),
      itemAction("withdraw", {
        summary: "Withdraw a shift swap",
        description: "Withdraws the caller's own swap request.",
      }),
    ],
  }),
  resource("Crew", "/time-entries", wf.TimeEntry, {
    verbs: ["list", "get"],
    order: { by: ["clock_in_at"], numeric: false },
    actions: [
      collectionAction("clockIn", {
        summary: "Clock in",
        description:
          "Opens a time entry inside the shift geofence. Protects against double clock-in across devices; an overlapping entry is refused. Compass replays queued punches with the same Idempotency-Key.",
        body: wf.TimeEntry.create as z.ZodType,
        status: 201,
      }),
      itemAction("clockOut", {
        summary: "Clock out",
        description:
          "Closes the open time entry. Forgotten clock-outs close automatically at 16 hours and are flagged.",
      }),
      itemAction("startBreak", {
        summary: "Start a break",
        description: "Records a break punch on the open time entry.",
      }),
      itemAction("endBreak", {
        summary: "End a break",
        description: "Ends the current break on the open time entry.",
      }),
    ],
  }),
  resource("Crew", "/time-entry-corrections", wf.TimeEntryCorrection, {
    verbs: ["list", "get", "create"],
    actions: [
      approve("time entry correction", "The submitter cannot approve their own correction."),
    ],
  }),
  resource("Crew", "/time-entry-audit", wf.TimeEntryAudit, {
    op: "timeEntryAuditEntries",
    verbs: ledger,
  }),
  resource("Crew", "/timesheets", wf.Timesheet, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("submit", {
        summary: "Submit a timesheet",
        description: "Submits the timesheet for approval.",
      }),
      approve(
        "timesheet",
        "The submitter cannot approve it, and an approval is voided when its hours change.",
      ),
    ],
  }),
  resource("Crew", "/timesheet-approvals", wf.TimesheetApproval, { verbs: ledger }),
  resource("Crew", "/kiosk-devices", wf.KioskDevice),
  resource("Crew", "/rate-cards", wf.RateCard),
  resource("Crew", "/rate-card-lines", wf.RateCardLine),
  resource("Crew", "/pay-rates", wf.PayRate, {
    verbs: ["list", "get", "create"],
    order: { by: ["effective_from"], numeric: false },
  }),
  resource("Crew", "/overtime-rules", wf.OvertimeRule),
  resource("Crew", "/union-local-rates", wf.UnionLocalRate),
  resource("Crew", "/wage-determinations", wf.WageDetermination),
  resource("Crew", "/pay-periods", wf.PayPeriod, {
    verbs: noDelete,
    actions: [transition("Pay Period", ["Open", "Closed"])],
  }),
  resource("Crew", "/payroll-runs", wf.PayrollRun, {
    verbs: ["list", "get", "create"],
    actions: [transition("Payroll Run", ["Draft", "In Review"])],
  }),
  resource("Crew", "/payroll-lines", wf.PayrollLine, { verbs: ledger }),
  resource("Crew", "/payroll-exports", wf.PayrollExport, { verbs: ["list", "get", "create"] }),
  resource("Crew", "/earning-codes", wf.EarningCode, {
    order: numericOrder(["earning_code"], [{ earning_code: "010" }, { earning_code: "020" }]),
  }),
  resource("Crew", "/per-diems", wf.PerDiem),
  resource("Crew", "/time-off-policies", wf.TimeOffPolicy),
  resource("Crew", "/time-off-requests", wf.TimeOffRequest, {
    verbs: ["list", "get", "create"],
    actions: [
      approve("time off request", "The submitter cannot approve it."),
      itemAction("decline", {
        summary: "Decline a time off request",
        description: "Declines the request.",
      }),
    ],
  }),

  // Credentials
  resource("Credentials", "/credential-categories", wf.CredentialCategory, {
    order: { by: ["position"], numeric: false },
  }),
  resource("Credentials", "/credentials", wf.Credential, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("revoke", {
        summary: "Revoke a credential",
        description: "Revokes the credential; scans after revocation are refused.",
      }),
    ],
  }),
  resource("Credentials", "/access-grid", wf.AccessGridEntry, { op: "accessGridEntries" }),
  resource("Credentials", "/access-scans", wf.AccessScan, {
    verbs: ["list", "get", "create"],
    order: { by: ["scanned_at"], numeric: false },
  }),
  resource("Credentials", "/certifications", wf.Certification),
  resource("Credentials", "/certification-holders", wf.CertificationHolder, {
    actions: [
      itemAction("verify", {
        summary: "Verify a certification",
        description:
          "Verifies the certification against its issuer or evidence. Certifications cannot be self-verified.",
      }),
    ],
  }),

  // Finance
  resource("Finance", "/budgets", fin.Budget, {
    actions: [
      itemQuery("summary", {
        summary: "Get budget totals",
        description:
          "Returns estimate, committed, actual and variance as NULL-aware totals. Unpriced lines are excluded from each sum and counted in `unpriced_count`.",
        response: fin.BudgetSummary.read,
      }),
    ],
  }),
  resource("Finance", "/budget-lines", fin.BudgetLine, {
    order: numericOrder(
      ["account_code", "urid"],
      [
        { account_code: "5000", urid: "0000.01" },
        { account_code: "5400", urid: "4000.01.01" },
      ],
    ),
  }),
  resource("Finance", "/expenses", fin.Expense, {
    verbs: noDelete,
    actions: [
      itemAction("submit", {
        summary: "Submit an expense",
        description: "Submits the expense for approval. A closed production refuses new expenses.",
      }),
      approve("expense", "The submitter cannot approve it."),
    ],
  }),
  resource("Finance", "/contingency-draws", fin.ContingencyDraw, {
    verbs: ["list", "get", "create"],
  }),
  resource("Finance", "/change-orders", fin.ChangeOrder, {
    verbs: noDelete,
    actions: [
      transition("Change Order", ["Proposed", "Active"]),
      approve(
        "change order",
        "Its requester cannot price and approve it alone, and an unpriced change order cannot be approved at zero.",
      ),
    ],
  }),
  resource("Finance", "/change-order-lines", fin.ChangeOrderLine),
  resource("Finance", "/accounting-periods", fin.AccountingPeriod, {
    verbs: ["list", "get", "create"],
    order: { by: ["starts_on"], numeric: false },
    actions: [
      itemAction("transition", {
        segment: "transitions",
        summary: "Transition an accounting period",
        description:
          "Moves the period through Open, In Period, Closing, Closed, Audited and Archived. A closed period refuses postings; Audited is reachable only through Closed.",
        body: transitionBody("AccountingPeriodTransitionRequest", AccountingPeriodState, [
          "Closing",
          "Closed",
        ]),
      }),
    ],
  }),
  resource("Finance", "/journal-entries", fin.JournalEntry, {
    verbs: noDelete,
    actions: [
      itemAction("post", {
        summary: "Post a journal entry",
        description:
          "Posts the entry to the ledger. The preparer cannot post it; a closed period refuses it.",
      }),
    ],
  }),
  resource("Finance", "/journal-lines", fin.JournalLine, {
    order: numericOrder(["account_code"], [{ account_code: "1000" }, { account_code: "5400" }]),
  }),
  resource("Finance", "/posting-lines", fin.PostingLine, {
    verbs: ledger,
    order: numericOrder(
      ["account_code", "urid"],
      [
        { account_code: "5000", urid: "0000.01" },
        { account_code: "5400", urid: "4000.01" },
      ],
    ),
    actions: [
      collectionAction("export", {
        segment: "exports",
        summary: "Export posting lines",
        description:
          "Projects the period's Universal Posting Lines to the target accounting platform through its field mapping. There is no other export format.",
        body: fin.PostingExportRequest,
        status: 202,
        response: z
          .object({
            export_job_id: z.uuid().meta({ example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }),
          })
          .meta({ id: "PostingExportAccepted" }),
      }),
    ],
  }),
  resource("Finance", "/invoices", fin.Invoice, {
    verbs: noDelete,
    actions: [
      transition("Invoice", ["Proposed", "Active"]),
      approve(
        "invoice",
        "Three-way match must pass, and a person who created the vendor or edited its bank details cannot approve payment to it.",
      ),
    ],
  }),
  resource("Finance", "/invoice-lines", fin.InvoiceLine),
  resource("Finance", "/payment-applications", fin.PaymentApplication, {
    verbs: ["list", "get", "create"],
  }),
  resource("Finance", "/billing-draws", fin.BillingDraw),
  resource("Finance", "/cost-centers", fin.CostCenter, {
    order: { by: ["cost_center_id"], numeric: false },
  }),
  resource("Finance", "/tax-jurisdictions", fin.TaxJurisdiction),
  resource("Finance", "/tax-rates", fin.TaxRate),
  resource("Finance", "/fx-rates", fin.FxRate, { order: { by: ["rate_date"], numeric: false } }),
  resource("Finance", "/price-books", fin.PriceBook),

  // Procurement
  resource("Procurement", "/rfqs", fin.Rfq, {
    label: "RFQ",
    actions: [
      itemAction("issue", {
        summary: "Issue an RFQ",
        description: "Sends invitations to bid. Responses stay sealed until the deadline.",
      }),
      transition("RFQ", ["Active", "Complete"]),
    ],
  }),
  resource("Procurement", "/rfq-invitations", fin.RfqInvitation, {
    verbs: ["list", "get", "create", "delete"],
    label: "RFQ invitation",
  }),
  resource("Procurement", "/rfq-responses", fin.RfqResponse, {
    verbs: ["list", "get", "create"],
    label: "RFQ response",
    actions: [
      itemAction("submit", {
        summary: "Submit an RFQ response",
        description: "Seals and submits the response. A bidder sees only their own response.",
      }),
    ],
  }),
  resource("Procurement", "/rfq-response-lines", fin.RfqResponseLine, {
    label: "RFQ response line",
  }),
  resource("Procurement", "/purchase-orders", fin.PurchaseOrder, {
    verbs: noDelete,
    label: "purchase order",
    actions: [
      approve("purchase order", "The creator of a purchase order cannot approve it."),
      transition("Purchase Order", ["Proposed", "Committed"]),
      itemAction("acknowledge", {
        summary: "Acknowledge a purchase order",
        description: "Records the vendor's acknowledgment of the purchase order.",
      }),
    ],
  }),
  resource("Procurement", "/po-lines", fin.PoLine, { label: "PO line" }),
  resource("Procurement", "/po-change-orders", fin.PoChangeOrder, {
    verbs: noDelete,
    label: "PO change order",
    actions: [approve("PO change order", "Its requester cannot approve it.")],
  }),
  resource("Procurement", "/goods-receipts", fin.GoodsReceipt, {
    verbs: ["list", "get", "create"],
  }),
  resource("Procurement", "/receipt-lines", fin.ReceiptLine, { verbs: ["list", "get", "create"] }),
  resource("Procurement", "/invoice-matches", fin.InvoiceMatch, {
    verbs: ["list", "get", "create"],
    label: "three-way match",
  }),
  resource("Procurement", "/catalog-bindings", fin.CatalogBinding),
  resource("Procurement", "/vendor-products", fin.VendorProduct),

  // Vendors
  resource("Vendors", "/vendors", fin.Vendor),
  resource("Vendors", "/vendor-classes", fin.VendorClass),
  resource("Vendors", "/vendor-class-assignments", fin.VendorClassAssignment, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Vendors", "/prequalifications", fin.Prequalification, {
    actions: [transition("Prequalification", ["Proposed", "Active"])],
  }),
  resource("Vendors", "/insurance-certificates", fin.InsuranceCertificate),
  resource("Vendors", "/vendor-scorecards", fin.VendorScorecard),
  resource("Vendors", "/sponsor-entitlements", fin.SponsorEntitlement, {
    actions: [transition("Entitlement Fulfillment", ["Committed", "Complete"])],
  }),

  // Safety
  resource("Safety", "/inspection-templates", saf.InspectionTemplate),
  resource("Safety", "/inspection-items", saf.InspectionItem, {
    order: { by: ["position"], numeric: false },
  }),
  resource("Safety", "/inspections", saf.Inspection, {
    verbs: noDelete,
    actions: [
      itemAction("signOff", {
        summary: "Sign off an inspection",
        description: "Signs off the inspection. Every item needs a result first.",
      }),
    ],
  }),
  resource("Safety", "/inspection-results", saf.InspectionResult, { verbs: noDelete }),
  resource("Safety", "/permit-requirements", saf.PermitRequirement, {
    verbs: ledger,
    actions: [
      collectionAction("generate", {
        summary: "Run the permit engine",
        description:
          "Runs the jurisdiction permit engine for a project and writes its permit requirements. An unpopulated jurisdiction returns a 422 `NO_ANSWER` refusal; it never passes.",
        body: z
          .object({
            project_id: z.uuid().meta({ example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f" }),
          })
          .meta({ id: "PermitEngineRequest" }),
        paged: true,
      }),
      transition("Permit", ["Proposed", "Active"]),
    ],
  }),
  resource("Safety", "/incidents", saf.Incident, {
    verbs: noDelete,
    actions: [
      transition("Incident", ["Active", "In Review"]),
      itemAction("close", {
        summary: "Close an incident",
        description:
          "Closes the incident with sign-off. A critical incident cannot be relabeled and closed in one request.",
      }),
    ],
  }),
  resource("Safety", "/incident-parties", saf.IncidentParty),
  resource("Safety", "/incident-media", saf.IncidentMedia, {
    op: "incidentMediaItems",
    verbs: ["list", "get", "create", "delete"],
    label: "incident media item",
  }),
  resource("Safety", "/dispatch-assignments", saf.DispatchAssignment, { verbs: noDelete }),
  resource("Safety", "/medical-encounters", saf.MedicalEncounter, { verbs: noDelete }),
  resource("Safety", "/crisis-alerts", saf.CrisisAlert, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("clear", {
        summary: "Clear a crisis alert",
        description: "Clears the alert and notifies the project.",
      }),
    ],
  }),
  resource("Safety", "/emergency-codes", saf.EmergencyCode, {
    order: numericOrder(["code"], [{ code: "10" }, { code: "20" }]),
  }),
  resource("Safety", "/radio-channels", saf.RadioChannel, {
    order: numericOrder(["channel"], [{ channel: 1 }, { channel: 2 }]),
  }),
];
