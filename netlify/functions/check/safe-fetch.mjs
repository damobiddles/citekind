// Fetches a public URL with SSRF protection.
// - only http/https on the default ports
// - every hostname is resolved and checked against private/reserved ranges
//   at connect time (custom lookup), so DNS rebinding can't slip past
// - redirects are followed by hand (max 4) and re-checked each hop
// - hard timeout and response size cap
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const blocked = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, "ipv4"));
[
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
].forEach(([a, p]) => blocked.addSubnet(a, p, "ipv6"));

export function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (!fam) return true;
  if (fam === 6) {
    const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return blocked.check(m[1], "ipv4");
  }
  return blocked.check(ip, fam === 4 ? "ipv4" : "ipv6");
}

export class FetchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new FetchError("bad_url", "That doesn't look like a valid web address."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("bad_url", "Only http and https addresses can be checked.");
  if (u.username || u.password) throw new FetchError("bad_url", "Addresses with login details can't be checked.");
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchError("bad_url", "Only standard web ports can be checked.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new FetchError("blocked", "That address isn't publicly reachable.");
  } else if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) {
    throw new FetchError("blocked", "That address isn't publicly reachable.");
  }
  return u;
}

function safeLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
      return cb(new FetchError("blocked", "That address isn't publicly reachable."));
    }
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const UA = "Mozilla/5.0 (compatible; CitekindChecker/1.0; +https://citekind.com/check/)";

function requestOnce(u, { timeout, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "GET",
      lookup: safeLookup,
      headers: {
        "User-Agent": UA,
        Accept: accept || "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      timeout,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, headers: res.headers, redirect: res.headers.location, body: "" });
      }
      let stream = res;
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0; let truncated = false;
      stream.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - maxBytes))); req.destroy(); stream.destroy(); finish(); return; }
        chunks.push(c);
      });
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated }); };
      stream.on("end", finish);
      stream.on("error", (e) => (chunks.length ? finish() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new FetchError("timeout", "The site took too long to respond.")));
    req.on("error", reject);
    req.end();
  });
}

// Returns { url, status, headers, body, truncated } for the final response.
export async function safeFetch(raw, { timeout = 6000, maxBytes = 1_500_000, maxRedirects = 4, accept } = {}) {
  let u = checkUrl(raw);
  const deadline = Date.now() + timeout;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchError("timeout", "The site took too long to respond.");
    let r;
    try {
      r = await requestOnce(u, { timeout: left, maxBytes, accept });
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError("unreachable", `We couldn't connect to ${u.hostname}.`);
    }
    if (r.redirect) { u = checkUrl(new URL(r.redirect, u).toString()); continue; }
    return { url: u.toString(), ...r };
  }
  throw new FetchError("redirects", "The site redirected too many times.");
}
