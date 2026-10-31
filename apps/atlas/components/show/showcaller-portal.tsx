"use client";

import { CUE_CALL_KINDS, CUE_CALL_SLUGS, type CueCallKind, type RunOfShow } from "@xos/data/show";
import {
  consoleCalls,
  consoleCue,
  displayCue,
  showcallerLinkGone,
  showcallerPath,
  type ShowcallerCue,
  type ShowcallerField,
  type ShowcallerRefusal,
  type ShowcallerRun,
  type ShowcallerWrite,
} from "@xos/data/showcaller-links";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import type { Platform } from "@xos/schemas/shortcuts/keys";
import { Button, Checkbox, IconButton, InlineAlert, Input, Switch, Tag, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import type { ActionResult } from "@/components/work/action-result";
import { fromLocalInput, toLocalInput } from "@/components/work/format";
import { portalWriteAction } from "@/lib/showcaller/actions";
import { clockChannelName } from "@/lib/showcaller/clock-channel";
import { ShowcallerConsole, type ShowcallerTransport } from "./showcaller-console";
import { defaultShowKeys } from "./show-keys";

/**
 * The showcaller portal (B3, G-80, ADR 0142): what someone with a showcaller link's code sees, outside the Atlas
 * shell and with no account. It reuses the Atlas showcaller console with the portal's transport (the
 * api_public.showcaller_* RPCs under the link's token and this device's grant) and the show scope's default keys
 * from the shortcut registry, and adds what the outside showcaller edits: uncalled cues' label, time, length,
 * segment, description, script and department calls, adding, moving and removing cues, and the Showcaller-audience
 * fields. Character key shortcuts can be turned off (WCAG 2.1.4; the preference is kept on this device), while the
 * Stream Deck's F13 to F20 always answer. Open clock pops out the room clock and presenter timer, which this page
 * feeds through a BroadcastChannel so the clock window never reads on its own while the portal is open.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Where this device keeps the character key choice. */
const SINGLE_KEYS_STORAGE = "xos-showcaller-single-keys";
/** The portal warns this long before the device's grant ends. */
const GRANT_WARNING_MS = 30 * 60_000;

function platformOf(): Platform {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "mac"
    : "other";
}

/** The character key choice as the shell applies it: data-shortcuts="off" on the document root. */
function applySingleKeys(on: boolean) {
  if (on) delete document.documentElement.dataset["shortcuts"];
  else document.documentElement.dataset["shortcuts"] = "off";
}

/** The choice made on this page, for a browser that refuses storage (a private window). */
let chosenSingleKeys: boolean | null = null;
const SINGLE_KEYS_EVENT = "xos-showcaller-single-keys";

function readSingleKeys(): boolean {
  if (chosenSingleKeys !== null) return chosenSingleKeys;
  try {
    return window.localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off";
  } catch {
    return true;
  }
}

function writeSingleKeys(on: boolean) {
  chosenSingleKeys = on;
  try {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE, on ? "on" : "off");
  } catch {
    // Private windows may refuse storage; the choice still holds for this page.
  }
  window.dispatchEvent(new Event(SINGLE_KEYS_EVENT));
}

function subscribeSingleKeys(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(SINGLE_KEYS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SINGLE_KEYS_EVENT, onChange);
  };
}

function fieldText(
  field: ShowcallerField,
  format: ReturnType<typeof useFormatter>,
  t: Translate,
): string {
  if (field.choiceLabel !== null) return field.choiceLabel;
  if (field.boolean !== null) return field.boolean ? t("yes") : t("no");
  if (field.number !== null) return format.number(field.number);
  if (field.timestamp !== null)
    return format.dateTime(new Date(field.timestamp), { dateStyle: "medium", timeStyle: "short" });
  if (field.date !== null)
    return format.dateTime(new Date(`${field.date}T00:00:00Z`), {
      dateStyle: "medium",
      timeZone: "UTC",
    });
  return field.text ?? "";
}

/** One uncalled cue edited in place: the fields the portal may write and the five department calls. */
function PortalCueEditor({
  cue,
  timeZone,
  showDate,
  write,
  onClose,
}: {
  cue: ShowcallerCue;
  timeZone: string;
  showDate: string;
  write: (w: ShowcallerWrite) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useTranslations("compliance.showcallerPortal") as unknown as Translate;
  const show = useTranslations("show") as unknown as Translate;
  const [pending, start] = useTransition();
  const [label, setLabel] = useState(cue.label);
  const [planned, setPlanned] = useState(
    cue.plannedAt ? toLocalInput(cue.plannedAt, timeZone).slice(11, 16) : "",
  );
  const [tbc, setTbc] = useState(cue.startTbc);
  const [duration, setDuration] = useState(
    cue.durationSeconds === null ? "" : String(cue.durationSeconds),
  );
  const [segment, setSegment] = useState(cue.segment ?? "");
  const [description, setDescription] = useState(cue.description ?? "");
  const [script, setScript] = useState(cue.script ?? "");
  const initial = Object.fromEntries(
    CUE_CALL_KINDS.map((k) => [k, cue.calls.find((c) => c.kind === k)?.instruction ?? ""]),
  ) as Record<CueCallKind, string>;
  const [calls, setCalls] = useState(initial);
  const day = cue.plannedAt ? toLocalInput(cue.plannedAt, timeZone).slice(0, 10) : showDate;
  const submit = () =>
    start(async () => {
      const saved = await write({
        op: "save",
        cueId: cue.id,
        expectedUpdatedAt: cue.updatedAt,
        fields: {
          label,
          plannedAt: planned ? fromLocalInput(`${day}T${planned}`, timeZone) : null,
          startTbc: planned !== "" && tbc,
          durationSeconds: duration === "" ? null : Number(duration),
          segment: segment.trim() === "" ? null : segment,
          description: description.trim() === "" ? null : description,
          script: script === "" ? null : script,
        },
      });
      if (!saved) return;
      const changed = Object.fromEntries(
        CUE_CALL_KINDS.filter((k) => calls[k].trim() !== initial[k].trim()).map((k) => [
          k,
          calls[k].trim() === "" ? null : calls[k].trim(),
        ]),
      );
      if (
        Object.keys(changed).length > 0 &&
        !(await write({ op: "calls", cueId: cue.id, calls: changed }))
      )
        return;
      onClose();
    });
  return (
    <form
      aria-label={show("cues.editing", { label: cue.label })}
      className="flex w-full flex-col gap-8 py-6"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`portal-label-${cue.id}`}
          label={show("cues.label")}
          maxLength={200}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          id={`portal-time-${cue.id}`}
          type="time"
          label={show("cues.planned")}
          value={planned}
          onChange={(e) => setPlanned(e.target.value)}
        />
        <Checkbox
          label={show("cues.tbc")}
          checked={planned !== "" && tbc}
          disabled={planned === ""}
          onChange={(e) => setTbc(e.target.checked)}
        />
        <Input
          id={`portal-duration-${cue.id}`}
          type="number"
          min={0}
          max={86400}
          width={120}
          label={show("cues.duration")}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <Input
          id={`portal-segment-${cue.id}`}
          label={show("cues.segment")}
          maxLength={200}
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
        />
      </div>
      <Textarea
        id={`portal-description-${cue.id}`}
        label={show("cues.description")}
        rows={2}
        maxLength={2000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Textarea
        id={`portal-script-${cue.id}`}
        label={show("cues.script")}
        rows={4}
        maxLength={20000}
        value={script}
        onChange={(e) => setScript(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-8 max-sm:grid-cols-1">
        {CUE_CALL_KINDS.map((k) => (
          <Textarea
            key={k}
            id={`portal-call-${CUE_CALL_SLUGS[k]}-${cue.id}`}
            label={show("cues.callFor", {
              department: show(`cues.departments.${CUE_CALL_SLUGS[k]}`),
            })}
            rows={2}
            maxLength={2000}
            value={calls[k]}
            onChange={(e) => setCalls((v) => ({ ...v, [k]: e.target.value }))}
          />
        ))}
      </div>
      <div className="flex gap-8">
        <Button type="submit" variant="primary" loading={pending} disabled={label.trim() === ""}>
          {show("cues.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {show("cues.cancel")}
        </Button>
      </div>
      <p className="m-0 text-text-12 text-text-secondary">{t("editNote")}</p>
    </form>
  );
}

export function ShowcallerPortal({ token, run }: { token: string; run: ShowcallerRun }) {
  const t = useTranslations("compliance.showcallerPortal") as unknown as Translate;
  const show = useTranslations("show") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const [department, setDepartment] = useState<CueCallKind | null>(null);
  const [refusal, setRefusal] = useState<ShowcallerRefusal | "unexpected" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const singleKeys = useSyncExternalStore(subscribeSingleKeys, readSingleKeys, () => true);
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const meta = run.meta;

  useEffect(() => applySingleKeys(singleKeys), [singleKeys]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The pop-out clock follows this page: every read is handed to it, so it never reads on its own meanwhile.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(clockChannelName(token));
    channel.postMessage({
      cues: run.cues.map(displayCue),
      name: meta.name,
      projectName: meta.projectName,
      brandName: meta.brandName,
      timeZone: meta.timeZone,
      serverNow: run.serverNow,
    });
    return () => channel.close();
  }, [token, run, meta]);

  const write = async (w: ShowcallerWrite): Promise<boolean> => {
    setRefusal(null);
    const result = await portalWriteAction(token, w);
    router.refresh();
    if (!result.ok) {
      setRefusal(result.reason);
      return false;
    }
    return true;
  };
  /** The console's errors in its own catalog: cue rules by rule, anything else as the portal's sentence. */
  const asAction = async (w: ShowcallerWrite): Promise<ActionResult> => {
    const result = await portalWriteAction(token, w);
    router.refresh();
    if (result.ok) return { ok: true, data: null };
    return {
      ok: false,
      error: result.reason.startsWith("cue_")
        ? { key: `rules.${result.reason}` }
        : { key: "refused", detail: t(`refusals.${result.reason}`) },
    };
  };
  const transport: ShowcallerTransport = {
    call: (cueId) => asAction({ op: "call", cueId }),
    standby: (cueId) => asAction({ op: "standby", cueId }),
    nudge: (seconds) => asAction({ op: "shift", seconds }),
  };

  const runOfShow: RunOfShow = {
    id: "portal",
    projectId: "",
    projectKey: "",
    projectName: meta.projectName,
    timeZone: meta.timeZone,
    scopeNodeId: null,
    name: meta.name,
    showDate: meta.showDate,
    cueCount: run.cues.length,
    calledCount: run.cues.filter((c) => c.calledAt !== null).length,
    curfewAt: meta.curfewAt,
  };
  const cues = useMemo(() => run.cues.map((c) => consoleCue(c, "portal")), [run.cues]);
  const calls = useMemo(() => consoleCalls(run.cues), [run.cues]);
  const shortcuts = useMemo(
    () => ({
      platform: platformOf(),
      scoped: defaultShowKeys(SHORTCUT_REGISTRY.shells.atlas, platformOf()),
    }),
    [],
  );
  const lastCalled = run.cues.reduce((last, c, i) => (c.calledAt ? i : last), -1);
  const grantEnds = Date.parse(meta.grantExpiresAt);
  const time = (iso: string) =>
    format.dateTime(new Date(iso), { timeStyle: "short", timeZone: meta.timeZone });

  return (
    <div className="mx-auto flex max-w-layout-wide flex-col gap-16 p-16">
      <header className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex flex-col gap-2">
          <span className="text-text-12 text-text-secondary">{meta.brandName}</span>
          <h1 className="m-0 text-heading-24 font-semibold">{meta.name}</h1>
          <span className="text-text-13 text-text-secondary">
            {[
              meta.projectName,
              meta.stage,
              format.dateTime(new Date(`${meta.showDate}T12:00:00Z`), {
                dateStyle: "full",
                timeZone: "UTC",
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="text-text-12 text-text-secondary">
            {t("callingAs", { name: meta.callerName })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-12">
          <Switch
            label={t("singleKeys")}
            checked={singleKeys}
            onChange={(e) => writeSingleKeys(e.target.checked)}
          />
          <Button
            variant="secondary"
            icon="Timer"
            onClick={() =>
              window.open(`${showcallerPath(token)}/clock`, "xos-showcaller-clock", "popup")
            }
          >
            {t("openClock")}
          </Button>
        </div>
      </header>

      {Number.isFinite(grantEnds) && grantEnds - now < GRANT_WARNING_MS ? (
        <InlineAlert tone="warning">
          {t("grantEnding", { time: time(meta.grantExpiresAt) })}
        </InlineAlert>
      ) : null}
      {refusal ? (
        <InlineAlert
          tone={refusal !== "unexpected" && showcallerLinkGone(refusal) ? "danger" : "warning"}
        >
          {t(`refusals.${refusal}`)}
        </InlineAlert>
      ) : null}

      <ShowcallerConsole
        org=""
        run={runOfShow}
        cues={cues}
        calls={calls}
        department={department}
        onDepartment={setDepartment}
        transport={transport}
        shortcuts={shortcuts}
      />

      <section aria-labelledby="portal-cues" className="flex flex-col gap-8">
        <h2 id="portal-cues" className="m-0 text-label-13 font-semibold">
          {show("cues.title")}
        </h2>
        <ol className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {run.cues.map((c, i) => {
            if (editing === c.id) {
              return (
                <li key={c.id} className="flex py-6">
                  <PortalCueEditor
                    cue={c}
                    timeZone={meta.timeZone}
                    showDate={meta.showDate}
                    write={write}
                    onClose={() => setEditing(null)}
                  />
                </li>
              );
            }
            const movable = c.calledAt === null;
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-8 py-6">
                <span className="flex flex-col gap-2">
                  {c.segment &&
                  (c.segment ?? "").trim().toLowerCase() !==
                    (run.cues[i - 1]?.segment ?? "").trim().toLowerCase() ? (
                    c.segmentColor ? (
                      <Tag swatch={c.segmentColor}>{c.segment}</Tag>
                    ) : (
                      <span className="text-text-12 font-semibold text-text-secondary">
                        {c.segment}
                      </span>
                    )
                  ) : null}
                  <span className="flex items-baseline gap-8">
                    <span className="font-mono text-text-12 text-text-secondary">{c.position}</span>
                    <span className="text-text-14">{c.label}</span>
                    {c.plannedAt ? (
                      <span className="text-text-12 text-text-secondary">
                        {c.startTbc
                          ? show("cues.tbcEstimate", { time: time(c.plannedAt) })
                          : time(c.plannedAt)}
                      </span>
                    ) : null}
                  </span>
                  {c.fields.length > 0 ? (
                    <span className="flex flex-wrap gap-4">
                      {c.fields.map((f) => (
                        <Tag key={f.key} {...(f.colorKey ? { swatch: f.colorKey } : {})}>
                          {t("fieldValue", { label: f.label, value: fieldText(f, format, t) })}
                        </Tag>
                      ))}
                    </span>
                  ) : null}
                  {c.calls
                    .filter((k) => department === null || k.kind === department)
                    .map((k) => (
                      <span key={k.kind} className="text-text-12 text-text-secondary">
                        {show("cues.callLine", {
                          department: show(`cues.departments.${CUE_CALL_SLUGS[k.kind]}`),
                          instruction: k.instruction,
                        })}
                      </span>
                    ))}
                </span>
                <span className="flex items-center gap-4">
                  <span className="text-text-12 text-text-secondary">
                    {c.calledAt ? t("called", { time: time(c.calledAt) }) : show("cues.notCalled")}
                  </span>
                  {movable ? (
                    <>
                      <IconButton
                        icon="Pencil"
                        label={show("cues.edit", { label: c.label })}
                        onClick={() => setEditing(c.id)}
                      />
                      <IconButton
                        icon="ArrowUp"
                        label={show("cues.moveUp", { label: c.label })}
                        disabled={i === 0 || i - 1 <= lastCalled}
                        onClick={() =>
                          start(
                            async () =>
                              void (await write({ op: "move", cueId: c.id, toPosition: i })),
                          )
                        }
                      />
                      <IconButton
                        icon="ArrowDown"
                        label={show("cues.moveDown", { label: c.label })}
                        disabled={i === run.cues.length - 1}
                        onClick={() =>
                          start(
                            async () =>
                              void (await write({ op: "move", cueId: c.id, toPosition: i + 2 })),
                          )
                        }
                      />
                      <IconButton
                        icon="X"
                        label={show("cues.remove", { label: c.label })}
                        onClick={() =>
                          start(async () => void (await write({ op: "remove", cueId: c.id })))
                        }
                      />
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
        <form
          className="flex flex-wrap items-end gap-8"
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            const label = adding.trim();
            if (label === "") return;
            start(async () => {
              if (
                await write({ op: "save", cueId: null, fields: { label }, expectedUpdatedAt: null })
              )
                setAdding("");
            });
          }}
        >
          <Input
            id="portal-add-label"
            label={show("cues.label")}
            placeholder={show("cues.labelExample")}
            maxLength={200}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          />
          <Button type="submit" disabled={adding.trim() === ""} loading={pending}>
            {show("cues.add")}
          </Button>
        </form>
      </section>
      <p className="m-0 text-text-12 text-text-secondary">
        {t("expires", {
          date: format.dateTime(new Date(meta.expiresAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
    </div>
  );
}
