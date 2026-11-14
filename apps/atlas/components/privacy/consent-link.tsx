import type { ConsentLinkRenderer } from "@xos/ui/consent";
import type { Route } from "next";
import Link from "next/link";

/** Draws a consent link with next/link. Imported only by client modules. */
export const routerLink: ConsentLinkRenderer = (link, className) => (
  <Link href={link.href as Route} className={className}>
    {link.label}
  </Link>
);
