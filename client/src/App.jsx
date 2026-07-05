import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logo from "./assets/redact-logo.png";

function App() {
  const [file, setFile] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [people, setPeople] = useState(null);
  const [videoPath, setVideoPath] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);

  const handleScan = async () => {
    if (!file) return;
    setScanning(true);
    setError(null);
    setPeople(null);

    const form = new FormData();
    form.append("video", file);

    try {
      const res = await fetch("/api/scan", { method: "POST", body: form });
      if (!res.ok) throw new Error("scan failed");
      const data = await res.json();
      setPeople(data.people);
      setVideoPath(data.videoPath);
      setSelected([]);
    } catch (err) {
      setError("Scan failed — is the backend running?");
    } finally {
      setScanning(false);
    }
  };

  const toggle = (id) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  return (
    <div style={styles.page}>
      <img src={logo} alt="Redact" style={styles.logo} />

      {/* upload zone */}
      <div style={styles.uploadRow}>
        <input
          type="file"
          accept="video/mp4,video/quicktime"
          onChange={(e) => setFile(e.target.files[0] || null)}
          style={styles.fileInput}
        />
        <button
          onClick={handleScan}
          disabled={!file || scanning}
          style={{
            ...styles.button,
            opacity: !file || scanning ? 0.4 : 1,
          }}
        >
          {scanning ? "Scanning…" : "Scan for faces"}
        </button>
      </div>

      {error && <p style={{ color: "#E5202A" }}>{error}</p>}

      {scanning && (
        <motion.p
          initial={{ opacity: 0.3 }}
          animate={{ opacity: 1 }}
          transition={{ repeat: Infinity, repeatType: "reverse", duration: 0.8 }}
          style={{ opacity: 0.6 }}
        >
          Analyzing video — detecting and clustering faces…
        </motion.p>
      )}

      {/* detected people grid */}
      <AnimatePresence>
        {people && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            style={styles.section}
          >
            <h2 style={{ fontWeight: 500 }}>
              {people.length} {people.length === 1 ? "person" : "people"} detected
              — select who to redact
            </h2>
            <div style={styles.grid}>
              {people.map((p, i) => {
                const isSelected = selected.includes(p.id);
                return (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.1 }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => toggle(p.id)}
                    style={{
                      ...styles.card,
                      border: isSelected
                        ? "3px solid #E5202A"
                        : "3px solid transparent",
                    }}
                  >
                    <img
                      src={`/faces/person_${p.id}.jpg`}
                      alt={`Person ${p.id}`}
                      style={{
                        ...styles.thumb,
                        filter: isSelected ? "blur(6px)" : "none",
                      }}
                    />
                    <p style={{ margin: "8px 0 0", fontSize: 14 }}>
                      Person {p.id}
                    </p>
                    <p style={{ margin: 0, fontSize: 12, opacity: 0.5 }}>
                      seen {p.appearances}×
                    </p>
                  </motion.div>
                );
              })}
            </div>

            <button
              disabled={selected.length === 0}
              style={{
                ...styles.button,
                marginTop: 24,
                background: "#E5202A",
                opacity: selected.length === 0 ? 0.4 : 1,
              }}
            >
              Redact {selected.length} selected →
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const styles = {
  page: {
    background: "#0D0F12",
    color: "#E9F1F6",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: 40,
    fontFamily: "system-ui, sans-serif",
  },
  logo: { width: 180, marginBottom: 32 },
  uploadRow: { display: "flex", gap: 12, alignItems: "center" },
  fileInput: { color: "#E9F1F6" },
  button: {
    background: "#1E2228",
    color: "#E9F1F6",
    border: "none",
    padding: "10px 20px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 15,
  },
  section: { marginTop: 40, textAlign: "center" },
  grid: {
    display: "flex",
    gap: 16,
    justifyContent: "center",
    flexWrap: "wrap",
    marginTop: 16,
  },
  card: {
    background: "#16181C",
    borderRadius: 12,
    padding: 12,
    cursor: "pointer",
    width: 140,
  },
  thumb: {
    width: "100%",
    height: 140,
    objectFit: "cover",
    borderRadius: 8,
    transition: "filter 0.2s",
  },
};

export default App;