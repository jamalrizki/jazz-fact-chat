/**
 * How long does a rate-limited provider want us to wait?
 *
 * Groq words the wait three ways inside its 429 message: "435ms", "11.2s" and
 * "1m5.2s". Returns seconds, or NaN when the message names no wait. This is
 * deterministic parsing, so it lives in code, not in the prompt.
 */
const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600 };

export function parseRetryWaitSeconds(message) {
  const token = String(message).match(/try again in\s+([0-9hms.]+)/i)?.[1];
  if (!token) return NaN;
  let total = 0;
  let found = false;
  for (const [, num, unit] of token.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
    total += Number(num) * UNIT_SECONDS[unit.toLowerCase()];
    found = true;
  }
  return found ? total : NaN;
}
