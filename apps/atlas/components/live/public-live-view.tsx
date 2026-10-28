import type {
  LiveDaySheetRow,
  LiveRecordRow,
  LiveRunRow,
  LiveView,
  PublicCue,
} from "@xos/data/live-links";
import { getFormatter, getTranslations } from "next-intl/server";

/**
 * The body of a public live view (P1, ADR 0130), drawn from the allowlisted rows of
 * api_public.live_view. Records show as a table for List, Table and Board (in groups when the view
 * groups by an allowlisted field) and as a day-grouped agenda for Calendar and Timeline, in the
 * project's zone. Running orders show their cues; day sheets show their body as plain text, never
 * HTML.
 */

type Format = Awaited<ReturnType<typeof getFormatter>>;

function when(format: Format, iso: string | null, timeZone: string): string {
  return iso
    ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone })
    : "";
}

function minutes(seconds: number | null): string {
  if (seconds === null) return "";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

async function RecordTable({
  rows,
  timeZone,
}: {
  rows: readonly LiveRecordRow[];
  timeZone: string;
}) {
  const t = await getTranslations("compliance.liveLinks");
  const format = await getFormatter();
  const dates = (r: LiveRecordRow) =>
    r.startsAt
      ? r.endsAt
        ? t("range", {
            start: when(format, r.startsAt, timeZone),
            end: when(format, r.endsAt, timeZone),
          })
        : when(format, r.startsAt, timeZone)
      : r.dueAt
        ? t("due", { date: when(format, r.dueAt, timeZone) })
        : t("noDate");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-text-13">
        <thead className="text-text-12 text-text-secondary">
          <tr>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.key")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.title")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.kind")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.state")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.dates")}
            </th>
            <th scope="col" className="py-8 font-medium">
              {t("columns.scopeNode")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-8 pe-12 whitespace-nowrap text-text-secondary">{r.key}</td>
              <td className="py-8 pe-12 text-text-primary">{r.title}</td>
              <td className="py-8 pe-12">{r.subtype ? `${r.kind} · ${r.subtype}` : r.kind}</td>
              <td className="py-8 pe-12">{r.state}</td>
              <td className="py-8 pe-12 whitespace-nowrap">{dates(r)}</td>
              <td className="py-8">{r.scopeNode ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Agenda({ rows, timeZone }: { rows: readonly LiveRecordRow[]; timeZone: string }) {
  const t = await getTranslations("compliance.liveLinks");
  const format = await getFormatter();
  const days = new Map<string, LiveRecordRow[]>();
  for (const r of rows) {
    const at = r.startsAt ?? r.dueAt;
    const day = at ? format.dateTime(new Date(at), { dateStyle: "full", timeZone }) : t("noDate");
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  return (
    <div className="flex flex-col gap-16">
      {[...days].map(([day, list]) => (
        <section key={day} className="flex flex-col gap-4">
          <h2 className="m-0 text-heading-14 font-semibold">{day}</h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {list.map((r) => (
              <li key={r.key} className="flex flex-wrap items-baseline gap-8 py-8 text-text-13">
                <span className="w-[5rem] shrink-0 text-text-secondary">
                  {r.startsAt
                    ? format.dateTime(new Date(r.startsAt), { timeStyle: "short", timeZone })
                    : r.dueAt
                      ? format.dateTime(new Date(r.dueAt), { timeStyle: "short", timeZone })
                      : ""}
                </span>
                <span className="text-text-primary">{r.title}</span>
                <span className="text-text-12 text-text-secondary">
                  {r.kind} · {r.state}
                  {r.scopeNode ? ` · ${r.scopeNode}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

async function CueTable({ cues, timeZone }: { cues: readonly PublicCue[]; timeZone: string }) {
  const t = await getTranslations("compliance.liveLinks");
  const format = await getFormatter();
  const time = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { timeStyle: "short", timeZone }) : "";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-text-13">
        <thead className="text-text-12 text-text-secondary">
          <tr>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.position")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.label")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.segment")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.planned")}
            </th>
            <th scope="col" className="py-8 pe-12 font-medium">
              {t("columns.duration")}
            </th>
            <th scope="col" className="py-8 font-medium">
              {t("columns.called")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {cues.map((c) => (
            <tr key={c.position}>
              <td className="py-8 pe-12 text-text-secondary">{c.position}</td>
              <td className="py-8 pe-12 text-text-primary">{c.label}</td>
              <td className="py-8 pe-12">{c.segment ?? ""}</td>
              <td className="py-8 pe-12 whitespace-nowrap">{time(c.plannedAt)}</td>
              <td className="py-8 pe-12">{minutes(c.durationSeconds)}</td>
              <td className="py-8 whitespace-nowrap">{time(c.calledAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Runs({ rows, timeZone }: { rows: readonly LiveRunRow[]; timeZone: string }) {
  const format = await getFormatter();
  return (
    <div className="flex flex-col gap-24">
      {rows.map((r) => (
        <section key={`${r.showDate}-${r.name}`} className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">
            {r.name}
            <span className="ms-8 text-text-13 font-normal text-text-secondary">
              {format.dateTime(new Date(`${r.showDate}T12:00:00Z`), {
                dateStyle: "full",
                timeZone: "UTC",
              })}
            </span>
          </h2>
          <CueTable cues={r.cues} timeZone={timeZone} />
        </section>
      ))}
    </div>
  );
}

async function DaySheets({ rows }: { rows: readonly LiveDaySheetRow[] }) {
  const format = await getFormatter();
  return (
    <div className="flex flex-col gap-24">
      {rows.map((r) => (
        <section key={r.day} className="flex flex-col gap-8">
          <h2 className="m-0 text-heading-16 font-semibold">
            {format.dateTime(new Date(`${r.day}T12:00:00Z`), {
              dateStyle: "full",
              timeZone: "UTC",
            })}
          </h2>
          {/* Plain text by design: the body is never rendered as HTML on a public page. */}
          <p className="m-0 text-text-14 whitespace-pre-wrap">{r.body}</p>
        </section>
      ))}
    </div>
  );
}

/** The rows of a live view, laid out as its view type says. */
export async function PublicLiveRows({ view }: { view: LiveView }) {
  const t = await getTranslations("compliance.liveLinks");
  const { data, meta } = view;
  if (data.rows.length === 0)
    return <p className="m-0 text-text-14 text-text-secondary">{t("empty")}</p>;
  if (data.collection === "project/schedule") {
    if (meta.viewType === "Calendar" || meta.viewType === "Timeline") {
      return <Agenda rows={data.rows} timeZone={meta.timeZone} />;
    }
    const group = meta.groupByField as keyof LiveRecordRow | null;
    if (group === "kind" || group === "state" || group === "phase") {
      const groups = new Map<string, LiveRecordRow[]>();
      for (const r of data.rows) {
        const key = String(r[group] ?? "");
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return (
        <div className="flex flex-col gap-24">
          {[...groups].map(([name, rows]) => (
            <section key={name} className="flex flex-col gap-8">
              {name ? <h2 className="m-0 text-heading-14 font-semibold">{name}</h2> : null}
              <RecordTable rows={rows} timeZone={meta.timeZone} />
            </section>
          ))}
        </div>
      );
    }
    return <RecordTable rows={data.rows} timeZone={meta.timeZone} />;
  }
  if (data.collection === "show/day_sheets") return <DaySheets rows={data.rows} />;
  return <Runs rows={data.rows} timeZone={meta.timeZone} />;
}
