import type { DeletionCertificateData } from "../../src/documents/deletion-certificate.ts";
import type { DocumentBrand } from "../../src/documents/generate.ts";
import type { DocumentKind } from "../../src/documents/model.ts";
import type { DocumentDataMap, DocumentProject } from "../../src/documents/templates.ts";
import type { SitePlan, SitePlanShape } from "../../src/places.ts";
import type { Sign } from "../../src/signage.ts";

/**
 * Record data for every Section 11.9 template, shaped like the seeded demo org, with the edge cases
 * the renderer has to survive: unpriced lines, long wrapping text, characters outside Inter's Latin
 * subset, a many-row table that spans pages, and empty sections. The unit tests and the veraPDF
 * check (scripts/verapdf-documents.ts) render each one.
 */

/** A 1 by 1 PNG, enough to exercise the logo Figure and its alternative text. */
export const LOGO_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A 30 by 40 JPEG and PNG portrait, for the badge photo Figure on every size (P5). */
export const PHOTO_JPEG = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKAC" +
      "AAQAAAABAAAAHqADAAQAAAABAAAAKAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZ" +
      "jwCyBOmACZjs+EJ+/8AAEQgAKAAeAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB" +
      "AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNE" +
      "RUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI" +
      "ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB" +
      "AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpD" +
      "REVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
      "x8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8S" +
      "EhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0d" +
      "HR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAAv/aAAwDAQACEQMRAD8A+RrTT+nFdNaaf04rStNP6cV01pp/Tiv0/FY/" +
      "zKyLM9tTNtNP6cV0ttp/y9K07TT+nFdLbaf8vSvlMTj9dz9+yTM9Nz//0PNrTT+nFdPaaf04rStNP6cV01pp/Tiu/FY/zPzD" +
      "Isy21M200/pxXSW+n/L0rUtNP6cV0ttp/wAvSvlMTj/M/fskzLTc/9HqLTT+nFdNaaf04qladq6a07V8xiq0+5/NuRV56al6" +
      "00/pxXSW2n/L0qnadq6W3+7XyuJrS7n79kledtz/2Q==",
    "base64",
  ),
);

export const PHOTO_PNG = Uint8Array.from(
  Buffer.from(
    "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" +
      "F2EAAAAASUVORK5CYII=",
    "base64",
  ),
);

export const BRAND: DocumentBrand = {
  name: "Northwind Live",
  legalEntity: "Northwind Live Productions LLC",
  accentHex: "#3b5bdb",
  logo: { bytes: LOGO_PNG, alt: "Northwind Live logo" },
};

export const NOW = new Date("2026-10-19T15:30:00Z");

const project: DocumentProject = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "NWF26",
  name: "Northwind Festival 2026",
  timeZone: "America/New_York",
};

const longText =
  "Supply, install and strike the main stage line array, including rigging points, motors, " +
  "truss, cabling and two technicians for every show day. Łódź crew note: Ωmega cue sheet.";

/** An 8 by 4 and a 4 by 8 PNG: a wide and a tall site plan drawing (B1). */
export const DRAWING_WIDE = hex(
  "89504e470d0a1a0a0000000d49484452000000080000000408020000003cafe9a7000000114944415478da6378f6ec3556c4403d0900f87456e10a6a48160000000049454e44ae426082",
);
export const DRAWING_TALL = hex(
  "89504e470d0a1a0a0000000d49484452000000040000000808020000005151c952000000114944415478da6378f6ec351c31d08e0300a64756e1cdeab8580000000049454e44ae426082",
);

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** A Live site plan with a stored 2000 by 1000 px drawing calibrated 50 ft over half its width (B1). */
export const sitePlan: SitePlan = {
  id: "00000000-0000-4000-8000-0000000000a1",
  projectId: project.id,
  venueId: "v1",
  venueLevelId: "l1",
  title: "Ground floor",
  imageUri: "attachments/org/att/ver/ground.png",
  planState: "Live",
  awaitingDrawing: false,
  drawing: {
    versionId: "ver1",
    rasterVersionId: null,
    page: null,
    contentType: "image/png",
    filename: "ground.png",
    shownVersionId: "ver1",
    widthPx: 2000,
    heightPx: 1000,
    unavailable: null,
  },
  calibration: { ax: 0.1, ay: 0.5, bx: 0.6, by: 0.5, feet: 50 },
  archivedAt: null,
  updatedAt: "2026-10-18T12:00:00Z",
  pins: [
    { id: "pin1", label: "Main gate", x: 0.2, y: 0.3, zoneId: null, recordId: null },
    { id: "pin2", label: "First aid · Łódź", x: 0.8, y: 0.7, zoneId: null, recordId: null },
  ],
};

export const sitePlanShapes: readonly SitePlanShape[] = [
  {
    id: "s1",
    sitePlanId: sitePlan.id,
    kind: "Route",
    label: "Egress north",
    tone: "Info",
    points: [
      [0.1, 0.1],
      [0.1, 0.6],
    ],
    lengthFt: 25,
    areaSqFt: null,
  },
  {
    id: "s2",
    sitePlanId: sitePlan.id,
    kind: "Barrier",
    label: "Crowd fence",
    tone: "Danger",
    points: [
      [0.3, 0.8],
      [0.7, 0.8],
    ],
    lengthFt: 40,
    areaSqFt: null,
  },
  {
    id: "s3",
    sitePlanId: sitePlan.id,
    kind: "Area",
    label: "Pit",
    tone: "Accent",
    points: [
      [0.1, 0.2],
      [0.3, 0.2],
      [0.3, 0.6],
      [0.1, 0.6],
    ],
    lengthFt: 80,
    areaSqFt: 400,
  },
  {
    id: "s4",
    sitePlanId: sitePlan.id,
    kind: "Label",
    label: "North",
    tone: "Neutral",
    points: [[0.5, 0.05]],
    lengthFt: null,
    areaSqFt: null,
  },
];

const signBase = {
  projectId: project.id,
  urid: "4000.05.01",
  message: null,
  widthIn: 24,
  heightIn: 36,
  substrate: "Coroplast",
  doubleSided: false,
  printerVendorId: null,
  poLineId: null,
  artworkVersionId: null,
  neededBy: "2026-10-20",
  orderedAt: null,
  printedAt: null,
  placedAt: null,
  placedBy: null,
  updatedAt: "2026-10-18T12:00:00Z",
  archivedAt: null,
  orderedViaPo: false,
  received: false,
  located: true,
  overdue: false,
} as const;

export const signs: readonly Sign[] = [
  {
    ...signBase,
    id: "sign1",
    key: "NWF26-SGN-1",
    number: 1,
    title: "Main entrance arrow",
    type: "Directional",
    quantity: 4,
    sitePlanPinId: "pin1",
    locationText: null,
    artworkVersionId: "art1",
    state: "Printed",
  },
  {
    ...signBase,
    id: "sign2",
    key: "NWF26-SGN-2",
    number: 2,
    title: "Bar menu",
    type: "Menu",
    quantity: 2,
    sitePlanPinId: null,
    locationText: "Behind the north bar",
    state: "Ordered",
    orderedViaPo: true,
  },
  {
    ...signBase,
    id: "sign3",
    key: "NWF26-SGN-3",
    number: 3,
    title: "No re-entry · Ωmega",
    type: "Regulatory",
    quantity: 6,
    sitePlanPinId: null,
    locationText: null,
    state: "To Order",
    located: false,
    widthIn: null,
    heightIn: null,
  },
  {
    ...signBase,
    id: "sign4",
    key: "NWF26-SGN-4",
    number: 4,
    title: "Sponsor wall",
    type: "Sponsor",
    quantity: 1,
    sitePlanPinId: "pin2",
    locationText: null,
    state: "Placed",
  },
];

export const FIXTURES: { readonly [K in DocumentKind]: DocumentDataMap[K] } = {
  "purchase-order": {
    project,
    order: {
      id: "10000000-0000-4000-8000-000000000001",
      projectId: project.id,
      projectKey: project.key,
      number: 12,
      key: "NWF26-PO12",
      vendorId: "v1",
      vendorName: "Stagecraft Audio Inc.",
      rfqResponseId: null,
      currencyCode: "USD",
      state: "Sent",
      createdAt: "2026-09-02T14:00:00Z",
      createdBy: null,
    },
    lines: Array.from({ length: 40 }, (_, i) => ({
      id: `l${i}`,
      lineNumber: i + 1,
      description: i === 0 ? longText : `Line item ${i + 1}`,
      elementId: null,
      budgetLineId: null,
      quantity: 2,
      unitBasis: null,
      unitPriceMinor: i === 3 ? null : 125_000,
      extendedMinor: i === 3 ? null : 250_000,
      receivedQuantity: i < 10 ? 2 : 0,
      acquisitionKind: "Purchase" as const,
      hireStartsAt: null,
      hireEndsAt: null,
    })),
    totals: { unpricedCount: 1, linesTotalMinor: null, approvedChangesMinor: 50_000 },
  },
  invoice: {
    project,
    invoice: {
      id: "20000000-0000-4000-8000-000000000001",
      projectId: project.id,
      direction: "Receivable",
      counterpartyId: "c1",
      payeePersonId: null,
      payeeName: null,
      engagementId: null,
      number: "INV-2026-0042",
      issuedOn: "2026-10-01",
      dueOn: "2026-10-31",
      currency: "USD",
      state: "Issued",
      unpricedCount: 0,
      subtotalMinor: 1_200_000,
      taxMinor: 84_000,
      totalMinor: 1_284_000,
      appliedMinor: 500_000,
      createdAt: "2026-09-30T12:00:00Z",
    },
    lines: [
      {
        id: "i1",
        lineNumber: 1,
        description: "Production management fee",
        quantity: 1,
        unitPriceMinor: 1_000_000,
        budgetLineId: null,
        extendedMinor: 1_000_000,
      },
      {
        id: "i2",
        lineNumber: 2,
        description: "Site visits",
        quantity: 4,
        unitPriceMinor: 50_000,
        budgetLineId: null,
        extendedMinor: 200_000,
      },
    ],
    counterpartyName: "Contoso Events",
  },
  "change-order": {
    project,
    order: {
      id: "30000000-0000-4000-8000-000000000001",
      projectId: project.id,
      budgetId: "b1",
      number: 3,
      title: "Add a second delay tower",
      orderTypeId: null,
      reason: "Audience area grew after the site plan revision.",
      requestedBy: null,
      pricedBy: null,
      state: "Priced",
      lineCount: 2,
      unpricedCount: 0,
      totalMinor: 840_000,
      createdAt: "2026-09-12T10:00:00Z",
    },
    lines: [
      {
        id: "c1",
        budgetLineId: null,
        description: "Delay tower rental",
        urid: "5000.01",
        quantity: 1,
        unitPriceMinor: 840_000,
        isNoCost: false,
        extendedMinor: 840_000,
      },
      {
        id: "c2",
        budgetLineId: null,
        description: "Permit amendment",
        urid: "5000.02",
        quantity: 1,
        unitPriceMinor: null,
        isNoCost: true,
        extendedMinor: null,
      },
    ],
    budgetName: "Production budget",
    currency: "USD",
  },
  "day-sheet": {
    project,
    sheet: {
      id: "40000000-0000-4000-8000-000000000001",
      projectId: project.id,
      projectKey: project.key,
      day: "2026-10-24",
      body: "Gates open at 16:00.\n\nWeather: dry, 18 C. Load-in at the north dock only.",
      publishedAt: "2026-10-23T20:00:00Z",
      updatedAt: "2026-10-23T19:00:00Z",
    },
  },
  "call-sheet": {
    project,
    sheet: {
      id: "50000000-0000-4000-8000-000000000001",
      projectId: project.id,
      projectKey: project.key,
      day: "2026-10-24",
      publishedAt: null,
      updatedAt: "2026-10-22T19:00:00Z",
    },
    calls: [
      {
        shiftId: "s1",
        startsAt: "2026-10-24T12:00:00Z",
        endsAt: "2026-10-24T22:00:00Z",
        roleCode: "AUD-A1",
        roleTitle: "Audio A1",
        personName: "Ana Ruiz",
      },
      {
        shiftId: "s2",
        startsAt: "2026-10-24T13:00:00Z",
        endsAt: "2026-10-24T23:00:00Z",
        roleCode: null,
        roleTitle: null,
        personName: null,
      },
    ],
  },
  "run-of-show": {
    project,
    run: {
      id: "60000000-0000-4000-8000-000000000001",
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      timeZone: project.timeZone,
      scopeNodeId: null,
      name: "Main stage, Saturday",
      showDate: "2026-10-24",
      cueCount: 3,
      calledCount: 1,
    },
    cues: [
      {
        id: "q1",
        runOfShowId: "r",
        position: 1,
        label: "House to half",
        plannedAt: "2026-10-24T23:00:00Z",
        durationSeconds: 30,
        calledAt: "2026-10-24T23:00:12Z",
        calledByName: "Sam Lee",
      },
      {
        id: "q2",
        runOfShowId: "r",
        position: 2,
        label: "Walk-in music out, headliner on",
        plannedAt: "2026-10-24T23:01:00Z",
        durationSeconds: 5400,
        calledAt: null,
        calledByName: null,
      },
      {
        id: "q3",
        runOfShowId: "r",
        position: 3,
        label: "Encore",
        plannedAt: null,
        durationSeconds: null,
        calledAt: null,
        calledByName: null,
      },
    ],
  },
  beo: {
    project,
    beo: {
      id: "70000000-0000-4000-8000-000000000001",
      key: "NWF26-7",
      projectId: project.id,
      projectKey: project.key,
      timeZone: project.timeZone,
      fulfillmentId: null,
      fulfillmentTitle: "Artist catering, Saturday",
      eventAt: "2026-10-24T22:00:00Z",
      guestCount: 85,
      approvedAt: "2026-10-20T15:00:00Z",
      approvedByName: "Jordan Park",
      createdBy: null,
      createdAt: "2026-10-18T15:00:00Z",
      lineCount: 2,
      total: {
        amountMinor: 425_000,
        currencyCode: "USD",
        unpricedCount: 1,
        mixedCurrencies: false,
      },
      lines: [
        {
          id: "b1",
          description: "Hot buffet",
          quantity: 85,
          unitPriceMinor: 5_000,
          currencyCode: "USD",
          amountMinor: 425_000,
        },
        {
          id: "b2",
          description: "Late snacks",
          quantity: 1,
          unitPriceMinor: null,
          currencyCode: null,
          amountMinor: null,
        },
      ],
    },
  },
  "credential-badge": {
    project,
    credential: {
      id: "80000000-0000-4000-8000-000000000001",
      number: "NWF26-AAA-0042",
      holderPersonId: "p1",
      holderName: "Ana Ruiz",
      categoryId: "cat1",
      categoryCode: "AAA",
      categoryName: "All access",
      projectId: project.id,
      projectKey: project.key,
      issuedByName: "Jordan Park",
      validFrom: "2026-10-20T00:00:00Z",
      validTo: "2026-10-27T00:00:00Z",
      revokedAt: null,
      revokedByName: null,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
    },
  },
  "inspection-report": {
    project,
    inspection: {
      id: "90000000-0000-4000-8000-000000000001",
      projectId: project.id,
      templateId: "t1",
      recordId: null,
      inspectorId: "p1",
      inspectedAt: "2026-10-23T14:00:00Z",
      signedOffBy: "p2",
      signedOffAt: "2026-10-23T16:00:00Z",
      archivedAt: null,
      results: [
        { id: "r1", itemId: "it1", resultEnumId: "ENM-082", note: null },
        { id: "r2", itemId: "it2", resultEnumId: "ENM-084", note: "Replace the frayed sling." },
      ],
    },
    templateName: "Stage structure daily walk",
    items: [
      { id: "it1", position: 1, prompt: "Ballast in place on every tower", critical: true },
      { id: "it2", position: 2, prompt: "Rigging slings and shackles", critical: true },
      { id: "it3", position: 3, prompt: "Stair handrails", critical: false },
    ],
    resultCodes: { "ENM-082": "INSP_PASSED", "ENM-084": "INSP_FAILED" },
    inspectorName: "Ana Ruiz",
    signedOffByName: "Jordan Park",
  },
  "incident-report": {
    project,
    incident: {
      id: "a0000000-0000-4000-8000-000000000001",
      projectId: project.id,
      projectKey: project.key,
      number: 4,
      key: "NWF26-4",
      title: "Guest slipped near the east bar",
      severityId: "sev2",
      zoneId: "z1",
      zoneCode: "E-BAR",
      zoneName: "East bar",
      occurredAt: "2026-10-24T23:40:00Z",
      reportedById: "p1",
      reportedByName: "Ana Ruiz",
      state: "Closed",
      closedSignedOffByName: "Jordan Park",
      latitude: 40.712776,
      longitude: -74.005974,
      createdAt: "2026-10-24T23:45:00Z",
      updatedAt: "2026-10-25T01:00:00Z",
      responderCount: 2,
    },
    severityLabel: "Moderate",
    history: [
      {
        id: "h1",
        fromState: null,
        toState: "Reported",
        reason: "Reported from Compass",
        at: "2026-10-24T23:45:00Z",
        byName: "Ana Ruiz",
      },
      {
        id: "h2",
        fromState: "Reported",
        toState: "Dispatched",
        reason: "Medic team 2 sent",
        at: "2026-10-24T23:47:00Z",
        byName: "Sam Lee",
      },
    ],
  },
  "final-cost-report": {
    project,
    report: {
      project: { id: project.id, key: project.key, name: project.name, phase: "Closeout" },
      hasBaseline: true,
      rows: [
        {
          accountCode: "5100",
          currency: "USD",
          baselineMinor: 10_000_000,
          baselineUnpricedCount: 0,
          approvedChangeMinor: 840_000,
          revisedMinor: 10_840_000,
          pricedRevisedMinor: 10_840_000,
          actualMinor: 10_500_000,
          varianceMinor: 340_000,
          budgetLineIds: [],
        },
        {
          accountCode: "5200",
          currency: "USD",
          baselineMinor: null,
          baselineUnpricedCount: 1,
          approvedChangeMinor: 0,
          revisedMinor: null,
          pricedRevisedMinor: 200_000,
          actualMinor: 180_000,
          varianceMinor: null,
          budgetLineIds: [],
        },
      ],
      totals: [
        {
          accountCode: "",
          currency: "USD",
          baselineMinor: null,
          baselineUnpricedCount: 1,
          approvedChangeMinor: 840_000,
          revisedMinor: null,
          pricedRevisedMinor: 11_040_000,
          actualMinor: 10_680_000,
          varianceMinor: null,
          budgetLineIds: [],
        },
      ],
    },
  },
  "agreement-certificate": {
    project,
    agreement: {
      id: "b0000000-0000-4000-8000-000000000001",
      projectId: project.id,
      offerId: null,
      personId: "p1",
      personName: "Ana Ruiz",
      counterpartyId: null,
      kind: "Contractor Agreement",
      title: "Audio A1 services, Northwind Festival 2026",
      state: "Signed",
      tokenExpiresAt: null,
      signedAt: "2026-09-20T18:12:00Z",
      signedName: "Ana Ruiz",
      createdAt: "2026-09-18T12:00:00Z",
      body: "1. Services. The contractor provides Audio A1 services on the show days.\n\n2. Fees. As set out in the offer.",
      signedBodySha256: "3f1d0a4c9b7e2f6a8d5c4b3a2918f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6",
      transitions: [
        {
          id: "t1",
          fromState: "Proposed",
          toState: "Sent",
          reason: "Sent for signature",
          at: "2026-09-18T12:05:00Z",
          by: null,
        },
        {
          id: "t2",
          fromState: "Sent",
          toState: "Signed",
          reason: "Signed by the contractor",
          at: "2026-09-20T18:12:00Z",
          by: null,
        },
      ],
    },
  },
  "site-plan": {
    project,
    plan: sitePlan,
    venueName: "Northwind Pier Pavilion",
    levelName: "Ground",
    shapes: sitePlanShapes,
    drawing: DRAWING_WIDE,
    signsAtPins: { pin1: ["NWF26-SGN-1 Main entrance arrow"] },
  },
  "signage-build-sheet": {
    project,
    signs: signs,
    plans: [{ plan: sitePlan, drawing: DRAWING_WIDE }],
    artwork: {
      sign1: { bytes: PHOTO_PNG, filename: "arrow.png" },
      sign2: { bytes: null, filename: "menu-board.pdf" },
    },
  },
};

/**
 * The deletion certificate of an org (A79, Section 14.7), with a long name and characters outside the font's
 * Latin subset, so veraPDF checks the fallback and wrapping on it too.
 */
export const DELETION_CERTIFICATE: DeletionCertificateData = {
  id: "0192a000-0000-7000-8000-00000000c001",
  deletedOrgId: "0192a000-0000-7000-8000-0000000000b1",
  orgName:
    "Harbor Lights Productions: Ünïcode Ωmega Ŝtage & Touring Company of the Greater Northwest Coast",
  orgSlug: "harbor-lights",
  basis: "deletion_request",
  requestedAt: "2026-10-01T12:00:00Z",
  dueAt: "2026-10-08T12:00:00Z",
  purgedAt: "2026-10-08T13:23:00Z",
  tablesPurged: 41,
  rowsPurged: 18204,
  storageObjectsDeleted: 112,
  ownerName: "Xavier Dubois",
  timeZone: "America/Los_Angeles",
};

/**
 * A badge issued after BADGE_V2_FROM with a CR- number the gates read, and its holder's photo: renders version 2
 * on every size (P5).
 */
export const BADGE_V2: DocumentDataMap["credential-badge"] = {
  project,
  credential: {
    ...FIXTURES["credential-badge"].credential,
    id: "80000000-0000-4000-8000-000000000002",
    number: "CR-000042",
    holderName: "Ana María Ruiz-Delacroix Santiago de Compostela Villanueva",
    validFrom: "2027-03-01T00:00:00Z",
    validTo: "2027-03-08T00:00:00Z",
    createdAt: "2027-02-15T00:00:00Z",
    updatedAt: "2027-02-15T00:00:00Z",
  },
  photo: { bytes: PHOTO_JPEG, source: "Badge" },
};
