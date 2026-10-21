/**
 * Ports of custom domain provisioning (A79, migration 1355; Section 12). Atlas and Gateway hosts are added to
 * their Vercel project through the Vercel Domains API, which verifies DNS and issues TLS on its own; sending
 * domains are created at Resend, which verifies SPF and DKIM. Production wires the HTTP adapters
 * (vercel.ts, resend.ts) to the owner's tokens; tests wire fakes, so no test reaches either API.
 */

/** A DNS record the org publishes, as the provider asked for it. */
export interface DnsRecord {
  readonly type: string;
  readonly name: string;
  readonly value: string;
  /** What the record is for: routing, verification, spf, dkim, dmarc or receiving. */
  readonly purpose: string;
  readonly priority?: number;
}

/** Where a domain stands at its provider after a call. */
export interface ProviderState {
  /** The provider's id of the domain: the host name for Vercel, the domain id for Resend. */
  readonly ref: string;
  /** DNS verification passed at the provider. */
  readonly verified: boolean;
  /** The TLS certificate is in place (Atlas and Gateway hosts); true for sending domains once verified. */
  readonly tlsReady: boolean;
  /** Records still to publish, or all of them while nothing is verified. */
  readonly records: readonly DnsRecord[];
}

/** Atlas and Gateway hosts on a Vercel project. */
export interface HostProvider {
  add(hostname: string): Promise<ProviderState>;
  check(hostname: string): Promise<ProviderState>;
  remove(hostname: string): Promise<void>;
}

/** Sending domains at Resend. */
export interface SendingDomainProvider {
  create(hostname: string): Promise<ProviderState>;
  check(ref: string): Promise<ProviderState>;
  remove(ref: string): Promise<void>;
}

/** The providers the worker has; a missing one leaves its jobs queued until the owner configures it. */
export interface DomainProviders {
  readonly atlas: HostProvider | null;
  readonly gateway: HostProvider | null;
  readonly sending: SendingDomainProvider | null;
}
