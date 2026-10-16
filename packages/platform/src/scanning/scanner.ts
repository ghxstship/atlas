/**
 * The virus scanner port (A22-011, Section 9). The upload scan worker depends on this interface
 * only; `clamavScanner` (clamd over TCP) is the adapter for local development and self-hosting, and
 * a hosted scanning service is another adapter behind the same interface.
 */

export type ScanVerdict =
  { readonly clean: true } | { readonly clean: false; readonly signature: string };

export interface VirusScanner {
  /** Scans the bytes. Throws `ScannerUnavailableError` when the scanner cannot give a verdict. */
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/** The scanner could not be reached or did not answer with a verdict; the scan is retried. */
export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScannerUnavailableError";
  }
}
