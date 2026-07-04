import cv2
import numpy as np
import sys
import os

MODEL_PATH = "face_detection_yunet_2023mar.onnx"
DEBUG = "--debug" in sys.argv


def load_detector(width, height):
    """YuNet: DNN-based face detector (ONNX). Handles angles, motion,
    and occlusion far better than Haar cascades."""
    if not os.path.exists(MODEL_PATH):
        sys.exit(f"Error: model file missing -> {MODEL_PATH}")

    return cv2.FaceDetectorYN.create(
        MODEL_PATH,
        "",
        (width, height),
        score_threshold=0.65,   # tuned: real faces score 0.86+, noise < 0.65
        nms_threshold=0.3,
        top_k=5000,
    )


def anonymize_region(region, style):
    """Make a face region unrecognizable, blended via a feathered oval."""
    rh, rw = region.shape[:2]

    if style == "pixelate":
        blocks = 7
        small = cv2.resize(region, (blocks, blocks),
                           interpolation=cv2.INTER_LINEAR)
        anon = cv2.resize(small, (rw, rh),
                          interpolation=cv2.INTER_NEAREST)
    else:
        k = max(31, (rw // 2) | 1)   # blur scales with face size; must be odd
        anon = cv2.GaussianBlur(region, (k, k), 0)

    # feathered elliptical mask: soft oval, not a hard rectangle
    mask = np.zeros((rh, rw), dtype=np.uint8)
    cv2.ellipse(mask, (rw // 2, rh // 2), (rw // 2, rh // 2),
                0, 0, 360, 255, -1)
    mask = cv2.GaussianBlur(mask, (31, 31), 0)
    mask3 = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR) / 255.0

    return (anon * mask3 + region * (1 - mask3)).astype("uint8")


def process_video(input_path, output_path, style="blur", persist_frames=10):
    video = cv2.VideoCapture(input_path)

    fps = video.get(cv2.CAP_PROP_FPS)
    width = int(video.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(video.get(cv2.CAP_PROP_FRAME_COUNT))

    detector = load_detector(width, height)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    frame_num = 0
    blurred_frames = 0
    cached_boxes = []   # [x1, y1, x2, y2, ttl]

    while True:
        ok, frame = video.read()
        if not ok:
            break

        _, faces = detector.detect(frame)

        if faces is not None and len(faces) > 0:
            fresh = []
            for face in faces:
                x, y, w, h = face[:4].astype(int)
                confidence = float(face[14])

                # geometric filter: faces are ~square; torso/skin false
                # positives arrive as tall rectangles
                if h > 1.4 * w:
                    continue

                if DEBUG:
                    cv2.rectangle(frame, (x, y), (x + w, y + h),
                                  (0, 255, 0), 3)
                    cv2.putText(frame, f"{confidence:.2f}", (x, y - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
                    continue

                # asymmetric padding: extra room below for jaw/beard
                pad_w = int(w * 0.3)
                x1 = max(x - pad_w, 0)
                x2 = min(x + w + pad_w, width)
                y1 = max(y - int(h * 0.3), 0)
                y2 = min(y + h + int(h * 0.5), height)
                fresh.append([x1, y1, x2, y2, persist_frames])

            if fresh:
                cached_boxes = fresh

        if not DEBUG:
            still_alive = []
            for x1, y1, x2, y2, ttl in cached_boxes:
                region = frame[y1:y2, x1:x2]
                if region.size > 0:
                    frame[y1:y2, x1:x2] = anonymize_region(region, style)
                if ttl - 1 > 0:
                    still_alive.append([x1, y1, x2, y2, ttl - 1])
            cached_boxes = still_alive

        if cached_boxes:
            blurred_frames += 1
        writer.write(frame)

        frame_num += 1
        if frame_num % 30 == 0:
            print(f"   processed {frame_num}/{total} frames...", end="\r")

    video.release()
    writer.release()
    print(f"\n✅ done: {frame_num} frames, anonymized on {blurred_frames}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python face_blur.py <video_file> [--pixelate] [--debug]")

    input_path = sys.argv[1]
    cli_style = "pixelate" if "--pixelate" in sys.argv else "blur"
    name, _ = os.path.splitext(os.path.basename(input_path))

    if DEBUG:
        suffix = "debug"
    else:
        suffix = cli_style if cli_style == "pixelate" else "blurred"
    output_path = f"{name}_{suffix}.mp4"

    process_video(input_path, output_path, style=cli_style)
    print(f"   saved -> {output_path}")