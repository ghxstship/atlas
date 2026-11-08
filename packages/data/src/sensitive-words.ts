/**
 * True when free text names a dietary, allergy, accessibility or protected-group need in common English or Spanish
 * words (ADR 0164). The same list as private.looks_sensitive (6852): a test holds them together. A backstop that sends a
 * person to the consent step, not a classifier.
 */
export const SENSITIVE_WORDS =
  "allerg|alerg|dietary|diet\\M|dieta\\M|dietétic|dietetic|vegan|vegetarian|pescatarian|kosher|halal|gluten|celiac|celíac|nut[- ]free|intoleran|anaphyla|anafila|epipen|wheelchair|silla de ruedas|disabilit|disabled|discapacid|accesibilidad|accessibility|service animal|animal de servicio|sign language|lengua de señas|interpreter|intérprete|medical condition|condición médica|supplier diversity|minority[- ]owned|women[- ]owned|veteran[- ]owned|lgbt";

const SENSITIVE_PATTERN = new RegExp(`(${SENSITIVE_WORDS.replaceAll("\\M", "\\b")})`, "i");

export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}
