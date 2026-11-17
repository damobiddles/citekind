// POST /api/send-report  ->  emails the visitor their AI visibility report via Resend.
// Only signed readiness results (from /api/check) and self-test ticks are accepted,
// and every visitor-supplied string is length-limited, link-free and escaped,
// so the endpoint can't be used to send arbitrary mail from citekind.com.
import { verify } from "../../lib/sign.mjs";
import { buildPrompts } from "../../lib/prompts.mjs";

export const config = {
  path: "/api/send-report",
  rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

const FROM = "Citekind <report@citekind.com>";
const SITE = "https://citekind.com";
const DAY = 86_400_000;
const byIp = new Map();
const byEmail = new Map();

function over(map, key, limit) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < DAY);
  if (list.length >= limit) { map.set(key, list); return true; }
  list.push(now); map.set(key, list);
  if (map.size > 5000) map.clear();
  return false;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Short free-text fields: no links, no markup, no line breaks.
function field(v, max) {
  const s = String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) throw new Error("too_long");
  if (/https?:|www\.|@|<|>|\.(com|net|org|io|ru|cn|xyz|top)\b/i.test(s)) throw new Error("link");
  return s;
}

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function grade(score) {
  if (score >= 80) return ["AI-ready", "#0e7a5c", "Strong foundations for AI search"];
  if (score >= 55) return ["Partly ready", "#9a6500", "Good start, with gaps AI will notice"];
  return ["At risk", "#c2453b", "AI assistants will struggle to read and trust you"];
}

function visLine(named, total) {
  const pct = Math.round((100 * named) / total);
  if (named === 0) return "You weren't named in any of the answers you ticked. That's the most common result we see, and the most fixable.";
  if (pct < 40) return `Patchy: you were named in ${named} of ${total} answers. Buyers asking AI for a shortlist will usually see competitors first.`;
  if (pct < 80) return `Visible, not yet consistent: you were named in ${named} of ${total} answers. The gap is usually third-party proof and answer-ready content.`;
  return `Strong: you were named in ${named} of ${total} answers. Next, check how you're described and whether the details are accurate.`;
}

const dotColour = { pass: "#0e7a5c", warn: "#f2b84b", fail: "#c2453b" };
const dotChar = { pass: "&#10003;", warn: "!", fail: "&times;" };

function renderEmail({ name, company, ready, self, canReply = false }) {
  const font = "font-family:Inter,Helvetica,Arial,sans-serif";
  const serif = "font-family:Georgia,'Times New Roman',serif";
  const hi = name ? `Hi ${esc(name.split(" ")[0])},` : "Hi,";
  let readyHtml = "", selfHtml = "", text = [];

  if (ready) {
    const [g, gc, gline] = grade(ready.score);
    const host = new URL(ready.url).hostname;
    text.push(`AI READINESS: ${ready.score}/100 (${g}) for ${host}`, "");
    readyHtml = `
<tr><td style="padding:28px 32px 8px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td width="110" valign="middle"><div style="width:96px;height:96px;border-radius:48px;background:#f6f4ef;border:6px solid ${gc};text-align:center;${serif};font-size:34px;font-weight:bold;line-height:96px;color:#18212b">${ready.score}</div></td>
    <td valign="middle" style="${font};color:#18202a">
      <div style="display:inline-block;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${gc}">${g}</div>
      <div style="${serif};font-size:21px;font-weight:bold;margin:4px 0">${esc(gline)}</div>
      <div style="font-size:13px;color:#5a6570">AI readiness score out of 100 for ${esc(host)}</div>
    </td></tr></table>
</td></tr>
<tr><td style="padding:8px 32px 8px">${ready.checks.map((c) => {
      text.push(`- ${c.label}: ${c.points}/${c.max}. ${c.detail}${c.fix ? `\n  Fix: ${c.fix}` : ""}`);
      const bots = c.bots ? `<div style="font-size:12px;color:#5a6570;margin-top:6px">${c.bots.map((b) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:10px;border:1px solid ${b.blocked ? "#e9b8b2" : "#e3ded3"};${b.blocked ? "background:#fbe9e7;color:#c2453b" : ""}">${esc(b.ua)} ${b.blocked ? "blocked" : "allowed"}</span>`).join("")}</div>` : "";
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3ded3"><tr>
  <td width="28" valign="top" style="padding:14px 0"><div style="width:18px;height:18px;border-radius:9px;background:${dotColour[c.status]};color:#fff;font:bold 11px/18px Arial,sans-serif;text-align:center">${dotChar[c.status]}</div></td>
  <td valign="top" style="padding:14px 0;${font};color:#18202a">
    <div style="font-size:15px;font-weight:bold">${esc(c.label)} <span style="float:right;font-weight:normal;color:#5a6570;font-size:13px">${c.points} / ${c.max}</span></div>
    <div style="font-size:14px;color:#5a6570;margin-top:4px;line-height:1.5">${esc(c.detail)}</div>${bots}
    ${c.fix ? `<div style="font-size:14px;margin-top:6px;line-height:1.5"><b style="color:#0e7a5c">Fix:</b> ${esc(c.fix)}</div>` : ""}
  </td></tr></table>`;
    }).join("")}
  <p style="${font};font-size:12px;color:#5a6570;margin:12px 0 0;line-height:1.5">Indicative: based on your home page, robots.txt, llms.txt and sitemap as of ${new Date(ready.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.</p>
</td></tr>`;
    text.push("");
  }

  if (self) {
    const named = self.ticks.filter(Boolean).length;
    const total = self.ticks.length;
    const pct = Math.round((100 * named) / total);
    text.push(`AI VISIBILITY SELF-TEST: ${pct}%`, visLine(named, total), "");
    selfHtml = `
<tr><td style="padding:24px 32px 8px">
  <div style="${serif};font-size:21px;font-weight:bold;color:#18212b">AI visibility self-test: <span style="color:#0e7a5c">${pct}%</span></div>
  <p style="${font};font-size:14px;color:#5a6570;margin:6px 0 10px;line-height:1.5">${esc(visLine(named, total))}</p>
  ${self.prompts.map((q, i) => {
      const c = self.ticks[i * 2], p = self.ticks[i * 2 + 1];
      text.push(`- ${q}\n  ChatGPT: ${c ? "named" : "not named"} | Perplexity: ${p ? "named" : "not named"}`);
      return `<div style="border-top:1px solid #e3ded3;padding:12px 0;${font}"><div style="font-size:14px;color:#18202a">${esc(q)}</div>
  <div style="font-size:13px;color:#5a6570;margin-top:4px">ChatGPT: <b style="color:${c ? "#0e7a5c" : "#5a6570"}">${c ? "named" : "not named"}</b> &nbsp;·&nbsp; Perplexity: <b style="color:${p ? "#0e7a5c" : "#5a6570"}">${p ? "named" : "not named"}</b></div></div>`;
    }).join("")}
</td></tr>`;
    text.push("");
  }

  const title = company ? `AI visibility report: ${company}` : "Your AI visibility report";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ef">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f4ef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3ded3;border-radius:14px;overflow:hidden">
<tr><td style="background:#18212b;padding:22px 32px">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr>
    <td style="padding-right:10px"><div style="width:26px;height:26px;border-radius:6px;background:#232e3a;position:relative"><div style="width:9px;height:9px;background:#37d6a6;margin:5px 0 0 5px"></div><div style="width:9px;height:9px;background:#37d6a6;margin:3px 0 0 13px"></div></div></td>
    <td style="${serif};font-size:21px;font-weight:bold;color:#ffffff">Citekind</td></tr></table>
  <div style="${font};font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#37d6a6;margin-top:22px">Free AI visibility check</div>
  <div style="${serif};font-size:28px;font-weight:bold;color:#ffffff;line-height:1.2;margin-top:6px">${esc(title)}</div>
</td></tr>
<tr><td style="padding:26px 32px 0;${font};font-size:15px;line-height:1.6;color:#18202a">
  <p style="margin:0 0 12px">${hi}</p>
  <p style="margin:0">Here's your full report from the Citekind AI visibility check, with every finding and the fix for each. Most of the fixes are things your team can ship this month.</p>
</td></tr>
${readyHtml}${selfHtml}
<tr><td style="padding:24px 32px 32px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#18212b;border-radius:14px"><tr><td style="padding:24px 26px">
    <div style="${serif};font-size:20px;font-weight:bold;color:#ffffff;line-height:1.3">Want to know exactly what AI says about you, and how to change it?</div>
    <div style="${font};font-size:14px;color:#b7c1c9;margin:8px 0 18px;line-height:1.5">The AI Visibility Audit tests your real buyer prompts across ChatGPT, Perplexity, Gemini, Copilot and Google AI Overviews, benchmarks you against competitors and gives you a 90-day plan.</div>
    <a href="${SITE}/#contact" style="display:inline-block;background:#37d6a6;color:#18212b;${font};font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:999px">Book your audit</a>
  </td></tr></table>
  ${canReply ? `<p style="${font};font-size:14px;color:#18202a;margin:18px 0 0;line-height:1.6">Any questions about your results? Just reply to this email.</p>` : ""}
</td></tr>
</table>
<p style="${font};font-size:12px;color:#5a6570;margin:16px 0 0;line-height:1.5;max-width:600px">You're getting this because you asked for your report at <a href="${SITE}/check/" style="color:#5a6570">citekind.com/check</a>. We won't add you to a mailing list.<br>Citekind · AI search visibility for B2B tech · Buckinghamshire, UK</p>
</td></tr></table></body></html>`;

  const plain = [hi, "", "Here's your full report from the Citekind AI visibility check.", "", ...text,
    "Want to know exactly what AI says about you? Book an AI Visibility Audit: " + SITE + "/#contact", "",
    ...(canReply ? ["Any questions about your results? Just reply to this email.", ""] : []), "Citekind, AI search visibility for B2B tech"].join("\n");
  return { subject: ready ? `${title.replace(/^AI visibility report: /, "")} scored ${ready.score}/100 for AI readiness` : title, html, text: plain };
}

export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!process.env.RESEND_API_KEY) return json(503, { error: "Email isn't set up yet." });
  let d;
  try { d = await req.json(); } catch { return json(400, { error: "Bad request." }); }
  if (!d || d.hp) return json(400, { error: "Bad request." });

  const email = String(d.email || "").trim();
  if (!EMAIL_RE.test(email) || email.length > 200) return json(400, { error: "Please enter a valid email address." });

  let name, company, self = null, ready = null;
  try {
    name = field(d.name, 60);
    company = field(d.company, 60);
    if (d.self) {
      const s = d.self;
      const inp = {
        company: field(s.company, 60), category: field(s.category, 60), audience: field(s.audience, 60),
        region: field(s.region, 40), competitor: field(s.competitor, 60),
      };
      if (!inp.company || !inp.category) throw new Error("missing");
      if (!Array.isArray(s.ticks) || s.ticks.length !== 10) throw new Error("ticks");
      self = { prompts: buildPrompts(inp), ticks: s.ticks.map(Boolean) };
      if (!company) company = inp.company;
    }
  } catch { return json(400, { error: "Some details couldn't be used. Please keep names short and without links." }); }

  if (d.ready) {
    const { sig, ...r } = d.ready;
    if (!verify(r, sig)) return json(400, { error: "Your check results have expired. Please run the check again." });
    if (Date.now() - Date.parse(r.checkedAt) > DAY) return json(400, { error: "Your check results have expired. Please run the check again." });
    ready = r;
  }
  if (!ready && !self) return json(400, { error: "Run the check or the self-test first." });

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (over(byIp, ip, 10) || over(byEmail, email.toLowerCase(), 3)) return json(429, { error: "We've already sent a few reports here today. Please try again tomorrow." });

  const { subject, html, text } = renderEmail({ name, company, ready, self, canReply: !!process.env.REPORT_REPLY_TO });
  const payload = { from: FROM, to: [email], subject, html, text, tags: [{ name: "source", value: "ai-check" }] };
  if (process.env.REPORT_REPLY_TO) payload.reply_to = process.env.REPORT_REPLY_TO;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("resend error", res.status, (await res.text()).slice(0, 300));
      return json(502, { error: "We couldn't send the email just now, but your report is below." });
    }
    return json(200, { sent: true });
  } catch (e) {
    console.error("resend failed", e && e.message);
    return json(502, { error: "We couldn't send the email just now, but your report is below." });
  }
};

export { renderEmail };
