// Signs check results so /api/send-report can trust a score the browser
// sends back without re-fetching the site. Key is derived from the Resend
// key, so there's no extra secret to manage.
import crypto from "node:crypto";

function key() {
  const k = process.env.RESEND_API_KEY;
  return k ? crypto.createHash("sha256").update("citekind-report-sig:" + k).digest() : null;
}

const canon = (r) => JSON.stringify({ url: r.url, score: r.score, checks: r.checks, fixes: r.fixes, checkedAt: r.checkedAt });

export function sign(result) {
  const k = key();
  return k ? crypto.createHmac("sha256", k).update(canon(result)).digest("hex") : null;
}

export function verify(result, sig) {
  const k = key();
  if (!k || typeof sig !== "string" || sig.length !== 64) return false;
  const want = Buffer.from(sign(result), "hex");
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
