import { getTranslations } from "next-intl/server";
import { signInWithProvider } from "@/app/auth/actions";
import { enabledProviders } from "@/lib/auth/providers";
import { Button } from "@/components/ui";

/**
 * OAuth buttons for the providers Supabase Auth has enabled (Section 9: Google, Apple and
 * Microsoft), then a divider above the email form. Passwordless methods come first (Section 11.10,
 * rule 12). Nothing renders when no provider is enabled.
 */
export async function ProviderButtons({ next }: { next: string }) {
  const [providers, t] = await Promise.all([enabledProviders(), getTranslations("gateway.auth")]);
  if (providers.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-8">
        {providers.map((provider) => (
          <form key={provider} action={signInWithProvider}>
            <input type="hidden" name="provider" value={provider} />
            <input type="hidden" name="next" value={next} />
            <Button type="submit" className="w-full">
              {t("providers.continueWith", { provider: t(`providers.${provider}`) })}
            </Button>
          </form>
        ))}
      </div>
      <Divider />
    </>
  );
}

export async function Divider() {
  const t = await getTranslations("gateway.auth");
  return (
    <div className="flex items-center gap-8 text-text-12 text-text-tertiary" role="separator">
      <span className="h-px flex-1 bg-border-subtle" />
      {t("or")}
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}
