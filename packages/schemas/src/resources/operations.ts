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

// Travel, lodging, ground transport and local contacts (B5, ADR 0144). Read-only views; writes go through Atlas.

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const word = (description: string, example: string) => z.string().meta({ description, example });
const oneOf = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

export const Flight = defineResource({
  name: "Flight",
  table: "app.travel_grid",
  description:
    "A live Flight segment the caller may read, with the traveller's name, the journey it belongs to (legs within 24 hours of the previous landing) and its phase now. Phase and journey are computed on every read; the fare never appears.",
  base: "view",
  key: "id",
  fields: {
    id: f.uuid("Identifier of the travel segment."),
    org_id: f.ref("owning org"),
    project_id: f.ref("project"),
    person_id: f.ref("traveller"),
    traveler_name: nullable(word("Traveller's name, when the caller may know it.", "Kai Morgan")),
    engagement_id: nullable(f.ref("engagement travelled under")),
    fulfillment_id: nullable(f.ref("Travel fulfillment")),
    operator_name: nullable(word("Airline.", "Northwind Air")),
    service_identifier: nullable(f.code("Flight number.", "NW101")),
    confirmation_identifier: nullable(f.code("Booking confirmation code.", "QX7Y2B")),
    departs_from: word("Departure airport.", "LHR"),
    departs_at: f.instant("Departure instant."),
    departs_time_zone: f.timeZone("IANA zone of the departure time."),
    arrives_at_place: word("Arrival airport.", "MIA"),
    arrives_at: nullable(f.instant("Arrival instant, when known.")),
    arrives_time_zone: f.timeZone("IANA zone of the arrival time."),
    phase: oneOf(
      ["Upcoming", "In Flight", "Departed", "Landed"],
      "Phase now: Upcoming, In Flight, Departed (no arrival time) or Landed.",
    ),
    journey_id: f.uuid("First leg of the journey."),
    leg_number: f.int("Position in the journey, from 1.", 1, 1),
    leg_count: f.int("Legs in the journey.", 2, 1),
    final_arrival_at: nullable(f.instant("Arrival of the journey's last leg.")),
    final_arrival_place: nullable(word("Arrival place of the journey's last leg.", "MIA")),
    final_arrival_time_zone: nullable(f.timeZone("IANA zone of the last arrival.")),
  },
});

export const Transfer = defineResource({
  name: "Transfer",
  table: "app.transfer_board",
  description:
    "A live ground transfer with its vehicle, driver, passengers, the flight it meets, warnings and status, computed on every read. The drop-off time is the planner's estimate; no drive time is computed.",
  base: "view",
  key: "id",
  fields: {
    id: f.uuid("Identifier of the transfer."),
    org_id: f.ref("owning org"),
    project_id: f.ref("project"),
    transfer_number: f.int("Number within the project.", 3, 1),
    transfer_key: nullable(f.code("Display key {project_key}-{transfer_number}.", "NWL-3")),
    fulfillment_id: nullable(f.ref("Travel fulfillment")),
    vehicle_id: nullable(f.ref("vehicle")),
    vehicle_label: nullable(word("Vehicle label.", "Van 1")),
    vehicle_type: nullable(
      oneOf(["Sedan", "SUV", "Van", "Sprinter", "Minibus", "Coach", "Other"], "Vehicle type."),
    ),
    seats: nullable(f.int("Passenger seats; the driver is not counted.", 7, 1)),
    driver_person_id: nullable(f.ref("driver")),
    driver_name: nullable(word("Driver's name.", "Dave Lindqvist")),
    pickup_place: word("Pickup place.", "Miami International Airport (MIA)"),
    pickup_at: f.instant("Pickup instant."),
    pickup_time_zone: f.timeZone("IANA zone of the pickup time."),
    dropoff_place: word("Drop-off place.", "Crew Hotel"),
    dropoff_at: f.instant("Drop-off instant, the planner's estimate."),
    dropoff_time_zone: f.timeZone("IANA zone of the drop-off time."),
    meets_travel_segment_id: nullable(f.ref("flight the pickup meets")),
    meets_service_identifier: nullable(f.code("Flight number of the met flight.", "NW101")),
    meets_flight_arrives_at: nullable(f.instant("Arrival of the met flight.")),
    meets_flight_after_pickup: f.bool("The met flight lands after the pickup time.", false),
    passenger_count: f.int("Live passengers.", 2),
    primary_passenger_id: nullable(f.ref("primary passenger")),
    primary_passenger_name: nullable(word("Primary passenger's name.", "Kai Morgan")),
    tight_turnaround: f.bool(
      "The driver's previous drop-off plus the turnaround is after this pickup.",
      false,
    ),
    status: oneOf(["Unassigned", "Assigned", "Underway", "Done"], "Status now."),
    notes: nullable(word("Notes for the desk.", "Meet at door 4.")),
  },
});

export const TransferVehicle = defineResource({
  name: "TransferVehicle",
  table: "app.transfer_vehicles",
  description: "A vehicle a project's ground transfers run in. No plate is stored.",
  base: "view",
  key: "id",
  fields: {
    id: f.uuid("Identifier of the vehicle."),
    org_id: f.ref("owning org"),
    project_id: f.ref("project"),
    counterparty_id: nullable(f.ref("car service")),
    label: word("Label the desk and drivers know it by.", "Van 1"),
    vehicle_type: oneOf(
      ["Sedan", "SUV", "Van", "Sprinter", "Minibus", "Coach", "Other"],
      "Vehicle type.",
    ),
    seats: f.int("Passenger seats; the driver is not counted.", 7, 1),
  },
});

export const SpaceBooking = defineResource({
  name: "SpaceBooking",
  table: "app.space_booking_board",
  description:
    "A live green room, dressing room or other space booking with its space, act and set time, the cluster of overlapping bookings it belongs to, the peak party against capacity and whether the set moved, computed on every read.",
  base: "view",
  key: "id",
  fields: {
    id: f.uuid("Identifier of the booking."),
    org_id: f.ref("owning org"),
    project_id: f.ref("project"),
    space_id: f.ref("space"),
    space_name: nullable(word("Space name.", "Green Room A")),
    space_capacity: nullable(f.int("Occupant capacity of the space.", 10, 1)),
    venue_name: nullable(word("Venue name.", "Northwind Pier Pavilion")),
    engagement_id: nullable(f.ref("engagement")),
    engagement_cue_id: nullable(f.ref("set time")),
    purpose: oneOf(
      ["Green Room", "Dressing Room", "Production Office", "Hospitality Suite", "Other"],
      "What the space is booked as.",
    ),
    booking_mode: oneOf(
      ["Exclusive", "Shared"],
      "Exclusive holds the space alone; Shared bookings may overlap.",
    ),
    party_size: nullable(f.int("People expected.", 6, 1)),
    starts_at: f.instant("In."),
    ends_at: f.instant("Out."),
    act_name: nullable(word("Act the space is for.", "Arturo Bell")),
    set_label: nullable(word("Set time label.", "Arturo Bell set")),
    set_planned_at: nullable(f.instant("Planned start of the set.")),
    set_moved: f.bool("The set's planned time falls outside the booking.", false),
    conflict_group: nullable(f.ref("first booking of the overlapping cluster")),
    group_size: f.int("Bookings in the cluster.", 1, 1),
    group_peak_party: f.int("Peak party at one instant in the cluster.", 6),
    over_capacity: nullable(f.bool("The peak party exceeds the space's capacity.", false)),
  },
});

export const LocalContact = defineResource({
  name: "LocalContact",
  table: "app.project_local_contacts",
  description:
    "A local contact listed for a project: its own rows and its venue's. A member contact shows the member's current name and directory work phone, read live.",
  base: "view",
  key: "id",
  fields: {
    id: f.uuid("Identifier of the local contact."),
    org_id: f.ref("owning org"),
    project_id: f.ref("project the row is listed for"),
    venue_id: nullable(f.ref("venue of a venue contact")),
    day: nullable(f.date("Project day the contact serves; null for every day.")),
    contact_role: oneOf(
      [
        "Promoter",
        "Venue",
        "Production",
        "Security",
        "Transport",
        "Hospitality",
        "Medical",
        "Other",
      ],
      "What the contact is called for.",
    ),
    contact_title: nullable(word("Title or job.", "Production Manager")),
    source: oneOf(["Member", "Contact"], "Member (read live) or Contact (typed)."),
    display_name: nullable(word("Name.", "Pier Pavilion Desk")),
    organization_name: nullable(word("Organization.", "Northwind Pier Pavilion")),
    phone: nullable(word("Phone, E.164 for a typed contact.", "+13055550100")),
    email: nullable(f.email("Business email of a typed contact.")),
    audience: oneOf(
      ["Internal", "Shared"],
      "Internal stays inside the org; Shared also reaches the people engaged or rostered on the project.",
    ),
    member_active: f.bool("False once a member contact's membership has ended.", true),
  },
});

export const AccommodationNight = defineResource({
  name: "AccommodationNight",
  table: "app.accommodation_block_nights",
  description:
    "One night of a live accommodation block: rooms held, assigned to live stays and free, computed on read with the same count as the block's occupancy guard.",
  base: "view",
  fields: {
    block_id: f.ref("accommodation block"),
    org_id: f.ref("owning org"),
    project_id: f.ref("project"),
    block_number: f.int("Number of the block within the project.", 6, 1),
    title: word("Block name.", "Harborview Crew Block"),
    night: f.date("Night held."),
    rooms_held: f.int("Rooms held each night.", 10, 1),
    assigned: f.int("Rooms assigned on the night.", 4),
    free: f.int("Rooms free on the night.", 6),
    release_on: nullable(f.date("Release date.")),
    nightly_rate_minor: nullable(f.money("Nightly rate in minor units; null is unpriced.", 18900)),
    currency_code: nullable(f.currency("ISO 4217 currency of the rate.")),
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
