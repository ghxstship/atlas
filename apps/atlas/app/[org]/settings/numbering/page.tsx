import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.numbering: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/numbering">) {
  return <SettingsSectionPage node="settings.numbering" params={await params} />;
}
