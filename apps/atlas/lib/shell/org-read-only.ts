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

/**
 * Whether plan-limit banners (A107) apply. A canceled org, or one waiting for deletion, is read-only whatever its plan,
 * and reactivating comes before any plan change, so telling its Owner to upgrade contradicts the read-only banner
 * beside it (crawl 4.9). During dunning or a pause the limits still matter once billing is current again.
 */
export function planLimitBannersApply(status: OrgBannerStatus): boolean {
  return status.readOnlyReason !== "canceled" && status.readOnlyReason !== "deletion";
}
