const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function probeObsStream(request) {
  if (!request.inputUrl || !String(request.inputUrl).trim()) {
    throw new Error("OBS recording URL is required before stream stats can be probed.");
  }

  const ffprobePath = normalizeFfprobePath(request.ffmpegPath);
  const output = await runFfprobe(ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate",
    "-of", "json",
    String(request.inputUrl).trim(),
  ]);

  return parseResult(output);
}

function runFfprobe(ffprobePath, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      reject(new Error("ffprobe timed out while reading the OBS stream. Make sure OBS is streaming and the URL is reachable."));
    }, 8000);

    process.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    process.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    process.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start ffprobe at '${ffprobePath}'. ${error.message}`));
    });

    process.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || "ffprobe could not read the stream."));
        return;
      }

      resolve(output);
    });
  });
}

function parseResult(json) {
  const root = JSON.parse(json);
  const stream = Array.isArray(root.streams) && root.streams.length > 0 ? root.streams[0] : {};
  const codec = stream.codec_name || null;
  const width = toInt(stream.width);
  const height = toInt(stream.height);
  const fps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
  const bitrate = toInt(stream.bit_rate) || toInt(root.format?.bit_rate);

  return {
    codec,
    width,
    height,
    fps,
    bitrate,
    bitrateText: formatBitrate(bitrate),
    resolutionText: formatResolution(width, height),
  };
}

function normalizeFfprobePath(configuredPath) {
  if (!configuredPath || !String(configuredPath).trim()) {
    return "ffprobe";
  }

  const trimmedPath = String(configuredPath).trim().replace(/^"|"$/g, "");

  if (fs.existsSync(trimmedPath) && fs.statSync(trimmedPath).isDirectory()) {
    return path.join(trimmedPath, os.platform() === "win32" ? "ffprobe.exe" : "ffprobe");
  }

  const fileName = path.basename(trimmedPath);
  if (fileName.toLowerCase().startsWith("ffmpeg")) {
    const directory = path.dirname(trimmedPath);
    return directory === "." ? (os.platform() === "win32" ? "ffprobe.exe" : "ffprobe") : path.join(directory, os.platform() === "win32" ? "ffprobe.exe" : "ffprobe");
  }

  return trimmedPath;
}

function toInt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseFrameRate(frameRate) {
  if (!frameRate || frameRate === "0/0") {
    return null;
  }

  const parts = String(frameRate).split("/");
  if (parts.length === 2) {
    const numerator = Number.parseFloat(parts[0]);
    const denominator = Number.parseFloat(parts[1]);

    if (!Number.isNaN(numerator) && !Number.isNaN(denominator) && denominator > 0) {
      return numerator / denominator;
    }
  }

  const value = Number.parseFloat(frameRate);
  return Number.isNaN(value) ? null : value;
}

function formatBitrate(bitrate) {
  if (!bitrate) {
    return "Not reported";
  }

  return bitrate >= 1000000
    ? `${trimNumber(bitrate / 1000000)} Mbps`
    : `${trimNumber(bitrate / 1000)} Kbps`;
}

function formatResolution(width, height) {
  if (!width || !height) {
    return "Not reported";
  }

  let quality;
  if (height >= 2160) quality = "2160p";
  else if (height >= 1440) quality = "1440p";
  else if (height >= 1080) quality = "1080p";
  else if (height >= 720) quality = "720p";
  else if (height >= 480) quality = "480p";
  else quality = `${height}p`;

  return `${width} x ${height} (${quality})`;
}

function trimNumber(value) {
  return Number(value.toFixed(2)).toString();
}

module.exports = {
  probeObsStream,
};
