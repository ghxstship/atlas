import {
  INTAKE_TOKEN,
  intakeAsksForCode,
  parseIntakeRefusal,
  readIntake,
  type IntakeRefusal,
} from "@xos/data/vendor-intake";
import { listCurrencies } from "@xos/data/projects";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getFormatter, getMessages } from "next-intl/server";
import { IntakeWizard } from "@/components/outside/intake-wizard";
import { OutsideCodeForm } from "@/components/outside/code-form";
import { ButtonLink, InlineAlert } from "@/components/ui";
import { observability } from "@/lib/observability";
import { INTAKE_GRANT_COOKIE, publicDb, visitorAddress } from "@/lib/outside/public";
import { getGatewayContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return {
    title: t("gatewayOnboarding.intake.title"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A reusable vendor intake link (B2, ADR 0141). The no-account part ends at reading the intake: the code form, then the
 * brand, project, title, instructions, what will be asked and the expiry. To go on the person signs in to Gateway or
 * creates an account, which they do themselves, and the steps run on their session. Never the team's note, the rate,
 * the agreement's body or the org's id.
 */
export default async function VendorIntakePage({
  params,
  searchParams,
}: PageProps<"/onboard/[token]">) {
  const { token } = await params;
  if (!INTAKE_TOKEN.test(token)) notFound();
  const query = await searchParams;
  const asked: IntakeRefusal | null =
    typeof query["reason"] === "string" ? parseIntakeRefusal(query["reason"]) : null;
  const t = await getTranslate();
  const grant = (await cookies()).get(INTAKE_GRANT_COOKIE)?.value ?? null;
  const path = `/onboard/${token}`;
  const heading = (
    <h1 className="m-0 text-heading-24 font-semibold">{t("gatewayOnboarding.intake.title")}</h1>
  );
  if (grant === null || (asked !== null && intakeAsksForCode(asked))) {
    return (
      <>
        {heading}
        <OutsideCodeForm
          action={`${path}/open`}
          intro={t("gatewayOnboarding.intake.codeIntro")}
          refusal={asked && asked !== "intake_grant" ? t(`gateway.tokens.refusals.${asked}`) : null}
          stop={
            asked === "intake_link_locked" ||
            asked === "intake_link_expired" ||
            asked === "intake_link_ended"
          }
        />
      </>
    );
  }
  const read = await readIntake(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("vendor intake read failed", {
      route: "/onboard/[token]",
      error: read.error,
    });
    throw new Error("vendor intake read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    return (
      <>
        {heading}
        {intakeAsksForCode(reason) ? (
          <OutsideCodeForm
            action={`${path}/open`}
            intro={t("gatewayOnboarding.intake.codeIntro")}
            refusal={reason === "intake_grant" ? null : t(`gateway.tokens.refusals.${reason}`)}
            stop={false}
          />
        ) : (
          <InlineAlert tone="danger">{t(`gateway.tokens.refusals.${reason}`)}</InlineAlert>
        )}
      </>
    );
  }
  const link = read.data;
  const format = await getFormatter();
  const ctx = await getGatewayContext();
  // The wizard's copy goes only to this page: gatewayOnboarding is not one of Gateway's client namespaces.
  const messages = (await getMessages()) as unknown as {
    gateway: { outcomes: unknown };
    gatewayOnboarding: { intake: unknown };
  };
  const currencies = ctx === null ? null : await listCurrencies(ctx.db);
  const asks = [
    link.roleType === "Vendor" ? t("gatewayOnboarding.intake.asks.company") : null,
    link.collectTaxForm ? t("gatewayOnboarding.intake.asks.tax") : null,
    link.collectPayout ? t("gatewayOnboarding.intake.asks.payout") : null,
    link.agreement ? t("gatewayOnboarding.intake.asks.agreement") : null,
    link.collectInvoice ? t("gatewayOnboarding.intake.asks.invoice") : null,
  ].filter((a): a is string => a !== null);
  return (
    <>
      <header
        className="flex flex-col gap-4 border-t-4 pt-12"
        style={link.brandAccentHex ? { borderColor: link.brandAccentHex } : undefined}
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {link.brandName} · {link.projectName}
        </p>
        <h1 className="m-0 text-heading-24 font-semibold">{link.title}</h1>
        {link.roleTitle ? (
          <p className="m-0 text-text-13 text-text-secondary">{link.roleTitle}</p>
        ) : null}
        {link.instructions ? (
          <p className="m-0 whitespace-pre-line text-text-14">{link.instructions}</p>
        ) : null}
        <p className="m-0 text-text-12 text-text-secondary">
          {t("gatewayOnboarding.intake.expires", {
            date: format.dateTime(new Date(link.expiresAt), {
              dateStyle: "medium",
              timeZone: link.timeZone,
            }),
          })}
        </p>
      </header>
      {asked ? (
        <InlineAlert tone="warning">{t(`gateway.tokens.refusals.${asked}`)}</InlineAlert>
      ) : null}
      {link.full ? (
        <InlineAlert tone="warning">{t("gateway.tokens.refusals.intake_link_full")}</InlineAlert>
      ) : ctx === null ? (
        <section className="flex flex-col gap-8">
          <p className="m-0 text-text-14">{t("gatewayOnboarding.intake.willAsk")}</p>
          <ul className="m-0 flex flex-col gap-4 ps-16 text-text-13">
            {asks.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gatewayOnboarding.intake.signInWhy")}
          </p>
          <div>
            <ButtonLink variant="primary" href={`/auth/sign-in?next=${encodeURIComponent(path)}`}>
              {t("gatewayOnboarding.intake.continue")}
            </ButtonLink>
          </div>
        </section>
      ) : (
        <NextIntlClientProvider
          messages={
            {
              gateway: { outcomes: messages.gateway.outcomes },
              gatewayOnboarding: { intake: messages.gatewayOnboarding.intake },
            } as never
          }
        >
          <IntakeWizard
            token={token}
            link={link}
            currencies={currencies?.ok ? currencies.data : []}
            addressCopy={{
              title: t("payouts.w9.formTitle"),
              legalName: t("payouts.w9.legalName"),
              legalNameHelp: t("payouts.w9.legalNameHelp"),
              street: t("payouts.w9.street"),
              locality: t("payouts.w9.locality"),
              region: t("payouts.w9.region"),
              postal: t("payouts.w9.postal"),
              submit: t("payouts.w9.submit"),
              done: t("payouts.w9.done"),
              errors: {
                legalName: t("payouts.w9.errors.legalName"),
                streetAddress: t("payouts.w9.errors.streetAddress"),
                locality: t("payouts.w9.errors.locality"),
                regionCode: t("payouts.w9.errors.regionCode"),
                postalCode: t("payouts.w9.errors.postalCode"),
              },
            }}
            accounts={ctx.accounts
              .filter((a) => a.roles.includes("Account Owner") || a.roles.includes("Account Admin"))
              .map((a) => ({ id: a.id, name: a.name }))}
          />
        </NextIntlClientProvider>
      )}
      {link.suppressPoweredBy ? null : (
        <footer className="text-text-12 text-text-secondary">
          {t("gatewayOnboarding.intake.poweredBy")}
        </footer>
      )}
    </>
  );
}
