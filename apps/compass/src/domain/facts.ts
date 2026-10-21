/**
 * The facts of an external item in words (A92): calendar dates as written, instants in the zone they carry, money in
 * its currency, durations and catalog labels. A label followed by a value reads as one phrase ("Departs Wed, Jun 10,
 * 9:00 AM EDT"), so a list row's subtitle never splits a label from what it labels.
 */
import { formatCalendarDay, formatCalendarRange, formatInstant } from "./dates";
import { formatMoney } from "./expenses";
import type { Fact } from "./external";

export type Translate = (key: string, values: Readonly<Record<string, string | number>>) => string;

export function factText(fact: Fact, t: Translate, locale: string, deviceZone?: string): string {
  switch (fact.kind) {
    case "day":
      return formatCalendarDay(fact.day, locale);
    case "range":
      return formatCalendarRange(
        fact.from,
        fact.to,
        (from, to) => t("compassExternal.between", { from, to }),
        locale,
      );
    case "instant":
      return formatInstant(fact.at, fact.zone, locale, deviceZone);
    case "money":
      return formatMoney(fact.minor, fact.currency, locale);
    case "minutes":
      return t("compassExternal.duration", {
        hours: Math.floor(fact.minutes / 60),
        minutes: fact.minutes % 60,
      });
    case "text":
      return fact.text;
    case "label":
      return t(fact.key, fact.values ?? {});
  }
}

export function factsText(
  facts: readonly Fact[],
  t: Translate,
  locale: string,
  deviceZone?: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i] as Fact;
    const next = facts[i + 1];
    if (
      fact.kind === "label" &&
      next &&
      (next.kind === "instant" || next.kind === "day" || next.kind === "money")
    ) {
      out.push(`${factText(fact, t, locale, deviceZone)} ${factText(next, t, locale, deviceZone)}`);
      i += 1;
    } else {
      out.push(factText(fact, t, locale, deviceZone));
    }
  }
  return out.filter((s) => s.trim().length > 0);
}
