const express = require("express");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = 3001;

const PYTHON_DIR = path.join(__dirname, "..", "python");
const PYTHON_BIN = path.join(PYTHON_DIR, "venv", "bin", "python");

app.use(cors());
app.use(express.json());

app.use("/faces", express.static(path.join(PYTHON_DIR, "faces")));
app.use("/outputs", express.static(path.join(PYTHON_DIR, "outputs")));

// ---------- session wipe ----------
const WIPE_DIRS = ["uploads", "faces", "embeddings", "outputs"].map((d) =>
  path.join(PYTHON_DIR, d)
);

function wipeSession() {
  let removed = 0;
  for (const dir of WIPE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed++;
    }
  }
  return removed;
}

// ---------- job registry ----------
// In memory only: jobs die with the process, exactly like our files. No DB.
const jobs = new Map(); // jobId -> { kind, status, progress, people?, videoPath?, output? }

function runWorker(jobId, args, onDone) {
  const job = jobs.get(jobId);
  const worker = spawn(PYTHON_BIN, args, { cwd: PYTHON_DIR });

  let stdout = "";
  let stderrLog = "";
  let buf = "";

  worker.stdout.on("data", (c) => (stdout += c));

  // stderr carries PROGRESS lines; chunks can split mid-line, so buffer the tail
  worker.stderr.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/^PROGRESS (\d+)\/(\d+)/);
      if (m) {
        const done = Number(m[1]);
        const total = Number(m[2]);
        job.progress = total > 0 ? Math.min(1, done / total) : 0;
      } else if (line.trim()) {
        stderrLog += line + "\n";
      }
    }
  });

  worker.on("close", (code) => {
    if (code !== 0) {
      console.error("worker failed:", stderrLog);
      job.status = "error";
      job.error = "Worker failed";
      return;
    }
    try {
      onDone(JSON.parse(stdout));
    } catch (err) {
      console.error("bad worker output:", stdout);
      job.status = "error";
      job.error = "Could not parse worker output";
    }
  });
}

// ---------- upload ----------
const storage = multer.diskStorage({
  destination: path.join(PYTHON_DIR, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Redact backend is running" });
});

// POST /api/scan — returns a jobId immediately, worker runs in the background
app.post("/api/scan", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file received" });

  const jobId = crypto.randomUUID();
  const videoPath = req.file.path;
  jobs.set(jobId, { kind: "scan", status: "running", progress: 0, videoPath });

  runWorker(jobId, ["worker.py", "scan", videoPath], (result) => {
    const job = jobs.get(jobId);
    job.people = result.people;
    job.progress = 1;
    job.status = "ready";
  });

  res.json({ jobId });
});

// POST /api/redact — same pattern: start the blur, return a jobId
app.post("/api/redact", (req, res) => {
  const { videoPath, selectedIds } = req.body;

  if (!videoPath || !Array.isArray(selectedIds) || selectedIds.length === 0) {
    return res.status(400).json({ error: "videoPath and selectedIds required" });
  }

  const uploadsDir = path.join(PYTHON_DIR, "uploads");
  const resolved = path.resolve(videoPath);
  if (!resolved.startsWith(uploadsDir)) {
    return res.status(400).json({ error: "Invalid video path" });
  }
  const ids = selectedIds.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n < 1)) {
    return res.status(400).json({ error: "Invalid person IDs" });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { kind: "blur", status: "running", progress: 0 });

  runWorker(jobId, ["worker.py", "blur", resolved, ids.join(",")], (result) => {
    const job = jobs.get(jobId);
    job.output = `/${result.output}`;
    job.progress = 1;
    job.status = "ready";
  });

  res.json({ jobId });
});

// GET /api/status/:id — the polling endpoint that drives the progress bar
app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  res.json({
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    people: job.people,
    videoPath: job.videoPath,
    output: job.output,
    error: job.error,
  });
});

// POST /api/wipe — delete all session files and forget every job
app.post("/api/wipe", (req, res) => {
  const removed = wipeSession();
  jobs.clear();
  res.json({ ok: true, removed });
});

app.listen(PORT, () => {
  console.log(`✅ Redact server running on http://localhost:${PORT}`);
  console.log(`🧹 wiped ${wipeSession()} leftover session files`);
});