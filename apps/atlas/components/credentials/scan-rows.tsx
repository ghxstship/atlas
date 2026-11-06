import { refusalReasonKey, type AccessScan } from "@xos/data/credentials";
import { dateTime, type Format } from "@/components/operations/chrome";
import { joined, ToneChip } from "@/components/operations/kit";
import type { ModulePage } from "@/lib/operations/context";

export function ScanRows({
  page,
  scans,
  format,
}: {
  page: ModulePage;
  scans: readonly AccessScan[];
  format: Format;
}) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
      {scans.map((s) => (
        <li
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
        >
          <span>
            {joined(
              s.zoneCode,
              page.t(`credentials.scans.directions.${s.direction}`),
              dateTime(format, s.scannedAt),
            )}
          </span>
          <ResultChip page={page} scan={s} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A scan's outcome: Granted, Denied with the database's reason in the viewer's language (a denial from before B8 has
 * none), or Overridden with who let the person in and why.
 */
export function ResultChip({ page, scan }: { page: ModulePage; scan: AccessScan }) {
  const t = page.t;
  if (scan.overrideOfScanId) {
    return (
      <span className="inline-flex flex-col gap-2">
        <ToneChip tone="warning">{t("credentials.scans.overridden")}</ToneChip>
        <span className="text-text-12 text-text-secondary">
          {t("credentials.scans.overriddenBy", {
            name: scan.createdByName ?? t("credentials.common.unnamed"),
            reason: scan.overrideReason ?? "",
          })}
        </span>
      </span>
    );
  }
  if (scan.result === "Granted") {
    return <ToneChip tone="success">{t("credentials.scans.granted")}</ToneChip>;
  }
  return (
    <ToneChip tone="danger">
      {scan.refusalReason
        ? t("credentials.scans.deniedBecause", {
            reason: t(`credentials.scans.reasons.${refusalReasonKey(scan.refusalReason)}`),
          })
        : t("credentials.scans.noReason")}
    </ToneChip>
  );
}

/** How long a denial can be overridden (app.override_access_scan, 2970). */
