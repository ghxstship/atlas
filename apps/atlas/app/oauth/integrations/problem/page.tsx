import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";

/** Why connecting a storage account did not finish (B16, ADR 0155 D5), on Atlas's own page. */
export const dynamic = "force-dynamic";

const KNOWN = new Set([
  "integration_oauth_state_invalid",
  "integration_oauth_unsupported",
  "integration_account_connected",
  "credential_revoked",
  "oauth_not_configured",
  "oauth_refresh_token_missing",
  "rate_limited",
]);

export default async function Page({ searchParams }: { searchParams: Promise<{ rule?: string }> }) {
  const { rule } = await searchParams;
  const t = (await getTranslations("storageLinks")) as unknown as (key: string) => string;
  return (
    <main className="mx-auto flex max-w-560 flex-col gap-16 p-24">
      <h1 className="m-0 text-heading-20 font-semibold">{t("problemTitle")}</h1>
      <InlineAlert tone="danger">
        {t(`errors.${rule && KNOWN.has(rule) ? rule : "unexpected"}`)}
      </InlineAlert>
      <Link href="/" className="font-medium text-accent-text underline">
        {t("home")}
      </Link>
    </main>
  );
}
