import { defaultLocale, getMessages } from "@xos/i18n";

export default function HomePage() {
  const messages = getMessages(defaultLocale).shell.gateway;
  return (
    <main>
      <h1>{messages.name}</h1>
      <p>{messages.tagline}</p>
    </main>
  );
}
