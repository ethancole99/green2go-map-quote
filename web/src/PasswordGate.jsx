import { useState } from "react";

const STORAGE_KEY = "g2g-unlocked";

export default function PasswordGate({ children }) {
  const [unlocked, setUnlocked] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  if (unlocked) return children;

  function handleSubmit(e) {
    e.preventDefault();
    const correct = import.meta.env.VITE_APP_PASSWORD;
    if (correct && input === correct) {
      localStorage.setItem(STORAGE_KEY, "true");
      setUnlocked(true);
    } else {
      setError(true);
      setInput("");
    }
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "rgba(255,255,255,0.98)",
          borderRadius: 24,
          padding: "48px 64px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          maxWidth: 420,
          width: "90%",
        }}
      >
        <h1
          style={{
            margin: "0 0 12px 0",
            fontSize: 40,
            fontWeight: 900,
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            textAlign: "center",
          }}
        >
          Green2Go
        </h1>
        <p style={{ margin: "0 0 28px 0", fontSize: 16, color: "#666", textAlign: "center", fontWeight: 500 }}>
          Enter password to continue
        </p>

        <input
          type="password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(false);
          }}
          autoFocus
          placeholder="Password"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 16px",
            fontSize: 16,
            borderRadius: 12,
            border: error ? "2px solid #d32f2f" : "2px solid #ddd",
            marginBottom: error ? 8 : 20,
            outline: "none",
          }}
        />
        {error && (
          <div style={{ color: "#d32f2f", fontSize: 13, fontWeight: 700, marginBottom: 12, textAlign: "center" }}>
            Incorrect password
          </div>
        )}

        <button
          type="submit"
          style={{
            width: "100%",
            padding: "16px 24px",
            fontSize: 16,
            fontWeight: 900,
            color: "#fff",
            background: "linear-gradient(135deg, #00c853 0%, #00e676 100%)",
            border: "none",
            borderRadius: 12,
            cursor: "pointer",
          }}
        >
          Enter
        </button>
      </form>
    </div>
  );
}
