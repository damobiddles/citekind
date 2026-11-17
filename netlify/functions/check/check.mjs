// POST /api/check  { url, hp }  ->  AI readiness report (JSON)
// Results are indicative: we only look at the home page, robots.txt,
// llms.txt and the sitemap.
import { safeFetch, checkUrl, FetchError } from "./safe-fetch.mjs";
import { analyse } from "./analyse.mjs";

export const config = {
  path: "/api/check",
  // Netlify's edge rate limit (per IP): 6 checks a minute.
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

// Best-effort per-instance limits on top of Netlify's: 20 checks per IP per hour,
// and a 10 minute cache per site so repeat checks don't hammer anyone.
const HOUR = 3_600_000;
const hits = new Map();
const cache = new Map();

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < HOUR);
  if (list.length >= 20) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
});

function normalise(input) {
  let s = String(input || "").trim();
  if (!s || s.length > 300) throw new FetchError("bad_url", "Please enter your website address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  const u = checkUrl(s);
  return `${u.protocol}//${u.host}/`;
}

async function optional(url, opts) {
  try { const r = await safeFetch(url, opts); return { status: r.status, body: r.status === 200 ? r.body : "", headers: r.headers }; }
  catch { return { status: 0, body: "" }; }
}

export default async (req, context) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  let data;
  try { data = await req.json(); } catch { return json(400, { error: "Bad request." }); }
  if (data && data.hp) return json(400, { error: "Bad request." }); // honeypot filled: a bot

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (limited(ip)) return json(429, { error: "You've run a lot of checks. Please try again in an hour, or book an audit for the full picture." });

  let start;
  try { start = normalise(data?.url); } catch (e) { return json(400, { error: e.message }); }

  const key = start.replace(/^http:/, "https:");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return json(200, hit.result);

  // Home page first (it tells us the real origin after redirects).
  let home;
  try {
    home = await safeFetch(start, { timeout: 6500 });
  } catch (e) {
    if (start.startsWith("https:") && e.code === "unreachable") {
      try { home = await safeFetch(start.replace(/^https:/, "http:"), { timeout: 4000 }); } catch {}
    }
    if (!home) return json(422, { error: e instanceof FetchError ? e.message : "We couldn't load that site." });
  }
  if (home.status >= 400) {
    return json(422, { error: `Your home page returned an error (HTTP ${home.status}). If it works in your browser, the site may be blocking automated visitors, which would also affect AI crawlers.` });
  }
  const ctype = String(home.headers["content-type"] || "");
  if (ctype && !/html|xml|text\/plain/i.test(ctype)) return json(422, { error: "That address didn't return a web page." });

  const origin = new URL(home.url).origin;
  const [robotsRes, llms, sm] = await Promise.all([
    optional(origin + "/robots.txt", { timeout: 3000, maxBytes: 300_000, accept: "text/plain,*/*" }),
    optional(origin + "/llms.txt", { timeout: 3000, maxBytes: 300_000, accept: "text/plain,text/markdown,*/*" }),
    optional(origin + "/sitemap.xml", { timeout: 3000, maxBytes: 200_000, accept: "application/xml,text/xml,*/*" }),
  ]);
  const robots = robotsRes.status >= 500 ? { status: "error", body: "" } : { status: robotsRes.status, body: robotsRes.status === 200 ? robotsRes.body : "" };
  const sitemap = { ok: sm.status === 200 && /<(urlset|sitemapindex)\b/i.test(sm.body) };

  const result = analyse({ finalUrl: home.url, html: home.body, robots, llms, sitemap });
  result.checkedAt = new Date().toISOString();
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return json(200, result);
};
