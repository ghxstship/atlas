import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  audiencesFor,
  CUE_FIELD_AUDIENCES,
  listCueFieldAudiences,
  setCueFieldAudiences,
} from "../src/custom-fields.ts";
import { readClientCueFields } from "../src/gateway-operations.ts";
import { addCustomFieldChoice, setCustomFieldChoiceColor } from "../src/governance.ts";
import {
  getLibrarySegment,
  insertLibrarySegment,
  listLibrarySegments,
  listSegmentCopies,
  publishLibrarySegment,
  removeLibraryCue,
  removeLibrarySegment,
  saveLibraryCue,
  saveLibraryCueCalls,
  saveLibrarySegment,
} from "../src/segment-library.ts";
import {
  isSegmentColor,
  listCues,
  listSegmentColors,
  segmentKey,
  setSegmentColor,
  updateCue,
} from "../src/show.ts";
import {
  joinShowChannel,
  openShowChannel,
  showChannelStatus,
  unreadInConversation,
} from "../src/show-channel.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const argsOf = (call: { steps: [string, unknown[]][] } | undefined) =>
  call?.steps.find(([step]) => step === "args")?.[1][0];
const stepOf = (call: { steps: [string, unknown[]][] } | undefined, name: string) =>
  call?.steps.filter(([step]) => step === name).map(([, args]) => args);

describe("cues and segment colours (2920)", () => {
  it("reads the new cue columns and the link a cue was called through", async () => {
    const { db } = fakeClient({
      "from:cues": [
        okResponse([
          {
            id: "c1",
            run_of_show_id: "r1",
            position: 1,
            label: "Award One",
            planned_at: null,
            duration: "00:04:00",
            called_at: "2027-06-05T23:00:00Z",
            start_tbc: false,
            standby_at: null,
            segment: "Awards",
            description: "Presenter walks on.",
            script: "Please welcome",
            segment_instance_id: "i1",
            updated_at: "2027-06-05T23:00:00Z",
            caller: null,
            link: { caller_name: "Sam Okafor" },
          },
        ]),
      ],
    });
    const list = await listCues(db, "r1");
    expect(list.ok && list.data[0]).toMatchObject({
      segment: "Awards",
      script: "Please welcome",
      segmentInstanceId: "i1",
      calledByName: null,
      calledViaLink: "Sam Okafor",
      durationSeconds: 240,
    });
  });

  it("writes the segment, description and script, blank as null", async () => {
    const { db, calls } = fakeClient({ "from:cues": [okResponse([{ id: "c1" }])] });
    expect(
      (await updateCue(db, "c1", { segment: "  ", description: " Walk on ", script: "" })).ok,
    ).toBe(true);
    expect(stepOf(calls[0], "update")?.[0]?.[0]).toEqual({
      segment: null,
      description: "Walk on",
      script: null,
    });
  });

  it("knows the seven colours and matches segment names as the database does", () => {
    expect(isSegmentColor("cat-7")).toBe(true);
    expect(isSegmentColor("cat-8")).toBe(false);
    expect(isSegmentColor(null)).toBe(false);
    expect(segmentKey("  Act I ")).toBe(segmentKey("act i"));
    expect(segmentKey(null)).toBe("");
  });

  it("lists, sets and clears segment colours", async () => {
    const { db, calls } = fakeClient({
      "from:run_segment_colors": [
        okResponse([
          { segment: "Act I", color_key: "cat-2" },
          { segment: "Bad", color_key: "red" },
        ]),
        errorResponse("42501", "denied"),
      ],
      "rpc:set_segment_color": [okResponse(null), errorResponse("XR001", "segment_color_key: no")],
    });
    const colors = await listSegmentColors(db, "r1");
    expect(colors.ok && [...colors.data]).toEqual([["act i", "cat-2"]]);
    expect((await listSegmentColors(db, "r1")).ok).toBe(false);
    expect((await setSegmentColor(db, "r1", "Act I", null)).ok).toBe(true);
    expect(argsOf(calls[2])).toEqual({
      p_run_of_show_id: "r1",
      p_segment: "Act I",
      p_color_key: null,
    });
    expect((await setSegmentColor(db, "r1", "Act I", "cat-1")).ok).toBe(false);
  });
});

describe("cue field audiences and choice colours (2920)", () => {
  it("keeps Person, Money and Email with the crew", () => {
    expect(CUE_FIELD_AUDIENCES).toEqual(["Crew", "Showcaller", "Client"]);
    expect(audiencesFor("Choice")).toEqual(CUE_FIELD_AUDIENCES);
    expect(audiencesFor("Person")).toEqual(["Crew"]);
    expect(audiencesFor("Money")).toEqual(["Crew"]);
    expect(audiencesFor("Email")).toEqual(["Crew"]);
  });

  it("reads audiences by field in their order", async () => {
    const { db } = fakeClient({
      "from:cue_field_audiences": [
        okResponse([
          { custom_field_definition_id: "f1", audience: "Client" },
          { custom_field_definition_id: "f1", audience: "Crew" },
          { custom_field_definition_id: "f2", audience: "Crew" },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    const read = await listCueFieldAudiences(db, "o1");
    expect(read.ok && read.data.get("f1")).toEqual(["Crew", "Client"]);
    expect(read.ok && read.data.get("f2")).toEqual(["Crew"]);
    expect((await listCueFieldAudiences(db, "o1")).ok).toBe(false);
  });

  it("adds the missing audiences and removes the rest", async () => {
    const { db, calls } = fakeClient({
      "from:cue_field_audiences": [
        okResponse([
          { id: "a1", audience: "Crew" },
          { id: "a2", audience: "Client" },
        ]),
        okResponse(null),
        okResponse(null),
        errorResponse("XR001", "cue_field_audience_type: no"),
      ],
    });
    expect((await setCueFieldAudiences(db, "f1", ["Crew", "Showcaller"])).ok).toBe(true);
    expect(stepOf(calls[1], "in")?.[0]).toEqual(["id", ["a2"]]);
    expect(stepOf(calls[2], "insert")?.[0]?.[0]).toEqual([
      { custom_field_definition_id: "f1", audience: "Showcaller" },
    ]);
    const refused = await setCueFieldAudiences(db, "f1", []);
    expect(refused.ok).toBe(false);
  });

  it("adds a choice with a colour and recolours one", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_choices": [
        okResponse({ id: "ch1" }),
        okResponse([{ id: "ch1" }]),
        okResponse([]),
      ],
    });
    expect(
      await addCustomFieldChoice(db, {
        orgId: "o1",
        fieldId: "f1",
        key: "wide",
        label: "Wide",
        sortOrder: 1,
        colorKey: "cat-3",
      }),
    ).toEqual({ ok: true, data: { id: "ch1" } });
    expect(stepOf(calls[0], "insert")?.[0]?.[0]).toMatchObject({ color_key: "cat-3" });
    expect((await setCustomFieldChoiceColor(db, "ch1", null)).ok).toBe(true);
    expect((await setCustomFieldChoiceColor(db, "missing", "cat-1")).ok).toBe(false);
  });

  it("reads a Client's cue fields in field order, and nothing for no cues", async () => {
    expect(await readClientCueFields({} as XosClient, [])).toEqual({ ok: true, data: [] });
    const queue = [
      okResponse([
        {
          cue_id: "c1",
          field_key: "b",
          label: "B",
          data_type: "Text",
          sort_order: 2,
          value_text: "x",
        },
        {
          cue_id: "c1",
          field_key: "a",
          label: "A",
          data_type: "Choice",
          sort_order: 1,
          choice_label: "Wide",
          choice_color_key: "cat-3",
        },
      ]),
      errorResponse("42501", "denied"),
    ];
    const db = {
      schema: () => ({
        from: () => ({ select: () => ({ in: async () => queue.shift() }) }),
      }),
    } as unknown as XosClient;
    const read = await readClientCueFields(db, ["c1"]);
    expect(read.ok && read.data.map((f) => f.key)).toEqual(["a", "b"]);
    expect(read.ok && read.data[0]).toMatchObject({ choiceLabel: "Wide", choiceColorKey: "cat-3" });
    expect((await readClientCueFields(db, ["c1"])).ok).toBe(false);
  });
});

describe("segment library (2921)", () => {
  it("lists segments with their live cue counts", async () => {
    const { db } = fakeClient({
      "from:segment_library": [
        okResponse([
          {
            id: "s1",
            name: "Awards",
            description: null,
            color_key: "cat-4",
            version: 3,
            updated_at: "t",
            cues: [
              { id: "a", deleted_at: null },
              { id: "b", deleted_at: "t" },
            ],
          },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    const list = await listLibrarySegments(db, "o1");
    expect(list.ok && list.data[0]).toMatchObject({ colorKey: "cat-4", version: 3, cueCount: 1 });
    expect((await listLibrarySegments(db, "o1")).ok).toBe(false);
  });

  it("reads one segment with its cues and department calls in order", async () => {
    const { db } = fakeClient({
      "from:segment_library": [
        okResponse({
          id: "s1",
          name: "Awards",
          description: "Three awards",
          color_key: "nope",
          version: 2,
          updated_at: "t",
          cues: [],
          detail: [
            {
              id: "lc2",
              position: 2,
              label: "Walk-off",
              duration: null,
              description: null,
              script: null,
              deleted_at: null,
              calls: [],
            },
            {
              id: "lc1",
              position: 1,
              label: "Award One",
              duration: "00:04:00",
              description: null,
              script: "Welcome",
              deleted_at: null,
              calls: [
                { call_kind: "Lighting", instruction: "LX 40", deleted_at: null },
                { call_kind: "Audio", instruction: "Mic", deleted_at: null },
                { call_kind: "Video", instruction: "Old", deleted_at: "t" },
              ],
            },
            {
              id: "gone",
              position: 3,
              label: "Gone",
              duration: null,
              description: null,
              script: null,
              deleted_at: "t",
              calls: null,
            },
          ],
        }),
        okResponse(null),
        errorResponse("42501", "denied"),
      ],
    });
    const detail = await getLibrarySegment(db, "s1");
    expect(detail.ok && detail.data.colorKey).toBeNull();
    expect(detail.ok && detail.data.cues.map((c) => c.id)).toEqual(["lc1", "lc2"]);
    expect(detail.ok && detail.data.cues[0]?.calls.map((c) => c.kind)).toEqual([
      "Audio",
      "Lighting",
    ]);
    expect(detail.ok && detail.data.cues[0]?.durationSeconds).toBe(240);
    expect(await getLibrarySegment(db, "s1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getLibrarySegment(db, "s1")).ok).toBe(false);
  });

  it("creates, edits and removes segments", async () => {
    const { db, calls } = fakeClient({
      "from:segment_library": [
        okResponse({ id: "s1" }),
        okResponse([{ id: "s1" }]),
        okResponse([]),
        okResponse([{ id: "s1" }]),
        okResponse([]),
        errorResponse("23505", "duplicate"),
      ],
    });
    const input = { orgId: "o1", name: " Awards ", description: "  ", colorKey: "cat-4" as const };
    expect(await saveLibrarySegment(db, input)).toEqual({ ok: true, data: { id: "s1" } });
    expect(stepOf(calls[0], "insert")?.[0]?.[0]).toEqual({
      org_id: "o1",
      name: "Awards",
      description: null,
      color_key: "cat-4",
    });
    expect((await saveLibrarySegment(db, { ...input, id: "s1" })).ok).toBe(true);
    expect((await saveLibrarySegment(db, { ...input, id: "s9" })).ok).toBe(false);
    expect((await removeLibrarySegment(db, "s1")).ok).toBe(true);
    expect((await removeLibrarySegment(db, "s9")).ok).toBe(false);
    expect((await saveLibrarySegment(db, input)).ok).toBe(false);
  });

  it("adds a cue at the end, edits and removes cues", async () => {
    const { db, calls } = fakeClient({
      "from:segment_library_cues": [
        okResponse([{ position: 1 }, { position: 4 }]),
        okResponse({ id: "lc5" }),
        okResponse([{ id: "lc5" }]),
        okResponse([{ id: "lc5" }]),
        okResponse([]),
        errorResponse("42501", "denied"),
      ],
    });
    const cue = {
      segmentId: "s1",
      label: " Award ",
      durationSeconds: 60,
      description: null,
      script: "",
    };
    expect(await saveLibraryCue(db, cue)).toEqual({ ok: true, data: { id: "lc5" } });
    expect(stepOf(calls[1], "insert")?.[0]?.[0]).toEqual({
      segment_library_id: "s1",
      position: 5,
      label: "Award",
      duration: "60 seconds",
      description: null,
      script: null,
    });
    expect((await saveLibraryCue(db, { ...cue, id: "lc5", durationSeconds: null })).ok).toBe(true);
    expect((await removeLibraryCue(db, "lc5")).ok).toBe(true);
    expect((await removeLibraryCue(db, "lc9")).ok).toBe(false);
    expect((await saveLibraryCue(db, cue)).ok).toBe(false);
  });

  it("saves a library cue's calls: upsert, clear and leave the rest", async () => {
    const { db, calls } = fakeClient({
      "from:segment_library_cue_calls": [
        okResponse([{ id: "k1", call_kind: "Lighting" }]),
        okResponse(null),
        okResponse(null),
        okResponse([{ id: "k1", call_kind: "Lighting" }]),
        errorResponse("23514", "too long"),
        errorResponse("42501", "denied"),
      ],
    });
    expect(
      (await saveLibraryCueCalls(db, "lc1", { Lighting: "LX 41", Audio: "Mic", Video: "  " })).ok,
    ).toBe(true);
    expect(stepOf(calls[1], "update")?.[0]?.[0]).toEqual({ instruction: "LX 41" });
    expect(stepOf(calls[2], "insert")?.[0]?.[0]).toEqual({
      segment_library_cue_id: "lc1",
      call_kind: "Audio",
      instruction: "Mic",
    });
    expect((await saveLibraryCueCalls(db, "lc1", { Lighting: null })).ok).toBe(false);
    expect((await saveLibraryCueCalls(db, "lc1", {})).ok).toBe(false);
  });

  it("inserts into a running order and publishes", async () => {
    const { db, calls } = fakeClient({
      "rpc:insert_library_segment": [
        okResponse("i1"),
        errorResponse("XR001", "segment_insert_before_called: no"),
      ],
      "rpc:publish_library_segment": [
        okResponse([
          { run_of_show_id: "r1", segment_instance_id: "i1", outcome: "Published" },
          { run_of_show_id: "r2", segment_instance_id: null, outcome: "No Instance" },
          { run_of_show_id: "r3", segment_instance_id: "i3", outcome: "Strange" },
        ]),
        errorResponse("XR001", "segment_publish_runs: no"),
      ],
    });
    const insert = {
      runOfShowId: "r1",
      segmentId: "s1",
      beforePosition: 3,
      startsAt: "2027-06-05T23:30:00Z",
    };
    expect(await insertLibrarySegment(db, insert)).toEqual({
      ok: true,
      data: { instanceId: "i1" },
    });
    expect(argsOf(calls[0])).toEqual({
      p_run_of_show_id: "r1",
      p_segment_library_id: "s1",
      p_before_position: 3,
      p_starts_at: "2027-06-05T23:30:00Z",
    });
    expect((await insertLibrarySegment(db, insert)).ok).toBe(false);
    const published = await publishLibrarySegment(db, "s1", ["r1", "r2", "r3"]);
    expect(published.ok && published.data.map((r) => r.outcome)).toEqual([
      "Published",
      "No Instance",
      "No Instance",
    ]);
    expect((await publishLibrarySegment(db, "s1", [])).ok).toBe(false);
  });

  it("lists the running orders holding a copy, by show day", async () => {
    const { db } = fakeClient({
      "from:run_segment_instances": [
        okResponse([
          {
            id: "i2",
            run_of_show_id: "r2",
            library_version: 2,
            run: { name: "B", show_date: "2027-06-06" },
          },
          {
            id: "i1",
            run_of_show_id: "r1",
            library_version: 1,
            run: { name: "A", show_date: "2027-06-05" },
          },
          { id: "i3", run_of_show_id: "r3", library_version: 1, run: null },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    const copies = await listSegmentCopies(db, "s1");
    expect(copies.ok && copies.data.map((c) => c.instanceId)).toEqual(["i3", "i1", "i2"]);
    expect((await listSegmentCopies(db, "s1")).ok).toBe(false);
  });
});

describe("show channels (2922)", () => {
  it("reads the panel's status", async () => {
    const { db } = fakeClient({
      "rpc:show_channel_status": [
        okResponse([
          {
            channel_exists: true,
            conversation_id: "cv1",
            am_member: true,
            can_join: false,
            can_open: false,
          },
        ]),
        okResponse([]),
        errorResponse("42501", "project not found"),
      ],
    });
    expect(await showChannelStatus(db, "p1")).toEqual({
      ok: true,
      data: { exists: true, conversationId: "cv1", isMember: true, canJoin: false, canOpen: false },
    });
    expect((await showChannelStatus(db, "p1")).ok).toBe(false);
    expect((await showChannelStatus(db, "p1")).ok).toBe(false);
  });

  it("opens and joins, answering the conversation", async () => {
    const { db } = fakeClient({
      "rpc:open_show_channel": [okResponse("cv1"), errorResponse("42501", "denied")],
      "rpc:join_show_channel": [
        okResponse("cv1"),
        errorResponse("XR001", "show_channel_client: never", "show_channel_client"),
      ],
    });
    expect(await openShowChannel(db, "p1")).toEqual({ ok: true, data: { conversationId: "cv1" } });
    expect((await openShowChannel(db, "p1")).ok).toBe(false);
    expect(await joinShowChannel(db, "p1")).toEqual({ ok: true, data: { conversationId: "cv1" } });
    expect((await joinShowChannel(db, "p1")).ok).toBe(false);
  });

  it("counts the unread messages of the channel", async () => {
    const { db } = fakeClient({
      "rpc:my_conversations": [
        okResponse([
          { conversation_id: "x", unread_count: 9 },
          { conversation_id: "cv1", unread_count: 2 },
        ]),
        okResponse([]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await unreadInConversation(db, "o1", "cv1")).toEqual({ ok: true, data: 2 });
    expect(await unreadInConversation(db, "o1", "cv1")).toEqual({ ok: true, data: 0 });
    expect((await unreadInConversation(db, "o1", "cv1")).ok).toBe(false);
  });
});
