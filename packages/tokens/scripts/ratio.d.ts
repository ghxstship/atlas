/** Types for the browser-safe contrast arithmetic (scripts/ratio.js). */

export function luminance(hex: string): number;
export function ratio(a: string, b: string): number;
export function composite(bgHex: string, overlayHex: string, opacity: number): string;
