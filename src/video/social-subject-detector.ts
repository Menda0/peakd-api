import { access } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const YOLO_INPUT = 640;
const PERSON_CLASS_ID = 0;

export type PersonDetection = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  confidence: number;
};

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let sessionModelPath: string | null = null;

async function getSession(modelPath: string): Promise<ort.InferenceSession> {
  if (!sessionPromise || sessionModelPath !== modelPath) {
    await access(modelPath);
    sessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
    sessionModelPath = modelPath;
  }
  return sessionPromise;
}

function letterboxParams(
  srcW: number,
  srcH: number,
): { scale: number; padX: number; padY: number } {
  const scale = Math.min(YOLO_INPUT / srcW, YOLO_INPUT / srcH);
  const padX = (YOLO_INPUT - srcW * scale) / 2;
  const padY = (YOLO_INPUT - srcH * scale) / 2;
  return { scale, padX, padY };
}

function toSourceCoords(
  cx: number,
  cy: number,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
  scale: number,
  padX: number,
  padY: number,
): { cx: number; cy: number; width: number; height: number } {
  const x1 = (cx - w / 2 - padX) / scale;
  const y1 = (cy - h / 2 - padY) / scale;
  const x2 = (cx + w / 2 - padX) / scale;
  const y2 = (cy + h / 2 - padY) / scale;
  return {
    cx: Math.min(srcW, Math.max(0, (x1 + x2) / 2)) / srcW,
    cy: Math.min(srcH, Math.max(0, (y1 + y2) / 2)) / srcH,
    width: Math.min(1, Math.max(0, (x2 - x1) / srcW)),
    height: Math.min(1, Math.max(0, (y2 - y1) / srcH)),
  };
}

async function buildInputTensor(
  imagePath: string,
): Promise<{ tensor: ort.Tensor; srcW: number; srcH: number; scale: number; padX: number; padY: number }> {
  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (srcW <= 0 || srcH <= 0) {
    throw new Error(`Invalid image dimensions: ${imagePath}`);
  }

  const { scale, padX, padY } = letterboxParams(srcW, srcH);
  const { data } = await sharp(imagePath)
    .resize(Math.round(srcW * scale), Math.round(srcH * scale), {
      fit: 'inside',
    })
    .extend({
      top: Math.floor(padY),
      bottom: Math.ceil(padY),
      left: Math.floor(padX),
      right: Math.ceil(padX),
      background: { r: 114, g: 114, b: 114 },
    })
    .resize(YOLO_INPUT, YOLO_INPUT)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floatData = new Float32Array(3 * YOLO_INPUT * YOLO_INPUT);
  for (let i = 0; i < YOLO_INPUT * YOLO_INPUT; i++) {
    floatData[i] = data[i * 3] / 255;
    floatData[i + YOLO_INPUT * YOLO_INPUT] = data[i * 3 + 1] / 255;
    floatData[i + 2 * YOLO_INPUT * YOLO_INPUT] = data[i * 3 + 2] / 255;
  }

  const tensor = new ort.Tensor('float32', floatData, [
    1,
    3,
    YOLO_INPUT,
    YOLO_INPUT,
  ]);
  return { tensor, srcW, srcH, scale, padX, padY };
}

function parseYoloOutput(
  output: ort.Tensor,
  srcW: number,
  srcH: number,
  scale: number,
  padX: number,
  padY: number,
  minConfidence: number,
): PersonDetection[] {
  const data = output.data as Float32Array;
  const dims = output.dims;
  const detections: PersonDetection[] = [];

  let channels = 84;
  let anchors = 8400;
  if (dims.length === 3) {
    if (dims[1] === 84) {
      channels = dims[1];
      anchors = dims[2];
    } else if (dims[2] === 84) {
      anchors = dims[1];
      channels = dims[2];
    }
  }

  const channelMajor = dims.length === 3 && dims[1] === channels;

  for (let i = 0; i < anchors; i++) {
    const read = (c: number): number =>
      channelMajor ? data[c * anchors + i] : data[i * channels + c];

    const cx = read(0);
    const cy = read(1);
    const w = read(2);
    const h = read(3);

    let bestScore = 0;
    let bestClass = -1;
    for (let c = 4; c < channels; c++) {
      const score = read(c);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c - 4;
      }
    }

    if (bestClass !== PERSON_CLASS_ID || bestScore < minConfidence) continue;

    const mapped = toSourceCoords(cx, cy, w, h, srcW, srcH, scale, padX, padY);
    detections.push({
      cx: mapped.cx,
      cy: mapped.cy,
      width: mapped.width,
      height: mapped.height,
      confidence: bestScore,
    });
  }

  return detections;
}

/** Detect persons; returns largest person by bbox area or null. */
export async function detectLargestPerson(
  imagePath: string,
  modelPath: string,
  minConfidence: number,
): Promise<PersonDetection | null> {
  const session = await getSession(modelPath);
  const { tensor, srcW, srcH, scale, padX, padY } =
    await buildInputTensor(imagePath);
  const inputName = session.inputNames[0];
  const output = await session.run({ [inputName]: tensor });
  const outTensor = output[session.outputNames[0]];
  const persons = parseYoloOutput(
    outTensor,
    srcW,
    srcH,
    scale,
    padX,
    padY,
    minConfidence,
  );
  if (persons.length === 0) return null;
  return persons.reduce((best, p) =>
    p.width * p.height > best.width * best.height ? p : best,
  );
}

/** @internal test helper */
export function resetDetectorSessionForTests(): void {
  sessionPromise = null;
  sessionModelPath = null;
}
