import { readView, type ExternalRow } from "@xos/data/gateway";
import {
  listEngagementAllocations,
  namesClosed,
  type EngagedAllocation,
} from "@xos/data/gateway-allocations";
import { listEngagementOfferings } from "@xos/data/offerings";
import { listEngagementRoster, type RosterEntry } from "@xos/data/roster";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { RegionError, Section } from "@/components/page/page";
import { enumKey } from "@/lib/enum-key";
import { tabHref } from "@/lib/engagement";
import { formatDateTime } from "@/lib/format";
import { listEngagedGuests } from "@/lib/party";
import { allocationTone } from "@/lib/roster-member";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { AdvanceFileForm, AdvanceLinesForm, GuestListConfirmForm } from "./advance-forms";
import { AdvanceAnswerForm } from "./forms";
import { GuestRequestForm } from "./party-forms";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * The Advance tab (Section 4.4.4; R9, migrations 2710 to 2716): the sent packets the party answers,
 * each section by its kind. Text keeps the free answer; File uploads through the scanned party-uploads
 * bucket; Schedule Window proposes windows; Item Request and Credential Request ask for the section's
 * choices, which become allocations the producer's review decides; Crew Roster reads the roster;
 * Guest List keeps the guest list and its cap. Contractors and sponsors get the same tab without a
 * guest list (ADR 0100, prompt lines 917 to 926). Each line shows its allocation's computed stage.
 */

type SectionRow = ExternalRow<"advance_sections">;
type SubmissionRow = ExternalRow<"advance_submissions">;
type LineRow = ExternalRow<"advance_submission_lines">;
type FileRow = ExternalRow<"advance_submission_files">;
type ChoiceRow = ExternalRow<"advance_section_choices">;

interface Context {
  readonly t: Translate;
  readonly locale: string;
  readonly engagementKey: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly engagementId: string;
  readonly timeZone: string;
  readonly roleType: string;
  readonly recipient: ExternalRow<"my_advance_recipients"> | undefined;
  readonly choices: readonly ChoiceRow[];
  readonly lines: readonly LineRow[];
  readonly files: readonly FileRow[];
  readonly allocations: ReadonlyMap<string, EngagedAllocation>;
  readonly entries: readonly RosterEntry[];
  readonly guests: {
    readonly used: number;
    readonly cap: number | null;
    readonly offered: boolean;
  };
}

export async function AdvanceTab({ view, t, locale, engagementKey }: TabProps) {
  const db = view.ctx.db;
  const { engagement } = view;
  const [packets, recipients] = await Promise.all([
    readView(db, "advance_packets", {
      eq: { project_id: engagement.projectId },
      order: ["due_at", "asc"],
    }),
    readView(db, "my_advance_recipients", {}),
  ]);
  if (!packets.ok || !recipients.ok) return <RegionError />;
  if (packets.data.length === 0) {
    return (
      <TabEmpty
        icon="ClipboardList"
        sentence={t("gateway.engagement.advance.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  const packetIds = packets.data.flatMap((p) => (p.id ? [p.id] : []));
  const [sections, submissions] = await Promise.all([
    readView(db, "advance_sections", {
      in: ["advance_packet_id", packetIds],
      order: ["position", "asc"],
    }),
    readView(db, "advance_submissions", { order: ["submitted_at", "desc"] }),
  ]);
  if (!sections.ok || !submissions.ok) return <RegionError />;
  const sectionIds = sections.data.flatMap((s) => (s.id ? [s.id] : []));
  const submissionIds = submissions.data.flatMap((s) => (s.id ? [s.id] : []));
  const typed = sections.data.some((s) => s.section_kind !== "Text");
  const [choices, lines, files, allocations, roster, offerings, guests] = await Promise.all([
    readView(db, "advance_section_choices", { in: ["advance_section_id", sectionIds] }),
    readView(db, "advance_submission_lines", {
      in: ["advance_submission_id", submissionIds],
      order: ["line_number", "asc"],
    }),
    readView(db, "advance_submission_files", {
      in: ["advance_submission_id", submissionIds],
      order: ["position", "asc"],
    }),
    typed
      ? listEngagementAllocations(db, engagement.id)
      : Promise.resolve({ ok: true as const, data: [] }),
    typed
      ? listEngagementRoster(db, engagement.id)
      : Promise.resolve({ ok: true as const, data: [] }),
    sections.data.some((s) => s.section_kind === "Guest List")
      ? listEngagementOfferings(db, engagement.id)
      : Promise.resolve({ ok: true as const, data: [] }),
    sections.data.some((s) => s.section_kind === "Guest List")
      ? listEngagedGuests(db, engagement.id)
      : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  if (
    !choices.ok ||
    !lines.ok ||
    !files.ok ||
    !allocations.ok ||
    !roster.ok ||
    !offerings.ok ||
    !guests.ok
  ) {
    return <RegionError />;
  }
  const guestOffer = offerings.data.find((o) => o.offering === "Guest List");
  const base = {
    t,
    locale,
    engagementKey,
    orgId: engagement.orgId,
    orgName: engagement.orgName,
    engagementId: engagement.id,
    timeZone: engagement.projectTimeZone,
    roleType: engagement.roleType,
    choices: choices.data,
    lines: lines.data,
    files: files.data,
    allocations: new Map(allocations.data.map((a) => [a.id, a])),
    entries: roster.data,
    guests: {
      used: guests.data
        .filter((g) => g.state !== "Declined")
        .reduce((n, g) => n + 1 + g.plusOnes, 0),
      cap: guestOffer?.capPerEngagement ?? null,
      offered: guestOffer !== undefined && guestOffer.mode !== "Not Offered",
    },
  };
  return (
    <div className="flex flex-col gap-24">
      {packets.data.map((packet) => {
        // The recipient this engagement answers as: the one linked to it, else the packet's only one.
        const mine = recipients.data.filter((r) => r.advance_packet_id === packet.id);
        const recipient =
          mine.find((r) => r.engagement_id === engagement.id) ??
          mine.find((r) => r.engagement_id === null);
        const ctx: Context = { ...base, recipient };
        return (
          <Section key={packet.id ?? ""} id={`packet-${packet.id}`} title={packet.title ?? ""}>
            {packet.due_at ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("gateway.engagement.due", { date: formatDateTime(locale, packet.due_at) })}
              </p>
            ) : null}
            <RowList
              label={packet.title ?? ""}
              items={sections.data
                .filter((s) => s.advance_packet_id === packet.id)
                .map((s) => sectionRow(s, submissions.data, ctx))}
            />
          </Section>
        );
      })}
    </div>
  );
}

function sectionRow(s: SectionRow, submissions: readonly SubmissionRow[], ctx: Context) {
  const { t, recipient } = ctx;
  const kind = s.section_kind ?? "Text";
  const latest = submissions.find(
    (sub) =>
      sub.advance_section_id === s.id && (!recipient || sub.advance_recipient_id === recipient.id),
  );
  const returned = latest?.review_outcome === "Returned";
  const open = Boolean(recipient?.id && s.id && (!latest || returned)) && kind !== "Crew Roster";
  return {
    id: s.id ?? "",
    title: `${s.position}. ${s.title ?? ""}`,
    meta: [t(`gateway.engagement.advance.kinds.${enumKey(kind)}`), s.prompt],
    ...(latest
      ? {
          tag: latest.review_outcome
            ? {
                label: t(enumLabelKey("advanceReviewOutcome", latest.review_outcome)),
                tone: toneFor(latest.review_outcome === "Accepted" ? "Accepted" : "Returned"),
              }
            : { label: t("gateway.engagement.advance.awaitingReview"), tone: "accent" as const },
        }
      : {}),
    detail: (
      <div className="flex flex-col gap-8">
        {latest && kind === "Text" ? (
          <p className="m-0 whitespace-pre-line rounded-control bg-bg-surface p-8 text-text-13">
            {latest.body}
          </p>
        ) : null}
        {latest && kind !== "Text" ? <AnswerDetail answer={latest} kind={kind} ctx={ctx} /> : null}
        {latest?.recorded_by_producer ? (
          // B15 (ADR 0154): an answer the org recorded from an Aurora draft says so; project inbox mail can
          // come from anyone, so the label never claims the party sent it.
          <p className="m-0 text-text-12 text-text-secondary" data-testid="recorded-by-producer">
            {t(
              latest.recorded_from_message
                ? "gateway.engagement.advance.recordedFromMessage"
                : "gateway.engagement.advance.recordedBy",
              { org: ctx.orgName },
            )}
            {latest.review_outcome
              ? ""
              : ` ${t("gateway.engagement.advance.recordedChange", { org: ctx.orgName })}`}
          </p>
        ) : null}
        {returned && latest?.return_reason ? (
          <p className="m-0 text-text-13 text-danger-text">{latest.return_reason}</p>
        ) : null}
        <KindBody section={s} kind={kind} open={open} ctx={ctx} />
      </div>
    ),
  };
}

/** What a typed answer holds: its files with their scan state, or its lines with each allocation's stage. */
function AnswerDetail({
  answer,
  kind,
  ctx,
}: {
  answer: SubmissionRow;
  kind: string;
  ctx: Context;
}) {
  const { t, locale } = ctx;
  if (kind === "Guest List") {
    return (
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.engagement.advance.guestsConfirmed")}
      </p>
    );
  }
  const files = ctx.files.filter((f) => f.advance_submission_id === answer.id);
  const lines = ctx.lines.filter((l) => l.advance_submission_id === answer.id);
  return (
    <div className="flex flex-col gap-8">
      {answer.answer_note ? <p className="m-0 text-text-13">{answer.answer_note}</p> : null}
      {files.length > 0 ? (
        <RowList
          label={t("gateway.engagement.advance.filesLabel")}
          items={files.map((f) => ({
            id: f.id ?? "",
            title: f.title ?? "",
            tag: {
              label: t(`gateway.engagement.advance.scan.${enumKey(f.scan_status ?? "Scanning")}`),
              tone:
                f.scan_status === "Clean"
                  ? ("success" as const)
                  : f.scan_status === "Scanning"
                    ? ("neutral" as const)
                    : ("danger" as const),
            },
          }))}
        />
      ) : null}
      {lines.length > 0 ? (
        <RowList
          label={t("gateway.engagement.advance.linesLabel")}
          items={lines.map((l) => {
            const allocation = l.allocation_id ? ctx.allocations.get(l.allocation_id) : undefined;
            const window =
              l.needed_from && l.needed_to
                ? t("gateway.engagement.advance.window", {
                    from: formatDateTime(locale, l.needed_from, l.window_zone),
                    to: formatDateTime(locale, l.needed_to, l.window_zone),
                  })
                : null;
            return {
              id: l.id ?? "",
              title:
                kind === "Schedule Window"
                  ? (window ?? "")
                  : t("gateway.engagement.advance.lineTitle", {
                      n: l.quantity ?? 0,
                      item: l.class_name ?? l.category_name ?? "",
                    }),
              meta: [kind === "Schedule Window" ? null : window, l.person_name, l.line_note],
              ...(allocation
                ? {
                    tag: {
                      label: t(
                        `gateway.engagement.crew.items.status.${enumKey(allocation.status)}`,
                      ),
                      tone: allocationTone(allocation.status),
                    },
                  }
                : {}),
            };
          })}
        />
      ) : null}
    </div>
  );
}

/** The kind's own part of a section: its form while the section is open, or what it reads. */
function KindBody({
  section,
  kind,
  open,
  ctx,
}: {
  section: SectionRow;
  kind: string;
  open: boolean;
  ctx: Context;
}): ReactNode {
  const { t, recipient } = ctx;
  const sectionId = section.id ?? "";
  const label = section.title ?? "";
  const accepted = ctx.entries.filter(
    (e) => e.personId !== null && e.entryState === "Accepted" && e.personResponse === "Accepted",
  );
  const people = accepted.map((e) => ({ value: e.id, label: e.fullName ?? "" }));
  const items = ctx.choices
    .filter((c) => c.advance_section_id === sectionId)
    .map((c) =>
      c.asset_class_id
        ? { value: `asset_class:${c.asset_class_id}`, label: c.class_name ?? "" }
        : {
            value: `credential_category:${c.credential_category_id}`,
            label: c.category_name ?? "",
          },
    );
  switch (kind) {
    case "Text":
      return open && recipient?.id ? (
        <AdvanceAnswerForm recipientId={recipient.id} sectionId={sectionId} prompt={label} />
      ) : null;
    case "File":
      return open && recipient?.id ? (
        <AdvanceFileForm
          orgId={ctx.orgId}
          recipientId={recipient.id}
          sectionId={sectionId}
          maxFiles={section.max_lines ?? 1}
          label={label}
        />
      ) : null;
    case "Schedule Window":
    case "Item Request":
    case "Credential Request": {
      const deadline =
        kind === "Credential Request"
          ? namesDueSentence(recipient?.names_due_at ?? null, ctx)
          : null;
      return (
        <>
          {deadline ? <p className="m-0 text-text-13 text-text-secondary">{deadline}</p> : null}
          {open && recipient?.id ? (
            <AdvanceLinesForm
              recipientId={recipient.id}
              sectionId={sectionId}
              kind={kind}
              label={label}
              timeZone={ctx.timeZone}
              maxLines={section.max_lines ?? 1}
              perPerson={section.per_person ?? false}
              items={items}
              // After the naming deadline a credential line names nobody; the pool still goes in.
              people={
                kind === "Credential Request" && namesPast(recipient.names_due_at ?? null)
                  ? []
                  : people
              }
            />
          ) : null}
        </>
      );
    }
    case "Crew Roster": {
      const counts = new Map<string, number>();
      for (const e of ctx.entries) counts.set(e.entryState, (counts.get(e.entryState) ?? 0) + 1);
      return (
        <p className="m-0 text-text-13 text-text-secondary">
          {ctx.entries.length === 0
            ? t("gateway.engagement.advance.rosterEmpty")
            : [...counts]
                .map(([state, n]) =>
                  t("gateway.engagement.advance.rosterCount", {
                    n,
                    state: t(enumLabelKey("rosterEntryState", state)),
                  }),
                )
                .join(" · ")}{" "}
          <Link
            href={tabHref(ctx.engagementKey, "engagement.crew") as Route}
            className="text-text-link"
          >
            {t("gateway.engagement.advance.rosterLink")}
          </Link>
        </p>
      );
    }
    case "Guest List": {
      if (ctx.roleType === "Contractor" || ctx.roleType === "Sponsor") {
        return (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.engagement.advance.noGuestList")}
          </p>
        );
      }
      return (
        <div className="flex flex-col gap-8">
          <p className="m-0 text-text-13 text-text-secondary">
            {ctx.guests.cap === null
              ? t("gateway.engagement.advance.guestsUsed", { n: ctx.guests.used })
              : t("gateway.engagement.advance.guestsCap", {
                  n: ctx.guests.used,
                  cap: ctx.guests.cap,
                })}
          </p>
          {ctx.guests.offered ? <GuestRequestForm engagementId={ctx.engagementId} /> : null}
          {open && recipient?.id ? (
            <GuestListConfirmForm
              recipientId={recipient.id}
              sectionId={sectionId}
              label={label}
              timeZone={ctx.timeZone}
            />
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function namesPast(at: string | null): boolean {
  return namesClosed({ namesDueAt: at });
}

/** "Name your passes by" before the recipient's deadline, "Names closed" after it (G-141). */
function namesDueSentence(at: string | null, ctx: Context): string | null {
  if (at === null) return null;
  const date = formatDateTime(ctx.locale, at);
  return namesPast(at)
    ? ctx.t("gateway.engagement.advance.namesDue.closed", { date, org: ctx.orgName })
    : ctx.t("gateway.engagement.advance.namesDue.open", { date });
}
