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
MATCH_THRESHOLD = 0.25      # below SFace's 0.363 — lenient, to avoid splitting one person
UNCERTAIN_THRESHOLD = 0.15  # below this we're confident it's someone else
PERSIST_FRAMES = 10         # keep blurring a spot for N frames after last sighting

EMB_DIR = "embeddings"
OUT_DIR = "outputs"


def load_models(width, height):
    detector = cv2.FaceDetectorYN.create(
        DETECTOR_MODEL, "", (width, height),
        score_threshold=0.65, nms_threshold=0.3, top_k=5000,
    )
    recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_MODEL, "")
    return detector, recognizer


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
    """Heal pose-splits: merge clusters whose mean embeddings match."""
    changed = True
    while changed:
        changed = False
        for i in range(len(people)):
            for j in range(i + 1, len(people)):
                mi = (people[i]["emb_sum"] / people[i]["count"]).astype(np.float32)
                mj = (people[j]["emb_sum"] / people[j]["count"]).astype(np.float32)
                score = recognizer.match(mi, mj, cv2.FaceRecognizerSF_FR_COSINE)
                if score > MATCH_THRESHOLD:
                    people[i]["emb_sum"] += people[j]["emb_sum"]
                    people[i]["count"] += people[j]["count"]
                    if people[j]["thumb_area"] > people[i]["thumb_area"]:
                        people[i]["thumb"] = people[j]["thumb"]
                        people[i]["thumb_area"] = people[j]["thumb_area"]
                    people.pop(j)
                    changed = True
                    break
            if changed:
                break
    return people


def cluster_faces(video_path):
    video = cv2.VideoCapture(video_path)

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

    people = []          # each: {"id", "emb_sum", "count", "thumb", "thumb_area"}
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
                        if fw * fh > best_person["thumb_area"]:
                            # bigger face → better thumbnail
                            best_person["thumb"] = frame[max(y, 0):y + fh,
                                                         max(x, 0):x + fw]
                            best_person["thumb_area"] = fw * fh
                    else:
                        # new person: start their embedding sum + save a thumbnail crop
                        thumb = frame[max(y, 0):y + fh, max(x, 0):x + fw]
                        people.append({
                            "id": len(people) + 1,
                            "emb_sum": emb.copy(),
                            "count": 1,
                            "thumb": thumb,
                            "thumb_area": fw * fh,
                        })

        frame_num += 1

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
    targets = []
    for pid in selected_ids:
        emb = np.load(f"{EMB_DIR}/person_{pid}.npy").astype(np.float32)
        targets.append(emb)

    video = cv2.VideoCapture(video_path)
    fps = video.get(cv2.CAP_PROP_FPS) or 30
    w = int(video.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
    detector, recognizer = load_models(w, h)

    os.makedirs(OUT_DIR, exist_ok=True)
    silent_path = f"{OUT_DIR}/redacted_silent.mp4"
    writer = cv2.VideoWriter(silent_path,
                             cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    trail = []   # recent target sightings: [x, y, fw, fh, ttl]

    while True:
        ok, frame = video.read()
        if not ok:
            break

        _, faces = detector.detect(frame)
        if faces is not None:
            for face_row in faces:
                x, y, fw, fh = face_row[:4].astype(int)

                if fw < 60 or fh < 60:
                    hit = True                     # too small to identify → blur
                else:
                    aligned = recognizer.alignCrop(frame, face_row)
                    emb = recognizer.feature(aligned)
                    best = max(recognizer.match(emb, t,
                               cv2.FaceRecognizerSF_FR_COSINE) for t in targets)
                    hit = best >= UNCERTAIN_THRESHOLD

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

    video.release()
    writer.release()

    # audio restore: video from blurred file, audio from original (Project 1 trick)
    final_path = f"{OUT_DIR}/redacted.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-i", silent_path, "-i", video_path,
         "-map", "0:v", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac",
         final_path],
        check=True, capture_output=True,
    )
    os.remove(silent_path)
    print(json.dumps({"output": final_path}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python worker.py scan <video> | blur <video> <ids>")
    mode = sys.argv[1]
    if mode == "scan":
        cluster_faces(sys.argv[2])
    elif mode == "blur":
        ids = [int(i) for i in sys.argv[3].split(",")]
        blur_faces(sys.argv[2], ids)
    else:
        sys.exit(f"Unknown mode: {mode}")