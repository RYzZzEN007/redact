# Redact

**Selective face anonymization for video.** Upload a clip, and Redact detects everyone who appears, groups each distinct person into their own identity, and lets you pick exactly who to blur — leaving everyone else untouched. Nothing is stored; every file is wiped when the session ends.

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Redact demo — scan a clip, select one person, download the result with only that person blurred" />
</p>

---

## What makes it different

Most face-blur tools blur *every* face. Redact answers a harder question: **"blur this person, but not that one."**

In the demo above, three people are detected. Only the center subject is selected — and in the output, his face is blurred while the two people beside him stay perfectly visible. That selective control is the whole point.

- **Groups faces by identity**, not just detection — the same person across 100 frames becomes one selectable subject.
- **Blur-by-choice** — tick who to anonymize; anyone left unticked stays visible.
- **Protects the unknown** — a face the scan never catalogued is blurred by default, so nobody leaks.
- **No storage, no accounts** — single-session processing, all artifacts wiped on demand.

---

## How it works

```
          ┌─────────────┐     video      ┌──────────────┐    spawn     ┌────────────────┐
  Browser │   React UI  │ ─────────────▶ │ Node/Express │ ───────────▶ │  Python worker │
  (Vite)  │  phase FSM  │ ◀───────────── │  job registry│ ◀─────────── │  OpenCV + ffmpeg│
          └─────────────┘   jobId/poll   └──────────────┘   stdout     └────────────────┘
```

**The scan pass** samples the video, detects faces with **YuNet**, and turns each into a 128-d embedding with **SFace**. Faces are clustered online into people by cosine similarity against each person's running-mean embedding, a merge pass heals identities that split across pose changes, and a phantom filter drops faces seen too briefly to be real. Each surviving person gets a thumbnail and a saved mean embedding.

**The blur pass** walks every frame, and for each detected face asks *who does this resemble most?* against all catalogued people. If the best match is a selected person — blur. If it matches nobody confidently — blur anyway (protect the unknown). Otherwise, leave it clear. A short temporal-persistence trail keeps the blur steady through detection hiccups, and the audio is restored from the original before the H.264 export.

**The pipeline is asynchronous:** the API returns a job ID immediately and the worker streams progress to the server, which the UI polls — so the long blur pass shows a real progress bar instead of a frozen request.

---

## Tech stack

| Layer     | Tools |
|-----------|-------|
| Frontend  | React (Vite), Framer Motion |
| Backend   | Node.js, Express, Multer |
| CV worker | Python, OpenCV (YuNet detection + SFace recognition), NumPy |
| Video     | ffmpeg (H.264 re-encode, audio remux) |

---

## Running locally

Redact runs as two processes — a Node server and a Vite dev server — with a Python virtual environment for the CV worker.

**1. Python worker**
```bash
cd python
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**2. Backend** (new terminal)
```bash
cd server
npm install
npm start                       # http://localhost:3001
```

**3. Frontend** (new terminal)
```bash
cd client
npm install
npm run dev                     # http://localhost:5173
```

Open `http://localhost:5173`, drop in a clip, and go. `ffmpeg` must be installed and on your `PATH`. The YuNet and SFace ONNX models are included in `python/`.

---

## Design decisions worth calling out

A few choices that came out of testing on real footage rather than theory:

- **Merge threshold at SFace's own 0.363.** Assignment during clustering is deliberately lenient (to avoid splitting one person across poses), but merging compares two *stable* mean embeddings — so it uses SFace's official same-person line. Getting this wrong once fused two different people into one identity; the fix was recognizing that a single noisy frame and a stable mean deserve different thresholds.
- **Nearest-identity, not per-target matching.** The blur pass classifies each face against *everyone* catalogued and acts on the best match — so two similar-looking people are told apart correctly, and an unselected person stays clear even if they slightly resemble a selected one.
- **Blur when uncertain.** For a privacy tool, the safe failure is over-protection. A face that matches nobody confidently gets blurred rather than risk a leak.
- **Sharpness-scored thumbnails.** Subject cards use the sharpest crop (variance-of-Laplacian × size), not just the biggest — motion-blurred frames don't win.
- **H.264 output.** The raw OpenCV writer produces a codec browsers won't play; the final pass re-encodes to H.264 with `+faststart` so the result streams in-browser.

---

## Production considerations

Redact is built to run locally, where the only reachable client is your own machine. Exposing it publicly would need real hardening — the main risk isn't a classic DDoS but **resource exhaustion**, since each blur job is minutes of CPU:

- Per-IP rate limiting and a bounded job queue (one worker at a time)
- Per-session resource and upload caps
- HTTPS and a hardened reverse proxy

These are out of scope for a local tool but noted as the path to a real deployment.

---

## Privacy

No database. No accounts. Uploads, thumbnails, embeddings, and outputs live only for the session and are wiped on "start over" and on server restart. Nothing about your video leaves your machine.
