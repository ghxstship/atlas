/**
 * Knowledge, Places, Logistics, Advancing, Hospitality and Assets (Sections 4.2 and 7.4).
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { Direction, FulfillmentKind, ReconciliationResult } from "../common/enums.ts";
import { defineResource } from "../common/resource.ts";

// Knowledge

export const Sop = defineResource({
  name: "Sop",
  table: "app.sops",
  description: "A standard operating procedure that members acknowledge.",
  serverSet: ["sop_state"],
  fields: {
    title: f.text("SOP title.", "Working at Height"),
    body: f.document("SOP body as a rich text document."),
    urid: c.UridAtAnyGrain.nullable(),
    sop_state: f.stateLabel("SOP state.", "Active"),
    requires_acknowledgment: f.bool("Whether members must acknowledge it.", true),
  },
});

export const SopAcknowledgment = defineResource({
  name: "SopAcknowledgment",
  table: "app.sop_acknowledgments",
  description: "A person's acknowledgment of an SOP version.",
  immutable: ["sop_id", "person_id"],
  serverSet: ["acknowledged_at"],
  fields: {
    sop_id: f.ref("SOP"),
    person_id: f.ref("acknowledging person"),
    acknowledged_at: f.instant("When it was acknowledged."),
  },
});

export const DocumentResource = defineResource({
  name: "Document",
  table: "app.documents",
  description: "A document with versions. Files are stored in tenant-scoped storage.",
  fields: {
    title: f.text("Document title.", "Venue Site Plan"),
    project_id: f.ref("project").nullable(),
    record_id: f.ref("record the document belongs to").nullable(),
    classification: f.stateLabel("Column classification of the content.", "Internal"),
    current_version_id: f.ref("current version").nullable(),
  },
  serverSet: ["current_version_id"],
});

export const DocumentVersion = defineResource({
  name: "DocumentVersion",
  table: "app.document_versions",
  description: "An immutable version of a document.",
  immutable: ["document_id"],
  serverSet: ["version_number", "byte_size", "sha256"],
  fields: {
    document_id: f.ref("document"),
    version_number: f.int("Version number.", 3, 1),
    file_name: f.text("Original file name.", "site-plan-v3.pdf"),
    mime_type: f.text("Sniffed MIME type.", "application/pdf"),
    byte_size: f.int("File size in bytes.", 482113),
    sha256: f.code("SHA-256 of the file.", "9f2c4e1a7b"),
  },
});

export const VerbiageTerm = defineResource({
  name: "VerbiageTerm",
  table: "app.verbiage_terms",
  description: "A controlled vocabulary term with casing rules. Em dashes are refused.",
  fields: {
    term: f.text("Term.", "Load-In"),
    casing_rule: f.text("Casing rule.", "Title Case as a noun"),
    usage: f.longText("Usage note.", "Hyphenate as a noun; two words as a verb."),
  },
});

// Places

export const Venue = defineResource({
  name: "Venue",
  table: "app.venues",
  description: "A venue.",
  fields: {
    name: f.text("Venue name.", "Harborfront Lawn"),
    address_line1: f.text("Street address.", "100 Harbor Way"),
    locality: f.text("City.", "Miami"),
    region: f.text("State or region.", "FL"),
    postal_code: f.code("Postal code.", "33132"),
    country: f.countryCode(),
    jurisdiction_id: c.JurisdictionId.nullable(),
    time_zone: f.timeZone(),
    latitude: f.latitude().nullable(),
    longitude: f.longitude().nullable(),
  },
});

export const Space = defineResource({
  name: "Space",
  table: "app.spaces",
  description: "A space within a venue.",
  immutable: ["venue_id"],
  fields: {
    venue_id: f.ref("venue"),
    name: f.text("Space name.", "North Lawn"),
    capacity: f.int("Rated occupant capacity.", 2500).nullable(),
    area_sq_ft: f.quantity("Floor area in square feet.", 18000).nullable(),
  },
});

export const Zone = defineResource({
  name: "Zone",
  table: "app.zones",
  description: "An access or operations zone within a space.",
  immutable: ["space_id"],
  fields: {
    space_id: f.ref("space"),
    name: f.text("Zone name.", "Backstage"),
    zone_code: f.code("Zone code used on credentials.", "BS"),
  },
});

export const CapabilityDocument = defineResource({
  name: "CapabilityDocument",
  table: "app.capability_documents",
  description:
    "A venue capability document with a validity window. A frozen document cannot change.",
  immutable: ["venue_id"],
  serverSet: ["frozen"],
  fields: {
    venue_id: f.ref("venue"),
    document_id: f.ref("document"),
    valid_from: f.date("First day the document is valid."),
    valid_to: f.date("Last day the document is valid.").nullable(),
    frozen: f.bool("Whether the document is frozen.", false),
  },
});

export const SitePlan = defineResource({
  name: "SitePlan",
  table: "app.site_plans",
  description: "A site plan drawing for a venue.",
  immutable: ["venue_id"],
  fields: {
    venue_id: f.ref("venue"),
    title: f.text("Site plan title.", "Festival Layout"),
    document_id: f.ref("drawing document"),
  },
});

export const SitePlanPin = defineResource({
  name: "SitePlanPin",
  table: "app.site_plan_pins",
  description: "A pin on a site plan.",
  immutable: ["site_plan_id"],
  fields: {
    site_plan_id: f.ref("site plan"),
    label: f.text("Pin label.", "First Aid"),
    x: f.quantity("Horizontal position, 0 to 1.", 0.42),
    y: f.quantity("Vertical position, 0 to 1.", 0.71),
  },
});

export const Geofence = defineResource({
  name: "Geofence",
  table: "app.geofences",
  description: "A geofence used for Compass clock in.",
  fields: {
    name: f.text("Geofence name.", "Harborfront Site"),
    venue_id: f.ref("venue").nullable(),
    latitude: f.latitude(),
    longitude: f.longitude(),
    radius_m: f.int("Radius in meters.", 250, 1),
  },
});

export const Requirement = defineResource({
  name: "Requirement",
  table: "app.requirements",
  description:
    "A requirement or a capability: one shape with a direction facet, so reconciliation is a join.",
  fields: {
    direction: Direction,
    project_id: f.ref("project").nullable(),
    venue_id: f.ref("venue").nullable(),
    urid: c.UridAtAnyGrain,
    statement: f.longText(
      "What is required or provided.",
      "Three-phase 400 A power at stage left.",
    ),
    quantity: f.quantity("Quantity required or provided.", 1).nullable(),
    unit: c.UnitCode.nullable(),
    critical: f.bool("Whether the requirement is critical.", true),
    assertion_rank: f.int("Assertion rank of the claim, 0 to 4.", 3),
  },
});

export const Reconciliation = defineResource({
  name: "Reconciliation",
  table: "app.reconciliations",
  description: "A reconciliation run of requirements against capabilities.",
  immutable: ["project_id"],
  serverSet: ["run_at", "met_count", "gap_count", "unknown_count"],
  fields: {
    project_id: f.ref("project"),
    venue_id: f.ref("venue").nullable(),
    run_at: f.instant("When the reconciliation ran."),
    met_count: f.int("Requirements met.", 18),
    gap_count: f.int("Requirements with a gap.", 2),
    unknown_count: f.int("Requirements with an unknown result.", 1),
  },
});

export const ReconciliationLine = defineResource({
  name: "ReconciliationLine",
  table: "app.reconciliation_lines",
  description: "One requirement's reconciliation result.",
  serverSet: ["reconciliation_id", "requirement_id", "capability_id", "result"],
  fields: {
    reconciliation_id: f.ref("reconciliation"),
    requirement_id: f.ref("requirement"),
    capability_id: f.ref("matching capability").nullable(),
    result: ReconciliationResult,
  },
});

// Logistics

export const Shipment = defineResource({
  name: "Shipment",
  table: "app.shipments",
  description: "A shipment into or out of a venue.",
  immutable: ["project_id"],
  serverSet: ["shipment_state"],
  fields: {
    project_id: f.ref("project"),
    carrier: f.text("Carrier name.", "Coastal Freight"),
    tracking_number: f.code("Carrier tracking identifier.", "CF123456789").nullable(),
    direction: f.code("Inbound or outbound.", "inbound"),
    shipment_state: f.stateLabel("Shipment state.", "Scheduled"),
    expected_at: f.instant("Expected arrival or departure."),
  },
});

export const ShipmentLine = defineResource({
  name: "ShipmentLine",
  table: "app.shipment_lines",
  description: "A line on a shipping manifest.",
  immutable: ["shipment_id"],
  fields: {
    shipment_id: f.ref("shipment"),
    description: f.text("Line description.", "Truss sections, 10 ft"),
    quantity: f.quantity("Quantity.", 24),
    unit: c.UnitCode,
    asset_class_id: f.ref("asset class").nullable(),
  },
});

export const DockSlot = defineResource({
  name: "DockSlot",
  table: "app.dock_slots",
  description: "A dock slot booking.",
  immutable: ["venue_id"],
  serverSet: ["checked_in_at"],
  fields: {
    venue_id: f.ref("venue"),
    shipment_id: f.ref("shipment").nullable(),
    starts_at: f.instant("Slot start."),
    ends_at: f.instant("Slot end."),
    dock: f.code("Dock door.", "D2"),
    checked_in_at: f.instant("When the vehicle checked in.").nullable(),
  },
});

export const GateQueueEntry = defineResource({
  name: "GateQueueEntry",
  table: "app.gate_queue",
  description: "A vehicle waiting at the venue gate.",
  immutable: ["venue_id"],
  fields: {
    venue_id: f.ref("venue"),
    dock_slot_id: f.ref("dock slot").nullable(),
    vehicle_plate: f.code("Vehicle plate.", "FL-ABC123"),
    arrived_at: f.instant("When the vehicle arrived."),
    released_at: f.instant("When the vehicle was released.").nullable(),
  },
});

export const MarshallingLogEntry = defineResource({
  name: "MarshallingLogEntry",
  table: "app.marshalling_log",
  description: "A marshalling yard log entry: staging and release.",
  immutable: ["venue_id"],
  fields: {
    venue_id: f.ref("venue"),
    vehicle_plate: f.code("Vehicle plate.", "FL-ABC123"),
    event: f.code("Log event.", "staged"),
    logged_at: f.instant("When the event was logged."),
    notes: f.longText("Notes.", "Held for the second dock window.").nullable(),
  },
});

// Advancing

export const AdvancePacket = defineResource({
  name: "AdvancePacket",
  table: "app.advance_packets",
  description: "An advance packet sent to parties for one project.",
  immutable: ["project_id"],
  serverSet: ["advance_state", "sent_at"],
  fields: {
    project_id: f.ref("project"),
    title: f.text("Packet title.", "Headliner Advance"),
    advance_state: f.stateLabel("Advance state.", "Active"),
    due_at: f.instant("When submissions are due."),
    sent_at: f.instant("When the packet was sent.").nullable(),
  },
});

export const AdvanceSection = defineResource({
  name: "AdvanceSection",
  table: "app.advance_sections",
  description: "A section of an advance packet.",
  immutable: ["advance_packet_id"],
  fields: {
    advance_packet_id: f.ref("advance packet"),
    position: f.int("Section order.", 1, 1),
    title: f.text("Section title.", "Hospitality"),
    form_definition_id: f.ref("form the section collects").nullable(),
  },
});

export const AdvanceRecipient = defineResource({
  name: "AdvanceRecipient",
  table: "app.advance_recipients",
  description:
    "A party bound to an advance packet. Recipients without an account use a token and access code.",
  immutable: ["advance_packet_id"],
  fields: {
    advance_packet_id: f.ref("advance packet"),
    person_id: f.ref("recipient person").nullable(),
    organization_id: f.ref("recipient organization").nullable(),
    engagement_id: f.ref("engagement").nullable(),
  },
});

export const AdvanceSubmission = defineResource({
  name: "AdvanceSubmission",
  table: "app.advance_submissions",
  description: "A recipient's submission for one section.",
  immutable: ["advance_section_id", "advance_recipient_id"],
  serverSet: ["submitted_at"],
  fields: {
    advance_section_id: f.ref("advance section"),
    advance_recipient_id: f.ref("advance recipient"),
    form_submission_id: f.ref("form submission"),
    submitted_at: f.instant("When it was submitted."),
  },
});

export const AdvancePromotion = defineResource({
  name: "AdvancePromotion",
  table: "app.advance_promotions",
  description:
    "A submission promoted into project records, such as a requirement or a fulfillment.",
  immutable: ["advance_submission_id"],
  fields: {
    advance_submission_id: f.ref("advance submission"),
    target_urn: f.text(
      "URN of the record created from the submission.",
      "urn:xpms:requirement:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
  },
});

export const Rider = defineResource({
  name: "Rider",
  table: "app.riders",
  description: "A technical or hospitality rider for an engagement.",
  fields: {
    engagement_id: f.ref("engagement"),
    title: f.text("Rider title.", "Technical Rider 2026"),
    document_id: f.ref("source document").nullable(),
  },
});

export const RiderLine = defineResource({
  name: "RiderLine",
  table: "app.rider_lines",
  description: "A rider line, reconciled against capabilities.",
  immutable: ["rider_id"],
  fields: {
    rider_id: f.ref("rider"),
    urid: c.UridAtAnyGrain.nullable(),
    statement: f.longText("What the rider asks for.", "Two wedge monitors per vocalist."),
    quantity: f.quantity("Quantity.", 2).nullable(),
    requirement_id: f.ref("requirement created from the line").nullable(),
  },
});

// Hospitality

export const Fulfillment = defineResource({
  name: "Fulfillment",
  table: "app.fulfillments",
  description: "A lodging, catering, travel or amenity fulfillment.",
  immutable: ["project_id"],
  serverSet: ["fulfillment_state"],
  fields: {
    project_id: f.ref("project"),
    kind: FulfillmentKind,
    engagement_id: f.ref("engagement served").nullable(),
    title: f.text("Fulfillment title.", "Headliner Hotel Block"),
    fulfillment_state: f.stateLabel("Fulfillment state.", "Committed"),
    starts_at: f.instant("Service start.").nullable(),
    ends_at: f.instant("Service end.").nullable(),
  },
});

export const FulfillmentLine = defineResource({
  name: "FulfillmentLine",
  table: "app.fulfillment_lines",
  description: "A line of a fulfillment.",
  immutable: ["fulfillment_id"],
  fields: {
    fulfillment_id: f.ref("fulfillment"),
    description: f.text("Line description.", "King room, 3 nights"),
    quantity: f.quantity("Quantity.", 4),
    unit: c.UnitCode,
    unit_price_minor: f.money("Unit price.", 32900),
    currency: f.currency(),
  },
});

export const Beo = defineResource({
  name: "Beo",
  table: "app.beos",
  description: "A banquet event order.",
  immutable: ["project_id"],
  fields: {
    project_id: f.ref("project"),
    fulfillment_id: f.ref("catering fulfillment").nullable(),
    title: f.text("BEO title.", "Crew Lunch Saturday"),
    service_at: f.instant("Service time."),
    guest_count: f.int("Guaranteed count.", 140),
  },
});

export const BeoLine = defineResource({
  name: "BeoLine",
  table: "app.beo_lines",
  description: "A line of a banquet event order.",
  immutable: ["beo_id"],
  fields: {
    beo_id: f.ref("BEO"),
    description: f.text("Menu item or service.", "Grilled vegetable wraps"),
    quantity: f.quantity("Quantity.", 140),
    unit_price_minor: f.money("Unit price.", 1450),
    currency: f.currency(),
  },
});

// Assets

export const AssetClass = defineResource({
  name: "AssetClass",
  table: "app.asset_classes",
  description: "An asset class bound to a catalog element (class grain).",
  fields: {
    name: f.text("Asset class name.", "Truss Section 10 ft"),
    element_id: c.ItemId.nullable(),
    urid: c.Urid,
  },
});

export const AssetUnit = defineResource({
  name: "AssetUnit",
  table: "app.asset_units",
  description:
    "An individual asset tracked by serial or asset tag (unit grain), with a nine-value lifecycle.",
  immutable: ["asset_class_id"],
  serverSet: ["asset_state"],
  fields: {
    asset_class_id: f.ref("asset class"),
    asset_tag: f.code("Asset tag (a code that is ours).", "NWL-TR-0042"),
    serial_number: f.code("Manufacturer serial (an identifier).", "SN-88231").nullable(),
    asset_state: f.stateLabel("Asset lifecycle state.", "Active"),
  },
});

export const AssetLot = defineResource({
  name: "AssetLot",
  table: "app.asset_lots",
  description: "A quantity of an asset class at a place (lot grain).",
  immutable: ["asset_class_id"],
  fields: {
    asset_class_id: f.ref("asset class"),
    venue_id: f.ref("venue").nullable(),
    quantity: f.quantity("Quantity on hand.", 36),
  },
});

export const AssetIdentifier = defineResource({
  name: "AssetIdentifier",
  table: "app.asset_identifiers",
  description:
    "An external identifier recorded against an asset unit, such as a GTIN or an NFC tag.",
  immutable: ["asset_unit_id"],
  fields: {
    asset_unit_id: f.ref("asset unit"),
    identifier_class: f.code("Identifier class.", "gtin"),
    value: f.code("Identifier value.", "00012345678905"),
  },
});

export const AssetCustody = defineResource({
  name: "AssetCustody",
  table: "app.asset_custody",
  description: "An append-only custody ledger entry.",
  immutable: ["asset_unit_id"],
  serverSet: ["recorded_at"],
  fields: {
    asset_unit_id: f.ref("asset unit"),
    custodian_person_id: f.ref("custodian person").nullable(),
    custodian_organization_id: f.ref("custodian organization").nullable(),
    location_venue_id: f.ref("venue").nullable(),
    recorded_at: f.instant("When custody changed."),
  },
});

export const AssetMaintenance = defineResource({
  name: "AssetMaintenance",
  table: "app.asset_maintenance",
  description: "A maintenance event for an asset unit.",
  immutable: ["asset_unit_id"],
  fields: {
    asset_unit_id: f.ref("asset unit"),
    performed_on: f.date("When the maintenance was done."),
    description: f.longText("What was done.", "Replaced the spigots."),
    cost_minor: f.money("Maintenance cost.", 12000),
    currency: f.currency(),
  },
});

export const AssetDamage = defineResource({
  name: "AssetDamage",
  table: "app.asset_damage",
  description: "A damage report for an asset unit.",
  immutable: ["asset_unit_id"],
  fields: {
    asset_unit_id: f.ref("asset unit"),
    reported_at: f.instant("When the damage was reported."),
    description: f.longText("What is damaged.", "Bent chord on one end."),
    engagement_id: f.ref("responsible engagement").nullable(),
  },
});

/** A list of codes in a request, used by scan endpoints. */
export const ScanRequest = z
  .object({
    code: z
      .string()
      .min(1)
      .meta({ description: "Scanned barcode, QR or NFC payload.", example: "NWL-TR-0042" }),
    symbology: z
      .string()
      .min(1)
      .meta({ description: "Symbology of the scan.", example: "code128" }),
  })
  .meta({ id: "ScanRequest", description: "A scanned code." });
