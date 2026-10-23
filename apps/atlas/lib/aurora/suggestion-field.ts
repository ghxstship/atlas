/**
 * The hidden form field that carries an Aurora suggestion's id from the extraction panel to the
 * form's save (A95). Its own module, so the browser imports the name without the server code that
 * closes suggestions (lib/aurora/suggestions.ts).
 */
export const SUGGESTION_FIELD = "aiSuggestionId";
