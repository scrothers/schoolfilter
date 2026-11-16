#!/usr/bin/env node
// Generate baseline.json for the filter-check page. Run on an UNFILTERED network.
//
//   node gen-baseline.mjs [--sites sites.json] [--out baseline.json] [--chrome chromium-browser]
//
// For each domain in sites.json:
//   1. Ask 1.1.1.1 whether it exists (gone domains are recorded and skipped).
//   2. Discover logo/icon image URLs served from that domain or its subdomains:
//      <link rel=icon|apple-touch-icon|mask-icon>, web-manifest icons, <img> tags
//      that look like logos, and well-known icon paths. Content images and
//      og:image are skipped on purpose.
//   3. Download each candidate, keep real images (status 200, image bytes, no
//      CORP same-origin/same-site), drop duplicate bytes. Candidates a bot
//      wall refuses (401/403/429/503, connection error) go to Chromium as-is.
//   4. Load the survivors in headless Chromium as cross-origin <img>, exactly as
//      the page does, twice, and keep those that load both times with the same
//      size. Also records whether a no-cors GET / gets through.
//   5. Keep up to MAX_IMAGES per site, preferring distinct sizes.
// Requires Node 22+ (global fetch + WebSocket) and Chromium.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc, []));
const SITES = args.sites ?? new URL("sites.json", import.meta.url).pathname;
const OUT = args.out ?? new URL("baseline.json", import.meta.url).pathname;
const CHROME = args.chrome ?? "chromium-browser";

const MAX_IMAGES = 5;
const MAX_CANDIDATES = 24;
const CONCURRENCY = 12;
const UA = "schoolscan-baseline/1.0 (+parental filter test; finds site logos)";
const WELL_KNOWN = ["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.png",
  "/favicon.svg", "/favicon-32x32.png", "/favicon-16x16.png", "/logo.png", "/logo.svg", "/images/logo.png"];
const LOGO_HINT = /logo|brand|icon|emblem/i;

const log = (...m) => console.error(...m);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function get(url, accept, maxBytes = 2_000_000) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" },
                                 redirect: "follow", signal: AbortSignal.timeout(10000) });
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, maxBytes);
    return { status: r.status, url: r.url, headers: r.headers, buf };
  } catch {
    return null;
  }
}

async function exists(domain) {
  const r = await get(`https://1.1.1.1/dns-query?type=A&name=${encodeURIComponent(domain)}`, "application/dns-json");
  if (!r || r.status !== 200) return true; // can't tell; assume it exists
  try { return (JSON.parse(r.buf.toString()).Answer || []).some(a => a.type === 1); } catch { return true; }
}

const decodeEntities = s => s.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
};

function looksLikeImage(buf, type) {
  if (/^image\//i.test(type || "")) return true;
  const h = buf.subarray(0, 12);
  return (h[0] === 0x89 && h[1] === 0x50) || (h[0] === 0xFF && h[1] === 0xD8) || h.subarray(0, 3).toString() === "GIF" ||
         (h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0) || h.subarray(8, 12).toString() === "WEBP" ||
         /^\s*(<\?xml[^>]*>\s*)?<svg/i.test(buf.subarray(0, 200).toString());
}

async function discover(domain) {
  const base = domain.replace(/^www\./, "");
  const inFamily = u => { try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === base || x.hostname.endsWith("." + base)); } catch { return false; } };
  const cands = new Map(); // url -> priority (lower is better)
  const add = (u, pri) => { if (inFamily(u) && !cands.has(u)) cands.set(u, pri); };
  const resolve = (href, from) => { try { return new URL(href, from).href; } catch { return null; } };

  const page = await get(`https://${domain}/`, "text/html,application/xhtml+xml");
  let origin = `https://${domain}`;
  if (page && page.status < 500) {
    const from = page.url || origin + "/";
    if (inFamily(from)) origin = new URL(from).origin;
    const html = page.buf.toString("utf8");
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const rel = (attr(tag, "rel") || "").toLowerCase();
      const href = attr(tag, "href");
      if (!href) continue;
      if (/icon|apple-touch|mask-icon/.test(rel) && !/startup/.test(rel)) add(resolve(href, from), 1); // no iOS splash screens
      if (rel === "manifest") {
        const mu = resolve(href, from);
        const m = mu && await get(mu, "application/manifest+json,application/json");
        try {
          for (const ic of JSON.parse(m.buf.toString()).icons || []) add(resolve(ic.src, mu), 2);
        } catch { /* no manifest */ }
      }
    }
    for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
      const src = attr(tag, "src") || attr(tag, "data-src");
      if (src && !src.startsWith("data:") && LOGO_HINT.test(tag)) add(resolve(src, from), 3);
    }
  }
  for (const p of WELL_KNOWN) { add(origin + p, 4); add(`https://${domain}${p}`, 4); }
  return [...cands].sort((a, b) => a[1] - b[1]).slice(0, MAX_CANDIDATES).map(([u, pri]) => ({ url: u, pri }));
}

async function prefilter(cands) {
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    const r = await get(c.url, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
    // Bot protection often challenges plain HTTP clients but lets a browser's
    // image request through, so let Chromium decide for those.
    if (!r || [401, 403, 429, 503].includes(r.status)) { out.push({ ...c, hash: null }); continue; }
    if (r.status !== 200 || r.buf.length < 50) continue;
    if (!looksLikeImage(r.buf, r.headers.get("content-type"))) continue;
    if (/same-(origin|site)/i.test(r.headers.get("cross-origin-resource-policy") || "")) continue;
    const hash = createHash("sha1").update(r.buf).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ ...c, hash });
  }
  return out;
}

// ---------- headless Chromium ----------

async function withChrome(fn) {
  const profile = mkdtempSync(join(tmpdir(), "schoolscan-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 100 && !targets; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!targets) throw new Error("chromium did not start");
    const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
    const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (fnSrc, arg) => {
      const m = await send("Runtime.evaluate", { expression: `(${fnSrc})(${JSON.stringify(arg)})`,
                                                 awaitPromise: true, returnByValue: true });
      if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
      return m.result.result.value;
    };
    return await fn(evaluate);
  } finally {
    chrome.kill("SIGTERM");
    rmSync(profile, { recursive: true, force: true });
  }
}

// Runs inside the browser: same probes as index.html.
const BROWSER_PROBE = async ({ images, domains }) => {
  const T = 8000;
  const loadImg = url => new Promise(res => {
    const img = new Image();
    const t = setTimeout(() => { img.src = ""; res(null); }, T);
    img.referrerPolicy = "no-referrer";
    img.onload = () => { clearTimeout(t); res(img.naturalWidth > 0 ? [img.naturalWidth, img.naturalHeight] : null); };
    img.onerror = () => { clearTimeout(t); res(null); };
    img.src = url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();
  });
  const connect = async d => {
    try {
      await fetch("https://" + d + "/?_=" + Date.now(), { mode: "no-cors", cache: "no-store", credentials: "omit",
                                                         signal: AbortSignal.timeout(T) });
      return true;
    } catch { return false; }
  };
  const run = async (items, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
  };
  return { sizes: await run(images, loadImg), connects: await run(domains, connect) };
};

// ---------- main ----------

const sitesByCat = JSON.parse(readFileSync(SITES, "utf8"));
const domains = [...new Set(Object.values(sitesByCat).flat())];
log(`${domains.length} domains`);

const found = await pool(domains, CONCURRENCY, async d => {
  if (!(await exists(d))) { log(`  ${d}: gone`); return { domain: d, gone: true, cands: [] }; }
  const cands = await prefilter(await discover(d));
  log(`  ${d}: ${cands.length} candidate image(s)`);
  return { domain: d, gone: false, cands };
});

const live = found.filter(f => !f.gone);
const allImages = live.flatMap(f => f.cands.map(c => c.url));
log(`verifying ${allImages.length} images in Chromium (2 passes)…`);
const passes = await withChrome(async evaluate => [
  await evaluate(BROWSER_PROBE.toString(), { images: allImages, domains: live.map(f => f.domain) }),
  await evaluate(BROWSER_PROBE.toString(), { images: allImages, domains: [] }),
]);
const sizeOf = new Map(allImages.map((u, i) => {
  const [a, b] = [passes[0].sizes[i], passes[1].sizes[i]];
  return [u, a && b && a[0] === b[0] && a[1] === b[1] ? a : null];
}));
const connectOf = new Map(live.map((f, i) => [f.domain, passes[0].connects[i]]));

const sites = {};
for (const f of found) {
  if (f.gone) { sites[f.domain] = { gone: true, fetchOk: false, images: [] }; continue; }
  const ok = f.cands.filter(c => sizeOf.get(c.url)).map(c => ({ ...c, size: sizeOf.get(c.url) }));
  // Prefer distinct sizes first (harder for a filter's single icon to match), then by source priority.
  const picked = [];
  const sizes = new Set();
  for (const c of ok) if (picked.length < MAX_IMAGES && !sizes.has(c.size.join("x"))) { picked.push(c); sizes.add(c.size.join("x")); }
  for (const c of ok) if (picked.length < MAX_IMAGES && !picked.includes(c)) picked.push(c);
  sites[f.domain] = { fetchOk: connectOf.get(f.domain), images: picked.map(c => ({ url: c.url, w: c.size[0], h: c.size[1] })) };
}

const counts = { 0: 0, 1: 0, 2: 0, "3+": 0 };
for (const s of Object.values(sites)) if (!s.gone) counts[s.images.length >= 3 ? "3+" : s.images.length]++;
writeFileSync(OUT, JSON.stringify({ version: 2, taken: new Date().toISOString(), generator: "gen-baseline.mjs",
                                    ua: UA, sites }, null, 1) + "\n");
log(`wrote ${OUT}`);
log(`images per live site: 0 → ${counts[0]}, 1 → ${counts[1]}, 2 → ${counts[2]}, 3+ → ${counts["3+"]}`);
log("sites with no image (no block-page check possible): " +
    Object.entries(sites).filter(([, s]) => !s.gone && !s.images.length).map(([d]) => d).join(", "));
