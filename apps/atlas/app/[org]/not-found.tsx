import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { TemplateSystemLink } from "@xos/ui/static";
import { PATH_HEADER } from "@/lib/auth/assurance";
import { ROUTE_ORG_HEADER } from "@/lib/shell/route-org";

/**
 * 404 inside an org (ADR 0006): a hidden page, or a row the person may not read, such as a project
 * a Viewer is not a member of (ADR 0016 item 1). The shell stays, and the copy never says whether
 * the page exists; Go to Home is the way on. The boundary is part of every org route, so it renders
 * on the server and sends no JavaScript (ADR 0027); the org comes from the path the proxy forwards,
 * since a not-found boundary receives no params.
 */
export default async function OrgNotFound() {
  const [t, headerStore] = await Promise.all([getTranslations("shell.system.notFound"), headers()]);
  const org =
    headerStore.get(PATH_HEADER)?.split(/[/?]/)[1] || headerStore.get(ROUTE_ORG_HEADER) || null;
  return (
    <TemplateSystemLink
      icon="SearchX"
      title={t("title")}
      sentence={t("body")}
      actionLabel={t("action")}
      href={org ? `/${encodeURIComponent(org)}/home` : "/"}
    />
  );
}
