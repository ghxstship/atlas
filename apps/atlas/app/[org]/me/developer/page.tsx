import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.developer: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/developer">) {
  return <SettingsSectionPage node="me.developer" params={await params} />;
}
