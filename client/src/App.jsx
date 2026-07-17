import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logo from "./assets/redact-logo.png";
import "./App.css";

function App() {
  const [file, setFile] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [people, setPeople] = useState(null);
  const [videoPath, setVideoPath] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [redacting, setRedacting] = useState(false);
  const [resultUrl, setResultUrl] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const acceptFile = (f) => {
    if (f && /\.(mp4|mov)$/i.test(f.name)) {
      setFile(f);
      setError(null);
    } else if (f) {
      setError("Only .mp4 and .mov files are supported.");
    }
  };

  const handleScan = async () => {
    if (!file) return;
    setScanning(true);
    setError(null);
    setPeople(null);
    setResultUrl(null);

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
      setError("Scan failed — check that the backend is running.");
    } finally {
      setScanning(false);
    }
  };

  const handleRedact = async () => {
    if (selected.length === 0 || !videoPath) return;
    setRedacting(true);
    setError(null);
    setResultUrl(null);

    try {
      const res = await fetch("/api/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath, selectedIds: selected }),
      });
      if (!res.ok) throw new Error("redact failed");
      const data = await res.json();
      setResultUrl(`${data.videoUrl}?t=${Date.now()}`);
    } catch (err) {
      setError("Redaction failed — check the server logs.");
    } finally {
      setRedacting(false);
    }
  };

  const handleStartOver = async () => {
    try {
      await fetch("/api/wipe", { method: "POST" });
    } catch (err) {
      // even if wipe fails, reset the UI
    }
    setFile(null);
    setPeople(null);
    setVideoPath(null);
    setSelected([]);
    setResultUrl(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const toggle = (id) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  return (
    <div className="page">
      <header className="header">
        <img src={logo} alt="Redact" className="logo" />
        <p className="tagline">
          select<span className="sep">/</span>blur
          <span className="sep">/</span>nothing persists
        </p>
      </header>

      <main className="main">
        {/* 01 — upload */}
        <section className="step">
          <div className="eyebrow">
            <span className="num">01</span> upload
          </div>

          <div
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              acceptFile(e.dataTransfer.files[0]);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          >
            <span className="corner-a" />
            {scanning && <div className="scanline" />}

            {file ? (
              <>
                <span className="file-chip">{file.name}</span>
                <p className="drop-hint">click to choose a different file</p>
              </>
            ) : (
              <>
                <p className="drop-label">
                  Drop a video here or <strong>browse</strong>
                </p>
                <p className="drop-hint">mp4 · mov · max 200mb · stays on this machine</p>
              </>
            )}

            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,video/quicktime"
              onChange={(e) => acceptFile(e.target.files[0])}
              style={{ display: "none" }}
            />
          </div>

          <div className="actions">
            <button
              className="btn btn-red"
              onClick={handleScan}
              disabled={!file || scanning || redacting}
            >
              {scanning ? "Scanning…" : "Scan for faces"}
            </button>
          </div>

          {scanning && (
            <p className="status">detecting and clustering faces</p>
          )}
        </section>

        {error && <div className="error">{error}</div>}

        {/* 02 — select */}
        <AnimatePresence>
          {people && (
            <motion.section
              className="step"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <div className="eyebrow">
                <span className="num">02</span> select
              </div>
              <h2 className="step-title">
                {people.length === 0
                  ? "No faces found"
                  : `${people.length} ${
                      people.length === 1 ? "person" : "people"
                    } detected`}
              </h2>

              {people.length === 0 ? (
                <p className="status">try a clip where faces are closer to the camera</p>
              ) : (
                <>
                  <div className="grid">
                    {people.map((p, i) => (
                      <motion.div
                        key={p.id}
                        className={`card ${
                          selected.includes(p.id) ? "selected" : ""
                        }`}
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: i * 0.07 }}
                        whileTap={{ scale: 0.96 }}
                        onClick={() => !redacting && toggle(p.id)}
                        role="checkbox"
                        aria-checked={selected.includes(p.id)}
                        tabIndex={0}
                        onKeyDown={(e) =>
                          e.key === "Enter" && !redacting && toggle(p.id)
                        }
                      >
                        <div className="thumb-wrap">
                          <img
                            className="thumb"
                            src={`/faces/person_${p.id}.jpg`}
                            alt={`Person ${p.id}`}
                          />
                          <div className="redact-bar">redacted</div>
                        </div>
                        <p className="subject-id">subject {String(p.id).padStart(2, "0")}</p>
                        <p className="subject-meta">seen {p.appearances}×</p>
                      </motion.div>
                    ))}
                  </div>

                  <div className="actions">
                    <button
                      className="btn btn-red"
                      onClick={handleRedact}
                      disabled={selected.length === 0 || redacting}
                    >
                      {redacting
                        ? "Redacting…"
                        : `Redact ${selected.length} selected`}
                    </button>
                  </div>

                  {redacting && (
                    <p className="status">
                      blurring selected faces frame by frame — this takes a few minutes
                    </p>
                  )}
                </>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        {/* 03 — export */}
        <AnimatePresence>
          {resultUrl && (
            <motion.section
              className="step"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <div className="eyebrow">
                <span className="num">03</span> export
              </div>
              <h2 className="step-title">Faces redacted</h2>

              <video className="player" src={resultUrl} controls />

              <div className="actions">
                <a href={resultUrl} download="redacted.mp4">
                  <button className="btn btn-red">Download redacted video</button>
                </a>
                <button className="btn btn-ghost" onClick={handleStartOver}>
                  Start over — wipe session
                </button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      <footer className="footer">
        session-only processing · files wiped on start over · no accounts · no database
      </footer>
    </div>
  );
}

export default App;