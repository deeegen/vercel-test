import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (url) {
      // Redirect through proxy to hide original URL
      window.location.href = `/api/proxy?url=${encodeURIComponent(url)}`;
    }
  };

  return (
    <div
      style={{
        maxWidth: "600px",
        margin: "50px auto",
        fontFamily: "sans-serif",
      }}
    >
      <h1>Vercel Proxy</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="url"
          placeholder="Enter URL to proxy"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: "100%", padding: "10px", fontSize: "16px" }}
          required
        />
        <button
          type="submit"
          style={{ marginTop: "10px", padding: "10px 20px" }}
        >
          Go
        </button>
      </form>
    </div>
  );
}
