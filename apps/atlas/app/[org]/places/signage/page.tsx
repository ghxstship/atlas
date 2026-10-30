import { SignagePage } from "@/components/places/signage/signage-page";

/** Places > Signage (B1, G-24). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/places/signage">) {
  return <SignagePage params={await params} search={await searchParams} />;
}
