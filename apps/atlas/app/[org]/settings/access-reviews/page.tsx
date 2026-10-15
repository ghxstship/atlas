import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.access-reviews: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/access-reviews">) {
  return <SettingsSectionPage node="settings.access-reviews" params={await params} />;
}
