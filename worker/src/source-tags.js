/**
 * Answers never name or cite their sources: the page already shows which tools ran.
 * The prompt says so, but models still add "(Source: MusicBrainz)" or start a sentence
 * with "According to Wikipedia, …". This removes those in code, before the reply goes out.
 *
 * Only phrases that name a known source are touched, so "(per bar)", "via the ii–V"
 * or "according to the melody" survive.
 */
const SOURCE_NAMES = "wikipedia|musicbrainz|all ?about ?jazz|aaj|discogs|jazzdisco|jazz discography project|tavily|[a-z]+_[a-z_]+";

// "(Source: …)", "(Sources: a, b)", "(per Wikipedia)", "(via Discogs listing)", "(according to MusicBrainz)".
const SOURCE_TAG = new RegExp(
  `[ \\t]*\\((?:sources?\\s*:\\s*[^()\\n]{1,60}|(?:per|via|according to)\\s+(?:the\\s+)?(?:${SOURCE_NAMES})\\b[^()\\n]{0,40})\\)`,
  "gi",
);

// "Wikipedia", "the MusicBrainz entry", "Discogs' credits", "All About Jazz's review": a source name,
// optionally possessive and followed by one word for the kind of page.
const SOURCE_REF =
  `(?:the\\s+)?(?:${SOURCE_NAMES})(?:'s|')?(?:\\s+(?:entry|page|article|listing|listings|database|data|discography|credits|review|bio|biography|results?|excerpts?))?`;

// One source or several: "Wikipedia and Discogs".
const SOURCES = `${SOURCE_REF}(?:\\s+(?:and|&)\\s+${SOURCE_REF})*`;

// Mid-sentence, between commas: "The album, according to MusicBrainz, came out in 1959."
const PHRASE_BETWEEN_COMMAS = new RegExp(`,\\s*(?:according to|per)\\s+${SOURCES},\\s*`, "gi");

// At the start of a sentence, line or list item: "According to Wikipedia, he was born in 1926."
const PHRASE_LEADING = new RegExp(
  `(^|[.!?]\\s+|\\n[ \\t]*(?:[-*•]|\\d+[.)])?[ \\t]*)(?:according to|per)\\s+${SOURCES},?\\s+(\\S)`,
  "gi",
);

// At the end of a clause: "He was born in 1926, according to Wikipedia."
const PHRASE_TRAILING = new RegExp(`,?\\s+(?:according to|per|via)\\s+${SOURCES}(?=\\s*(?:[.;:!?)]|,|$))`, "gim");

export function stripSourceTags(text) {
  return String(text)
    .replace(SOURCE_TAG, "")
    .replace(/[ \t]*【[^】]*】/g, "")
    .replace(PHRASE_BETWEEN_COMMAS, " ")
    .replace(PHRASE_LEADING, (_, lead, first) => lead + first.toUpperCase())
    .replace(PHRASE_TRAILING, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}
