/**
 * Travel, lodging, ground transport and local contacts (B5 2940 to 2946; ADR 0144). Read-only resources over the
 * computed views: the flight grid (app.travel_grid, Flight rows only), the transfer board and vehicles, the space
 * booking board, a project's local contacts and the blocks by night, with two collection queries for the acts without
 * rooms and the rooming list. Writes are made in Atlas through @xos/data, as blocks are today. catalog/modules/
 * hospitality.ts spreads these into the Hospitality additions.
 *
 * Every capability below is the one the view's policies or the RPC require, so the API never gates more strictly
 * than the database: hospitality.fulfillment.read for every hospitality resource and both queries, and
 * show.run_of_show.read for local contacts. The rooming list logs every person it returns.
 */
import { z } from "@hono/zod-openapi";
import { fields, operations } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { orNull } from "../../correct.ts";
import { collectionQuery, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const projectQuery = z.object({
  project_id: z
    .uuid()
    .meta({ description: "Project whose rooms are read.", example: fields.EXAMPLE_UUID }),
});

const ActWithoutRoom = z
  .object({
    engagement_id: fields.uuid("Artist engagement."),
    act_name: orNull(z.string().meta({ description: "Supplying account, else the artist.", example: "Arturo Bell" })),
    engagement_state: z.string().meta({ description: "Engagement state.", example: "Onboarding" }),
    people_count: z.int().meta({ description: "People of the act: the artist and live roster people.", example: 3 }),
  })
  .meta({
    id: "ActWithoutRoom",
    description:
      "An Artist engagement of the project in Onboarding to Closing with Lodging offered, none of whose people holds a live room on the project's blocks (B5, G-66).",
  });

const Stay = z
  .object({
    check_in_on: fields.date("First night."),
    check_out_on: fields.date("Departure day."),
    source: z.enum(["Credentials", "Travel"]).meta({
      description: "Credentials (access days, for credentials.credential.read holders) or Travel (the travel request dates).",
      example: "Credentials",
    }),
  })
  .meta({ id: "SuggestedStay", description: "A stay suggested from access days or travel dates; never stored." });

const AssignedStay = z
  .object({
    assignment_id: fields.uuid("Room assignment."),
    block_id: fields.uuid("Accommodation block."),
    block_title: orNull(z.string().meta({ description: "Block name.", example: "Harborview Crew Block" })),
    check_in_on: fields.date("First night."),
    check_out_on: fields.date("Departure day."),
    allocation_id: orNull(fields.uuid("Allocation the room was issued under.")),
  })
  .meta({ id: "AssignedStay", description: "A live room assignment on one of the project's blocks." });

const RoomingCost = z
  .object({
    currency_code: orNull(fields.currency("Currency of the blocks; null for unpriced blocks.")),
    nights: z.int().meta({ description: "Assigned nights.", example: 3 }),
    amount_minor: orNull(fields.money("Nights times the nightly rate; null when a block is unpriced.", 56700)),
  })
  .meta({ id: "RoomingCost", description: "The cost of a person's assigned nights in one currency." });

const RoomingEntry = z
  .object({
    roster_entry_id: fields.uuid("Roster entry."),
    engagement_id: fields.uuid("Engagement."),
    party_name: orNull(z.string().meta({ description: "Supplying account, else the engaged person.", example: "Bayside Audio" })),
    person_id: fields.uuid("Person."),
    person_name: orNull(z.string().meta({ description: "Person's name.", example: "Kai Morgan" })),
    role_code: orNull(fields.code("Role worked.", "9000.50.02")),
    suggested_stays: z.array(Stay),
    assigned_stays: z.array(AssignedStay),
    uncovered_nights: z.int().meta({ description: "Suggested nights no assignment covers.", example: 2 }),
    status: z.enum(["Covered", "Partial", "Missing", "No Dates"]).meta({ description: "Rooming status.", example: "Partial" }),
    cost: z.array(RoomingCost),
    lodging_allocation_id: orNull(fields.uuid("An Approved block allocation of the entry not yet fully issued.")),
  })
  .meta({
    id: "RoomingEntry",
    description:
      "A person of the travel party who needs a room (B5, G-67): suggested stays, assigned stays, what is uncovered and what it costs. Each one returned is logged as a read of the person's travel request.",
  });

export const groundTransportResources: readonly ResourceSpec[] = [
  resource("Hospitality", "/flights", operations.Flight, {
    verbs: ["list", "get"],
    order: { by: ["departs_at", "id"], numeric: false },
  }),
  resource("Hospitality", "/transfers", operations.Transfer, {
    verbs: ["list", "get"],
    order: { by: ["pickup_at", "id"], numeric: false },
  }),
  resource("Hospitality", "/transfer-vehicles", operations.TransferVehicle, {
    verbs: ["list", "get"],
    order: { by: ["label", "id"], numeric: false },
  }),
  resource("Hospitality", "/space-bookings", operations.SpaceBooking, {
    verbs: ["list", "get"],
    order: { by: ["starts_at", "id"], numeric: false },
  }),
  resource("Hospitality", "/local-contacts", operations.LocalContact, {
    verbs: ["list"],
    order: { by: ["project_id", "id"], numeric: false },
  }),
  resource("Hospitality", "/accommodation-nights", operations.AccommodationNight, {
    verbs: ["list"],
    order: { by: ["block_id", "night"], numeric: false },
    actions: [
      collectionQuery("actsWithoutRooms", {
        summary: "List the acts without rooms",
        description:
          "Artist engagements of the project in Onboarding to Closing with Lodging offered none of whose people (the artist and live, not-declined roster people) holds a live room on the project's blocks, through `app.acts_without_rooms`. Needs hospitality.fulfillment.read on the project (404 otherwise). Reads no project fact.",
        rpc: "app.acts_without_rooms",
        query: projectQuery,
        paged: true,
        response: ActWithoutRoom,
      }),
      collectionQuery("roomingList", {
        summary: "Read a project's rooming list",
        description:
          "The travel party members whose travel request needs lodging and whose engagement offers Lodging, with suggested stays (credential access days for credentials.credential.read holders, else the travel dates), assigned stays, uncovered nights, status and cost, through `app.rooming_list`. Needs hospitality.fulfillment.read on the project (404 otherwise). Every person returned is logged as a read of their travel request.",
        rpc: "app.rooming_list",
        query: projectQuery,
        paged: true,
        response: RoomingEntry,
      }),
    ],
  }),
];

export const groundTransportCapabilities: Readonly<Record<string, CapabilityRule>> = {
  flights: { read: "hospitality.fulfillment.read" },
  transfers: { read: "hospitality.fulfillment.read" },
  transferVehicles: { read: "hospitality.fulfillment.read" },
  spaceBookings: { read: "hospitality.fulfillment.read" },
  // A rule holds one code, and an API key is gated by its capability group: the project read of a day sheet. The
  // view's policy also admits places.venue.read holders for venue rows, which they read in Atlas.
  localContacts: { read: "show.run_of_show.read" },
  accommodationNights: {
    read: "hospitality.fulfillment.read",
    actions: {
      actsWithoutRooms: "hospitality.fulfillment.read",
      roomingList: "hospitality.fulfillment.read",
    },
  },
};
