import { forgetOAuthRequest, getAuthorizationDetails, getConsentRequest } from "@xos/data/oauth";
import { KeyRound } from "lucide-react";
import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { ConsentForm } from "@/components/auth/security/consent-form";
import { InlineAlert } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authSecurity.consent");
  return { title: t("pageTitle") };
}

const ERRORS = new Set([
  "oauth_request_expired",
  "oauth_request_recorded",
  "oauth_client_unknown",
  "oauth_not_member",
  "oauth_scope_unknown",
  "oauth_scope_missing",
]);

/**
 * The OAuth consent page (A99, ADR 0055; Section 8.5, "OAuth apps with scopes mapped to capability groups and a
 * consent screen"). Supabase Auth's OAuth server sends the person here (site URL plus authorization_url_path) with the
 * authorization id. The page shows the app, the org that registered it, the capability groups it asked for (marking
 * Restricted ones, which need step-up) and where the person returns; Allow records the grant and Supabase Auth issues
 * the code. Requests without PKCE S256 can only be denied. The proxy has already asked for a second factor if the
 * person holds one.
 */
export default async function ConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  const query = await searchParams;
  const parsed = z
    .string()
    .regex(/^[a-z0-9]{16,64}$/)
    .safeParse(query["authorization_id"]);
  const viewer = await getViewer();
  if (!viewer) {
    const next = parsed.success ? `/oauth/consent?authorization_id=${parsed.data}` : "/";
    redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  }
  const t = await getTranslations("authSecurity");
  // Keys built from data (an error rule, a capability group) go through the untyped translator.
  const tr = await getTranslate();
  if (!parsed.success) {
    return <InlineAlert tone="danger">{t("consent.invalid")}</InlineAlert>;
  }
  const authorizationId = parsed.data;
  const recordedError = typeof query["error"] === "string" ? query["error"] : null;

  const details = await getAuthorizationDetails(viewer.db, authorizationId);
  const request = await getConsentRequest(viewer.db, authorizationId);
  if (details.ok && details.data.redirectUrl && request.ok && request.data) {
    // Supabase Auth already holds a consent that covers this request, and the grant covers its groups.
    await forgetOAuthRequest(viewer.db, authorizationId);
    redirect(details.data.redirectUrl as Route);
  }

  const heading = (
    <div className="flex flex-col gap-8">
      <KeyRound aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="m-0 text-heading-20 font-semibold">
        {request.ok && request.data
          ? t("consent.title", { app: request.data.appName })
          : t("consent.pageTitle")}
      </h1>
    </div>
  );

  if (!details.ok || !request.ok || !request.data) {
    const rule = recordedError && ERRORS.has(recordedError) ? recordedError : null;
    return (
      <div className="flex flex-col gap-16">
        {heading}
        <InlineAlert tone="danger">
          {rule ? tr(`authSecurity.errors.${rule}`) : t("consent.expired")}
        </InlineAlert>
        {details.ok ? <ConsentForm authorizationId={authorizationId} canAllow={false} /> : null}
      </div>
    );
  }

  const r = request.data;
  const scope = (s: string) => tr(`authSecurity.scopes.${s}`);
  return (
    <div className="flex flex-col gap-16">
      {heading}
      <p className="m-0 text-text-14 text-text-secondary">
        {t("consent.org", { app: r.appName, org: r.orgName })}
      </p>
      <section aria-labelledby="consent-scopes" className="flex flex-col gap-8">
        <h2 id="consent-scopes" className="m-0 text-heading-14 font-semibold">
          {t("consent.scopesHeading")}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-14">
          {r.scopes.map((s) => (
            <li key={s} className="flex flex-wrap items-center gap-8">
              <span>{scope(s)}</span>
              {r.restrictedScopes.includes(s) ? (
                <span className="rounded-pill bg-warning-subtle px-8 py-2 text-text-11 font-semibold text-warning-text">
                  {t("consent.restricted")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {r.grantedScopes && r.grantedScopes.length > 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("consent.granted", { scopes: r.grantedScopes.map(scope).join(", ") })}
          </p>
        ) : null}
      </section>
      {r.restrictedScopes.length > 0 ? (
        <InlineAlert tone="warning">{t("consent.restrictedNote")}</InlineAlert>
      ) : null}
      {r.pkceS256 ? null : <InlineAlert tone="danger">{t("consent.pkce")}</InlineAlert>}
      <p className="m-0 text-text-12 text-text-secondary break-all">
        {t("consent.redirect", { uri: r.redirectUri })}
      </p>
      {viewer.email ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("consent.signedInAs", { email: viewer.email })}
        </p>
      ) : null}
      <ConsentForm authorizationId={authorizationId} canAllow={r.pkceS256} />
    </div>
  );
}
