import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.spend-authority: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/spend-authority">) {
  return <SettingsSectionPage node="settings.spend-authority" params={await params} />;
}
