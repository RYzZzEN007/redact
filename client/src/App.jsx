import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import "./App.css";

const POLL_MS = 700;
const WIPE = [0.65, 0, 0.35, 1];

/* The mark: "DACT" starts under a redaction bar that wipes away on mount —
   the wordmark un-redacts itself. */
function Brand({ small = false }) {
  return (
    <div className="brand">
      <span className={`brand-word ${small ? "small" : ""}`}>
        <span>RE</span>
        <span className="brand-hide">
          <span>DACT</span>
          <motion.span
            className="brand-bar"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ delay: 0.5, duration: 0.7, ease: WIPE }}
            style={{ transformOrigin: "right" }}
          />
        </span>
      </span>
      {!small && <span className="brand-dash" aria-hidden />}
    </div>
  );
}

function Progress({ label, value }) {
  const pct = Math.round(value * 100);
  return (
    <div className="progress-wrap">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-meta">
        <span>{pct >= 99 ? "encoding" : label}</span>
        <span className="pct">{pct}%</span>
      </div>
    </div>
  );
}

function Working({ label, title, sub, value }) {
  return (
    <>
      <div className="plate sweep">CLASSIFIED</div>
      <h2 className="title" style={{ textAlign: "center" }}>{title}</h2>
      <p className="sub" style={{ textAlign: "center" }}>{sub}</p>
      <Progress label={label} value={value} />
    </>
  );
}

function Tick() {
  return (
    <div className="tick">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="#0D0F12" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

const screen = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -16 },
  transition: { duration: 0.4 },
};

export default function App() {
  // upload -> scanning -> select -> blurring -> done
  const [phase, setPhase] = useState("upload");
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [people, setPeople] = useState([]);
  const [videoPath, setVideoPath] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [resultUrl, setResultUrl] = useState(null);
  const inputRef = useRef(null);

  /* One poller drives both long phases — self-scheduling so a slow response
     never stacks requests. */
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

  const startScan = async () => {
    if (!file) return;
    setError("");
    setProgress(0);
    const form = new FormData();
    form.append("video", file);
    try {
      const res = await fetch("/api/scan", { method: "POST", body: form });
      if (!res.ok) throw new Error();
      const { jobId: id } = await res.json();
      setJobId(id);
      setPhase("scanning");
    } catch {
      setError("Upload failed — is the backend running?");
    }
  };

  const startBlur = async () => {
    if (selected.size === 0) return;
    setError("");
    setProgress(0);
    try {
      const res = await fetch("/api/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath, selectedIds: [...selected] }),
      });
      if (!res.ok) throw new Error();
      const { jobId: id } = await res.json();
      setJobId(id);
      setPhase("blurring");
    } catch {
      setError("Could not start the redaction.");
    }
  };

  const reset = useCallback(async () => {
    try {
      await fetch("/api/wipe", { method: "POST" });
    } catch {
      /* reset the UI regardless */
    }
    setFile(null);
    setJobId(null);
    setPeople([]);
    setVideoPath(null);
    setSelected(new Set());
    setResultUrl(null);
    setProgress(0);
    setError("");
    setPhase("upload");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="app">
     <div className="topbar">
        <button className="topbar-btn" onClick={reset} title="Start over">
          <Brand small />
        </button>
        <span className="topbar-note">single-session · no storage</span>
      </div>

      <div className="stage">
        <AnimatePresence mode="wait">
          {/* ---------- upload ---------- */}
          {phase === "upload" && (
            <motion.div key="upload" {...screen} style={{ width: "100%", textAlign: "center" }}>
              <Brand />
              <p className="lede">
                Upload a clip, pick which people to anonymize, and download the
                redacted result. Faces are detected and grouped automatically.
              </p>

              <div
                className={`dropzone ${drag ? "drag" : ""}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); accept(e.dataTransfer.files[0]); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
              >
                {file ? (
                  <>
                    <span className="chip">{file.name}</span>
                    <p className="drop-sub">click to choose a different file</p>
                  </>
                ) : (
                  <>
                    <div className="drop-mark" />
                    <p className="drop-title">Drop a clip to redact</p>
                    <p className="drop-sub">or click to browse · MP4 / MOV · up to 200 MB</p>
                  </>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  accept="video/mp4,video/quicktime"
                  onChange={(e) => accept(e.target.files[0])}
                  style={{ display: "none" }}
                />
              </div>

              <div className="row">
                <button className="btn btn-primary" onClick={startScan} disabled={!file}>
                  Scan for faces
                </button>
              </div>

              {error && <p className="err">{error}</p>}
            </motion.div>
          )}

          {/* ---------- scanning ---------- */}
          {phase === "scanning" && (
            <motion.div key="scanning" {...screen} style={{ width: "100%" }}>
              <Working
                label="scanning"
                title="Scanning for faces"
                sub="Detecting and grouping everyone who appears in the clip."
                value={progress}
              />
            </motion.div>
          )}

          {/* ---------- select ---------- */}
          {phase === "select" && (
            <motion.div key="select" {...screen} style={{ width: "100%", textAlign: "center" }}>
              <h2 className="title">
                {people.length} {people.length === 1 ? "person" : "people"} detected
              </h2>
              <p className="sub">Select who to blur. Everyone you leave unticked stays visible.</p>

              <div className="grid">
                {people.map((p) => (
                  <motion.button
                    key={p.id}
                    layout
                    className={`card ${selected.has(p.id) ? "on" : ""}`}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => toggle(p.id)}
                    aria-pressed={selected.has(p.id)}
                  >
                    <div className="shot">
                      <img src={`/faces/person_${p.id}.jpg`} alt={`Person ${p.id}`} />
                      <div className="scrim" />
                      <div className="stamp">redacted</div>
                    </div>
                    <div className="card-foot">
                      <div>
                        <p className="cid">Person {p.id}</p>
                        <p className="cmeta">{p.appearances} frames</p>
                      </div>
                      <Tick />
                    </div>
                  </motion.button>
                ))}
              </div>

              <div className="row">
                <motion.button
                  className="btn btn-primary"
                  onClick={startBlur}
                  disabled={selected.size === 0}
                  whileHover={selected.size > 0 ? { scale: 1.03 } : {}}
                  whileTap={selected.size > 0 ? { scale: 0.97 } : {}}
                >
                  {selected.size === 0
                    ? "Select someone to redact"
                    : `Redact ${selected.size} ${selected.size === 1 ? "person" : "people"}`}
                </motion.button>
                <button className="btn" onClick={reset}>Start over</button>
              </div>

              {error && <p className="err">{error}</p>}
            </motion.div>
          )}

          {/* ---------- blurring ---------- */}
          {phase === "blurring" && (
            <motion.div key="blurring" {...screen} style={{ width: "100%" }}>
              <Working
                label="redacting"
                title="Redacting"
                sub="Blurring the selected people across every frame."
                value={progress}
              />
            </motion.div>
          )}

          {/* ---------- done ---------- */}
          {phase === "done" && (
            <motion.div key="done" {...screen} style={{ width: "100%", textAlign: "center" }}>
              <h2 className="title">Redacted</h2>
              <p className="sub">Download it — everything here is wiped when you start over.</p>
              <video className="player" src={resultUrl} controls />
              <div className="row">
                <a href={resultUrl} download="redacted.mp4">
                  <button className="btn btn-primary">Download video</button>
                </a>
                <button className="btn" onClick={reset}>Start over — wipe session</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <p className="foot">session-only · no accounts · no database</p>
    </div>
  );
}