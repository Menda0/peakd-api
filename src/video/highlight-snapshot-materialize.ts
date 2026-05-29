import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FfmpegBinaries } from '../ffmpeg/ffmpeg.helper';
import { runFfmpeg } from '../ffmpeg/ffmpeg.helper';
import type { HighlightScoredFrame } from './highlight.types';

export async function materializeHighlightSnapshots(
  selections: HighlightScoredFrame[],
  workDir: string,
  processedPath: string,
  bins: FfmpegBinaries,
): Promise<string[]> {
  const snapshotPaths: string[] = [];

  for (let i = 0; i < selections.length; i++) {
    const name = `snapshot_${String(i + 1).padStart(3, '0')}.jpg`;
    const outPath = join(workDir, name);
    snapshotPaths.push(outPath);

    const selection = selections[i];
    if (selection.framePath) {
      await copyFile(selection.framePath, outPath);
      continue;
    }

    await runFfmpeg(
      [
        '-y',
        '-i',
        processedPath,
        '-ss',
        String(selection.t),
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outPath,
      ],
      bins,
    );
  }

  return snapshotPaths;
}
