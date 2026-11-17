# Citekind website

Static site for Citekind, hosted on Netlify. No build step: the HTML files in this folder are published as they are.

- `index.html`: home page, including the animated "How the audit works" demo (`#how`, plain CSS and JS, no libraries) and the audit request form (handled by Netlify Forms)
- `thanks.html`: page shown after the form is sent
- `check/`: free AI visibility checker. The page calls `/api/check`, a Netlify Function in `netlify/functions/check/` (no dependencies, shared code in `netlify/lib/`) that fetches the visitor's site with SSRF protection and scores it. The "full report" gate is the Netlify form `ai-check-report` (lead notification to Damien) plus `/api/send-report`, which emails the visitor via Resend from report@citekind.com. Needs the `RESEND_API_KEY` env var in Netlify (set, functions scope); optional `REPORT_REPLY_TO` sets the reply-to address
- `llms.txt`: plain-text summary of Citekind for AI tools
- `blog/`: blog index, posts, and shared `blog/blog.css`
- `sitemap.xml`: public pages for search engines (referenced from `robots.txt`)

Brand palette ("ink and mint"): ink `#18212b`, ink-2 `#232e3a`, deep ink `#10161d`, mint `#37d6a6`, mint text `#0e7a5c`, paper `#f6f4ef`. Canonical domain: https://citekind.com
