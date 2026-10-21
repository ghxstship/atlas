import { getMyOrganization } from "@xos/data";
import { getOrgAuthStatus } from "@xos/data/auth-assurance";
import { Clock } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { Button } from "@/components/ui";
import { safeNext } from "@/lib/auth/redirect";
import { getViewer } from "@/lib/shell/context";
import { signInAgainAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.policy");
  return { title: t("sessionEndedTitle") };
}

/**
 * Where the proxy sends a member whose session an org no longer accepts (Section 9, A77): older than the org's
 * security.session_hours, or idle longer than its security.idle_timeout_minutes. Signing in again starts a new
 * session and returns to `next`.
 */
export default async function SessionEndedPage({ searchParams }: PageProps<"/auth/session-ended">) {
  const query = await searchParams;
  const next = safeNext(query["next"]);
  const idle = query["reason"] === "idle";
  const slug = z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/)
    .safeParse(query["org"]);
  const viewer = await getViewer();
  const org =
    slug.success && viewer?.person
      ? await getMyOrganization(viewer.db, viewer.person.id, slug.data)
      : null;
  const status = org?.ok && viewer ? await getOrgAuthStatus(viewer.db, org.data.id) : null;
  const name = org?.ok ? org.data.name : "";
  const hours = status?.ok ? status.data?.sessionHours : null;
  const t = await getTranslations("authSecurity.policy");
  return (
    <div className="flex flex-col items-center gap-16 text-center">
      <Clock aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="text-heading-20 font-semibold">{t("sessionEndedTitle")}</h1>
      {name ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {idle || !hours ? t("idle", { org: name }) : t("sessionEnded", { org: name, hours })}
        </p>
      ) : null}
      <form action={signInAgainAction} className="w-full">
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="primary" className="w-full">
          {t("signInAgain")}
        </Button>
      </form>
    </div>
  );
}
