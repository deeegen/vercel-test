import fetch from "node-fetch";
import { JSDOM } from "jsdom";

export default async function handler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("Missing 'url' query parameter");
  }

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get("content-type");

    // If HTML, rewrite URLs
    if (contentType && contentType.includes("text/html")) {
      const html = await response.text();
      const dom = new JSDOM(html);
      const document = dom.window.document;

      // Rewrite href/src URLs
      ["a", "link", "script", "img", "source"].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => {
          if (el.href)
            el.href = `/api/proxy?url=${encodeURIComponent(el.href)}`;
          if (el.src) el.src = `/api/proxy?url=${encodeURIComponent(el.src)}`;
        });
      });

      // Optional: remove referrer for privacy
      document.querySelectorAll("a").forEach((a) => {
        a.rel = "noreferrer noopener";
      });

      res.setHeader("Content-Type", "text/html");
      return res.send(dom.serialize());
    }

    // Otherwise, proxy binary/media content
    const buffer = await response.arrayBuffer();
    response.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send("Error fetching URL: " + err.message);
  }
}
