type Translate = (key: string, values: Record<string, number>) => string;

/** What a crisis alert's row says it reached (6070): who was told, who the worker still has to tell, who it could not. */
export function alertReach(
  t: Translate,
  alert: {
    readonly peopleTold: number | null;
    readonly peopleToldOnSite: number | null;
    readonly peopleWaiting: number | null;
    readonly peopleNotSent: number | null;
  },
): string {
  const count = alert.peopleTold ?? 0;
  const onSite = alert.peopleToldOnSite ?? 0;
  const waiting = alert.peopleWaiting ?? 0;
  const notSent = alert.peopleNotSent ?? 0;
  return [
    t(waiting > 0 ? "incidents.alerts.reachSoFar" : "incidents.alerts.reach", { count, onSite }),
    ...(waiting > 0 ? [t("incidents.alerts.reachWaiting", { count: waiting })] : []),
    ...(notSent > 0 ? [t("incidents.alerts.reachNotSent", { count: notSent })] : []),
  ].join(" ");
}
