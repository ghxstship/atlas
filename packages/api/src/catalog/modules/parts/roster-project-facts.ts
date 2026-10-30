/**
 * Crew roster entries and their project facts (R4 2633 to 2637, R5 2650 to 2657; ADR 0101 and 0102). The producing
 * org's read of roster entries with their people (app.roster_entry_people), the per-project facts a rostered person
 * enters on their entry (travel request, uniform sizes, vehicle), and the travel party of a project with its daily
 * counts. catalog/modules/advancing.ts spreads these into the Advancing additions.
 *
 * Every fact read and write goes through the database: app.roster_project_facts decides the caller's standing
 * (the person, the company that rosters them, a producer by capability) and logs every read of a value by anyone
 * other than the person. The capabilities below gate API keys by group; the RPCs decide everything else.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { orNull } from "../../correct.ts";
import { collectionQuery, itemAction, itemQuery, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const label = (id: string, values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ id, description, example: values[0] });

export const ProjectFactKind = label(
  "ProjectFactKind",
  ["Travel", "Uniform", "Vehicle"],
  "A kind of project fact a rostered person enters on their roster entry, asked only while its offering (Travel, Uniforms, Parking) is on.",
);
const ShoeSizeSystem = label(
  "ShoeSizeSystem",
  ["US Men", "US Women", "EU", "UK"],
  "Sizing system of a shoe size.",
);
const RosterEntryState = label(
  "RosterEntryState",
  ["Draft", "Submitted", "Accepted", "Returned", "Withdrawn"],
  "Review state of a roster entry.",
);
const RosterPersonResponse = label(
  "RosterPersonResponse",
  ["Pending", "Accepted", "Declined"],
  "The rostered person's own answer.",
);
const garment = () =>
  orNull(
    z
      .enum(["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"])
      .meta({ description: "Letter size.", example: "M" }),
  );
const seat = () =>
  orNull(
    z
      .enum(["Window", "Aisle", "No Preference"])
      .meta({ description: "Preferred seat.", example: "Aisle" }),
  );
const airportCode = (description: string) =>
  orNull(
    z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .meta({ description, example: "MIA" }),
  );
const str = (description: string, example: string) => z.string().meta({ description, example });
const flag = (description: string) => fields.bool(description, true);
const kinds = (description: string) =>
  z.object({
    travel: flag(`${description} Travel.`),
    uniform: flag(`${description} Uniform.`),
    vehicle: flag(`${description} Vehicle.`),
  });

const RosterEntry = defineResource({
  name: "RosterEntry",
  table: "app.roster_entry_people",
  description:
    "A person on an engagement's crew roster (Section 4.5.8, ADR 0101), as the producing org reads it on projects where the caller holds advancing.packet.read: the party, the resolved person (the engaged person for the self entry), a pending invitation's address, the role and arrival, the review state with the latest return reason, the person's own answer and the categories of their live work details share. Roster entries are written through Gateway and the roster RPCs.",
  base: "view",
  key: "id",
  fields: {
    id: fields.uuid("Identifier of the roster entry."),
    org_id: fields.ref("producing org"),
    project_id: fields.ref("project"),
    engagement_id: fields.ref("engagement the person works under"),
    party_name: orNull(str("Supplying account, else the engaged person.", "Bayside Audio")),
    role_type: str("External role type of the engagement.", "Vendor"),
    is_self: fields.bool("True for the engaged person's own entry.", false),
    person_id: orNull(fields.ref("resolved person; null for an unclaimed invitation")),
    full_name: orNull(str("Name of the person.", "Kai Morgan")),
    invited_email: orNull(str("Address of the pending invitation.", "kai@example.com")),
    invitation_expires_at: orNull(fields.instant("When the pending invitation lapses.")),
    role_code: orNull(fields.code("Role worked, from the Roles Library.", "9000.50.02")),
    job_title: orNull(str("Job title of the role.", "Audio Technician")),
    arrival_starts_at: orNull(fields.instant("Arrival window start.")),
    arrival_ends_at: orNull(fields.instant("Arrival window end.")),
    arrival_time_zone: orNull(fields.timeZone("IANA time zone of the arrival window.")),
    entry_state: RosterEntryState,
    person_response: RosterPersonResponse,
    responded_at: orNull(fields.instant("When the person last answered.")),
    return_reason: orNull(
      str("What the reviewer asked to change, while Returned.", "Add the arrival."),
    ),
    replaces_entry_id: orNull(fields.ref("withdrawn entry this one replaces")),
    share_categories: z
      .array(z.string())
      .meta({
        description: "Work details categories the person shares on this entry.",
        example: ["Uniform Sizes"],
      }),
  },
});

const TravelValue = z
  .object({
    id: fields.uuid("Identifier of the travel request."),
    inbound_airport_code: airportCode("IATA code of the airport the person flies into."),
    inbound_airport_name: orNull(str("Name of that airport.", "Miami International Airport")),
    outbound_airport_code: airportCode("IATA code of the airport the person flies home from."),
    outbound_airport_name: orNull(str("Name of that airport.", "Miami International Airport")),
    inbound_on: orNull(fields.date("Day the person travels to the project.")),
    outbound_on: orNull(fields.date("Day the person travels home.")),
    seat_preference: seat(),
    meal_preference: orNull(str("Meal preference.", "Vegetarian")),
    needs_ground_transport: fields.bool("The person needs a pickup on arrival.", true),
    needs_lodging: fields.bool("The person needs a room.", false),
    travel_notes: orNull(str("Notes for the travel desk.", "Arriving with a guitar case.")),
    updated_at: fields.instant("When the request was last saved."),
  })
  .meta({
    id: "RosterTravelRequest",
    description: "The travel a rostered person asks for on one project (R5).",
  });

const UniformValue = z
  .object({
    id: fields.uuid("Identifier of the uniform sizes."),
    shirt_size: garment(),
    jacket_size: garment(),
    pants_size: garment(),
    glove_size: garment(),
    hat_size: garment(),
    pants_waist_in: orNull(
      z.int().min(20).max(70).meta({ description: "Pants waist in inches.", example: 32 }),
    ),
    pants_inseam_in: orNull(
      z.int().min(20).max(40).meta({ description: "Pants inseam in inches.", example: 32 }),
    ),
    shoe_size: orNull(
      z.number().min(1).max(20).meta({ description: "Shoe size in half sizes.", example: 10.5 }),
    ),
    shoe_size_system: orNull(ShoeSizeSystem),
    updated_at: fields.instant("When the sizes were last saved."),
  })
  .meta({
    id: "RosterUniformSizes",
    description: "The uniform sizes a rostered person gives for one project (R5).",
  });

const VehicleValue = z
  .object({
    id: fields.uuid("Identifier of the vehicle."),
    make: str("Vehicle make.", "Ford"),
    model: str("Vehicle model.", "Transit"),
    color: orNull(str("Vehicle color.", "White")),
    plate: str("License plate, letters and digits.", "ABC1234"),
    plate_region: str("ISO 3166-2 region that issued the plate.", "US-FL"),
    updated_at: fields.instant("When the vehicle was last saved."),
  })
  .meta({
    id: "RosterVehicle",
    description: "The vehicle a rostered person brings to one project (R5).",
  });

const RosterProjectFacts = z
  .object({
    roster_entry_id: fields.uuid("Roster entry."),
    engagement_id: fields.uuid("Engagement."),
    org_id: fields.uuid("Producing org."),
    person_id: orNull(fields.uuid("Person the entry resolves to.")),
    standing: z.enum(["Person", "Company", "Producer"]).meta({
      description:
        "Who reads: Person, the entry's own person; Company, a roster manager of the account that rosters them; Producer, a member of the producing org by capability.",
      example: "Producer",
    }),
    offered: z
      .object({
        travel: flag("Travel is offered."),
        lodging: flag("Lodging is offered."),
        uniforms: flag("Uniforms are offered."),
        parking: flag("Parking is offered."),
      })
      .meta({
        id: "RosterFactOfferings",
        description: "Which offerings the project turns on for the engagement.",
      }),
    present: kinds("A live row exists for").meta({
      id: "RosterFactPresence",
      description: "Which kinds are on file.",
    }),
    entered_by_person: kinds("The person entered").meta({
      id: "RosterFactProvenance",
      description:
        "Which kinds the person entered themselves; the others were entered by their company.",
    }),
    readable: z.array(ProjectFactKind).meta({
      description: "Kinds the caller reads; the others come back null.",
      example: ["Travel"],
    }),
    travel: orNull(TravelValue),
    uniform: orNull(UniformValue),
    vehicle: orNull(VehicleValue),
  })
  .meta({
    id: "RosterProjectFacts",
    description:
      "The project facts of a roster entry as the caller may read them (R5). Each Company or Producer read of a value is written to the person's access log, and a Producer read to the producing org's audit ledger.",
  });

const RosterTravelRequestInput = z
  .object({
    inbound_airport_code: airportCode(
      "IATA code of the airport the person flies into; uppercased.",
    ),
    outbound_airport_code: airportCode(
      "IATA code of the airport the person flies home from; uppercased.",
    ),
    inbound_on: orNull(fields.date("Day the person travels to the project.")),
    outbound_on: orNull(fields.date("Day the person travels home; on or after inbound_on.")),
    seat_preference: seat().optional(),
    meal_preference: orNull(
      z.string().max(100).meta({ description: "Meal preference.", example: "Vegetarian" }),
    ).optional(),
    needs_ground_transport: z
      .boolean()
      .optional()
      .meta({ description: "A pickup is needed on arrival.", example: true }),
    needs_lodging: z
      .boolean()
      .optional()
      .meta({ description: "A room is needed; only while lodging is offered.", example: false }),
    travel_notes: orNull(
      z.string().max(500).meta({ description: "Notes for the travel desk.", example: "Two bags." }),
    ).optional(),
  })
  .meta({
    id: "RosterTravelRequestInput",
    description:
      "A full replacement of a roster entry's travel request. At least an airport or a date.",
  });

const RosterUniformSizesInput = z
  .object({
    shirt_size: garment().optional(),
    jacket_size: garment().optional(),
    pants_size: garment().optional(),
    glove_size: garment().optional(),
    hat_size: garment().optional(),
    pants_waist_in: orNull(
      z.int().meta({ description: "Waist in inches, 20 to 70.", example: 32 }),
    ).optional(),
    pants_inseam_in: orNull(
      z.int().meta({ description: "Inseam in inches, 20 to 40.", example: 32 }),
    ).optional(),
    shoe_size: orNull(
      z.number().meta({ description: "Shoe size, 1 to 20 in half sizes.", example: 10.5 }),
    ).optional(),
    shoe_size_system: orNull(ShoeSizeSystem).optional(),
  })
  .meta({
    id: "RosterUniformSizesInput",
    description: "A full replacement of a roster entry's uniform sizes. At least one size.",
  });

const RosterVehicleInput = z
  .object({
    make: z.string().min(1).max(60).meta({ description: "Vehicle make.", example: "Ford" }),
    model: z.string().min(1).max(60).meta({ description: "Vehicle model.", example: "Transit" }),
    color: orNull(
      z.string().max(30).meta({ description: "Vehicle color.", example: "White" }),
    ).optional(),
    plate: z.string().min(1).max(20).meta({
      description: "License plate; uppercased with spaces and hyphens removed.",
      example: "ABC 1234",
    }),
    plate_region: z
      .string()
      .min(2)
      .max(6)
      .meta({ description: "ISO 3166-2 region of the plate.", example: "US-FL" }),
  })
  .meta({
    id: "RosterVehicleInput",
    description: "A full replacement of a roster entry's vehicle.",
  });

const ClearProjectFactRequest = z
  .object({ kind: ProjectFactKind })
  .meta({ id: "ClearProjectFactRequest", description: "The project fact kind to clear." });

const SavedProjectFact = z
  .object({ id: fields.uuid("Identifier of the saved row.") })
  .meta({ id: "SavedProjectFact", description: "The live row a project fact save wrote." });

const projectQuery = z.object({
  project_id: z
    .uuid()
    .meta({ description: "Project whose travel party is read.", example: fields.EXAMPLE_UUID }),
});

const TravelPartyMember = z
  .object({
    roster_entry_id: fields.uuid("Roster entry."),
    engagement_id: fields.uuid("Engagement."),
    party_name: orNull(str("Supplying account, else the engaged person.", "Bayside Audio")),
    person_id: fields.uuid("Person."),
    person_name: orNull(str("Name of the person.", "Kai Morgan")),
    role_code: orNull(fields.code("Role worked.", "9000.50.02")),
    arrival_starts_at: orNull(fields.instant("Arrival window start.")),
    arrival_ends_at: orNull(fields.instant("Arrival window end.")),
    arrival_time_zone: orNull(fields.timeZone("IANA time zone of the arrival window.")),
    travel: orNull(TravelValue),
    room: z
      .object({
        assigned: fields.bool("A room is assigned on one of the project's blocks.", false),
        check_in_on: orNull(fields.date("Check-in day.")),
        check_out_on: orNull(fields.date("Check-out day.")),
        block_name: orNull(str("Title of the block.", "Hotel Cadillac")),
      })
      .meta({
        id: "TravelPartyRoom",
        description: "The person's room on the project, if assigned.",
      }),
    pickup: z
      .object({ booked: fields.bool("A ground segment is booked on the arrival day.", false) })
      .meta({ id: "TravelPartyPickup", description: "Whether the person's pickup is booked." }),
    pass: orNull(
      z
        .object({ issued: fields.bool("A live credential is issued on the engagement.", false) })
        .meta({
          id: "TravelPartyPass",
          description:
            "Whether the person's pass is issued; null without credentials.credential.read.",
        }),
    ),
  })
  .meta({
    id: "TravelPartyMember",
    description:
      "A rostered person of a project's travel party with what hospitality has arranged (R5, G-175).",
  });

const TravelDayCount = z
  .object({
    day: fields.date("Day."),
    arriving: z.int().meta({ description: "People arriving.", example: 1 }),
    departing: z.int().meta({ description: "People departing.", example: 0 }),
    on_site: z.int().meta({ description: "People on site, arrival to departure day.", example: 1 }),
    rooms_needed: z.int().meta({ description: "Rooms needed that night.", example: 1 }),
    pickups_needed: z.int().meta({ description: "Pickups needed that day.", example: 1 }),
    truncated: fields.bool("The range ran past 120 days and was cut.", false),
  })
  .meta({ id: "TravelDayCount", description: "One day of a project's travel counts (R5, G-175)." });

const SAVE_REFUSALS =
  "Refusals answer 422 with the rule: project_fact_not_yours, roster_entry_withdrawn, roster_entry_declined, project_fact_closed, org_read_only, offering_not_offered, project_fact_company_write_off and project_fact_person_entered";

export const rosterEntryResources: readonly ResourceSpec[] = [
  resource("Advancing", "/roster-entries", RosterEntry, {
    verbs: ["list", "get"],
    order: { by: ["engagement_id", "id"], numeric: false },
    actions: [
      itemQuery("projectFacts", {
        summary: "Read a roster entry's project facts",
        description:
          "The travel request, uniform sizes and vehicle of a roster entry as the caller may read them, through `app.roster_project_facts`. The person and the company that rosters them read every kind; a producer reads the kinds its project capabilities cover (Travel hospitality.fulfillment.read, Uniform opportunities.engagement.read or crew.shift.write, Vehicle credentials.credential.read) on Submitted, Accepted and Returned entries. Every Company or Producer read of a value is logged in the person's access log. 404 without standing.",
        rpc: "app.roster_project_facts",
        response: RosterProjectFacts,
      }),
      itemAction("saveTravelRequest", {
        summary: "Save a roster entry's travel request",
        description: `Replaces the live travel request through \`app.save_roster_travel_request\`. ${SAVE_REFUSALS}, airport_unknown, travel_dates_order, project_fact_empty and project_fact_text_length. A company write notifies the person.`,
        rpc: "app.save_roster_travel_request",
        body: RosterTravelRequestInput,
        response: SavedProjectFact,
      }),
      itemAction("saveUniformSizes", {
        summary: "Save a roster entry's uniform sizes",
        description: `Replaces the live uniform sizes through \`app.save_roster_uniform_sizes\`. ${SAVE_REFUSALS}, project_fact_empty, shoe_size_format, shoe_size_system_required and pants_measure_range. A company write notifies the person.`,
        rpc: "app.save_roster_uniform_sizes",
        body: RosterUniformSizesInput,
        response: SavedProjectFact,
      }),
      itemAction("saveVehicle", {
        summary: "Save a roster entry's vehicle",
        description: `Replaces the live vehicle through \`app.save_roster_vehicle\`. ${SAVE_REFUSALS}, vehicle_fields_required, plate_format, plate_region_format and project_fact_text_length. A company write notifies the person.`,
        rpc: "app.save_roster_vehicle",
        body: RosterVehicleInput,
        response: SavedProjectFact,
      }),
      itemAction("clearProjectFact", {
        summary: "Clear a project fact of a roster entry",
        description:
          "Soft-deletes the live row of one kind through `app.clear_roster_project_fact`. The person clears at any time; the company only rows the person did not enter (422 project_fact_person_entered) while it manages the roster (422 project_fact_not_yours).",
        rpc: "app.clear_roster_project_fact",
        body: ClearProjectFactRequest,
        response: SavedProjectFact.partial().meta({
          id: "ClearedProjectFact",
          description: "Nothing; the kind is cleared.",
        }),
      }),
      collectionQuery("travelParty", {
        summary: "Read a project's travel party",
        description:
          "Every rostered person of the project the producer reads (live entries Submitted, Accepted or Returned on engagements Onboarding to Closing with Travel offered), with their travel request and whether a room is assigned, a pickup booked and a pass issued, through `app.roster_travel_party`. Needs hospitality.fulfillment.read on the project (404 otherwise). Every travel value returned is logged.",
        rpc: "app.roster_travel_party",
        query: projectQuery,
        paged: true,
        response: TravelPartyMember,
      }),
      collectionQuery("travelDayCounts", {
        summary: "Count a project's travel party by day",
        description:
          "Arrivals, departures, people on site, rooms and pickups needed per day from the first arrival to the last departure, at most 120 days, through `app.roster_travel_day_counts`. Needs hospitality.fulfillment.read on the project. Each call is logged.",
        rpc: "app.roster_travel_day_counts",
        query: projectQuery,
        paged: true,
        response: TravelDayCount,
      }),
    ],
  }),
];

export const rosterEntryCapabilities: Readonly<Record<string, CapabilityRule>> = {
  rosterEntries: {
    read: "advancing.packet.read",
    actions: {
      projectFacts: "opportunities.engagement.read",
      saveTravelRequest: "me.work_details.write",
      saveUniformSizes: "me.work_details.write",
      saveVehicle: "me.work_details.write",
      clearProjectFact: "me.work_details.write",
      travelParty: "hospitality.fulfillment.read",
      travelDayCounts: "hospitality.fulfillment.read",
    },
  },
};
