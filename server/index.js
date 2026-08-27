const express = require("express");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3001;

const PYTHON_DIR = path.join(__dirname, "..", "python");
// In a container we run one system python; locally we use the venv. Env var lets us switch.
const PYTHON_BIN = process.env.PYTHON_BIN || path.join(PYTHON_DIR, "venv", "bin", "python");

app.use(cors());
app.use(express.json());

app.use("/faces", express.static(path.join(PYTHON_DIR, "faces")));
app.use("/outputs", express.static(path.join(PYTHON_DIR, "outputs")));

// serve the built React app (produced by `npm run build` in client/)
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
app.use(express.static(CLIENT_DIST));

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

// ---------- job registry + queue ----------
// In memory only: jobs die with the process, exactly like our files. No DB.
// One worker runs at a time (concurrency 1). Everything else waits in line,
// so the API stays responsive and a busy CPU never spawns ten workers at once.
const jobs = new Map();   // jobId -> { kind, status, progress, position, args, onDone, ... }
const queue = [];         // jobIds waiting to run, in order
let activeJob = null;     // jobId currently running, or null

// lightweight running stats so you can glance at overnight activity
const stats = { started: 0, completed: 0, failed: 0, bootedAt: new Date().toISOString() };

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function enqueue(jobId) {
  queue.push(jobId);
  refreshPositions();
  pump();
}

// each queued job knows how many are ahead of it (0 = next up)
function refreshPositions() {
  queue.forEach((id, i) => {
    const job = jobs.get(id);
    if (job) job.position = i;
  });
}

function pump() {
  if (activeJob) return;             // already running one
  const jobId = queue.shift();
  if (!jobId) return;                // nothing waiting
  const job = jobs.get(jobId);
  if (!job) return pump();           // was wiped; skip

  activeJob = jobId;
  job.status = "running";
  job.position = -1;
  job.startedAt = Date.now();
  refreshPositions();
  stats.started++;
  log(`job ${jobId.slice(0, 8)} ${job.kind} started (${queue.length} still queued)`);

  runWorker(jobId, job.args, (result) => {
    job.onDone(result);
  });
}

function finishActive(jobId, ok) {
  const job = jobs.get(jobId);
  const kind = job ? job.kind : "?";
  const secs = job && job.startedAt ? ((Date.now() - job.startedAt) / 1000).toFixed(1) : "?";
  if (ok) { stats.completed++; log(`job ${jobId.slice(0, 8)} ${kind} finished in ${secs}s`); }
  else    { stats.failed++;    log(`job ${jobId.slice(0, 8)} ${kind} FAILED after ${secs}s`); }
  activeJob = null;
  pump();                            // start the next one
}

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
      finishActive(jobId, false);
      return;
    }
    try {
      onDone(JSON.parse(stdout));
      finishActive(jobId, true);
    } catch (err) {
      console.error("bad worker output:", stdout);
      job.status = "error";
      job.error = "Could not parse worker output";
      finishActive(jobId, false);
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

// POST /api/scan — enqueue a scan, return a jobId immediately
app.post("/api/scan", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file received" });

  const jobId = crypto.randomUUID();
  const videoPath = req.file.path;
  jobs.set(jobId, {
    kind: "scan",
    status: "queued",
    progress: 0,
    position: queue.length,
    videoPath,
    args: ["worker.py", "scan", videoPath],
    onDone: (result) => {
      const job = jobs.get(jobId);
      job.people = result.people;
      job.progress = 1;
      job.status = "ready";
    },
  });
  enqueue(jobId);
  res.json({ jobId });
});

// POST /api/redact — enqueue a blur, return a jobId immediately
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
  jobs.set(jobId, {
    kind: "blur",
    status: "queued",
    progress: 0,
    position: queue.length,
    args: ["worker.py", "blur", resolved, ids.join(",")],
    onDone: (result) => {
      const job = jobs.get(jobId);
      job.output = `/${result.output}`;
      job.progress = 1;
      job.status = "ready";
    },
  });
  enqueue(jobId);
  res.json({ jobId });
});

// GET /api/status/:id — polling endpoint: drives progress bar AND queue position
app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  res.json({
    kind: job.kind,
    status: job.status,            // queued | running | ready | error
    progress: job.progress,
    position: job.status === "queued" ? job.position : -1, // 0 = next up
    people: job.people,
    videoPath: job.videoPath,
    output: job.output,
    error: job.error,
  });
});

// GET /api/stats — private glance at activity (how busy has it been?)
app.get("/api/stats", (req, res) => {
  res.json({
    ...stats,
    queued: queue.length,
    active: activeJob ? 1 : 0,
    tracked: jobs.size,
  });
});

// POST /api/wipe — clear the queue and forget finished jobs, but DON'T yank
// files out from under a job that's currently running (that corrupts its output).
app.post("/api/wipe", (req, res) => {
  queue.length = 0;                 // drop anything waiting
  for (const [id, job] of jobs) {   // forget every job except the one running now
    if (id !== activeJob) jobs.delete(id);
  }
  const removed = activeJob ? 0 : wipeSession();  // only delete files if nothing's mid-run
  res.json({ ok: true, removed, deferred: !!activeJob });
});

// SPA fallback: any route that isn't an API or static file returns the app
app.get(/^(?!\/api|\/faces|\/outputs).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

// swallow harmless range-request errors from video scrubbing (browser asks for
// a byte range that no longer matches a mid-write/just-wiped file)
app.use((err, req, res, next) => {
  if (err && err.status === 416) return res.status(416).end();
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => {
  log(`Redact server running on http://localhost:${PORT}`);
  log(`wiped ${wipeSession()} leftover session files`);
});