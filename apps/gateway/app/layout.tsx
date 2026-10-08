import type { Metadata } from "next";
import type { ReactNode } from "react";
import { defaultLocale, getMessages } from "@xos/i18n";

const messages = getMessages(defaultLocale).shell.gateway;

export const metadata: Metadata = {
  title: messages.name,
  description: messages.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
