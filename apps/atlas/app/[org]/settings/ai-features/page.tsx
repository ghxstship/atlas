import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.ai-features: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/ai-features">) {
  return <SettingsSectionPage node="settings.ai-features" params={await params} />;
}
