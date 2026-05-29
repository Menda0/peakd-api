import { spawn } from 'node:child_process';

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

function formatSpawnError(bin: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return (
      `Cannot run "${bin}" (not found on PATH). Install ffmpeg (e.g. brew install ffmpeg) ` +
      `or set FFMPEG_PATH and FFPROBE_PATH in .env to the full paths ` +
      `(Apple Silicon Homebrew: /opt/homebrew/bin/ffmpeg and /opt/homebrew/bin/ffprobe).`
    );
  }
  return err.message || String(err);
}

function runCmd(
  bin: string,
  args: string[],
  label: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      const errno = err as NodeJS.ErrnoException;
      reject(new Error(formatSpawnError(bin, errno)));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${label} exited ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`,
          ),
        );
      }
    });
  });
}

export interface FfprobeResult {
  durationSec: number;
  hasAudio: boolean;
  videoWidth: number;
  videoHeight: number;
}

export async function ffprobeJson(
  videoPath: string,
  bins: FfmpegBinaries,
): Promise<FfprobeResult> {
  const { stdout } = await runCmd(
    bins.ffprobe,
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ],
    'ffprobe',
  );

  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };

  const durationRaw = data.format?.duration;
  const durationSec =
    durationRaw !== undefined ? Number.parseFloat(durationRaw) : NaN;

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Could not read positive duration from ffprobe output');
  }

  const videoStream = data.streams?.find((s) => s.codec_type === 'video');
  const videoWidth = videoStream?.width ?? 0;
  const videoHeight = videoStream?.height ?? 0;

  const hasAudio =
    data.streams?.some((s) => s.codec_type === 'audio') ?? false;

  return { durationSec, hasAudio, videoWidth, videoHeight };
}

export async function runFfmpeg(
  args: string[],
  bins: FfmpegBinaries,
): Promise<void> {
  await runCmd(bins.ffmpeg, args, 'ffmpeg');
}
