import cv2
import sys
import glob
import os
import json
import subprocess
import numpy as np

DETECTOR_MODEL = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = "face_recognition_sface_2021dec.onnx"

SAMPLE_EVERY = 5            # embed every 5th frame during scan, not all frames
MATCH_THRESHOLD = 0.25      # assignment: single noisy frame vs mean — lenient on purpose
MERGE_THRESHOLD = 0.363     # merging: stable mean vs stable mean — SFace's same-person line
UNCERTAIN_THRESHOLD = 0.15  # below this a face matches nobody we know — protect it
PERSIST_FRAMES = 10         # keep blurring a spot for N frames after last sighting

DETECT_SCALE = 0.5          # blur pass: detect on half-res frames (~4x faster)
REVERIFY_EVERY = 5          # re-embed tracked faces every N frames
PROGRESS_EVERY = 100        # print progress to stderr every N frames

EMB_DIR = "embeddings"
OUT_DIR = "outputs"


def load_models(width, height):
    detector = cv2.FaceDetectorYN.create(
        DETECTOR_MODEL, "", (width, height),
        score_threshold=0.65, nms_threshold=0.3, top_k=5000,
    )
    recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_MODEL, "")
    return detector, recognizer


def crop_score(crop):
    """Thumbnail quality = sharpness x size. Motion-blurred crops score near zero."""
    if crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()   # focus measure
    return float(sharpness * (crop.shape[0] * crop.shape[1]) ** 0.5)


def detect_scaled(detector, frame, scale):
    """Detect on a downscaled frame, return rows mapped back to full-res coords."""
    small = cv2.resize(frame, None, fx=scale, fy=scale)
    detector.setInputSize((small.shape[1], small.shape[0]))
    _, faces = detector.detect(small)
    if faces is None:
        return None
    faces = faces.copy()
    faces[:, :14] /= scale   # x, y, w, h + 5 landmark pairs → full-res space
    return faces


def progress(done, total):
    if done % PROGRESS_EVERY == 0:
        print(f"PROGRESS {done}/{total}", file=sys.stderr, flush=True)


def blur_region(frame, x, y, fw, fh):
    x0, y0 = max(x, 0), max(y, 0)
    x1 = min(x + fw, frame.shape[1])
    y1 = min(y + fh, frame.shape[0])
    roi = frame[y0:y1, x0:x1]
    if roi.size == 0:
        return
    k = max(roi.shape[1] // 2, 1) | 1          # adaptive kernel, forced odd
    blurred = cv2.GaussianBlur(roi, (k, k), 0)
    mask = np.zeros(roi.shape[:2], np.uint8)
    cv2.ellipse(mask, (roi.shape[1] // 2, roi.shape[0] // 2),
                (roi.shape[1] // 2, roi.shape[0] // 2), 0, 0, 360, 255, -1)
    mask = cv2.GaussianBlur(mask, (31, 31), 0)  # feather the edge
    m = mask[..., None] / 255.0
    frame[y0:y1, x0:x1] = (blurred * m + roi * (1 - m)).astype(np.uint8)


def merge_clusters(people, recognizer):
    """Heal pose-splits: merge clusters whose stable means clear SFace's own bar."""
    changed = True
    while changed:
        changed = False
        for i in range(len(people)):
            for j in range(i + 1, len(people)):
                mi = (people[i]["emb_sum"] / people[i]["count"]).astype(np.float32)
                mj = (people[j]["emb_sum"] / people[j]["count"]).astype(np.float32)
                score = recognizer.match(mi, mj, cv2.FaceRecognizerSF_FR_COSINE)
                if score > MERGE_THRESHOLD:
                    people[i]["emb_sum"] += people[j]["emb_sum"]
                    people[i]["count"] += people[j]["count"]
                    if people[j]["thumb_score"] > people[i]["thumb_score"]:
                        people[i]["thumb"] = people[j]["thumb"]
                        people[i]["thumb_score"] = people[j]["thumb_score"]
                    people.pop(j)
                    changed = True
                    break
            if changed:
                break
    return people


def cluster_faces(video_path):
    video = cv2.VideoCapture(video_path)
    total_frames = int(video.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    # clean up thumbnails + embeddings from any previous run
    for old in glob.glob("faces/person_*.jpg"):
        os.remove(old)
    os.makedirs(EMB_DIR, exist_ok=True)
    for old in glob.glob(f"{EMB_DIR}/person_*.npy"):
        os.remove(old)

    ok, frame = video.read()
    if not ok:
        sys.exit("Could not read video")
    h, w = frame.shape[:2]
    detector, recognizer = load_models(w, h)

    people = []          # each: {"id", "emb_sum", "count", "thumb", "thumb_score"}
    frame_num = 0
    sampled_frames = 0   # how many frames we actually embedded (for the phantom filter)

    video.set(cv2.CAP_PROP_POS_FRAMES, 0)
    while True:
        ok, frame = video.read()
        if not ok:
            break

        if frame_num % SAMPLE_EVERY == 0:
            sampled_frames += 1
            _, faces = detector.detect(frame)
            if faces is not None:
                for face_row in faces:
                    # size filter: tiny detections are noise, not faces
                    x, y, fw, fh = face_row[:4].astype(int)
                    if fw < 60 or fh < 60:
                        continue

                    aligned = recognizer.alignCrop(frame, face_row)
                    emb = recognizer.feature(aligned)

                    crop = frame[max(y, 0):y + fh, max(x, 0):x + fw]
                    score_now = crop_score(crop)

                    # compare against the running MEAN of each known person
                    best_score = 0
                    best_person = None
                    for person in people:
                        mean = (person["emb_sum"] / person["count"]).astype(np.float32)
                        score = recognizer.match(
                            emb, mean,
                            cv2.FaceRecognizerSF_FR_COSINE,
                        )
                        if score > best_score:
                            best_score = score
                            best_person = person

                    if best_person is not None and best_score > MATCH_THRESHOLD:
                        best_person["count"] += 1
                        best_person["emb_sum"] += emb   # fingerprint keeps improving
                        if score_now > best_person["thumb_score"]:
                            # sharper, better-sized face → better thumbnail
                            best_person["thumb"] = crop
                            best_person["thumb_score"] = score_now
                    else:
                        # new person: start their embedding sum + save a thumbnail crop
                        people.append({
                            "id": len(people) + 1,
                            "emb_sum": emb.copy(),
                            "count": 1,
                            "thumb": crop,
                            "thumb_score": score_now,
                        })

        frame_num += 1
        progress(frame_num, total_frames)

    video.release()

    # heal pose-splits before filtering
    people = merge_clusters(people, recognizer)

    # phantom filter, scaled to video length: 2% of sampled frames, floor of 3
    min_appearances = max(3, sampled_frames // 50)
    people = [p for p in people if p["count"] >= min_appearances]

    for i, p in enumerate(people, start=1):
        p["id"] = i

    # output: thumbnails to faces/, mean embeddings to embeddings/, JSON to stdout
    os.makedirs("faces", exist_ok=True)

    result = []
    for person in people:
        fname = f"faces/person_{person['id']}.jpg"
        cv2.imwrite(fname, person["thumb"])
        np.save(f"{EMB_DIR}/person_{person['id']}.npy",
                person["emb_sum"] / person["count"])
        result.append({
            "id": person["id"],
            "appearances": person["count"],
            "thumbnail": fname,
        })

    print(json.dumps({"people": result}))


def blur_faces(video_path, selected_ids):
    # load ALL known people from the scan, remember which are selected
    known = []   # (person_id, embedding)
    for f in glob.glob(f"{EMB_DIR}/person_*.npy"):
        pid = int(os.path.basename(f).split("_")[1].split(".")[0])
        known.append((pid, np.load(f).astype(np.float32)))
    if not known:
        sys.exit("No embeddings found — run a scan first")
    selected = set(selected_ids)

    video = cv2.VideoCapture(video_path)
    fps = video.get(cv2.CAP_PROP_FPS) or 30
    w = int(video.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(video.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    detector, recognizer = load_models(w, h)

    os.makedirs(OUT_DIR, exist_ok=True)
    silent_path = f"{OUT_DIR}/redacted_silent.mp4"
    writer = cv2.VideoWriter(silent_path,
                             cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    trail = []       # recent target sightings: [x, y, fw, fh, ttl]
    frame_num = 0

    while True:
        ok, frame = video.read()
        if not ok:
            break

        faces = detect_scaled(detector, frame, DETECT_SCALE)
        if faces is not None:
            for face_row in faces:
                x, y, fw, fh = face_row[:4].astype(int)

                if fw < 60 or fh < 60:
                    hit = True                     # too small to identify → blur
                else:
                    cx, cy = x + fw // 2, y + fh // 2
                    in_trail = any(b[0] <= cx <= b[0] + b[2]
                                   and b[1] <= cy <= b[1] + b[3]
                                   for b in trail)
                    if in_trail and frame_num % REVERIFY_EVERY != 0:
                        hit = True                 # tracked face → skip embedding
                    else:
                        # nearest-identity: who does this face resemble MOST?
                        aligned = recognizer.alignCrop(frame, face_row)
                        emb = recognizer.feature(aligned)
                        best_pid, best = None, -1.0
                        for pid, temb in known:
                            s = recognizer.match(emb, temb,
                                                 cv2.FaceRecognizerSF_FR_COSINE)
                            if s > best:
                                best, best_pid = s, pid
                        if best < UNCERTAIN_THRESHOLD:
                            hit = True                  # unknown face → protect it
                        else:
                            hit = best_pid in selected  # known → their selection decides

                if hit:
                    # supersede stale trail boxes this fresh sighting overlaps
                    cx, cy = x + fw // 2, y + fh // 2
                    trail = [b for b in trail
                             if not (b[0] <= cx <= b[0] + b[2]
                                     and b[1] <= cy <= b[1] + b[3])]
                    trail.append([x, y, fw, fh, PERSIST_FRAMES])

        # blur every active trail box, then age them out
        for b in trail:
            blur_region(frame, b[0], b[1], b[2], b[3])
        trail = [[bx, by, bw, bh, ttl - 1]
                 for bx, by, bw, bh, ttl in trail if ttl > 1]

        writer.write(frame)
        frame_num += 1
        progress(frame_num, total_frames)

    video.release()
    writer.release()

    # audio restore: video from blurred file, audio from original (Project 1 trick)
    final_path = f"{OUT_DIR}/redacted.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-i", silent_path, "-i", video_path,
         "-map", "0:v", "-map", "1:a?",
         "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart",
         "-c:a", "aac",
         final_path],
        check=True, capture_output=True,
    )
    os.remove(silent_path)
    print(json.dumps({"output": final_path}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python worker.py scan <video> | blur <video> <ids>")
    mode = sys.argv[1]
    if mode == "blur":
        ids = [int(i) for i in sys.argv[3].split(",")]
        blur_faces(sys.argv[2], ids)
    elif mode == "scan":
        cluster_faces(sys.argv[2])
    else:
        sys.exit(f"Unknown mode: {mode}")