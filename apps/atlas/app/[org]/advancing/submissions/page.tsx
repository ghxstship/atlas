import { getNode } from "@xos/ia";
import { advancingPage } from "@/components/advancing/context";
import { flatSearch } from "@/components/advancing/shared";
import { SubmissionsSplit } from "@/components/advancing/submissions";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { LiveList } from "@/components/live/live-list";

/** Advancing > Submissions (Section 4.5.5): the review queue across projects. */
export default async function SubmissionsPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/submissions">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.submissions", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <>
      <LiveList org={routeParams.org} tables={["advance_submissions"]} />
      <SubmissionsSplit
        actx={actx}
        path={`/${routeParams.org}/advancing/submissions`}
        search={search}
        title={t(getNode(sitemap, "advancing.submissions").node.label)}
        packetsHref={`/${routeParams.org}/advancing/packets`}
      />
    </>
  );
}
