const express = require("express");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { spawn, execFile } = require("child_process");
const MAX_DURATION_S = 45;

function getDuration(filePath) {
  return new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath
    ], (err, stdout) => {
      if (err) return resolve(null); // if ffprobe fails, don't block — let it through
      const d = parseFloat(stdout.trim());
      resolve(Number.isFinite(d) ? d : null);
    });
  });
}

const app = express();
const PORT = process.env.PORT || 3001;

const PYTHON_DIR = path.join(__dirname, "..", "python");
const PYTHON_BIN = process.env.PYTHON_BIN || path.join(PYTHON_DIR, "venv", "bin", "python");

// --- watchdog thresholds ---
const MAX_JOB_MS = 900 * 1000;   // hard ceiling: no job may run longer than 10 min
const STALL_MS = 180 * 1000;      // no progress for 180s => considered hung
const WATCHDOG_EVERY_MS = 10 * 1000; // check every 10s

app.use(cors());
app.use(express.json());

app.use("/faces", express.static(path.join(PYTHON_DIR, "faces")));
app.use("/outputs", express.static(path.join(PYTHON_DIR, "outputs")));

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
const jobs = new Map();
const queue = [];
let activeJob = null;

const stats = { started: 0, completed: 0, failed: 0, killed: 0, bootedAt: new Date().toISOString() };

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function enqueue(jobId) {
  queue.push(jobId);
  refreshPositions();
  pump();
}

function refreshPositions() {
  queue.forEach((id, i) => {
    const job = jobs.get(id);
    if (job) job.position = i;
  });
}

function pump() {
  if (activeJob) return;
  const jobId = queue.shift();
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job) return pump();

  activeJob = jobId;
  job.status = "running";
  job.position = -1;
  job.startedAt = Date.now();
  job.lastProgressAt = Date.now();   // for stall detection
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
  if (activeJob === jobId) activeJob = null;   // only clear if it's still the active one
  pump();
}

function runWorker(jobId, args, onDone) {
  const job = jobs.get(jobId);
  const worker = spawn(PYTHON_BIN, args, { cwd: PYTHON_DIR });
  job.proc = worker;   // keep the handle so the watchdog can kill it

  let stdout = "";
  let stderrLog = "";
  let buf = "";

  worker.stdout.on("data", (c) => (stdout += c));

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
        job.lastProgressAt = Date.now();   // progress advanced — reset stall timer
      } else if (line.trim()) {
        stderrLog += line + "\n";
      }
    }
  });

  worker.on("close", (code) => {
    // if the watchdog already killed this job, don't double-finish it
    if (job.killed) return;
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

  worker.on("error", (err) => {
    if (job.killed) return;
    console.error("worker spawn error:", err);
    job.status = "error";
    job.error = "Worker could not start";
    finishActive(jobId, false);
  });
}

// ---------- watchdog: prevents the queue from ever deadlocking ----------
function killJob(jobId, reason) {
  const job = jobs.get(jobId);
  if (!job) { if (activeJob === jobId) activeJob = null; pump(); return; }
  job.killed = true;
  job.status = "error";
  job.error = reason;
  if (job.proc) {
    try { job.proc.kill("SIGKILL"); } catch {}
  }
  stats.killed++;
  const secs = job.startedAt ? ((Date.now() - job.startedAt) / 1000).toFixed(1) : "?";
  log(`job ${jobId.slice(0, 8)} ${job.kind} KILLED after ${secs}s — ${reason}`);
  if (activeJob === jobId) activeJob = null;
  pump();
}

setInterval(() => {
  if (!activeJob) return;
  const job = jobs.get(activeJob);
  if (!job || !job.startedAt) { activeJob = null; pump(); return; }  // ghost — clear it

  const now = Date.now();
  const ranFor = now - job.startedAt;
  const sinceProgress = now - (job.lastProgressAt || job.startedAt);

  if (ranFor > MAX_JOB_MS) {
    killJob(activeJob, `exceeded max runtime (${MAX_JOB_MS / 1000}s)`);
  } else if (sinceProgress > STALL_MS) {
    killJob(activeJob, `stalled — no progress for ${STALL_MS / 1000}s`);
  }
}, WATCHDOG_EVERY_MS);

// ---------- upload ----------
const storage = multer.diskStorage({
  destination: path.join(PYTHON_DIR, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Redact backend is running" });
});

app.post("/api/scan", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file received" });

  // reject clips that are too long to process in reasonable time
  const duration = await getDuration(req.file.path);
  if (duration !== null && duration > MAX_DURATION_S) {
    fs.rmSync(req.file.path, { force: true }); // wipe the rejected upload
    return res.status(400).json({ error: `Clips must be ${MAX_DURATION_S} seconds or shorter. Yours is ${Math.round(duration)}s.` });
  }

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

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  res.json({
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    position: job.status === "queued" ? job.position : -1,
    people: job.people,
    videoPath: job.videoPath,
    output: job.output,
    error: job.error,
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    ...stats,
    queued: queue.length,
    active: activeJob ? 1 : 0,
    tracked: jobs.size,
  });
});

// manual escape hatch: force-clear a stuck queue without redeploying
app.post("/api/admin/reset-queue", (req, res) => {
  if (activeJob) {
    const job = jobs.get(activeJob);
    if (job && job.proc) { try { job.proc.kill("SIGKILL"); } catch {} }
  }
  queue.length = 0;
  activeJob = null;
  const removed = wipeSession();
  jobs.clear();
  log(`queue force-reset via admin endpoint (${removed} files wiped)`);
  res.json({ ok: true, removed });
});

app.post("/api/wipe", (req, res) => {
  queue.length = 0;
  for (const [id, job] of jobs) {
    if (id !== activeJob) jobs.delete(id);
  }
  const removed = activeJob ? 0 : wipeSession();
  res.json({ ok: true, removed, deferred: !!activeJob });
});

app.get(/^(?!\/api|\/faces|\/outputs).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

app.use((err, req, res, next) => {
  if (err && err.status === 416) return res.status(416).end();
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => {
  log(`Redact server running on http://localhost:${PORT}`);
  log(`wiped ${wipeSession()} leftover session files`);
});