import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.keyboard-shortcuts: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/keyboard-shortcuts">) {
  return <SettingsSectionPage node="me.keyboard-shortcuts" params={await params} />;
}
