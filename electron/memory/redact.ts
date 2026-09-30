/**
 * Nothing secret goes into the vault. The memory prompt already says "never
 * store passwords or keys", but a prompt is a request, not a guarantee - and
 * the operator pastes keys into chat ("here's my Gemini key: AIza..."), which
 * the journal records word for word. Every write to memory passes through
 * this first.
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[API key removed]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[API key removed]'],
  [/\b(?:ck|ak)_[A-Za-z0-9_-]{16,}/g, '[API key removed]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, '[token removed]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token removed]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token removed]'],
  // Discord bot token: base64 user id . 6 chars . 27+ chars
  [/\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}/g, '[token removed]'],
  // Telegram bot token
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[token removed]'],
  [/\b(password|passcode|passwd|pin code|pin)\s*(?:is|:|=)\s*\S+/gi, '$1 [removed]'],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The text with API keys, tokens, private keys, passwords and card numbers replaced by a marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, marker] of PATTERNS) out = out.replace(re, marker);
  // Card numbers: 13-19 digits (spaces or dashes allowed) that pass the Luhn check.
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card number removed]' : m;
  });
  return out;
}
