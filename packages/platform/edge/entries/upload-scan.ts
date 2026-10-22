/** upload-scan: the scan worker, its stores and the scanner choice (ClamAV or the local pass-through). */
export { runUploadScans } from "../../src/scanning/worker.ts";
export { scanStore, supabaseStorage } from "../../src/scanning/stores.ts";
export { selectVirusScanner } from "../../src/scanning/select.ts";
export type { ClamdConnection } from "../../src/scanning/clamav.ts";
