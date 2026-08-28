import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import "./App.css";

const POLL_MS = 700;
const WIPE = [0.7, 0, 0.2, 1];

const PHASES = [
  { key: "upload", label: "Upload" },
  { key: "select", label: "Select" },
  { key: "redact", label: "Redact" },
  { key: "export", label: "Export" },
];

function phaseIndex(phase) {
  if (phase === "upload") return 0;
  if (phase === "scanning" || phase === "select") return 1;
  if (phase === "blurring") return 2;
  return 3;
}

function Wordmark() {
  return (
    <div className="wordmark">
      <span>RE</span>
      <span className="wm-hide">
        <span>DACT</span>
        <motion.span
          className="wm-bar"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ delay: 0.45, duration: 0.7, ease: WIPE }}
          style={{ transformOrigin: "right" }}
        />
      </span>
    </div>
  );
}

function Eyebrow({ num, label }) {
  return (
    <div className="eyebrow">
      <span className="num">{num}</span>
      <span className="label">{label}</span>
      <span className="rule" />
    </div>
  );
}

function Working({ num, label, value, caption, queuePos }) {
  const pct = Math.round(value * 100);
  const waiting = queuePos > 0;
  return (
    <div className="work">
      <Eyebrow num={num} label={label} />
      {waiting ? (
        <>
          <div className="work-label" style={{ marginTop: 0 }}>
            Waiting for resources to free up…
          </div>
          <div className="work-line">
            <div className="work-fill work-fill-indeterminate" />
          </div>
        </>
      ) : (
        <>
          <div className="work-num">
            <span className="pct">{String(pct).padStart(2, "0")}</span>
            <span style={{ color: "var(--faint)" }}>%</span>
          </div>
          <div className="work-line">
            <div className="work-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="work-label">{pct >= 99 ? "Encoding output" : caption}</div>
        </>
      )}
    </div>
  );
}

const screen = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
  transition: { duration: 0.32, ease: "easeOut" },
};

export default function App() {
  const [phase, setPhase] = useState("upload");
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [queuePos, setQueuePos] = useState(-1);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [people, setPeople] = useState([]);
  const [videoPath, setVideoPath] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [resultUrl, setResultUrl] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if ((phase !== "scanning" && phase !== "blurring") || !jobId) return;
    let alive = true;
    let timer = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/status/${jobId}`);
        if (!res.ok) throw new Error("gone");
        const s = await res.json();
        if (!alive) return;
        setProgress(s.progress || 0);
        setQueuePos(typeof s.position === "number" ? s.position : -1);
        if (s.status === "ready") {
          if (s.kind === "scan") {
            if (!s.people || s.people.length === 0) {
              setError("No faces found. Try a clip where faces are closer to the camera.");
              setPhase("upload");
            } else {
              setPeople(s.people);
              setVideoPath(s.videoPath);
              setSelected(new Set());
              setPhase("select");
            }
          } else {
            setResultUrl(`${s.output}?t=${Date.now()}`);
            setPhase("done");
          }
          return;
        }
        if (s.status === "error") {
          setError(s.error || "The worker failed. Check the server logs.");
          setPhase(s.kind === "scan" ? "upload" : "select");
          return;
        }
      } catch {
        if (!alive) return;
        setError("Lost the session. Upload again.");
        setPhase("upload");
        return;
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [phase, jobId]);

  const accept = (f) => {
    if (!f) return;
    if (!/\.(mp4|mov)$/i.test(f.name)) {
      setError("Only .mp4 and .mov files are supported.");
      return;
    }
    setError("");
    setFile(f);
  };

  // Upload with XMLHttpRequest so we get real upload progress (fetch can't
  // report upload progress — only download). The glyph bar fills as bytes go up.
  const startScan = () => {
    if (!file || uploading) return;
    setError("");
    setUploading(true);
    setUploadPct(0);

    const form = new FormData();
    form.append("video", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/scan");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploadPct(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const { jobId: id } = JSON.parse(xhr.responseText);
          setProgress(0);
          setQueuePos(-1);
          setJobId(id);
          setPhase("scanning");
        } catch {
          setError("Upload finished but the server response was invalid.");
        }
      } else {
        setError("Upload failed — is the backend running?");
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setError("Upload failed — network error.");
    };

    xhr.send(form);
  };

  const startBlur = async () => {
    if (selected.size === 0) return;
    setError(""); setProgress(0); setQueuePos(-1);
    try {
      const res = await fetch("/api/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath, selectedIds: [...selected] }),
      });
      if (!res.ok) throw new Error();
      const { jobId: id } = await res.json();
      setJobId(id); setPhase("blurring");
    } catch { setError("Could not start the redaction."); }
  };

  const reset = useCallback(async () => {
    try { await fetch("/api/wipe", { method: "POST" }); } catch {}
    setFile(null); setJobId(null); setPeople([]); setVideoPath(null);
    setSelected(new Set()); setResultUrl(null); setProgress(0); setQueuePos(-1);
    setUploading(false); setUploadPct(0);
    setError(""); setPhase("upload");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const active = phaseIndex(phase);

  return (
    <div className="app">
      <div className="bar">
        <button className="bar-mark" onClick={reset}>REDACT</button>
        <span className="bar-meta">Session // No storage</span>
      </div>

      <div className="index">
        {PHASES.map((p, i) => (
          <div
            key={p.key}
            className={`index-item ${i === active ? "active" : ""} ${i < active ? "done" : ""}`}
          >
            <span className="n">{String(i + 1).padStart(2, "0")}</span>
            <span>{p.label}</span>
          </div>
        ))}
      </div>

      <div className="stage">
        <AnimatePresence mode="wait">
          {phase === "upload" && (
            <motion.div key="upload" {...screen} className="hero">
              <Wordmark />
              <p className="lede">
                Detects everyone in a clip, groups each person, and blurs only who you
                choose. Nothing is stored — files are wiped when the session ends.
              </p>

              <div
                className={`drop ${drag ? "drag" : ""} ${file ? "has-file" : ""} ${uploading ? "uploading" : ""}`}
                onClick={() => { if (!uploading) inputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); if (!uploading) setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); if (!uploading) accept(e.dataTransfer.files[0]); }}
                role="button" tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && !uploading && inputRef.current?.click()}
              >
                <div className="drop-glyph">
                  <div
                    className="drop-glyph-fill"
                    style={{ width: uploading ? `${uploadPct}%` : "100%" }}
                  />
                </div>
                <div>
                  <div className="drop-primary">
                    {uploading
                      ? `Uploading… ${uploadPct}%`
                      : file
                      ? file.name
                      : "Drop a clip, or click to browse"}
                  </div>
                  <div className="drop-sub">
                    {uploading
                      ? "Sending your clip to the server"
                      : file
                      ? "Click to choose another"
                      : "MP4 / MOV · up to 200 MB"}
                  </div>
                </div>
                <input ref={inputRef} type="file" accept="video/mp4,video/quicktime"
                  onChange={(e) => accept(e.target.files[0])} style={{ display: "none" }} />
              </div>

              <div className="actions">
                <button className="btn btn-primary" onClick={startScan} disabled={!file || uploading}>
                  {uploading ? `Uploading… ${uploadPct}%` : "Scan for faces"}
                </button>
              </div>

              {error && <div className="err">{error}</div>}
            </motion.div>
          )}

          {phase === "scanning" && (
            <motion.div key="scanning" {...screen}>
              <Working num="02" label="Select — Scanning" value={progress}
                caption="Detecting and grouping faces" queuePos={queuePos} />
            </motion.div>
          )}

          {phase === "select" && (
            <motion.div key="select" {...screen}>
              <Eyebrow num="02" label={`Select — ${people.length} found`} />
              <div className="grid">
                {people.map((p) => (
                  <button
                    key={p.id}
                    className={`card ${selected.has(p.id) ? "on" : ""}`}
                    onClick={() => toggle(p.id)}
                    aria-pressed={selected.has(p.id)}
                  >
                    <div className="shot">
                      <img src={`/faces/person_${p.id}.jpg`} alt={`Person ${p.id}`} />
                      <div className="stamp"><span>REDACTED</span></div>
                    </div>
                    <div className="card-foot">
                      <span className="card-id">Person {p.id}</span>
                      <span className="card-n">{p.appearances}f</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="actions">
                <button className="btn btn-redact" onClick={startBlur} disabled={selected.size === 0}>
                  <span className="k">{String(selected.size).padStart(2, "0")}</span>
                  {selected.size === 0 ? "Select who to redact" : `Redact ${selected.size === 1 ? "person" : "people"}`}
                </button>
                <button className="btn" onClick={reset}>
                  <span className="k">←</span>Start over
                </button>
              </div>

              {error && <div className="err">{error}</div>}
            </motion.div>
          )}

          {phase === "blurring" && (
            <motion.div key="blurring" {...screen}>
              <Working num="03" label="Redact" value={progress}
                caption="Blurring selected faces frame by frame" queuePos={queuePos} />
            </motion.div>
          )}

          {phase === "done" && (
            <motion.div key="done" {...screen} className="result">
              <Eyebrow num="04" label="Export — Done" />
              <video className="player" src={resultUrl} controls />
              <div className="actions">
                <a href={resultUrl} download="redacted.mp4" style={{ flex: 1 }}>
                  <button className="btn btn-primary" style={{ width: "100%" }}>
                    <span className="k">↓</span>Download video
                  </button>
                </a>
                <button className="btn" onClick={reset}>
                  <span className="k">←</span>New session
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="foot">Redact — session-only · no accounts · no database</div>
    </div>
  );
}