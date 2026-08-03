const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const staticFfprobe = require("ffprobe-static");

// Verifies what a finished .mov segment actually contains (codec, sample rate, channels,
// duration) rather than assuming it matches obsIngestService.js's ffmpeg command line — the
// audio map there is optional ("0:a:0?"), so a source with no embedded audio silently produces a
// video-only file with no error. Probing the archival .mov (not the .mp4) since it's the one
// that always exists once a segment closes (mp4 does too, but they're identical audio-wise).
async function probeSegment(filePath) {
  const ffprobePath = normalizeFfprobePath();
  const output = await runFfprobe(ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,sample_rate,channels:format=duration",
    "-of", "json",
    filePath,
  ]);

  return parseResult(output);
}

function runFfprobe(ffprobePath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffprobe timed out while reading the segment file."));
    }, 8000);

    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start ffprobe at '${ffprobePath}'. ${error.message}`));
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || "ffprobe could not read the segment file."));
        return;
      }

      resolve(output);
    });
  });
}

function parseResult(json) {
  const root = JSON.parse(json);
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number.parseFloat(root.format?.duration);

  return {
    durationSeconds: Number.isNaN(duration) ? null : duration,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    audioSampleRate: audioStream?.sample_rate ? Number.parseInt(audioStream.sample_rate, 10) : null,
    audioChannels: audioStream?.channels ?? null,
  };
}

function normalizeFfprobePath() {
  const configured = process.env.FFPROBE_PATH;
  if (configured && String(configured).trim()) {
    return String(configured).trim().replace(/^"|"$/g, "");
  }

  if (staticFfprobe.path && fs.existsSync(staticFfprobe.path)) {
    return staticFfprobe.path;
  }

  return os.platform() === "win32" ? "ffprobe.exe" : "ffprobe";
}

module.exports = {
  probeSegment,
};
