// api/proxy.js
// Node.js serverless function for Vercel (generic Node style).
// Dependencies: cheerio
//
// Basic usage:
//  - Server-side proxied path: /p/<base64-url>  (rewritten to /api/proxy?u=<b64> by vercel.json)
//  - Or directly: /api/proxy?u=<base64-url>
//
// Important: This implementation intentionally strips/refuses some headers for privacy by default.
// If you need cookie forwarding/auth handling, add explicit allow/flag logic.

const cheerio = require("cheerio");

function b64Encode(str) {
  return Buffer.from(str, "utf8").toString("base64url"); // base64url avoids +/=
}
function b64Decode(b64) {
  return Buffer.from(b64, "base64url").toString("utf8");
}
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  try {
    // Accept target either as query param `u` (base64url) or path param style.
    const b64 =
      req.query.u || (req.url && (req.url.match(/[?&]u=([^&]+)/) || [])[1]);
    if (!b64) {
      res.statusCode = 400;
      return res.end("Missing `u` parameter (base64url-encoded target URL).");
    }

    const targetUrl = b64Decode(b64);
    if (!isHttpUrl(targetUrl)) {
      res.statusCode = 400;
      return res.end("Invalid target URL.");
    }

    // Build fetch options
    const method = req.method || "GET";
    const headers = {};
    // Copy allowed headers but strip/refuse ones that leak browser info
    const FORWARD_ALLOW = [
      "accept",
      "accept-language",
      "content-type",
      "range",
      "if-range",
      "if-none-match",
      "cache-control",
      "x-requested-with",
    ];
    for (const h of FORWARD_ALLOW) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }

    // Optionally forward cookies only if explicitly allowed
    // (default: don't forward browser cookies to upstream).
    // To enable, append &forwardCookies=1 to the proxy URL (explicit opt-in).
    if (req.query.forwardCookies === "1" && req.headers.cookie) {
      headers.cookie = req.headers.cookie;
    }

    // Remove Referer/Origin to protect privacy (server-to-server call)
    // If upstream needs a referer, you may set one explicitly.
    // headers.referer = ''; // we omit referer

    // Prepare body for non-GET requests
    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      body = req;
      // In Node serverless, req is a readable stream which can be passed to fetch.
    }

    // Forward Range header so media that supports it still works
    if (req.headers.range) headers.range = req.headers.range;

    // Perform the fetch
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
    });

    // Pass most response headers back, with privacy-safe modifications
    // Remove/mangle Set-Cookie by default to avoid leaking upstream cookies into the client.
    const upstreamHeaders = upstreamResponse.headers;
    const ct = upstreamHeaders.get("content-type") || "";

    // Copy headers except Set-Cookie / Server / x-powered-by etc.
    const HIDE_HEADERS = new Set(["set-cookie", "server", "x-powered-by"]);
    for (const [k, v] of upstreamHeaders.entries()) {
      if (HIDE_HEADERS.has(k.toLowerCase())) continue;
      // Overwrite/referrer policies for privacy
      if (k.toLowerCase() === "referrer-policy") continue;
      res.setHeader(k, v);
    }

    // Add privacy headers for outgoing response
    res.setHeader("Referrer-Policy", "no-referrer"); // prevent browser sending referer to other sites
    // Content-Security-Policy can be added if you want to further lock down embedded resources.
    // res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:;");

    // If upstream responded with a redirect status, rewrite Location to proxy too
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const loc = upstreamResponse.headers.get("location");
      if (loc) {
        // Resolve relative redirects against the target
        const resolved = new URL(loc, targetUrl).toString();
        const proxied = `/p/${b64Encode(resolved)}`;
        res.setHeader("Location", proxied);
      }
      res.statusCode = upstreamResponse.status;
      return res.end(); // no body needed
    }

    // If content is HTML, rewrite it (links, scripts, images, forms, srcset, inline CSS url(...))
    if (ct.includes("text/html")) {
      const text = await upstreamResponse.text();
      const $ = cheerio.load(text);

      // Helper to proxify a resolved URL string
      const proxify = (rawUrl) => {
        try {
          // ignore anchors, javascript, data:, mailto:
          if (!rawUrl) return rawUrl;
          if (
            rawUrl.startsWith("javascript:") ||
            rawUrl.startsWith("data:") ||
            rawUrl.startsWith("mailto:")
          )
            return rawUrl;
          const resolved = new URL(rawUrl, targetUrl).toString();
          return `/p/${b64Encode(resolved)}`;
        } catch (e) {
          return rawUrl;
        }
      };

      // Rewrite anchors
      $("a").each((i, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const p = proxify(href);
        $(el).attr("href", p);
        // privacy
        const rel = ($(el).attr("rel") || "") + " noreferrer noopener";
        $(el).attr("rel", rel.trim());
      });

      // Rewrite resources: img, script, link(rel=stylesheet), video source, audio source, iframe
      const resourceSelectors = [
        "img",
        "script",
        "iframe",
        "video",
        "audio",
        "source",
        "embed",
        'link[rel="stylesheet"]',
      ];
      resourceSelectors.forEach((sel) => {
        $(sel).each((i, el) => {
          const attr = $(el).attr("src")
            ? "src"
            : $(el).attr("href")
            ? "href"
            : null;
          if (!attr) return;
          const val = $(el).attr(attr);
          if (!val) return;
          $(el).attr(attr, proxify(val));
        });
      });

      // Rewrite <link href=...> (fonts/styles)
      $("link").each((i, el) => {
        const href = $(el).attr("href");
        if (href) $(el).attr("href", proxify(href));
      });

      // Rewrite forms (action)
      $("form").each((i, el) => {
        const action = $(el).attr("action") || "";
        // Make forms POST back to proxy (so cookies/tokens handled as desired)
        $(el).attr("action", proxify(action || targetUrl));
      });

      // Rewrite srcset attributes
      $("[srcset]").each((i, el) => {
        const raw = $(el).attr("srcset");
        if (!raw) return;
        const parts = raw
          .split(",")
          .map((p) => p.trim())
          .map((entry) => {
            const [u, descriptor] = entry.split(/\s+/, 2);
            return `${proxify(u)}${descriptor ? " " + descriptor : ""}`;
          });
        $(el).attr("srcset", parts.join(", "));
      });

      // Rewrite inline style url(...) occurrences
      $("*[style]").each((i, el) => {
        const style = $(el).attr("style");
        if (!style) return;
        const newStyle = style.replace(
          /url\((['"]?)(.*?)\1\)/g,
          (m, q, url) => {
            if (url.startsWith("data:") || url.startsWith("javascript:"))
              return `url(${q}${url}${q})`;
            return `url(${q}${proxify(url)}${q})`;
          }
        );
        $(el).attr("style", newStyle);
      });

      // Rewrite CSS inside <style> tags
      $("style").each((i, el) => {
        const css = $(el).html() || "";
        const newCss = css.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, url) => {
          if (url.startsWith("data:") || url.startsWith("javascript:"))
            return `url(${q}${url}${q})`;
          return `url(${q}${proxify(url)}${q})`;
        });
        $(el).html(newCss);
      });

      // Inject a small client-side script to remove query params or tidy the address bar
      // and ensure links generated client-side are proxified too.
      const clientScript = `
<script>
(function(){
  // Remove visible query strings that may contain base64 URLs.
  try {
    const allowedPath = location.pathname.replace(/(\\?|$).*/, '');
    history.replaceState(null, '', allowedPath);
  } catch(e){}

  // For any anchor created client-side later, ensure rel and proxify if needed.
  function proxifyAnchor(a){
    try{
      if(!a || !a.href) return;
      // don't proxify anchors that point to same-origin internal anchors
      if(a.hostname === location.hostname) return;
      a.rel = (a.rel || '') + ' noreferrer noopener';
      // if href is absolute external, transform to /p/<b64>
      const u = a.getAttribute('href');
      if(u && !u.startsWith('/') && !u.startsWith('#') && !u.startsWith('javascript:') && !u.startsWith('mailto:')){
        const enc = btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/, '');
        a.href = '/p/' + enc;
      }
    }catch(e){}
  }

  document.querySelectorAll('a').forEach(proxifyAnchor);
  new MutationObserver(function(m){
    for(const node of m){
      node.addedNodes && node.addedNodes.forEach(n=>{
        if(n && n.querySelectorAll){
          n.querySelectorAll('a').forEach(proxifyAnchor);
        }
      });
    }
  }).observe(document, {childList:true, subtree:true});
})();
</script>
`;
      $("head").append(clientScript);

      const out = $.html();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.statusCode = upstreamResponse.status || 200;
      return res.end(out);
    }

    // Non-HTML (images, media, json, etc.)
    // For streaming-capable responses (images/video), pipe through preserving status and key headers
    res.statusCode = upstreamResponse.status || 200;

    // Pass through content-type already set earlier
    // If upstream body is streamable, pipe it
    const upstreamBody = upstreamResponse.body;
    if (upstreamBody && upstreamBody.pipe) {
      // Node ReadableStream (WHATWG) vs Node stream handling: convert if needed
      // Most runtimes allow piping fetch().body directly. Fallback: read as arrayBuffer.
      try {
        upstreamBody.pipe(res);
        return;
      } catch (e) {
        // fallback: read buffer
        const buf = Buffer.from(await upstreamResponse.arrayBuffer());
        res.end(buf);
        return;
      }
    } else {
      // fallback
      const buf = Buffer.from(await upstreamResponse.arrayBuffer());
      res.end(buf);
      return;
    }
  } catch (err) {
    console.error("proxy error", err);
    res.statusCode = 500;
    res.end("Proxy error: " + String(err.message || err));
  }
};
