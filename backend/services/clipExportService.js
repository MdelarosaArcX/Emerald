const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { parseTimecodeToMilliseconds } = require("./timecodeFormat");

/**
 * Joins several recorded segments into a single file, carrying a SMPTE start timecode.
 *
 * Uses ffmpeg's concat demuxer with `-c copy`, so no frames are re-encoded: the segments all come
 * from one recording pipeline and therefore already share codec, resolution and rate, which is
 * exactly the condition the concat demuxer requires. That makes an export near-instant and
 * lossless rather than a second generation of H.264.
 *
 * The start timecode is written into the output as a QuickTime `tmcd` track (ffmpeg's -timecode).
 * That is what makes an export self-describing: dropped into LiveEdit — or Resolve, or Premiere —
 * the file reports where it belongs on a timeline instead of starting at zero.
 */

const EXPORTS_DIR_NAME = "Exports";

/** Segments must be joined in recording order, not selection order. */
const SEGMENT_INDEX = /-(\d+)\.mp4$/i;

class ClipExportService {
  constructor(recordingsPath, exportsPath) {
    this.recordingsPath = recordingsPath;
    this.exportsPath = exportsPath || path.join(recordingsPath, EXPORTS_DIR_NAME);
    fs.mkdirSync(this.exportsPath, { recursive: true });
  }

  /**
   * @param {object} request
   * @param {Array<{sessionFolder: string, fileName: string}>} request.clips
   * @param {string} request.startTimecode  HH:MM:SS:FF written into the output's tmcd track.
   * @param {number} [request.frameRate]    Frame base the timecode counts in.
   * @param {string} [request.outputName]
   */
  async export(request) {
    const clips = Array.isArray(request?.clips) ? request.clips : [];
    if (!clips.length) throw new Error("Select at least one clip to export.");

    const frameRate = Number(request.frameRate) || 25;
    const startTimecode = String(request.startTimecode || "").trim();
    if (parseTimecodeToMilliseconds(startTimecode, frameRate) === null) {
      throw new Error("startTimecode must be HH:MM:SS:FF.");
    }

    const sources = this.resolveSources(clips);
    const outputName = this.buildOutputName(request.outputName, sources[0]);
    const outputPath = path.join(this.exportsPath, outputName);

    // The concat demuxer takes a list file rather than the paths as arguments. It lives in the
    // OS temp dir, not alongside the export, so a half-finished export never leaves a stray
    // .txt in a folder the Media Browser lists.
    const listPath = path.join(os.tmpdir(), `emerald-export-${Date.now()}.txt`);
    // Single quotes escaped per the concat demuxer's own quoting rules; backslashes are fine
    // unescaped on Windows because the path is quoted.
    const listBody = sources.map((source) => `file '${source.filePath.replace(/'/g, "'\\''")}'`).join("\n");
    await fs.promises.writeFile(listPath, `${listBody}\n`, "utf8");

    try {
      await this.runFfmpeg(listPath, outputPath, startTimecode);
    } finally {
      await fs.promises.rm(listPath, { force: true }).catch(() => {});
    }

    const stat = await fs.promises.stat(outputPath);

    return {
      fileName: outputName,
      url: `/exports/${encodeURIComponent(outputName)}`,
      size: stat.size,
      startTimecode,
      frameRate,
      clipCount: sources.length,
      sourceFiles: sources.map((source) => source.fileName),
    };
  }

  /**
   * Maps the requested clips onto real files, in recording order.
   *
   * Every name is reduced with path.basename before being joined: these come from an HTTP body
   * and are about to become filesystem paths, so a "../.." in either field would otherwise read
   * outside the recordings root.
   */
  resolveSources(clips) {
    const sources = clips.map((clip) => {
      const sessionFolder = path.basename(String(clip?.sessionFolder || ""));
      const fileName = path.basename(String(clip?.fileName || ""));

      if (!sessionFolder || !fileName || !/\.mp4$/i.test(fileName)) {
        throw new Error(`'${fileName || "(unnamed)"}' is not an exportable clip.`);
      }

      const filePath = path.join(this.recordingsPath, sessionFolder, fileName);
      if (!fs.existsSync(filePath)) throw new Error(`'${fileName}' no longer exists.`);

      const match = SEGMENT_INDEX.exec(fileName);
      return {
        sessionFolder,
        fileName,
        filePath,
        // Sort key: session folder names are timestamps, so ordering by folder then by segment
        // index puts a multi-session selection into true chronological order.
        sortKey: `${sessionFolder}:${String(match ? Number(match[1]) : 0).padStart(6, "0")}`,
      };
    });

    return sources.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  buildOutputName(requested, firstSource) {
    const raw = String(requested || "").trim();
    if (raw) {
      // Filename only, and always .mp4 — the caller supplies a label, not a path.
      const safe = path.basename(raw).replace(/[^\w.\- ]+/g, "_").replace(/\.mp4$/i, "");
      if (safe) return `${safe}.mp4`;
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    return `export-${firstSource.sessionFolder}-${stamp}.mp4`;
  }

  runFfmpeg(listPath, outputPath, startTimecode) {
    const ffmpegPath = normalizeFfmpegPath();

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      // -safe 0 because the list holds absolute Windows paths, which the demuxer otherwise
      // rejects as unsafe.
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      // The tmcd track. Must precede the output; with -c copy it is the one thing ffmpeg still
      // authors itself rather than passing through.
      "-timecode", startTimecode,
      // Concatenated segments each restart their own timestamps at zero; without this the joined
      // output carries backwards jumps at every boundary, which players show as a freeze.
      "-fflags", "+genpts",
      // Puts the moov atom at the front so the result is seekable in a browser immediately —
      // the recorded segments themselves are written without this, which is why they are slow to
      // open for playback.
      "-movflags", "+faststart",
      outputPath,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      let stderr = "";

      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => reject(new Error(`Unable to start FFmpeg at '${ffmpegPath}': ${error.message}`)));
      child.on("exit", (code) => {
        if (code === 0) return resolve();
        fs.rm(outputPath, { force: true }, () => {});
        reject(new Error(stderr.trim().slice(-500) || `FFmpeg exited with code ${code}.`));
      });
    });
  }

  /** Exports already on disk, newest first, for listing in the UI. */
  async list() {
    let files;
    try {
      files = await fs.promises.readdir(this.exportsPath);
    } catch {
      return [];
    }

    const entries = await Promise.all(
      files.filter((name) => /\.mp4$/i.test(name)).map(async (fileName) => {
        const stat = await fs.promises.stat(path.join(this.exportsPath, fileName)).catch(() => null);
        if (!stat) return null;
        return {
          fileName,
          url: `/exports/${encodeURIComponent(fileName)}`,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          lastWriteTime: stat.mtimeMs,
        };
      }),
    );

    return entries
      .filter(Boolean)
      .sort((a, b) => b.lastWriteTime - a.lastWriteTime)
      .map(({ lastWriteTime, ...entry }) => entry);
  }
}

module.exports = {
  ClipExportService,
  EXPORTS_DIR_NAME,
};
