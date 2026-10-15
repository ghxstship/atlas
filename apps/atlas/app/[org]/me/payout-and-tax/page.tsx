import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.payout-and-tax: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/payout-and-tax">) {
  return <SettingsSectionPage node="me.payout-and-tax" params={await params} />;
}
