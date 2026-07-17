const express = require("express");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = 3001;

const PYTHON_DIR = path.join(__dirname, "..", "python");
const PYTHON_BIN = path.join(PYTHON_DIR, "venv", "bin", "python");

app.use(cors());
app.use(express.json());

// serve generated thumbnails + processed videos to the frontend
app.use("/faces", express.static(path.join(PYTHON_DIR, "faces")));
app.use("/outputs", express.static(path.join(PYTHON_DIR, "outputs")));

// session wipe: everything Redact generates lives in these four folders
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

// multer: store uploads in python/uploads/ with a safe unique name
const storage = multer.diskStorage({
  destination: path.join(PYTHON_DIR, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB cap
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Redact backend is running" });
});

// POST /api/scan — upload a video, run clustering, return the people list
app.post("/api/scan", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file received" });
  }

  const videoPath = req.file.path;

  const worker = spawn(PYTHON_BIN, ["worker.py", "scan", videoPath], {
    cwd: PYTHON_DIR, // run from python/ so model + faces/ paths resolve
  });

  let stdout = "";
  let stderr = "";

  worker.stdout.on("data", (chunk) => (stdout += chunk));
  worker.stderr.on("data", (chunk) => (stderr += chunk));

  worker.on("close", (code) => {
    if (code !== 0) {
      console.error("worker failed:", stderr);
      return res.status(500).json({ error: "Face scan failed" });
    }
    try {
      const result = JSON.parse(stdout);
      res.json({ videoPath, ...result });
    } catch (err) {
      console.error("bad worker output:", stdout);
      res.status(500).json({ error: "Could not parse worker output" });
    }
  });
});

// POST /api/redact — blur the selected people in an already-scanned video
app.post("/api/redact", (req, res) => {
  const { videoPath, selectedIds } = req.body;

  if (!videoPath || !Array.isArray(selectedIds) || selectedIds.length === 0) {
    return res.status(400).json({ error: "videoPath and selectedIds required" });
  }

  // safety: only allow files inside python/uploads, only numeric IDs
  const uploadsDir = path.join(PYTHON_DIR, "uploads");
  const resolved = path.resolve(videoPath);
  if (!resolved.startsWith(uploadsDir)) {
    return res.status(400).json({ error: "Invalid video path" });
  }
  const ids = selectedIds.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n < 1)) {
    return res.status(400).json({ error: "Invalid person IDs" });
  }

  const worker = spawn(PYTHON_BIN, ["worker.py", "blur", resolved, ids.join(",")], {
    cwd: PYTHON_DIR,
  });

  let stdout = "";
  let stderr = "";

  worker.stdout.on("data", (chunk) => (stdout += chunk));
  worker.stderr.on("data", (chunk) => (stderr += chunk));

  worker.on("close", (code) => {
    if (code !== 0) {
      console.error("blur worker failed:", stderr);
      return res.status(500).json({ error: "Redaction failed" });
    }
    try {
      const result = JSON.parse(stdout); // {"output": "outputs/redacted.mp4"}
      res.json({ videoUrl: `/${result.output}` });
    } catch (err) {
      console.error("bad worker output:", stdout);
      res.status(500).json({ error: "Could not parse worker output" });
    }
  });
});

// POST /api/wipe — delete all session files (uploads, faces, embeddings, outputs)
app.post("/api/wipe", (req, res) => {
  const removed = wipeSession();
  res.json({ ok: true, removed });
});

app.listen(PORT, () => {
  console.log(`✅ Redact server running on http://localhost:${PORT}`);
  console.log(`🧹 wiped ${wipeSession()} leftover session files`);
});