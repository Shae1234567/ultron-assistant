import type { Target } from '../browser';

/**
 * What agents may do on websites without asking. The operator is a minor,
 * and the agents act inside their signed-in accounts, so:
 *   - never: spend money, start subscriptions, create accounts, or type into
 *     password / card / ID fields (the operator does those themselves)
 *   - ask first: anything that publishes, sends, shares, deletes or confirms
 *   - otherwise: go ahead (navigate, write in the operator's own document...)
 */

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'ask'; verb: string; what: string }
  | { kind: 'block'; reason: string };

const MONEY = /\b(buy|purchase|pay( now)?|checkout|check out|place (your )?order|order now|complete (your )?(order|purchase)|subscribe|donate|add to (cart|bag|basket)|upgrade( now)?|start (a |your )?(free )?trial|add (a )?(payment|card)|billing|send (a )?tip)\b/i;
const ACCOUNT = /\b(sign ?up|create (an |your |a new )?account|register|join now)\b/i;
const DESTRUCTIVE = /\b(delete|remove|trash|discard|erase|deactivate|close (your )?account|unsubscribe|leave (the )?(group|server|channel)|clear all|empty trash)\b/i;
const OUTWARD = /\b(post|publish|send|submit|share|tweet|retweet|repost|reply|comment|upload|invite|transfer|go live|make public|schedule post)\b/i;
const CONFIRM = /\b(confirm|i agree|accept|agree|allow access|authori[sz]e|grant)\b/i;

const ALLOW: Verdict = { kind: 'allow' };

function words(t: Target): string {
  return `${t.text} ${t.label}`.replace(/\s+/g, ' ').trim();
}

function quote(s: string): string {
  return `"${s.slice(0, 70)}"`;
}

export function judgeClick(t: Target | null): Verdict {
  if (!t) return ALLOW;
  const w = words(t);
  if (!w) return ALLOW;
  if (MONEY.test(w)) {
    return { kind: 'block', reason: `${quote(w)} spends money or starts a subscription - Ultron never buys, pays or subscribes. Tell the operator this part is theirs to do.` };
  }
  if (ACCOUNT.test(w) && !/\b(sign|log) ?in\b/i.test(w)) {
    return { kind: 'block', reason: 'Creating accounts is the operator\'s job - they can do it in Apps > Sign in to websites, then the agents use it.' };
  }
  if (DESTRUCTIVE.test(w)) return { kind: 'ask', verb: 'delete', what: `click ${quote(w)} on ${t.host}` };
  if (OUTWARD.test(w)) return { kind: 'ask', verb: 'publish', what: `click ${quote(w)} on ${t.host}` };
  if (CONFIRM.test(w)) return { kind: 'ask', verb: 'confirm', what: `click ${quote(w)} on ${t.host}` };
  return ALLOW;
}

/** A 13-19 digit run that passes the Luhn check is a payment card number. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const digits = m.replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function judgeTyping(t: Target | null, text: string): Verdict {
  if (t?.sensitive) return { kind: 'block', reason: 'That field wants a password, card or ID number - only the operator types those, in Apps > Sign in to websites.' };
  if (looksLikeCardNumber(text)) return { kind: 'block', reason: 'That looks like a payment card number - Ultron never enters card details.' };
  return ALLOW;
}

/** Enter (or Ctrl+Enter) in a message box sends; in a form it submits whatever the form's buttons do. */
export function judgeSubmit(t: Target | null): Verdict {
  if (!t) return ALLOW;
  const where = `${t.label} ${t.text}`.replace(/\s+/g, ' ').trim();
  if (t.type === 'search' || t.role === 'searchbox' || /\b(search|find|filter|query|look up)\b/i.test(t.label)) return ALLOW;
  if (/\b(message|reply|comment|post|tweet|chat|write something|what's on your mind|send)\b/i.test(t.label)) {
    return { kind: 'ask', verb: 'send', what: `press Enter in ${quote(t.label)} on ${t.host} - that usually sends it` };
  }
  const buttons = t.formButtons.join(' / ');
  if (buttons && MONEY.test(buttons)) return { kind: 'block', reason: `That form's button (${quote(buttons)}) spends money - the operator does that part.` };
  if (buttons && ACCOUNT.test(buttons) && !/\b(sign|log) ?in\b/i.test(buttons)) return { kind: 'block', reason: 'That form creates an account - the operator does that part.' };
  if (buttons && (OUTWARD.test(buttons) || DESTRUCTIVE.test(buttons))) return { kind: 'ask', verb: 'submit', what: `submit the form (${quote(buttons)}) on ${t.host}` };
  void where;
  return ALLOW;
}

/** Delete/Backspace outside a text field acts on the page itself (a selected email, file or item). */
export function judgeKeys(keys: string, focused: Target | null): Verdict {
  const combos = keys.trim().split(/\s+/);
  if (combos.some((k) => /^(Control\+|ControlOrMeta\+|Meta\+)?Enter$/.test(k))) {
    const v = judgeSubmit(focused);
    if (v.kind !== 'allow') return v;
  }
  if (combos.some((k) => /^(Delete|Backspace|Shift\+Delete)$/.test(k)) && focused && !focused.editable) {
    return { kind: 'ask', verb: 'delete', what: `press ${combos.join(' ')} on ${focused.host} while ${quote(words(focused) || focused.tag)} is selected - that can delete it` };
  }
  return ALLOW;
}
