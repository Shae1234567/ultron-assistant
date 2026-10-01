/**
 * A school's D2L Brightspace address, however it was typed: "myschool.brightspace.com", "http://...",
 * or a whole copied link like "https://myschool.brightspace.com/d2l/home/12345" all become the site's
 * https origin. Anything that isn't a web address becomes '' (D2L not set up).
 */
export function schoolUrl(raw: string | null | undefined): string {
  let v = (raw ?? '').trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  v = v.replace(/^http:\/\//i, 'https://');
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || !/\.[a-z]{2,}$/i.test(u.hostname) || /\s/.test((raw ?? '').trim())) return '';
    return `https://${u.host.toLowerCase()}`;
  } catch {
    return '';
  }
}
