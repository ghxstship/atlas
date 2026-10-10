import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OrganizationForm } from "@/components/auth/forms";
import { ownerSignupDocuments } from "@/lib/auth/legal";
import { getViewer } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.organization");
  return { title: t("title") };
}

/**
 * Create an organization (app.create_organization): the signed-in person becomes its Owner on the
 * Access plan and accepts the documents legal/index.yaml requires of an Owner at signup.
 */
export default async function OrganizationPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/sign-in?next=%2Fauth%2Forganization");
  const t = await getTranslations("shell.auth.organization");
  const [terms, dpa] = ownerSignupDocuments();
  if (!terms || !dpa) {
    throw new Error("legal/index.yaml must list the Terms of Service and the DPA for Owners.");
  }
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
        <p className="text-text-13 text-text-secondary">{t("lead")}</p>
      </div>
      <OrganizationForm
        terms={{ href: `/legal/${terms.slug}`, title: terms.title }}
        dpa={{ href: `/legal/${dpa.slug}`, title: dpa.title }}
      />
    </div>
  );
}
