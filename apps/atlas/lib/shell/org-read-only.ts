import type { OrgBannerStatus } from "@xos/data/org-lifecycle";
import type { Result } from "@xos/data";

/**
 * Whether the whole org is read-only now (app.org_banner_status): canceled in its 30-day window, waiting for deletion,
 * read-only after dunning, or paused. The database refuses every write then (org_read_only), so pages offer no
 * create action instead of letting it fail (crawl 4.9). An unreadable status offers the action; the database decides.
 */
export function orgReadOnly(status: Result<OrgBannerStatus>): boolean {
  return status.ok && status.data.readOnlyReason !== null;
}
