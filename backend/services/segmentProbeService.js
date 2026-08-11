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
// A finished segment's contents never change, so its probe result is cacheable for the life of
// the process — keyed on size+mtime so the still-being-written last segment (whose size keeps
// growing) re-probes rather than serving a stale duration. Without this, every listing request
// re-spawned one ffprobe per segment: a 18,000-segment session folder meant 18,000 process spawns
// per request, which saturated the event loop badly enough that unrelated endpoints
// (/api/obs-recording/start among them) stopped responding at all.
const probeCache = new Map();
// Bounds memory on a long-lived process that has listed many sessions. Entries are ~100 bytes,
// so this is a few MB at most, and eviction is oldest-first (Map preserves insertion order).
const PROBE_CACHE_MAX_ENTRIES = 50000;

// Collapses concurrent probes of the *same* file into one child process. The listing endpoint is
// polled by several clients at once (and by a second machine over the LAN), so without this each
// caller independently spawns its own ffprobe for every segment.
const inFlightProbes = new Map();

async function probeSegment(filePath) {
  let cacheKey = null;
  try {
    const stat = await fs.promises.stat(filePath);
    cacheKey = `${filePath}|${stat.size}|${stat.mtimeMs}`;
    const cached = probeCache.get(cacheKey);
    if (cached) return cached;

    const pending = inFlightProbes.get(cacheKey);
    if (pending) return await pending;
  } catch {
    // Unstattable file — fall through and let ffprobe produce the real error.
  }

  const probe = (async () => {
    const ffprobePath = normalizeFfprobePath();
    const output = await runFfprobe(ffprobePath, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,sample_rate,channels:format=duration",
      "-of", "json",
      filePath,
    ]);

    return parseResult(output);
  })();

  if (!cacheKey) return await probe;

  inFlightProbes.set(cacheKey, probe);
  try {
    const result = await probe;

    if (probeCache.size >= PROBE_CACHE_MAX_ENTRIES) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) probeCache.delete(oldest);
    }
    probeCache.set(cacheKey, result);

    return result;
  } finally {
    inFlightProbes.delete(cacheKey);
  }
}

// Runs `tasks` with at most `limit` in flight, preserving input order in the result. Replaces
// bare Promise.all over a whole session folder, which fanned out to one concurrent child process
// per segment with no ceiling.
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
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
  mapWithConcurrency,
};
