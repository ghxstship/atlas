"use client";

import { Button, Select } from "@xos/ui";
import { useState } from "react";
import { DownloadLink } from "@/components/ui";

type Option = { readonly value: string; readonly label: string };

export interface DaySheetAudienceLabels {
  readonly downloadFor: string;
  readonly forTeam: string;
  readonly forDepartment: string;
  readonly team: string;
  readonly department: string;
  readonly showDepartment: string;
  readonly anyDepartment: string;
  readonly paper: string;
  readonly letter: string;
  readonly a4: string;
  readonly download: string;
  readonly audienceKind: string;
}

/**
 * Show > Day sheets, "Download for…" (B7, ADR 0146 decision 3): a day sheet's PDF for one team or one department,
 * optionally with only one show department's cues, on Letter or A4. It only builds the document link; the route
 * reads the sheet as the viewer and prints the audience's part through app.day_sheet_schedule. Loaded on demand
 * (components/lazy-ui/day-sheet-audience-download.tsx); labels come from the server.
 */
export function DaySheetAudienceDownload({
  href,
  teams,
  departments,
  callKinds,
  labels,
}: {
  /** The day sheet's document route. */
  href: string;
  teams: readonly Option[];
  departments: readonly Option[];
  /** Show departments by their CUE_CALL_SLUGS slug. */
  callKinds: readonly Option[];
  labels: DaySheetAudienceLabels;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"team" | "department">(teams.length > 0 ? "team" : "department");
  const [team, setTeam] = useState(teams[0]?.value ?? "");
  const [department, setDepartment] = useState(departments[0]?.value ?? "");
  const [dept, setDept] = useState("");
  const [paper, setPaper] = useState("letter");
  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-expanded={false}>
        {labels.downloadFor}
      </Button>
    );
  }
  const query = new URLSearchParams();
  if (kind === "team" && team) query.set("team", team);
  if (kind === "department" && department) query.set("department", department);
  if (dept) query.set("dept", dept);
  if (paper === "a4") query.set("paper", "a4");
  const ready = (kind === "team" && team !== "") || (kind === "department" && department !== "");
  return (
    <fieldset
      className="m-0 flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      data-testid="day-sheet-audience-download"
    >
      <legend className="px-4 text-label-13 font-medium">{labels.downloadFor}</legend>
      <Select
        id="day-sheet-audience-kind"
        label={labels.audienceKind}
        value={kind}
        onChange={(e) => setKind(e.target.value === "department" ? "department" : "team")}
        options={[
          ...(teams.length > 0 ? [{ value: "team", label: labels.forTeam }] : []),
          { value: "department", label: labels.forDepartment },
        ]}
      />
      {kind === "team" ? (
        <Select
          id="day-sheet-audience-team"
          label={labels.team}
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          options={[...teams]}
        />
      ) : (
        <Select
          id="day-sheet-audience-department"
          label={labels.department}
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          options={[...departments]}
        />
      )}
      <Select
        id="day-sheet-audience-dept"
        label={labels.showDepartment}
        value={dept}
        onChange={(e) => setDept(e.target.value)}
        options={[{ value: "", label: labels.anyDepartment }, ...callKinds]}
      />
      <Select
        id="day-sheet-audience-paper"
        label={labels.paper}
        value={paper}
        onChange={(e) => setPaper(e.target.value)}
        options={[
          { value: "letter", label: labels.letter },
          { value: "a4", label: labels.a4 },
        ]}
      />
      {ready ? (
        <DownloadLink href={`${href}?${query.toString()}`}>{labels.download}</DownloadLink>
      ) : null}
    </fieldset>
  );
}
