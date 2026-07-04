const express = require("express");
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

// serve the generated face thumbnails so the frontend can display them
app.use("/faces", express.static(path.join(PYTHON_DIR, "faces")));

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

  // spawn the Python worker as a child process
  const worker = spawn(PYTHON_BIN, ["worker.py", videoPath], {
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

app.listen(PORT, () => {
  console.log(`✅ Redact server running on http://localhost:${PORT}`);
});