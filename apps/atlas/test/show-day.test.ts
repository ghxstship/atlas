import type { TravelSegment } from "@xos/data/hospitality";
import type { RunOfShow } from "@xos/data/show";
import { describe, expect, it } from "vitest";
import {
  arrivalsOn,
  hotelsOn,
  pickShowDayProject,
  runProgress,
  setsByStage,
  showDayProjects,
  type RoomStay,
  type ShowDayCue,
} from "@/lib/show/show-day";

/**
 * Show > Show day (B6, G-179): sets grouped by stage with what is called and up next, each running
 * order's progress, arrivals inside the day's window on the project's calendar, and the hotels
 * covering that night.
 */
const ZONE = "America/New_York";
const run = (over: Partial<RunOfShow>): RunOfShow => ({
  id: "ros-main",
  projectId: "p1",
  projectKey: "NWS",
  projectName: "Northwind Summer Series",
  timeZone: ZONE,
  scopeNodeId: "stage-main",
  name: "Main Stage Running Order",
  showDate: "2027-06-05",
  cueCount: 0,
  calledCount: 0,
  ...over,
});
const cue = (over: Partial<ShowDayCue>): ShowDayCue => ({
  id: "c1",
  runOfShowId: "ros-main",
  position: 1,
  label: "Doors",
  plannedAt: null,
  durationSeconds: null,
  calledAt: null,
  ...over,
});

describe("sets by stage", () => {
  const runs = [run({}), run({ id: "ros-side", scopeNodeId: null, name: "Side Tent" })];
  const cues = [
    cue({ id: "doors", position: 1, label: "Doors", calledAt: "2027-06-05T23:00:00Z" }),
    cue({
      id: "opener",
      position: 2,
      label: "Opener",
      plannedAt: "2027-06-05T23:30:00Z",
      calledAt: "2027-06-05T23:31:00Z",
    }),
    cue({
      id: "headliner",
      position: 3,
      label: "Headliner",
      plannedAt: "2027-06-06T01:00:00Z",
      durationSeconds: 5400,
    }),
    cue({ id: "encore", position: 4, label: "Encore", plannedAt: "2027-06-06T02:30:00Z" }),
    cue({
      id: "dj",
      runOfShowId: "ros-side",
      position: 1,
      label: "DJ Set",
      plannedAt: "2027-06-06T00:00:00Z",
    }),
  ];
  const links = [
    { cueId: "opener", actName: "Harbor Lights" },
    { cueId: "headliner", actName: "Arturo Bell" },
    { cueId: "encore", actName: "Arturo Bell" },
    { cueId: "dj", actName: "DJ Coral" },
  ];
  const stages = new Map([["stage-main", "Main Stage"]]);

  it("groups set cues under their stage, the run's name when it has no stage", () => {
    const grouped = setsByStage(runs, cues, links, stages);
    expect(grouped.map((g) => [g.stage, g.sets.map((s) => s.cueId)])).toEqual([
      ["Main Stage", ["opener", "headliner", "encore"]],
      ["Side Tent", ["dj"]],
    ]);
  });

  it("marks called sets, the first uncalled set up next and the rest planned", () => {
    const [main] = setsByStage(runs, cues, links, stages);
    expect(main?.sets.map((s) => [s.actName, s.state])).toEqual([
      ["Harbor Lights", "called"],
      ["Arturo Bell", "next"],
      ["Arturo Bell", "planned"],
    ]);
    expect(main?.sets[1]?.durationSeconds).toBe(5400);
  });

  it("counts each running order's called cues and names the next cue", () => {
    expect(runProgress(runs, cues, stages)).toEqual([
      {
        runOfShowId: "ros-main",
        name: "Main Stage Running Order",
        stage: "Main Stage",
        called: 2,
        total: 4,
        next: { label: "Headliner", plannedAt: "2027-06-06T01:00:00Z" },
      },
      {
        runOfShowId: "ros-side",
        name: "Side Tent",
        stage: "Side Tent",
        called: 0,
        total: 1,
        next: { label: "DJ Set", plannedAt: "2027-06-06T00:00:00Z" },
      },
    ]);
  });
});

describe("arrivals", () => {
  const segment = (over: Partial<TravelSegment>): TravelSegment => ({
    id: "t1",
    projectId: "p1",
    projectKey: "NWS",
    personId: "a1",
    personName: "Arturo Bell",
    fulfillmentId: null,
    mode: "Flight",
    operatorName: "Coastal Air",
    serviceIdentifier: "CA 210",
    confirmationIdentifier: "QX7PLM",
    departsFrom: "LAX",
    departsAt: "2027-06-05T16:00:00Z",
    departsTimeZone: "America/Los_Angeles",
    arrivesAtPlace: "MIA",
    arrivesAt: "2027-06-06T00:05:00Z",
    arrivesTimeZone: ZONE,
    priceMinor: 45000,
    currencyCode: "USD",
    ...over,
  });

  it("lists who lands inside the day's window in the project zone, earliest first", () => {
    const list = arrivalsOn(
      [
        // 00:05 UTC on June 6 is 20:05 on June 5 in New York: June 5's arrival.
        segment({ id: "late" }),
        segment({ id: "morning", arrivesAt: "2027-06-05T13:00:00Z" }),
        // 04:30 UTC on June 6 is 00:30 on June 6 in New York: the next day's.
        segment({ id: "tomorrow", arrivesAt: "2027-06-06T04:30:00Z" }),
        // No arrival time: it counts on the day it leaves.
        segment({
          id: "ground",
          mode: "Ground",
          arrivesAt: null,
          departsAt: "2027-06-05T15:00:00Z",
        }),
      ],
      "2027-06-05",
      ZONE,
    );
    expect(list.map((s) => s.id)).toEqual(["morning", "ground", "late"]);
  });
});

describe("hotels", () => {
  const stay = (over: Partial<RoomStay>): RoomStay => ({
    id: "s1",
    personName: "Arturo Bell",
    checkInOn: "2027-06-04",
    checkOutOn: "2027-06-07",
    blockId: "b1",
    blockTitle: "Artist block",
    hotelName: "Harbor Inn",
    ...over,
  });

  it("counts the guests covering the night and names the day's check-ins and check-outs", () => {
    const nights = hotelsOn(
      [
        stay({}),
        stay({ id: "s2", personName: "Ivy Marchetti", checkInOn: "2027-06-05" }),
        stay({
          id: "s3",
          personName: "Quinn Ashby",
          checkInOn: "2027-06-02",
          checkOutOn: "2027-06-05",
        }),
        stay({
          id: "s4",
          personName: "Sam Kowalski",
          blockId: "b2",
          blockTitle: "Crew block",
          hotelName: null,
          checkInOn: "2027-06-06",
        }),
      ],
      "2027-06-05",
    );
    expect(nights).toEqual([
      {
        blockId: "b1",
        hotelName: "Harbor Inn",
        blockTitle: "Artist block",
        guests: ["Arturo Bell", "Ivy Marchetti"],
        checkIns: ["Ivy Marchetti"],
        checkOuts: ["Quinn Ashby"],
        assignmentIds: ["s1", "s2", "s3"],
      },
    ]);
  });
});

describe("the project and day the page opens on", () => {
  const runs = [
    run({ id: "r1", projectId: "p1", projectKey: "NWS", showDate: "2027-06-05" }),
    run({
      id: "r2",
      projectId: "p2",
      projectKey: "HLP",
      projectName: "Harbor Lights",
      showDate: "2027-06-10",
    }),
  ];
  it("lists each project once with its show dates", () => {
    expect(showDayProjects(runs).map((p) => [p.key, p.showDates])).toEqual([
      ["HLP", ["2027-06-10"]],
      ["NWS", ["2027-06-05"]],
    ]);
  });
  it("takes the project asked for, else the one with a show today, else the first", () => {
    const projects = showDayProjects(runs);
    expect(pickShowDayProject(projects, "NWS")?.key).toBe("NWS");
    expect(pickShowDayProject(projects, null, new Date("2027-06-05T18:00:00Z"))?.key).toBe("NWS");
    expect(pickShowDayProject(projects, "NOPE", new Date("2027-01-01T00:00:00Z"))?.key).toBe("HLP");
    expect(pickShowDayProject([], null)).toBeNull();
  });
});
