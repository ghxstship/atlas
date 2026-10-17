import { exploreOrganizations } from "@xos/data/profile-sharing";
import type { XosClient } from "@xos/data";
import type { Route } from "next";
import Link from "next/link";
import { RegionError } from "@/components/page/page";
import { Button, EmptyStateLink, Icon, Input, Tag } from "@/components/ui";
import type { Translate } from "@/lib/shell/translate";

/**
 * Explore, Organizations (journey 62, finding A38-003): Public organization profiles with the
 * verified badge, the verified domain and how many Public opportunities they have open, each
 * linking to its page at /c/{handle}. Only profiles their org made Public appear.
 */
export async function ExploreOrganizations({
  db,
  t,
  query,
}: {
  db: XosClient;
  t: Translate;
  query: string;
}) {
  const result = await exploreOrganizations(db, query === "" ? null : query);
  return (
    <>
      <form action="/explore" method="get" role="search" className="flex flex-wrap items-end gap-8">
        <input type="hidden" name="show" value="organizations" />
        <Input
          id="explore-org-q"
          name="q"
          type="search"
          label={t("gateway.explore.organizations.searchLabel")}
          defaultValue={query}
          width="100%"
        />
        <Button type="submit" variant="primary" icon="Search">
          {t("gateway.explore.search")}
        </Button>
      </form>
      {!result.ok ? (
        <RegionError />
      ) : (
        <>
          <h2 className="m-0 text-text-13 font-normal text-text-secondary">
            <span role="status">
              {t("gateway.explore.organizations.results", { n: result.data.length })}
            </span>
          </h2>
          {result.data.length === 0 ? (
            <EmptyStateLink
              icon="Building2"
              sentence={t("gateway.explore.organizations.empty")}
              actionLabel={t("gateway.explore.organizations.emptyAction")}
              href="/explore"
            />
          ) : (
            <ul
              aria-label={t("gateway.explore.organizations.listLabel")}
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0"
            >
              {result.data.map((o) => (
                <li
                  key={o.handle}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16"
                >
                  <div className="flex flex-wrap items-center gap-8">
                    <Link
                      href={`/c/${o.handle}` as Route}
                      className="text-text-14 font-semibold text-text-primary"
                    >
                      {o.name}
                    </Link>
                    {o.verified ? (
                      <Tag tone="success">
                        <span className="inline-flex items-center gap-4">
                          <Icon name="BadgeCheck" size={14} />
                          {t("gateway.profile.company.verified")}
                        </span>
                      </Tag>
                    ) : null}
                  </div>
                  {o.about ? (
                    <p className="m-0 line-clamp-3 text-text-13 text-text-secondary">{o.about}</p>
                  ) : null}
                  <p className="m-0 flex flex-wrap gap-12 text-text-12 text-text-secondary">
                    {o.verifiedDomain ? (
                      <span className="inline-flex items-center gap-4">
                        <Icon
                          name="ShieldCheck"
                          size={14}
                          label={t("gateway.profile.company.verifiedDomain")}
                        />
                        {o.verifiedDomain}
                      </span>
                    ) : null}
                    <span>
                      {t("gateway.explore.organizations.open", { n: o.openOpportunities })}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
