// Pure scoring logic for the AI readiness check. No network access here,
// so it can be tested against saved HTML.

export const AI_BOTS = [
  // name, what it does, weight (answer-time/search bots matter most for citations)
  { ua: "OAI-SearchBot", who: "ChatGPT search", weight: 2 },
  { ua: "ChatGPT-User", who: "ChatGPT browsing", weight: 2 },
  { ua: "PerplexityBot", who: "Perplexity", weight: 2 },
  { ua: "Claude-SearchBot", who: "Claude search", weight: 2 },
  { ua: "Bingbot", who: "Bing and Copilot", weight: 2 },
  { ua: "GPTBot", who: "OpenAI training", weight: 1 },
  { ua: "ClaudeBot", who: "Anthropic training", weight: 1 },
  { ua: "Google-Extended", who: "Gemini training", weight: 1 },
  { ua: "Applebot-Extended", who: "Apple Intelligence", weight: 1 },
  { ua: "CCBot", who: "Common Crawl", weight: 1 },
];

const REVIEW_SITES = [
  ["G2", /(^|\.)g2\.com$/], ["Capterra", /(^|\.)capterra\.(com|co\.uk)$/], ["Trustpilot", /(^|\.)trustpilot\.com$/],
  ["Gartner Peer Insights", /(^|\.)gartner\.com$/], ["TrustRadius", /(^|\.)trustradius\.com$/],
  ["GetApp", /(^|\.)getapp\.(com|co\.uk)$/], ["Software Advice", /(^|\.)softwareadvice\.(com|co\.uk)$/],
  ["Clutch", /(^|\.)clutch\.co$/], ["PeerSpot", /(^|\.)peerspot\.com$/],
];

const ORG_TYPES = /^(Organization|Corporation|ProfessionalService|LocalBusiness|OnlineBusiness|NGO|EducationalOrganization)$/i;
const OFFER_TYPES = /^(Product|SoftwareApplication|WebApplication|MobileApplication|Service|Offer|ProductGroup)$/i;

const decode = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const words = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "").trim() : null;
}

function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const t of tags) {
    const n = (attr(t, "name") || attr(t, "property") || "").toLowerCase();
    if (n === key) return attr(t, "content") || "";
  }
  return null;
}

// ---- robots.txt -----------------------------------------------------------
export function parseRobots(txt) {
  const groups = []; let cur = null; let lastWasUa = false; const sitemaps = [];
  for (let line of String(txt || "").split(/\r?\n/)) {
    line = line.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasUa || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasUa = true;
    } else {
      lastWasUa = false;
      if (key === "sitemap") sitemaps.push(val);
      else if ((key === "allow" || key === "disallow") && cur) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  return { groups, sitemaps };
}

// Is the home page ("/") blocked for this bot?
export function botBlocked(robots, ua) {
  const name = ua.toLowerCase();
  let group = robots.groups.find((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  if (!group) group = robots.groups.find((g) => g.agents.includes("*"));
  if (!group) return false;
  let best = null;
  for (const r of group.rules) {
    if (r.path === "" ) continue; // "Disallow:" with no path allows everything
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test("/")) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? !best.allow : false;
}

// ---- JSON-LD ----------------------------------------------------------------
export function schemaTypes(html) {
  const types = new Set(); let blocks = 0; let invalid = 0;
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n["@type"];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => types.add(String(x).replace(/^.*[/#]/, "")));
    Object.values(n).forEach((v) => typeof v === "object" && walk(v));
  };
  while ((m = re.exec(html))) {
    blocks++;
    try { walk(JSON.parse(m[1].trim())); } catch { invalid++; }
  }
  const micro = /\bitemtype\s*=\s*["']https?:\/\/schema\.org\//i.test(html);
  return { types: [...types], blocks, invalid, micro };
}

// ---- main analysis --------------------------------------------------------
export function analyse({ finalUrl, html, robots, llms, sitemap }) {
  const checks = [];
  const add = (c) => checks.push(c);
  const url = new URL(finalUrl);
  const head = html.slice(0, 400_000);

  // 1. HTTPS
  add(url.protocol === "https:"
    ? { id: "https", label: "Secure (HTTPS) site", max: 5, points: 5, status: "pass", detail: "Your site loads over HTTPS." }
    : { id: "https", label: "Secure (HTTPS) site", max: 5, points: 0, status: "fail", detail: "Your site loads over plain HTTP.", fix: "Serve the whole site over HTTPS and redirect HTTP to it. AI search tools and browsers trust secure sites more." });

  // 2. AI crawlers
  {
    const max = 20;
    if (robots.status === "error") {
      add({ id: "crawlers", label: "AI crawlers allowed", max, points: 10, status: "warn", detail: "We couldn't read your robots.txt (the server returned an error), so some crawlers may treat the site as off-limits.", fix: "Make sure /robots.txt returns a normal 200 response, or a 404 if you don't use one." });
    } else {
      const parsed = parseRobots(robots.body || "");
      const results = AI_BOTS.map((b) => ({ ...b, blocked: botBlocked(parsed, b.ua) }));
      const total = results.reduce((s, b) => s + b.weight, 0);
      const ok = results.reduce((s, b) => s + (b.blocked ? 0 : b.weight), 0);
      const points = Math.round((max * ok) / total);
      const blockedBots = results.filter((b) => b.blocked);
      const searchBlocked = blockedBots.filter((b) => b.weight === 2);
      add({
        id: "crawlers", label: "AI crawlers allowed", max, points,
        status: blockedBots.length === 0 ? "pass" : searchBlocked.length ? "fail" : "warn",
        detail: blockedBots.length === 0
          ? `None of the ${AI_BOTS.length} main AI crawlers we test are blocked in robots.txt${robots.status === 404 ? " (you don't have one, which means everything is allowed)" : ""}.`
          : `robots.txt blocks ${blockedBots.map((b) => `${b.ua} (${b.who})`).join(", ")}.`,
        fix: blockedBots.length === 0 ? undefined : searchBlocked.length
          ? `Allow ${searchBlocked.map((b) => b.ua).join(", ")} in robots.txt. These fetch pages when someone asks a question, so blocking them stops AI assistants from reading and citing you. Blocking training-only bots (like GPTBot or CCBot) is a separate, legitimate choice.`
          : "Only training crawlers are blocked. That's a valid choice, but it can reduce how well models know your brand over time. Review whether it's deliberate.",
        bots: results.map(({ ua, who, blocked }) => ({ ua, who, blocked })),
        note: "Robots.txt is only half the story: firewall and CDN bot rules (e.g. Cloudflare's AI bot blocking) can also turn AI crawlers away.",
      });
    }
  }

  // 3. Content without JavaScript
  {
    const max = 20;
    const body = (head.match(/<body\b[^>]*>([\s\S]*)/i) || [, head])[1];
    const text = stripTags(body.replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " "));
    const n = words(text).length;
    const shell = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(body);
    const points = n >= 300 ? 20 : n >= 120 ? 10 : 0;
    add({
      id: "nojs", label: "Content readable without JavaScript", max, points,
      status: points === 20 ? "pass" : points ? "warn" : "fail",
      detail: `Your home page has about ${n.toLocaleString("en-GB")} words of readable text before any JavaScript runs.${shell && n < 120 ? " It looks like an app shell that builds the page in the browser." : ""}`,
      fix: points === 20 ? undefined : "Most AI crawlers don't run JavaScript. Use server-side rendering or static pre-rendering so your key copy (what you do, who for, proof) is in the raw HTML.",
    });
  }

  // 4. Structured data
  {
    const max = 15;
    const s = schemaTypes(head);
    const hasOrg = s.types.some((t) => ORG_TYPES.test(t));
    const hasOffer = s.types.some((t) => OFFER_TYPES.test(t));
    const hasFaq = s.types.some((t) => /^FAQPage$/i.test(t));
    let points = 0;
    if (s.blocks - s.invalid > 0) points = 6 + (hasOrg ? 5 : 0) + (hasOffer ? 2 : 0) + (hasFaq ? 2 : 0);
    else if (s.micro) points = 4;
    const missing = [!hasOrg && "Organization", !hasOffer && "Product or Service", !hasFaq && "FAQPage"].filter(Boolean);
    add({
      id: "schema", label: "Structured data (schema.org)", max, points,
      status: points >= 13 ? "pass" : points ? "warn" : "fail",
      detail: s.blocks
        ? `Found ${s.blocks} JSON-LD block${s.blocks > 1 ? "s" : ""}${s.types.length ? ` with: ${s.types.slice(0, 8).join(", ")}` : ""}.${s.invalid ? ` ${s.invalid} couldn't be parsed.` : ""}`
        : s.micro ? "Found schema.org microdata but no JSON-LD." : "No structured data found on the home page.",
      fix: points >= 13 ? undefined : `Add JSON-LD describing your company${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Include your name, logo, description and sameAs links to LinkedIn and review profiles, so AI can connect the facts about you.${s.invalid ? " Fix the JSON-LD that doesn't parse." : ""}`,
    });
  }

  // 5. Meta description
  {
    const max = 10;
    const d = metaContent(head, "description");
    const og = metaContent(head, "og:description");
    const len = d ? d.length : 0;
    let points = 0, status = "fail", detail = "No meta description found.";
    if (d && len >= 50 && len <= 180) { points = 10; status = "pass"; detail = `“${d}” (${len} characters).`; }
    else if (d) { points = 5; status = "warn"; detail = `“${d}” is ${len} characters. Around 120 to 160 works best.`; }
    else if (og) { points = 4; status = "warn"; detail = `No meta description, but an Open Graph description exists: “${og}”.`; }
    add({ id: "meta", label: "Meta description", max, points, status, detail,
      fix: points === 10 ? undefined : "Write a 120 to 160 character meta description that says plainly what you do, for whom, and what makes you different. AI tools often reuse it as your one-line summary." });
  }

  // 6. Clear H1 / what-we-do
  {
    const max = 10;
    const h1s = (head.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi) || []).map((h) => stripTags(h)).filter(Boolean);
    const title = stripTags((head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]);
    const h1 = h1s[0] || "";
    const n = words(h1).length;
    const generic = /^(welcome|home|hello|hi|homepage|untitled)\b/i.test(h1);
    const desc = `${h1} ${metaContent(head, "description") || ""}`.toLowerCase();
    const says = /\b(for|helps?|platform|software|solution|service|provider|tool|app|api|agency|consult\w*|automat\w*|manag\w*|secur\w*|protect\w*|monitor\w*|complian\w*|payments?|data)\b/.test(desc);
    let points = 0;
    if (h1) { points = generic || n < 3 ? 3 : n > 20 ? 6 : 7; if (says) points += 3; if (h1s.length > 1) points = Math.max(0, points - 2); }
    else if (title) points = 2;
    points = Math.min(max, points);
    add({
      id: "h1", label: "Clear “what we do” headline", max, points,
      status: points >= 9 ? "pass" : points >= 5 ? "warn" : "fail",
      detail: h1 ? `Your main headline reads: “${h1.slice(0, 160)}”${h1s.length > 1 ? ` (and there are ${h1s.length} H1 headings on the page)` : ""}` : `No H1 heading found${title ? `; the page title is “${title.slice(0, 120)}”` : ""}.`,
      fix: points >= 9 ? undefined : "Use one H1 that states what you are and who it's for in plain words (e.g. “Managed detection and response for UK fintechs”). Clever taglines are hard for AI to classify.",
    });
  }

  // 7. Review profiles
  {
    const max = 10;
    const found = new Set();
    for (const m of head.matchAll(/\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
      try { const h = new URL(m[1]).hostname.toLowerCase(); REVIEW_SITES.forEach(([n, re]) => re.test(h) && found.add(n)); } catch {}
    }
    const list = [...found];
    const points = list.length >= 2 ? 10 : list.length === 1 ? 6 : 0;
    add({
      id: "reviews", label: "Links to review-site profiles", max, points,
      status: points === 10 ? "pass" : points ? "warn" : "fail",
      detail: list.length ? `Your home page links to: ${list.join(", ")}.` : "No links to G2, Capterra, Trustpilot, Gartner Peer Insights or similar from the home page.",
      fix: points === 10 ? undefined : "AI assistants lean heavily on review sites when recommending vendors. Build profiles on the two or three that matter in your category and link to them from your site (and in your schema sameAs).",
    });
  }

  // 8. llms.txt
  {
    const max = 5;
    const b = (llms.body || "").trim();
    const ok = llms.status === 200 && !/^<(!doctype|html)/i.test(b) && b.length > 0;
    const points = ok ? (b.length >= 200 ? 5 : 3) : 0;
    add({
      id: "llms", label: "llms.txt file", max, points,
      status: points === 5 ? "pass" : points ? "warn" : "fail",
      detail: ok ? `Found /llms.txt (${b.length.toLocaleString("en-GB")} characters).` : "No /llms.txt found.",
      fix: points === 5 ? undefined : "Add a short /llms.txt: a plain-text summary of what you do with links to your key pages. It's an emerging convention rather than a standard, but it's cheap and some AI tools already read it.",
    });
  }

  // 9. Sitemap
  {
    const max = 5;
    const parsed = parseRobots(robots.body || "");
    const ok = sitemap.ok || parsed.sitemaps.length > 0;
    add({
      id: "sitemap", label: "XML sitemap", max, points: ok ? 5 : 0, status: ok ? "pass" : "fail",
      detail: ok ? (parsed.sitemaps.length ? "Your robots.txt points to a sitemap." : "Found /sitemap.xml.") : "No sitemap found at /sitemap.xml or in robots.txt.",
      fix: ok ? undefined : "Publish an XML sitemap and reference it in robots.txt so crawlers find every page, including new content.",
    });
  }

  const score = checks.reduce((s, c) => s + c.points, 0);
  const fixes = checks.filter((c) => c.fix && c.points < c.max)
    .sort((a, b) => (b.max - b.points) - (a.max - a.points))
    .map((c) => ({ id: c.id, label: c.label, gain: c.max - c.points, fix: c.fix }));
  return { url: finalUrl, score, checks, fixes };
}
