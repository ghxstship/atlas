/**
 * The vulnerability disclosure contact, RFC 9116. Atlas also serves it on the API host, whose proxy passes
 * `/.well-known/` through. The same text is in Atlas and Gateway; infra/security/test/repo-controls.test.ts keeps them
 * equal and fails once Expires has passed, so renew it at a release, less than a year ahead.
 */
export const dynamic = "force-static";

const SECURITY_TXT = `Contact: mailto:support@ghxstship.pro
Expires: 2027-09-30T00:00:00.000Z
Policy: https://github.com/ghxstship/atlas/blob/main/SECURITY.md
Preferred-Languages: en
Canonical: https://atlas.ghxstship.tech/.well-known/security.txt
Canonical: https://gateway.ghxstship.tech/.well-known/security.txt
Canonical: https://api.ghxstship.tech/.well-known/security.txt
`;

export function GET(): Response {
  return new Response(SECURITY_TXT, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
