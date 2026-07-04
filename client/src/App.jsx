import { useState, useEffect } from "react";

function App() {
  const [status, setStatus] = useState("checking...");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => setStatus(data.message))
      .catch(() => setStatus("backend not reachable"));
  }, []);

  return (
    <div style={{ background: "#0D0F12", color: "#E9F1F6", minHeight: "100vh",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <h1>REDACT</h1>
        <p style={{ opacity: 0.6 }}>backend: {status}</p>
      </div>
    </div>
  );
}

export default App;