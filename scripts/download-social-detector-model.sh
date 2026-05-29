#!/usr/bin/env bash
# Downloads YOLOv8n ONNX for social smart-crop (requires Python + ultralytics).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/models/yolov8n.onnx"
mkdir -p "$(dirname "$OUT")"
if [[ -f "$OUT" ]]; then
  echo "Model already exists: $OUT"
  exit 0
fi
python3 - <<'PY'
from ultralytics import YOLO
m = YOLO("yolov8n.pt")
m.export(format="onnx")
PY
cp yolov8n.onnx "$OUT"
echo "Saved $OUT"
