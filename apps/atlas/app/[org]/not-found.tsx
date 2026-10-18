"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SystemPage } from "@/components/system-page";

/**
 * 404 inside an org (ADR 0006): a hidden page, or a row the person may not read, such as a project
 * a Viewer is not a member of (ADR 0016 item 1). The shell stays, and the copy never says whether
 * the page exists; Go to Home is the way on.
 */
export default function OrgNotFound() {
  const t = useTranslations("shell.system.notFound");
  const { org } = useParams<{ org: string }>();
  return (
    <SystemPage
      icon="SearchX"
      title={t("title")}
      sentence={t("body")}
      actionLabel={t("action")}
      href={`/${org}/home`}
    />
  );
}
