import axios from "axios";
import { parse } from "node-html-parser";

export default async function handler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter");

  try {
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VercelProxy/1.0)",
        "Referer": ""
      }
    });

    const contentType = response.headers["content-type"];
    
    if (contentType?.includes("text/html")) {
      // Rewrite HTML, inline JS/CSS, meta redirects
      const html = response.data.toString("utf-8");
      const root = parse(html);

      // Rewrite <a>, <img>, <link>, <script> URLs
      root.querySelectorAll("a, link, script, img").forEach((el) => {
        const attr = el.tagName === "a" || el.tagName === "link" ? "href" : "src";
        if (el.getAttribute(attr) && !el.getAttribute(attr).startsWith("http")) {
          el.setAttribute(attr, new URL(el.getAttribute(attr), targetUrl).href);
        }
      });

      // Rewrite meta refresh
      root.querySelectorAll("meta[http-equiv='refresh']").forEach((meta) => {
        const content = meta.getAttribute("content");
        if (content) {
          const parts = content.split(";url=");
          if (parts[1]) meta.setAttribute("content", `${parts[0]};url=/api/proxy?url=${encodeURIComponent(new URL(parts[1], targetUrl).href)}`);
        }
      });

      res.setHeader("Content-Type", "text/html");
      return res.send(root.toString());
    } else {
      // Binary/media content
      res.setHeader("Content-Type", contentType || "application/octet-stream");
      res.send(response.data);
    }
  } catch (err) {
    res.status(500).send("Error fetching URL");
  }
}
