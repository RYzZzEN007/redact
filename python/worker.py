import cv2
import sys
import glob
import os
import json
import numpy as np

DETECTOR_MODEL = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = "face_recognition_sface_2021dec.onnx"

SAMPLE_EVERY = 5        # embed every 5th frame, not all 550
MATCH_THRESHOLD = 0.25  # below SFace's 0.363 — lenient, to avoid splitting one person


def load_models(width, height):
    detector = cv2.FaceDetectorYN.create(
        DETECTOR_MODEL, "", (width, height),
        score_threshold=0.65, nms_threshold=0.3, top_k=5000,
    )
    recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_MODEL, "")
    return detector, recognizer


def cluster_faces(video_path):
    video = cv2.VideoCapture(video_path)

    # clean up thumbnails from any previous run
    for old in glob.glob("faces/person_*.jpg"):
        os.remove(old)

    ok, frame = video.read()
    if not ok:
        sys.exit("Could not read video")
    h, w = frame.shape[:2]
    detector, recognizer = load_models(w, h)

    people = []   # each: {"id", "embedding" (reference), "count", "thumb"}
    frame_num = 0

    video.set(cv2.CAP_PROP_POS_FRAMES, 0)
    while True:
        ok, frame = video.read()
        if not ok:
            break

        if frame_num % SAMPLE_EVERY == 0:
            _, faces = detector.detect(frame)
            if faces is not None:
                for face_row in faces:
                    # size filter: tiny detections are noise, not faces
                    x, y, fw, fh = face_row[:4].astype(int)
                    if fw < 60 or fh < 60:
                        continue

                    aligned = recognizer.alignCrop(frame, face_row)
                    emb = recognizer.feature(aligned)

                    # compare against everyone we've found so far
                    best_score = 0
                    best_person = None
                    for person in people:
                        score = recognizer.match(
                            emb, person["embedding"],
                            cv2.FaceRecognizerSF_FR_COSINE,
                        )
                        if score > best_score:
                            best_score = score
                            best_person = person

                    if best_person is not None and best_score > MATCH_THRESHOLD:
                        best_person["count"] += 1      # known person, seen again
                    else:
                        # new person: save their embedding + a thumbnail crop
                        thumb = frame[max(y, 0):y + fh, max(x, 0):x + fw]
                        people.append({
                            "id": len(people) + 1,
                            "embedding": emb,
                            "count": 1,
                            "thumb": thumb,
                        })

        frame_num += 1

    video.release()

    # drop phantom identities seen too few times to be real
    MIN_APPEARANCES = 3
    people = [p for p in people if p["count"] >= MIN_APPEARANCES]
    for i, p in enumerate(people, start=1):
        p["id"] = i

    # output: thumbnails to faces/, machine-readable JSON to stdout
    os.makedirs("faces", exist_ok=True)

    result = []
    for person in people:
        fname = f"faces/person_{person['id']}.jpg"
        cv2.imwrite(fname, person["thumb"])
        result.append({
            "id": person["id"],
            "appearances": person["count"],
            "thumbnail": fname,
        })

    print(json.dumps({"people": result}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python worker.py <video_file>")
    cluster_faces(sys.argv[1])