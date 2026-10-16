"use client";

import { useBoundaryCopy } from "@/components/error-copy.tsx";
import { Link } from "@/components/ui.tsx";

/** 404 inside a locale: names the next action and links home. */
export default function NotFound() {
  const copy = useBoundaryCopy();
  return (
    <section className="flex flex-col items-start gap-12 py-32 max-w-(--layout-reading)">
      <h1 className="m-0 text-heading-24 font-semibold">{copy.notFound.title}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{copy.notFound.sentence}</p>
      <Link href={copy.home}>{copy.notFound.action}</Link>
    </section>
  );
}
