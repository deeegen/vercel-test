import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (url) setProxyUrl(`/api/proxy?url=${encodeURIComponent(url)}`);
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Next.js Proxy</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="url"
          placeholder="Enter target URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: "400px", padding: "0.5rem" }}
        />
        <button type="submit" style={{ marginLeft: "0.5rem", padding: "0.5rem" }}>Go</button>
      </form>
      {proxyUrl && (
        <iframe
          src={proxyUrl}
          style={{ width: "100%", height: "80vh", marginTop: "1rem", border: "1px solid #ccc" }}
        />
      )}
    </div>
  );
}
