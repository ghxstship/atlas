import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClass } from "@xos/ui/static";
import { LegalLinks } from "@/components/privacy/legal-links";

/**
 * The public homepage a signed-out visitor sees at the site root (RRR-248): what XOS is, the way in,
 * what a Google sign-in shares, and the legal links in the footer, the Privacy Policy and the Consumer
 * Health Data Privacy Policy among them. Google's OAuth review reads the same page for the app's
 * description and its Privacy Policy link. A server component of plain links: it adds no script.
 */
export async function PublicHome() {
  const [t, tAuth, tShell, tCompass] = await Promise.all([
    getTranslations("shell.landing"),
    getTranslations("shell.auth.signIn"),
    getTranslations("shell"),
    getTranslations("compass.app"),
  ]);
  const apps = [
    {
      key: "atlas",
      name: tShell("atlas.name"),
      audience: t("apps.atlas"),
      body: tShell("atlas.tagline"),
    },
    {
      key: "gateway",
      name: tShell("gateway.name"),
      audience: t("apps.gateway"),
      body: tShell("gateway.tagline"),
    },
    {
      key: "compass",
      name: tCompass("name"),
      audience: t("apps.compass"),
      body: t("apps.compassTagline"),
    },
  ];
  return (
    <div className="flex min-h-dvh flex-col bg-bg-canvas">
      <header className="flex h-(--ui-topnav) items-center border-b border-border-subtle bg-bg-surface px-16 md:px-24">
        <span className="text-heading-20 font-semibold text-text-primary">{t("brand")}</span>
      </header>
      <main
        id="content"
        className="mx-auto flex w-full max-w-layout-wide flex-1 flex-col gap-48 px-16 py-48 md:px-24"
      >
        <section
          aria-labelledby="landing-title"
          className="flex max-w-layout-reading flex-col items-start gap-16"
        >
          <h1 id="landing-title" className="m-0 text-heading-32 font-semibold text-text-primary">
            {t("title")}
          </h1>
          <p className="m-0 text-text-16 text-text-secondary">{t("lead")}</p>
          <Link href="/auth/sign-in" className={buttonClass("primary", "lg")}>
            {t("signIn")}
          </Link>
          <p className="m-0 text-text-13 text-text-secondary">
            {tAuth("noAccount")}{" "}
            <Link href="/auth/sign-up" className="text-accent-text underline">
              {tAuth("toSignUp")}
            </Link>
          </p>
        </section>
        <section aria-labelledby="landing-apps" className="flex flex-col gap-16">
          <h2 id="landing-apps" className="m-0 text-heading-20 font-semibold text-text-primary">
            {t("apps.title")}
          </h2>
          <ul className="m-0 grid list-none gap-16 p-0 md:grid-cols-3">
            {apps.map((app) => (
              <li
                key={app.key}
                className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-16"
              >
                <h3 className="m-0 text-heading-16 font-semibold text-text-primary">{app.name}</h3>
                <p className="m-0 text-text-12 text-text-secondary">{app.audience}</p>
                <p className="m-0 text-text-13 text-text-primary">{app.body}</p>
              </li>
            ))}
          </ul>
        </section>
        <section
          aria-labelledby="landing-google"
          className="flex max-w-layout-reading flex-col gap-8"
        >
          <h2 id="landing-google" className="m-0 text-heading-20 font-semibold text-text-primary">
            {t("google.title")}
          </h2>
          <p className="m-0 text-text-14 text-text-secondary">
            {t.rich("google.body", {
              privacy: (chunks) => (
                <Link href="/legal/privacy-policy" className="text-accent-text underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </section>
      </main>
      <footer className="border-t border-border-subtle bg-bg-surface">
        <div className="mx-auto flex w-full max-w-layout-wide flex-col gap-8 px-16 py-24 md:px-24">
          <LegalLinks />
          <p className="m-0 text-text-12 text-text-secondary">{t("availability")}</p>
        </div>
      </footer>
    </div>
  );
}
