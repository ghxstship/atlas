import { useEffect, useState, type ReactElement } from "react";
import { useLocale, useT } from "../lib/context.tsx";
import { formatList } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { isRecordKind } from "@xos/icons/glyphs";
import {
  finalizeQuickAdd,
  quickAddKey,
  quickAddSigil,
  type QuickAddParse,
  type QuickAddResolution,
  type QuickAddToken,
  type QuickAddTokenType,
} from "./quickAddCore.ts";

/**
 * Sentences of a quick add line, from the app's own catalog. The shared `ui` catalog ships in every
 * page's first JavaScript, so quick add adds none to it (ADR 0073); without these, chips are named as
 * typed and the announcement lists the title and the chips.
 */
export interface QuickAddCopy {
  /** Names a chip by what it sets, such as "Owner: Dana Kim". */
  field?: (name: string, value: string) => string;
  /** What is announced once typing pauses, such as "Hang truss, with Owner: Dana Kim". */
  announce?: (title: string, fields: string) => string;
  /** Names the list of an ambiguous token's candidates, such as "Choose a match for ~open". */
  choose?: (token: string) => string;
  /** The list's entry before a candidate is chosen, such as "Matches: 2". */
  matches?: (count: number) => string;
}

export interface QuickAddChipsProps {
  parse: QuickAddParse;
  /** Resolutions by token key; without them every token shows as typed. */
  resolutions?: Readonly<Record<string, QuickAddResolution>>;
  /** Candidates chosen for ambiguous tokens, by token key. */
  choices?: Readonly<Record<string, string>>;
  /** Gives each chip a remove button that turns its token back into text. */
  onDismiss?: (token: QuickAddToken) => void;
  /** Called when the person picks one candidate of an ambiguous token. */
  onChoose?: (token: QuickAddToken, id: string) => void;
  /** What each kind of token sets, for chip names and the announcement, such as Owner or Due. */
  labels?: Partial<Record<QuickAddTokenType, string>>;
  copy?: QuickAddCopy;
}

/** A parsed day and time spoken in the person's language; the wall clock is formatted as is. */
function spokenDate(locale: string, token: QuickAddToken): string {
  const at = (iso: string, time?: string) => {
    const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
    const [h = 0, mi = 0] = (time ?? "00:00").split(":").map(Number);
    return new Date(Date.UTC(y, m - 1, d, h, mi));
  };
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(token.time ? { hour: "numeric", minute: "2-digit" } : {}),
  });
  if (!token.iso) return token.value;
  const start = at(token.iso, token.time);
  return token.endIso
    ? format.formatRange(start, at(token.endIso, token.endTime ?? token.time))
    : format.format(start);
}

/**
 * The chips of a quick add line (Section 11.7): the title as it will save, then one chip per token,
 * named by what it sets. A token the app could not resolve stays in the title; one with several
 * matches offers them in a list. Remove buttons and lists are reachable with Tab. A status region
 * announces the result once typing pauses.
 */
export function QuickAddChips({
  parse,
  resolutions,
  choices = {},
  onDismiss,
  onChoose,
  labels = {},
  copy = {},
}: QuickAddChipsProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  // Tokens still waiting for an answer show as typed, so the title does not jump while it comes.
  const shown: Record<string, QuickAddResolution> = {};
  const chips = parse.tokens.filter((token) => {
    if (token.type === "date" || resolutions === undefined) return true;
    const key = quickAddKey(token);
    const resolution = resolutions[key] ?? { status: "resolved", id: key, label: token.value };
    shown[key] = resolution;
    return resolution.status !== "unresolved";
  });
  const preview = finalizeQuickAdd(parse, resolutions === undefined ? undefined : shown, choices);
  const title = preview.title || t("record.untitled");
  const typed = (token: QuickAddToken) => `${quickAddSigil(token.type)}${token.value}`;
  const valueOf = (token: QuickAddToken) =>
    token.type === "date"
      ? spokenDate(locale, token)
      : (preview.tokens.find((p) => p.type === token.type)?.label ?? token.value);
  /** A chip's name: what it sets and its value when the app names them, else its value as typed. */
  const fieldOf = (token: QuickAddToken, value: string) => {
    const name = labels[token.type];
    if (name && copy.field) return copy.field(name, value);
    return token.type === "date" || value !== token.value ? value : typed(token);
  };

  const summary = preview.tokens.map((token) => fieldOf(token, valueOf(token)));
  const message =
    summary.length === 0
      ? title
      : (copy.announce?.(title, formatList(locale, summary)) ??
        formatList(locale, [title, ...summary]));
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSpoken(message), 600);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="me-4 font-medium">{title}</span>
      {chips.map((token) => {
        const key = quickAddKey(token);
        const resolution = shown[key];
        const candidates = resolution?.status === "ambiguous" ? resolution.candidates : null;
        const chosen = candidates?.find((c) => c.id === choices[key]);
        const resolved = resolution?.status === "resolved" ? resolution : null;
        const text =
          chosen?.label ?? (resolved && resolved.id !== key ? resolved.label : token.value);
        const kind = resolved && resolved.id !== key ? resolved.id : token.value;
        const detail = token.type === "date" ? spokenDate(locale, token) : resolved?.detail;
        return (
          <span key={key} className={chipClass} {...(detail ? { title: detail } : {})}>
            <Icon name={token.icon} size={12} color="var(--color-text-secondary)" />
            {token.type === "kind" && isRecordKind(kind) ? (
              <RecordKindGlyph kind={kind} size={12} />
            ) : null}
            {candidates && !chosen ? (
              <select
                aria-label={copy.choose?.(typed(token)) ?? typed(token)}
                value=""
                onChange={(e) => onChoose?.(token, e.target.value)}
                className="xos-hit max-w-full border-0 bg-transparent text-inherit cursor-pointer"
              >
                <option value="">
                  {copy.matches?.(candidates.length) ?? `${token.value} (${candidates.length})`}
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.detail ? `${c.label} · ${c.detail}` : c.label}
                  </option>
                ))}
              </select>
            ) : (
              text
            )}
            {onDismiss ? (
              <button
                type="button"
                aria-label={t("chip.remove", {
                  label: fieldOf(token, chosen?.label ?? valueOf(token)),
                })}
                onClick={() => onDismiss(token)}
                className="xos-hit inline-grid place-items-center ms-2 p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary rounded-mark cursor-pointer"
              >
                <Icon name="X" size={12} />
              </button>
            ) : null}
          </span>
        );
      })}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </div>
  );
}
