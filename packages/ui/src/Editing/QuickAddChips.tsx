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
}: QuickAddChipsProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const nameOf = (type: QuickAddTokenType) => labels[type] ?? t(`quickAdd.types.${type}`);
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
  const valueOf = (token: QuickAddToken) =>
    token.type === "date"
      ? spokenDate(locale, token)
      : (preview.tokens.find((p) => p.type === token.type)?.label ?? token.value);

  const summary = preview.tokens.map((token) =>
    t("quickAdd.field", { name: nameOf(token.type), value: valueOf(token) }),
  );
  const message =
    summary.length > 0
      ? t("quickAdd.announce", { title, fields: formatList(locale, summary) })
      : t("quickAdd.announceTitle", { title });
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
            {text}
            {candidates && !chosen ? (
              <select
                aria-label={t("quickAdd.choose", {
                  token: `${quickAddSigil(token.type)}${token.value}`,
                })}
                value=""
                onChange={(e) => onChoose?.(token, e.target.value)}
                className="xos-hit ms-2 max-w-full border-0 bg-transparent text-inherit cursor-pointer"
              >
                <option value="">{t("quickAdd.matches", { count: candidates.length })}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.detail ? `${c.label} · ${c.detail}` : c.label}
                  </option>
                ))}
              </select>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                aria-label={t("quickAdd.remove", {
                  name: nameOf(token.type),
                  value: chosen?.label ?? valueOf(token),
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
