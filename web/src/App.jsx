import { useState } from "react";
import "./index.css";

export default function App() {
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [error, setError] = useState(null);

  const API = "http://localhost:5175";

  async function generateImage() {
    setLoading(true);
    setError(null);
    setImage(null);
    setPrompt(null);

    try {
      const res = await fetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      setImage(data.imageBase64);
      setPrompt(data.prompt);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <div className="card">
        <h1>OnyxAI Image Generator</h1>

        <button onClick={generateImage} disabled={loading}>
          {loading ? "Generating..." : "Generate Image"}
        </button>

        {error && <p style={{ color: "#ef4444" }}>{error}</p>}

        {prompt && (
          <p>
            <strong>Prompt:</strong> {prompt}
          </p>
        )}

        {image && (
          <div className="preview">
            <img src={image} alt="Generated" />
          </div>
        )}
      </div>
    </div>
  );
}

