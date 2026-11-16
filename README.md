# School Filter Check

A single static page that checks whether a device can reach sites a school or
parental filter should block. Open it on the device you want to test, click
**Run all**, and read the results. Nothing from the tested sites is shown on
screen; the page only probes whether connections work.

Live: <https://scrothers.com/schoolfilter/>

## What it checks

For each domain in [`sites.json`](sites.json), stopping as soon as there's an answer:

1. **1.1.1.1**: asks Cloudflare's DNS-over-HTTPS whether the domain exists.
   If it doesn't, the site is **GONE**.
2. **Filter DNS** (optional): asks a filtering DNS service's DoH endpoint.
   NXDOMAIN, no answer, an internal address (10/8, 172.16/12, 192.168/16,
   100.64/10, 127/8, 0.0.0.0, 169.254/16), or a block-page IP shared by
   several unrelated domains is a **DNS BLOCK**, and the site isn't contacted.
3. **Connect**: `GET https://domain/` in `no-cors` mode.
4. **Images**: loads the site's own logo/icon images from
   [`baseline.json`](baseline.json) and checks each comes back at its
   recorded size.

| Result | Meaning |
| --- | --- |
| ALLOWED | At least half the site's real images loaded at the right size |
| SUSPECT | Something answered, but not the real site (a block page, even one served with 200 OK over intercepted HTTPS) |
| BLOCKED | Nothing got through |
| DNS BLOCK | The filter DNS refused or redirected it |
| UNTESTABLE | Failed in the baseline too, so the page can't tell |
| GONE | The domain no longer exists |

Filter DNS presets: Cloudflare for Families, Cloudflare Security,
CleanBrowsing Family/Adult. Any DoH endpoint that allows browser requests
(CORS) works; AdGuard, OpenDNS and NextDNS don't. The setting can be passed in
the link as `?filter=<url>`.

## Limits

- A browser can't see the device's own DNS answers, so without a filter DoH
  endpoint a DNS block shows up as BLOCKED.
- Sites with no usable baseline images (bot walls, `Cross-Origin-Resource-Policy:
  same-origin`, icons on a third-party CDN) can only be checked for
  reachability. On a device whose filter intercepts HTTPS, a block page there
  looks allowed. The page shows how many results fall in this bucket.

## Regenerating the baseline

Run on a network **without** filtering, with Node 22+ and Chromium installed:

```sh
node gen-baseline.mjs            # writes baseline.json (about 5 minutes)
node gen-baseline.mjs --chrome google-chrome --out baseline.json
```

It finds up to five logo/icon images per site served from that domain, loads
each in headless Chromium twice as a cross-origin `<img>` (exactly as the page
does), and records the ones that load with a stable size. Regenerate after
editing `sites.json`, and now and then as sites change their icons.

## Local use

The page fetches `sites.json` and `baseline.json`, so serve the folder rather
than opening the file directly:

```sh
python3 -m http.server 8000
```

Adding `?autorun` to the URL starts a run on load and writes a plain-text
report into a `<pre id="report">` element, for headless testing.
