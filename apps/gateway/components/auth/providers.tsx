import type { StaticImageData } from "next/image";
import { getTranslations } from "next-intl/server";
import { signInWithProvider } from "@/app/auth/actions";
import { enabledProviders, offersProviders, type OAuthProvider } from "@/lib/auth/providers";
import { Button } from "@/components/ui";
import googleMark from "./google-mark.svg";

/**
 * Provider marks. Google's sign-in branding guidelines require its "G" in its own four colors on
 * every theme, so the mark is an image file and is never recolored; the button around it uses the
 * design system's secondary style. The label is the button's accessible name, so the mark is
 * decorative.
 */
const MARKS: Partial<Record<OAuthProvider, StaticImageData>> = { google: googleMark };

/**
 * OAuth buttons for the providers Supabase Auth has enabled (Section 9: Google, Apple and
 * Microsoft), on the platform hosts (offersProviders), then a divider above the email form.
 * Passwordless methods come first (Section 11.10, rule 12). Nothing renders when no provider is
 * offered. Each button posts to signInWithProvider, which starts the PKCE flow.
 */
export async function ProviderButtons({ next }: { next: string }) {
  if (!(await offersProviders())) return null;
  const [providers, t] = await Promise.all([enabledProviders(), getTranslations("gateway.auth")]);
  if (providers.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-8">
        {providers.map((provider) => {
          const mark = MARKS[provider];
          return (
            <form key={provider} action={signInWithProvider}>
              <input type="hidden" name="provider" value={provider} />
              <input type="hidden" name="next" value={next} />
              <Button type="submit" className="w-full">
                {mark ? (
                  // A fixed brand mark: next/image would add client code to the sign-in page for nothing.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mark.src}
                    alt=""
                    aria-hidden="true"
                    className="size-icon-16 flex-none"
                  />
                ) : null}
                {t("providers.continueWith", { provider: t(`providers.${provider}`) })}
              </Button>
            </form>
          );
        })}
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
