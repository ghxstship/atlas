import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.out-of-office: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/out-of-office">) {
  return <SettingsSectionPage node="me.out-of-office" params={await params} />;
}
