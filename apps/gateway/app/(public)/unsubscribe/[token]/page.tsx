import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PARAM_TYPES } from "@xos/ia";
import { GuestUnsubscribeForm } from "@/components/unsubscribe/guest-unsubscribe";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.unsubscribe.title"), robots: { index: false, follow: false } };
}

/**
 * Stop guest list emails (B8, migration 2975, ADR 0147 decision 7). The link in a guest email's footer opens this page;
 * opening it changes nothing, so a mail scanner that fetches the link unsubscribes nobody. The button's server action
 * calls api_public.unsubscribe_guest_email, which suppresses the address for the org that sent the email.
 */
export default async function GuestUnsubscribePage({ params }: PageProps<"/unsubscribe/[token]">) {
  const { token } = await params;
  if (!PARAM_TYPES.token.test(token)) notFound();
  return <GuestUnsubscribeForm token={token} />;
}
