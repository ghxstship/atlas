/**
 * Work Details (A78, migration 1340, Section 4.5.6 item 10): a person's uniform sizes, dietary and
 * accessibility needs, travel profile, emergency contacts and loyalty programs, the per-engagement
 * consent that shares chosen categories with the engaging org, what that org reads, and the
 * person's access log. catalog/modules/identity.ts spreads these into the Identity additions, with
 * the correction that adds the Section 15 given and family names to people.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { editDefinition, editShape, orNull } from "../../correct.ts";
import { itemAction, itemQuery, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const label = (id: string, values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ id, description, example: values[0] });

const Category = label(
  "WorkDetailCategory",
  [
    "Emergency Contacts",
    "Uniform Sizes",
    "Dietary Needs",
    "Accessibility Needs",
    "Travel Profile",
    "Passport",
  ],
  "A category of work details shared with an engaging org on its own. Travel Profile is seat and meal preference, home airport and loyalty programs; Passport is the passport details.",
);
const GarmentSize = label(
  "GarmentLetterSize",
  ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
  "Letter size for a shirt, jacket or gloves.",
);
const DietaryNeed = label(
  "DietaryNeed",
  [
    "Vegetarian",
    "Vegan",
    "Pescatarian",
    "Halal",
    "Kosher",
    "Gluten Free",
    "Dairy Free",
    "Nut Free",
    "Shellfish Free",
  ],
  "A dietary need hospitality caters for.",
);
const AccessibilityNeed = label(
  "AccessibilityNeed",
  [
    "Step-Free Access",
    "Accessible Parking",
    "Accessible Restroom",
    "Seating",
    "Sign Language Interpreter",
    "Captioning",
    "Large Print",
    "Service Animal",
    "Quiet Space",
    "Assistance on Arrival",
  ],
  "An accessibility need the person asks an engaging org to plan for.",
);
const SeatPreference = label(
  "SeatPreference",
  ["Window", "Aisle", "No Preference"],
  "Preferred seat when an org books travel.",
);
const LoyaltyProgramKind = label(
  "LoyaltyProgramKind",
  ["Airline", "Hotel", "Car Rental", "Rail"],
  "Kind of travel loyalty program.",
);

const shortText = (description: string, example: string, max: number) =>
  orNull(fields.text(description, example, max));
const str = (description: string, example: string) => z.string().meta({ description, example });
const airport = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .meta({ description: "IATA airport code.", example: "MIA" });

const WorkDetails = editDefinition(
  defineResource({
    name: "WorkDetails",
    table: "app.person_work_details",
    description:
      "The caller's own work details (Section 4.5.6 item 10): uniform sizes, dietary and accessibility needs and the travel profile. Read and written only by the person; an engaging org sees a category only while the person shares it with that engagement. The passport number is Restricted and encrypted: it is written here, always read masked, and shown only through the logged revealPassport action. One live row per person (409 on a second).",
    base: "global",
    serverSet: ["person_id", "passport_number_last4"],
    restricted: ["passport_number"],
    immutable: ["person_id"],
    fields: {
      person_id: fields.ref("person the work details belong to; always the caller"),
      shirt_size: orNull(GarmentSize),
      jacket_size: orNull(GarmentSize),
      pants_size: shortText("Pants size as the person writes it.", "32x32", 20),
      shoe_size: shortText("Shoe size with its system.", "US 10.5", 20),
      glove_size: orNull(GarmentSize),
      hat_size: shortText("Hat size as the person writes it.", "7 1/4", 20),
      uniform_notes: shortText("Anything else about fit.", "Prefers a relaxed cut.", 500),
      dietary_needs: z
        .array(DietaryNeed)
        .max(9)
        .meta({ description: "Dietary needs, each once, in enum order.", example: ["Vegan"] }),
      allergies: shortText(
        "Allergies in the person's words, with how severe.",
        "Peanuts, severe",
        500,
      ),
      dietary_notes: shortText("Other dietary notes.", "No pork.", 500),
      accessibility_needs: z
        .array(AccessibilityNeed)
        .max(10)
        .meta({
          description: "Accessibility needs, each once, in enum order.",
          example: ["Seating"],
        }),
      accessibility_notes: shortText(
        "Accessibility needs in the person's words.",
        "Needs a seat near the stage door.",
        1000,
      ),
      seat_preference: orNull(SeatPreference),
      meal_preference: shortText("Preferred in-flight meal.", "Vegetarian (VGML)", 100),
      home_airport: orNull(airport),
      passport_number: orNull(
        z.string().min(5).max(30).meta({
          description:
            "Passport number, write-only: letters and digits are kept and encrypted. Send null to clear it.",
          example: "YA0000TEST",
        }),
      ),
      passport_number_last4: orNull(
        fields.code("Last four characters of the passport number.", "TEST"),
      ),
      passport_issuing_country: orNull(fields.countryCode("Country that issued the passport.")),
      passport_expires_on: orNull(fields.date("Day the passport expires.")),
      passport_name: shortText("Name exactly as printed in the passport.", "IVY MARCHETTI", 200),
    },
  }),
  {
    optionalOnCreate: [
      "shirt_size",
      "jacket_size",
      "glove_size",
      "seat_preference",
      "dietary_needs",
      "accessibility_needs",
    ],
  },
);

const EmergencyContact = editDefinition(
  defineResource({
    name: "EmergencyContact",
    table: "app.person_emergency_contacts",
    description:
      "One of the caller's emergency contacts (Section 4.5.6 item 10), in calling order, at most five (422 emergency_contact_limit). Phones are E.164 (Section 15). Shared with an engagement under the Emergency Contacts category.",
    base: "global",
    serverSet: ["person_id"],
    immutable: ["person_id"],
    fields: {
      person_id: fields.ref("person the contact belongs to; always the caller"),
      full_name: fields.text("Contact's name.", "Marco Marchetti", 200),
      relationship: shortText("How the contact relates to the person.", "Brother", 60),
      phone_e164: fields.phone("Contact's phone."),
      alternate_phone_e164: orNull(fields.phone("A second phone.")),
      email: orNull(fields.email("Contact's email address.")),
      sort_order: fields.int("Order to call in, lowest first.", 0),
    },
  }),
  { optionalOnCreate: ["sort_order"] },
);

const LoyaltyProgram = editDefinition(
  defineResource({
    name: "LoyaltyProgram",
    table: "app.person_loyalty_programs",
    description:
      "A travel loyalty program the caller belongs to, at most twenty (422 loyalty_program_limit). A program name appears once per kind (409). Shared with an engagement under the Travel Profile category.",
    base: "global",
    serverSet: ["person_id"],
    immutable: ["person_id"],
    fields: {
      person_id: fields.ref("person the program belongs to; always the caller"),
      program_kind: LoyaltyProgramKind,
      program_name: fields.text("Program.", "SkyMiles", 100),
      member_number: fields.text("Membership number.", "SM-0000-TEST", 40),
      sort_order: fields.int("Display order.", 0),
    },
  }),
  { optionalOnCreate: ["sort_order"] },
);

const WorkDetailShare = editDefinition(
  defineResource({
    name: "WorkDetailShare",
    table: "app.work_detail_shares",
    description:
      "The caller's consent to share chosen categories of their work details with the org that engages them, for one engagement, under a work_details_sharing consent record (Section 14.3). Creating a share for an engagement that already has one replaces its categories; fewer categories is a partial revocation. Revoke ends it at once and withdraws the org's consent with its last share. Shares cannot be made once the engagement is Complete or Canceled (422 work_detail_share_closed). The person and the engaging org read shares; only the person writes them.",
    serverSet: ["person_id", "consent_record_id", "shared_at", "revoked_at"],
    immutable: ["engagement_id"],
    fields: {
      engagement_id: fields.ref("engagement the share serves; the caller must be its person"),
      person_id: fields.ref("person sharing"),
      consent_record_id: fields.ref("work_details_sharing consent record for the org"),
      categories: z
        .array(Category)
        .min(1)
        .max(6)
        .meta({
          description: "Categories shared.",
          example: ["Dietary Needs", "Emergency Contacts"],
        }),
      shared_at: fields.instant("When the share was given."),
      revoked_at: orNull(fields.instant("When the person revoked it; null while it stands.")),
    },
  }),
  { nullable: ["created_by", "updated_by"] },
);

const WorkDetailEvent = defineResource({
  name: "WorkDetailEvent",
  table: "app.work_detail_events",
  description:
    "One entry of a person's work details access log (Section 8.4): a change they made, a share or revocation, or a read or reveal by an engaging org, with the categories and changed column names but never a value. The person reads all of theirs; an org's audit readers read the entries naming their org.",
  base: "view",
  fields: {
    id: fields.uuid("Identifier of the entry."),
    person_id: fields.ref("person whose work details were touched"),
    actor_person_id: orNull(fields.ref("person who acted; null for the database or a service")),
    org_id: orNull(fields.ref("org whose member acted or whose share changed")),
    engagement_id: orNull(fields.ref("engagement of a share, read or reveal")),
    action: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
      .meta({
        description:
          "What happened, as subject.verb: person_work_details.update, work_details.shared, work_details.share_changed, work_details.share_revoked, work_details.viewed, passport.revealed and others.",
        example: "work_details.viewed",
      }),
    categories: z
      .array(Category)
      .meta({ description: "Categories the act covered.", example: ["Dietary Needs"] }),
    changed_columns: z.array(z.string()).meta({
      description: "Columns an owner change touched, never their values.",
      example: ["allergies"],
    }),
    reason: shortText(
      "Reason an org member gave for revealing the passport number.",
      "Booking the June flights.",
      500,
    ),
    created_at: fields.instant("When it happened."),
  },
});

const PassportReveal = z
  .object({
    passport_number: z
      .string()
      .meta({ description: "The passport number in plain text.", example: "YA0000TEST" }),
  })
  .meta({
    id: "PassportReveal",
    description: "A revealed passport number. Each reveal is written to the person's access log.",
  });

const PassportRevealRequest = z
  .object({
    reason: z.string().min(10).max(500).meta({
      description: "Why the number is needed, 10 to 500 characters. Logged with the reveal.",
      example: "Booking the June flights.",
    }),
  })
  .meta({
    id: "PassportRevealRequest",
    description: "Request to reveal a shared passport number.",
  });

const sharedContact = z
  .object({
    full_name: z.string().meta({ description: "Contact's name.", example: "Marco Marchetti" }),
    relationship: orNull(z.string().meta({ description: "Relationship.", example: "Brother" })),
    phone_e164: fields.phone("Contact's phone."),
    alternate_phone_e164: orNull(fields.phone("A second phone.")),
    email: orNull(z.string().meta({ description: "Email address.", example: "marco@example.com" })),
    sort_order: z.int().meta({ description: "Calling order.", example: 0 }),
  })
  .meta({
    id: "SharedEmergencyContact",
    description: "An emergency contact as an engaging org reads it.",
  });

const SharedWorkDetails = z
  .object({
    engagement_id: fields.uuid("Engagement."),
    person_id: orNull(fields.uuid("Person the engagement names.")),
    org_id: fields.uuid("Engaging org."),
    work_detail_share_id: orNull(fields.uuid("Live share; null when none stands.")),
    shared_at: orNull(fields.instant("When the share was given.")),
    sharing_open: fields.bool(
      "The engagement is Onboarding to Closing; a closed engagement reads nothing.",
      true,
    ),
    categories: z
      .array(Category)
      .meta({ description: "Categories the person shared.", example: ["Dietary Needs"] }),
    readable: z.array(Category).meta({
      description:
        "Shared categories the caller's project capabilities cover; the others come back null.",
      example: ["Dietary Needs"],
    }),
    emergency_contacts: orNull(z.array(sharedContact)),
    uniform: orNull(
      z
        .object({
          shirt_size: orNull(GarmentSize),
          jacket_size: orNull(GarmentSize),
          pants_size: orNull(str("Pants size.", "32x32")),
          shoe_size: orNull(str("Shoe size.", "US 10.5")),
          glove_size: orNull(GarmentSize),
          hat_size: orNull(str("Hat size.", "7 1/4")),
          uniform_notes: orNull(str("Fit notes.", "Prefers a relaxed cut.")),
        })
        .meta({
          id: "SharedUniformSizes",
          description: "Uniform sizes as an engaging org reads them.",
        }),
    ),
    dietary: orNull(
      z
        .object({
          dietary_needs: z.array(DietaryNeed),
          allergies: orNull(str("Allergies.", "Peanuts, severe")),
          dietary_notes: orNull(str("Other dietary notes.", "No pork.")),
        })
        .meta({
          id: "SharedDietaryNeeds",
          description: "Dietary needs as an engaging org reads them.",
        }),
    ),
    accessibility: orNull(
      z
        .object({
          accessibility_needs: z.array(AccessibilityNeed),
          accessibility_notes: orNull(
            str("Accessibility notes.", "Needs a seat near the stage door."),
          ),
        })
        .meta({
          id: "SharedAccessibilityNeeds",
          description: "Accessibility needs as an engaging org reads them.",
        }),
    ),
    travel: orNull(
      z
        .object({
          seat_preference: orNull(SeatPreference),
          meal_preference: orNull(str("Preferred in-flight meal.", "Vegetarian (VGML)")),
          home_airport: orNull(airport),
          loyalty_programs: z.array(
            z
              .object({
                program_kind: LoyaltyProgramKind,
                program_name: str("Program.", "SkyMiles"),
                member_number: str("Membership number.", "SM-0000-TEST"),
              })
              .meta({
                id: "SharedLoyaltyProgram",
                description: "A loyalty program as an engaging org reads it.",
              }),
          ),
        })
        .meta({
          id: "SharedTravelProfile",
          description: "The travel profile as an engaging org reads it.",
        }),
    ),
    passport: orNull(
      z
        .object({
          passport_number: z
            .null()
            .meta({
              description: "Always null: the number is masked; reveal it through revealPassport.",
              example: null,
            }),
          passport_number_last4: orNull(str("Last four characters of the number.", "TEST")),
          passport_number_masked: fields.bool("A number is recorded and withheld.", true),
          passport_issuing_country: orNull(fields.countryCode("Country that issued the passport.")),
          passport_expires_on: orNull(fields.date("Day the passport expires.")),
          passport_name: orNull(str("Name as printed in the passport.", "IVY MARCHETTI")),
        })
        .meta({
          id: "SharedPassport",
          description: "Passport details as an engaging org reads them, the number masked.",
        }),
    ),
  })
  .meta({
    id: "SharedWorkDetails",
    description:
      "What the person an engagement names shared of their work details, as the caller may read it. Unshared or unreadable categories are null; the passport number is always masked.",
  });

export const workDetailResources: readonly ResourceSpec[] = [
  resource("Identity", "/work-details", WorkDetails, {
    actions: [
      itemAction("revealPassport", {
        summary: "Reveal the caller's passport number",
        description:
          "Returns the caller's own passport number in plain text through `app.reveal_my_passport_number`. Every reveal is written to the person's access log. 422 passport_number_missing when none is recorded.",
        rpc: "app.reveal_my_passport_number",
        response: PassportReveal,
      }),
    ],
  }),
  resource("Identity", "/emergency-contacts", EmergencyContact, {
    order: { by: ["sort_order", "created_at"], numeric: false },
  }),
  resource("Identity", "/loyalty-programs", LoyaltyProgram, {
    order: { by: ["sort_order", "created_at"], numeric: false },
  }),
  resource("Identity", "/work-detail-shares", WorkDetailShare, {
    verbs: ["list", "get", "create", "update"],
    actions: [
      itemAction("revoke", {
        summary: "Revoke a work details share",
        description:
          "Ends the share at once through `app.revoke_work_detail_share`; the org reads nothing more, and its work_details_sharing consent is withdrawn when this was its last live share. Only the person who gave it revokes it (422 work_detail_share_not_yours).",
        rpc: "app.revoke_work_detail_share",
      }),
      itemQuery("details", {
        summary: "Read what the share's person shared",
        description:
          "For a member of the engaging org: the shared categories the caller's project capabilities cover (safety readers and engagement editors for emergency contacts, engagement readers and shift editors for uniform sizes, hospitality readers for the rest), through `app.shared_work_details`. Nothing is returned once the share is revoked or the engagement is Complete or Canceled. The passport number is always masked. Each read is logged in the person's access log and the org's audit ledger.",
        rpc: "app.shared_work_details",
        response: SharedWorkDetails,
      }),
      itemAction("revealPassport", {
        summary: "Reveal a shared passport number",
        description:
          "For a member of the engaging org: returns the passport number through `app.reveal_shared_passport_number`. Needs a live share naming Passport on an open engagement, hospitality.fulfillment.read on the project, data.restricted.read.government_id in the org, step-up authentication (422 step_up_required) and a reason (422 passport_reveal_reason). Logged with the reason, never the value.",
        rpc: "app.reveal_shared_passport_number",
        body: PassportRevealRequest,
        response: PassportReveal,
      }),
    ],
  }),
  resource("Identity", "/work-detail-events", WorkDetailEvent, {
    order: { by: ["created_at"], numeric: false, descending: true },
  }),
];

export const workDetailCapabilities: Readonly<Record<string, CapabilityRule>> = {
  workDetails: {
    read: "me.work_details.write",
    write: "me.work_details.write",
    actions: { revealPassport: "me.work_details.write" },
  },
  emergencyContacts: { read: "me.work_details.write", write: "me.work_details.write" },
  loyaltyPrograms: { read: "me.work_details.write", write: "me.work_details.write" },
  workDetailShares: {
    read: "opportunities.engagement.read",
    write: "me.work_details.write",
    actions: {
      revoke: "me.work_details.write",
      details: "opportunities.engagement.read",
      revealPassport: "data.restricted.read.government_id",
    },
  },
  workDetailEvents: { read: "me.work_details.write" },
};

export const workDetailCorrections: readonly CorrectionInput[] = [
  {
    id: "person-given-family-names",
    since: "1.0.0-draft.2",
    resources: ["people"],
    change: "Adds the optional, updatable `given_name` and `family_name`.",
    reason:
      "app.people (1340, A78) gains optional given and family names beside full_name (Section 15 names). The full name stays as the person gave it; nothing assumes a first-last order.",
    apply: editShape({
      add: {
        given_name: {
          schema: shortText("Optional given name, as the person writes it.", "Ivy", 100),
          update: true,
        },
        family_name: {
          schema: shortText("Optional family name, as the person writes it.", "Marchetti", 100),
          update: true,
        },
      },
    }),
  },
];
