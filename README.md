# Reel Pipeline 🎬

> Turn raw gym footage into post-ready faceless reels with a single command — automatic face anonymization, caption burning, audio restoration, and Instagram-spec export.

![Python](https://img.shields.io/badge/Python-3.9+-blue)
![OpenCV](https://img.shields.io/badge/OpenCV-YuNet_DNN-green)
![ffmpeg](https://img.shields.io/badge/ffmpeg-H.264-orange)

![demo](demo.gif)

---

## Overview

I run a faceless fitness content brand, which means every reel needs the same repetitive technical edit: blur my face throughout, drop in a hook caption, and export to Instagram's spec. Done by hand in a mobile editor, that takes **~[X] minutes per clip**.

This pipeline does it in **~41 seconds**, automatically, from one command — so the time goes into making content instead of editing it.

```bash
python pipeline.py input.mov --hook "no one is coming to save you" --watermark "@yourhandle"
```

---

## Quick Start

**Requirements:** Python 3.9+, and `ffmpeg-full` (the standard ffmpeg formula omits the `drawtext` filter used for captions).

```bash
# 1. dependencies
pip install -r requirements.txt
brew install ffmpeg-full

# 2. run
python pipeline.py input.mov --hook "your caption" --watermark "@yourhandle"

# 3. result
# → output/<name>_reel.mp4
```

| Flag | Description | Default |
|------|-------------|---------|
| `--hook` | Caption text, burned top-center | none |
| `--watermark` | Brand handle, translucent, bottom | none |
| `--style` | `blur` or `pixelate` | `blur` |
| `--keep-temp` | Keep the intermediate anonymized file | off |

---
## Pipeline

```text
raw clip
   │
   ├─ ingest      validate + extract metadata (ffprobe)
   ├─ anonymize   detect & blur all faces (YuNet DNN)
   ├─ caption     burn hook + watermark, restore audio (ffmpeg)
   └─ export      encode to Instagram spec
   │
   └─→ output/<name>_reel.mp4
```
## How It Works

### `ingest.py` — validation & metadata
Validates the input and extracts resolution, fps, and duration via `ffprobe`.

Handles a real-world iPhone quirk: footage is stored landscape with a rotation *flag* rather than physically rotated pixels, so raw dimensions report vertical clips as `1920×1080`. The module reads the rotation flag from `side_data_list` and corrects orientation accordingly.

### `face_blur.py` — face anonymization
Detects and anonymizes every face frame-by-frame (bystanders included). Built in three iterations on real footage:

| Iteration | Approach | Outcome |
|-----------|----------|---------|
| 1 | Haar cascade | Fast, but failed on tilted-head poses and false-triggered on gym equipment / skin |
| 2 | YuNet (DNN, ONNX) | Fixed angle and motion misses; real faces detect at 0.86–0.95 confidence |
| 3 | False-positive filtering | Eliminated torso false positives via confidence threshold + geometric filter |

Iteration 3 used a built-in `--debug` mode that renders detection boxes and confidence scores instead of blurring. That surfaced the torso false positives (0.60–0.81 confidence, distinctly tall-rectangle shaped) and let me eliminate them with a **confidence threshold (0.65) plus a geometric aspect-ratio filter** — more robust than tightening the threshold alone, which risked dropping real faces.

Anonymization applies a **face-size-adaptive blur** (or pixelate) composited through a **feathered elliptical mask**, so strength scales with subject distance and blends into the frame instead of showing a hard box. **Temporal persistence** keeps the last-known region anonymized for 10 frames after a detection drop, bridging momentary misses.

### `captions.py` — captions, audio & encode
A single `ffmpeg` pass that burns the outlined hook caption and translucent watermark, while mapping **video from the anonymized file and audio from the untouched original** (`-map 0:v -map 1:a?`) — restoring the sound that OpenCV's video-only writer discards. Encodes to Instagram spec: H.264, CRF 20, AAC, `yuv420p`.

### `pipeline.py` — orchestration
Chains all three stages behind one `argparse` CLI by importing each module's functions, times the full run, and writes to a clean `output/` directory.

---

## Tech Stack

**Python 3** · **OpenCV** (YuNet DNN face detection) · **ffmpeg / ffmpeg-python** · **NumPy**

---

## Results

| | Manual (mobile editor) | Reel Pipeline |
|---|:---:|:---:|
| **Time per reel** | ~[X] min | ~41 sec |

*Measured on an 18-second, 1080×1920 clip.*