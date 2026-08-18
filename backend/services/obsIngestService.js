const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeFfmpegPath } = require("./obsRecordingService");
const { isUdpInputUrl, normalizeInputUrl } = require("./ffmpegInputUrl");
const { parseSizeLimit, getDirectorySize, enforceFolderQuota, trimActiveSessionSegments } = require("./storageQuotaService");
const { logEvent } = require("./eventLogService");
const { formatWallClockTimecode, timeReferenceSamples } = require("./timecodeFormat");
const { probeSegment } = require("./segmentProbeService");
const { createSessionFolder, clamp } = require("./sessionFolder");
const db = require("../db");

const MAINTENANCE_INTERVAL_MS = 5000;

// New emerald-tx-NNN.ts segments land on disk every TX_HLS_SEGMENT_SECONDS (~4s), but if
// emerald-tx-live.m3u8 only got rewritten on the general MAINTENANCE_INTERVAL_MS (5s) tick, TX's
// decode ffmpeg — which can only discover a segment once the playlist *file* lists it, not once
// it exists on disk — would run out of listed segments and stall for however much of that 5s
// window was left, starving the SDI hardware's buffer queue (dropped-frame counts) until the
// next tick caught it up. Refreshing far faster than segments actually close keeps a newly
// finished segment visible to TX within a fraction of a second instead of up to ~5s late.
const TX_PLAYLIST_REFRESH_INTERVAL_MS = 500;

// Ffmpeg's own hls muxer output (emerald-tx.m3u8, written by the third recording output below)
// updates itself by writing a temp file and renaming it over the target. On Windows, that
// rename fails silently once another process (the TX decoder) has the file open for reading,
// so ffmpeg's own playlist gets stuck after its first update and TX never advances past segment
// 0. Node owns this second copy instead: it rewrites the file in place (open+truncate+write, no
// rename) on every maintenance tick, which a concurrent reader picks up fine on Windows.
const TX_LIVE_PLAYLIST_NAME = "emerald-tx-live.m3u8";

// Deliberately independent of the archival segment_time (the 2-minute .mov/.mp4 clip length): the
// HLS muxer doesn't create/write its current .ts file on disk until that segment closes (verified
// empirically — with hls_time equal to the 2-minute archival duration, emerald-tx-000.ts didn't
// exist at all until t=120s, the exact same instant as emerald-001.mov/mp4 appearing). Combined
// with our own "only list *finished* segments" rule in writeTxPlaylist(), that meant nothing was
// ever playable on TX until a full *2* archival segments had elapsed, not 1. Short HLS segments
// (standard practice for live HLS) make the first .ts appear within a few seconds instead.
const TX_HLS_SEGMENT_SECONDS = 4;

// Standalone Broadcast WAV holding the session's audio on its own, alongside the video files.
// Deliberately *not* segmented like the video legs: BWF carries its timecode in a single bext
// "time_reference" field describing the start of the file, so one continuous file per session
// gives an NLE one unambiguous stamp to conform the whole session's audio against picture. A
// segmented WAV would need a correct stamp per file, which the segment muxer can't write.
const AUDIO_FILE_NAME = "emerald-audio.wav";
// 48 kHz is what the SDI embedded audio runs at end to end (see DeltacastSdkService's
// VHD_ASR_48000 extraction and the "-ar 48000" on every audio leg), and time_reference is counted
// in samples, so the stamp and the file have to agree on this rate or the audio lands offset.
const AUDIO_SAMPLE_RATE = 48000;

class ObsIngestService {
  constructor(recordingsPath) {
    this.recordingsPath = recordingsPath;
    this.process = null;
    this.recordingStatus = {
      isRecording: false,
      startedAt: null,
      inputUrl: null,
      outputPattern: null,
      segmentSeconds: 120,
      container: "mp4",
      backupPath: null,
      backupAvailable: false,
      lastMessage: null,
    };
    this.maintenanceHandle = null;
    this.txPlaylistHandle = null;
    this.maintenanceStopped = true;
    this.sessionFolderName = null;
    this.backupDir = null;
    this.copiedBackupSegments = new Set();
    this.dbSessionId = null;
    this.dbKnownSegments = new Set();
    this.dbFrameRate = 25;
    // Tracks whether the underlying FFmpeg OS process has actually exited — distinct from
    // `this.process` being nulled, which can happen before the process finishes flushing its
    // last segment during graceful shutdown (stdin "q" + up to 5s grace period).
    this.ffmpegExited = true;
  }

  // Timecode reads go through these two rather than touching timecodeMaster directly, so this
  // service still works when constructed standalone (tests, the orphan-playlist watcher) without
  // a generator client wired in — server.js assigns this.timecodeMaster at boot.
  timecodeNow() {
    return this.timecodeMaster ? this.timecodeMaster.currentDate() : new Date();
  }

  timecodeFrameRate() {
    return this.timecodeMaster ? this.timecodeMaster.frameRate : 25;
  }

  timecodeSource() {
    return this.timecodeMaster ? this.timecodeMaster.status.source : "wallclock";
  }

  async start(request) {
    if (!request.inputUrl || !String(request.inputUrl).trim()) {
      throw new Error("Recording URL is required.");
    }

    if (this.isProcessRunning()) {
      return { recordingStatus: this.recordingStatus };
    }

    const segmentSeconds = clamp(Number(request.segmentSeconds || 120), 10, 3600);
    // Deliberate gap between "captured" and "eligible to go on air" — e.g. so a producer has a
    // window to catch and cut something before it airs. 0 disables it (segments go live as soon
    // as they're finished, the previous behavior). Independent of segmentSeconds/the 2-minute
    // archival clip length — this only affects what's listed in emerald-tx-live.m3u8, so TX and
    // the Playback Deck stay ~this far behind the actual live capture at all times.
    const broadcastDelaySeconds = clamp(Number(request.broadcastDelaySeconds ?? 0), 0, 3600);
    const ffmpegPath = normalizeFfmpegPath(request.ffmpegPath);
    const inputUrl = normalizeInputUrl(request.inputUrl);
    // One folder per recording session, named after the local time the session started.
    // Segment index (%03d) is driven by the shared input's PTS boundaries, so it stays
    // identical across both outputs even though ProRes encoding and H.264 stream-copy run
    // at different real-time speeds — using "-strftime 1" per output instead would let
    // their filenames drift apart over time.
    const sessionFolderName = createSessionFolder(this.recordingsPath, "emerald", new Date());
    const sessionDir = path.join(this.recordingsPath, sessionFolderName);
    const archivalOutputPattern = path.join(sessionDir, "emerald-%03d.mov");
    const outputPattern = path.join(sessionDir, "emerald-%03d.mp4");
    const txPlaylistPath = path.join(sessionDir, "emerald-tx.m3u8");
    const txSegmentPattern = path.join(sessionDir, "emerald-tx-%03d.ts");
    const audioOutputPath = path.join(sessionDir, AUDIO_FILE_NAME);
    const { backupDir, backupPath } = resolveBackupDir();
    const recordingSizeLimitBytes = parseSizeLimit(process.env.RECORDING_SIZE_LIMIT);
    const storageSizeLimitBytes = parseSizeLimit(process.env.STORAGE_SIZE_LIMIT);

    // Read the generator's clock once, here, and derive both stamps from that single instant so
    // the video's tmcd track and the WAV's bext stamp can't disagree by a frame. Taken as late as
    // possible before spawn — everything above this line is filesystem setup, so the gap between
    // this read and ffmpeg actually opening its input is as small as it can be.
    const frameRate = clamp(Number(request.frameRate || this.timecodeFrameRate()), 1, 240);
    const startInstant = this.timecodeNow();
    const startTimecode = formatWallClockTimecode(startInstant, frameRate);
    const audioTimeReference = timeReferenceSamples(startInstant, AUDIO_SAMPLE_RATE);

    // Every recording writes three synchronized outputs from the same input in one ffmpeg
    // process: a ProRes 422 MOV for archival (hidden from Media Browser), a stream-copied
    // H.264 MP4 for playout (the one shown/played in Media Browser), and an HLS (.ts segments
    // + a live-updating .m3u8) rendition purely for Push On Air. The HLS muxer only appends a
    // segment to the playlist once that segment is actually finished, and only writes
    // #EXT-X-ENDLIST once ffmpeg exits cleanly — so while recording is still active, ffmpeg's
    // own "hls" demuxer can follow this playlist directly and it will naturally wait at the
    // live edge for the next segment instead of us having to poll the filesystem (see
    // DeltacastTxService.cs / server.js's /api/tx/start live-session branch).
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      ...buildUdpInputArgs(inputUrl),
      "-i", inputUrl,

      // Audio (once the Deltacast pipeline has it — CaptureOptions.EnableAudio on the C# side,
      // still off by default) rides in as an AAC track on this same input, so it's re-encoded
      // to AAC here rather than passed through — ProRes archival wants a real codec choice, not
      // whatever the delivery-side bitrate happens to be. "?" makes the map optional so this
      // stays a harmless no-op (exactly today's video-only behavior) until audio actually exists
      // upstream.
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le",
      "-c:a", "aac", "-b:a", "192k",
      // Writes a QuickTime tmcd track carrying the generator's timecode, which is what an NLE
      // reads as the clip's source timecode instead of starting it at 00:00:00:00. Note this is
      // only correct on segment 000: "-reset_timestamps 1" restarts each subsequent segment's
      // timeline at zero, so segments 001+ inherit this same start value rather than their own.
      // The authoritative per-segment timecode is the one reconcileSegments() writes to
      // RecordingSegment.startTimecode from each file's real creation time.
      "-timecode", startTimecode,
      // ProRes 422 at 1080p25 is CPU-heavy enough that this encoder can momentarily fall behind
      // real-time under load from everything else running concurrently (capture, previews, TX) —
      // ffmpeg's default 128-packet safety buffer ("Too many packets buffered for output stream")
      // was tripping and aborting the whole process (mov/mp4/ts share this one ffmpeg instance).
      // A larger queue gives it room to absorb bursts and catch back up instead of hard-failing.
      "-max_muxing_queue_size", "4096",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mov",
      archivalOutputPattern,

      // Video stays a cheap stream-copy, but audio can't: mp4's header (stsd atom) needs a known
      // sample rate up front, and blindly "-c copy"-ing the live AAC track without ever decoding
      // it left ffmpeg unable to determine that before opening the file ("sample rate not set" /
      // "Could not write header"), which aborted this whole process (all three outputs share one
      // ffmpeg invocation). Re-encoding forces ffmpeg to actually decode the stream and know its
      // parameters, exactly like the ProRes leg above already does.
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      // Same tmcd track as the archival leg above, so the playout copy carries the generator's
      // timecode too — same segment-000-only caveat.
      "-timecode", startTimecode,
      // Cheap video copy alongside a real audio encode can drift enough under load to overflow
      // ffmpeg's default 128-packet muxer buffer ("Too many packets buffered for output stream"),
      // aborting the whole process — same failure mode observed on the capture preview relay.
      "-max_muxing_queue_size", "4096",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      "-segment_start_number", "0",
      "-segment_format", "mp4",
      outputPattern,

      // Same fix as the mp4 leg above: blind "-c copy" of the live AAC track left ffmpeg unable
      // to determine its sample rate before opening the HLS output, aborting the whole process.
      // Re-encoding audio (video stays a cheap stream-copy) forces ffmpeg to actually decode it.
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-max_muxing_queue_size", "4096",
      "-f", "hls",
      "-hls_time", String(TX_HLS_SEGMENT_SECONDS),
      "-hls_list_size", "0",
      // "event" tells players (hls.js, Safari) this playlist only ever grows — segments are
      // never removed — so they can safely start at position 0 and keep extending playback as
      // new segments land, instead of defaulting to a live-edge sliding window.
      "-hls_playlist_type", "event",
      "-hls_flags", "independent_segments+append_list",
      "-hls_segment_filename", txSegmentPattern,
      txPlaylistPath,

      // Output 4: the session's audio on its own, as a Broadcast WAV, so audio and video can be
      // handled as separate files downstream and re-conformed by timecode rather than being
      // locked together in one container.
      //
      // "-write_bext 1" plus "time_reference" (samples since local midnight at the moment
      // recording started) is the pair an NLE reads to place this file against picture
      // automatically. PCM rather than MP3 deliberately: MP3 is lossy and its encoder/decoder
      // delay introduces a variable offset that defeats frame-accurate conform, which is the
      // whole reason this file exists.
      //
      // Caveat worth knowing: this pipeline's audio arrives already AAC-encoded over the UDP
      // preview stream from FfmpegStreamingService, so this is a decode of lossy audio —
      // sample-accurate for sync, but not an archival master. The edit-capture pipeline's WAV is
      // lifted straight off SDI as PCM by VHD_SlotExtractAudio and is the one to use for quality.
      "-map", "0:a:0?",
      "-c:a", "pcm_s16le",
      "-ar", String(AUDIO_SAMPLE_RATE),
      // Plain WAV tops out at 4GB (32-bit size fields); at 48kHz/16-bit/stereo that's ~6 hours,
      // which a long session can genuinely exceed. "auto" keeps writing a normal WAV until the
      // file actually needs RF64's 64-bit sizes, so short sessions stay maximally compatible.
      "-rf64", "auto",
      "-write_bext", "1",
      "-metadata", `time_reference=${audioTimeReference}`,
      audioOutputPath,
    ];

    try {
      this.process = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.process = null;
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: error.message };
      throw new Error(`Unable to start FFmpeg at '${ffmpegPath}'. Use the full path to ffmpeg.exe or a folder that contains ffmpeg.exe.`);
    }

    const startedProcess = this.process;

    // Throttled: a degraded/corrupted input signal can make ffmpeg's decoder emit a continuous
    // flood of stderr lines (observed: thousands/sec of "non-existing PPS referenced" /
    // "decode_slice_header error" while the incoming stream was unstable) — reacting to every
    // single chunk with an object-spread state update was enough to starve the whole Node event
    // loop, making even trivial synchronous routes like /api/obs-recording/status take 10+
    // seconds to answer. The underlying signal issue is real and still worth investigating, but
    // this process shouldn't fall over just relaying its last error message to the UI.
    let lastStderrUpdateAt = 0;
    const STDERR_UPDATE_THROTTLE_MS = 250;
    startedProcess.stderr.on("data", (chunk) => {
      const now = Date.now();
      if (now - lastStderrUpdateAt < STDERR_UPDATE_THROTTLE_MS) return;

      const message = chunk.toString().trim();
      if (message) {
        lastStderrUpdateAt = now;
        this.recordingStatus = { ...this.recordingStatus, lastMessage: message };
      }
    });

    this.ffmpegExited = false;

    startedProcess.on("error", (error) => {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, startedAt: null, lastMessage: error.message };
      if (this.process === startedProcess) {
        this.process = null;
      }
      this.ffmpegExited = true;
      this.stopMaintenance({ finalSync: true });
      db.recordSessionStop(sessionFolderName, { stoppedAt: new Date(), status: "crashed", lastMessage: error.message })
        .catch((dbError) => console.error("Unable to record session stop in database:", dbError.message));
    });

    startedProcess.on("exit", (code, signal) => {
      const detail = explainFfmpegMessage(this.recordingStatus.lastMessage || "FFmpeg stopped.", inputUrl);
      this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: detail };
      this.process = null;
      this.ffmpegExited = true;
      this.stopMaintenance({ finalSync: true });
      db.recordSessionStop(sessionFolderName, {
        stoppedAt: new Date(),
        status: code === 0 || signal === null ? "stopped" : "crashed",
        lastMessage: detail,
      }).catch((dbError) => console.error("Unable to record session stop in database:", dbError.message));
    });

    this.recordingStatus = {
      isRecording: true,
      startedAt: new Date().toISOString(),
      inputUrl,
      outputPattern,
      archivalOutputPattern,
      txPlaylistPath,
      segmentSeconds,
      broadcastDelaySeconds,
      container: "mp4",
      backupPath,
      backupAvailable: Boolean(backupDir),
      lastMessage: backupDir ? null : `Backup drive '${backupPath}' is not available — recording locally only.`,
    };

    this.sessionFolderName = sessionFolderName;
    this.recordingSizeLimitBytes = recordingSizeLimitBytes;
    this.storageSizeLimitBytes = storageSizeLimitBytes;
    this.broadcastDelaySeconds = broadcastDelaySeconds;
    this.copiedBackupSegments = new Set();
    this.dbSessionId = null;
    this.dbKnownSegments = new Set();
    this.dbFrameRate = frameRate;

    if (backupDir) {
      this.backupDir = backupDir;
    }

    // Quota enforcement always runs (it needs no backup drive); backup mirroring inside
    // the tick is skipped when backupDir isn't set.
    enforceFolderQuota(this.recordingsPath, this.recordingSizeLimitBytes, this.sessionFolderName);
    this.maintenanceStopped = false;
    this.scheduleMaintenance();
    this.scheduleTxPlaylistUpdate();

    // Codec/format details here reflect what the ffmpeg command above is actually configured to
    // do — RecordingSegment rows separately record what ffprobe verifies was really written to
    // each finished .mov, since the "0:a:0?" audio map is optional and silently no-ops when the
    // source has no embedded audio.
    db.recordSessionStart({
      folderName: sessionFolderName,
      startedAt: new Date(),
      // The exact same value handed to ffmpeg's -timecode above, not a second reading taken a few
      // milliseconds later — the DB and the file's tmcd track have to agree to be useful.
      startTimecode,
      timecodeSource: this.timecodeSource(),
      frameRate: this.dbFrameRate,
      inputUrl,
      segmentSeconds,
      broadcastDelaySeconds,
      videoCodecArchival: "prores_ks",
      videoProfileArchival: "ProRes 422 (profile 2)",
      pixelFormatArchival: "yuv422p10le",
      videoCodecPlayout: "h264 (stream copy)",
      audioCodec: "aac",
      audioBitrateKbps: 192,
      audioFileName: AUDIO_FILE_NAME,
      // The calibration already baked into this recording's audio by the upstream preview
      // encoder — this pipeline records that encoder's UDP output, so it inherits the correction
      // rather than applying one, and this just records which value was in force. Resolved
      // asynchronously so an unreachable capture service can't delay or fail starting a
      // recording; a null here means "unknown", not "zero".
      audioOffsetMs: request.audioOffsetMs ?? null,
      backupPath,
      backupAvailable: Boolean(backupDir),
    })
      .then((session) => { this.dbSessionId = session.id; })
      .catch((error) => console.error("Unable to record session in database:", error.message));

    await waitForFfmpegStartup(startedProcess, ffmpegPath, () => this.recordingStatus.lastMessage, inputUrl);

    logEvent(`Recording started — folder=${sessionFolderName}, segmentSeconds=${segmentSeconds}, broadcastDelaySeconds=${broadcastDelaySeconds}`, "info", "Recorder");
    // Companion lines matching the fixed archival/proxy pipeline this ffmpeg command always runs
    // (see the "-c:v prores_ks"/"-segment_format mov" and "-c:v copy"/"-segment_format mp4" legs
    // above) — not derived from the UI's format dropdowns, which don't actually control this.
    logEvent("Capture session started.", "info", "Recorder");
    logEvent("High-res recording -> ProRes 422 MOV.", "info", "Recorder");
    logEvent("Proxy recording -> H264 MP4.", "info", "Recorder");

    return { recordingStatus: this.recordingStatus };
  }

  stop() {
    if (!this.process) {
      this.recordingStatus = { ...this.recordingStatus, isRecording: false };
      return { recordingStatus: this.recordingStatus };
    }

    const processToStop = this.process;

    if (!processToStop.killed) {
      try {
        processToStop.stdin.write("q\n");
      } catch {
        // Fall back to terminating below.
      }

      setTimeout(() => {
        if (this.process === processToStop && !processToStop.killed) {
          processToStop.kill("SIGKILL");
        }
      }, 5000).unref();
    }

    // this.process is cleared here for UI/API purposes (recordingStatus.isRecording), but the
    // backup sync keys off this.ffmpegExited instead — the OS process may still be flushing its
    // last segment during graceful shutdown, and the "exit" handler above finalizes the backup
    // copy only once it has actually terminated.
    this.process = null;
    this.recordingStatus = { ...this.recordingStatus, isRecording: false, lastMessage: "Recording stopped." };
    return { recordingStatus: this.recordingStatus };
  }

  isProcessRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null);
  }

  // setInterval does not wait for an async callback to finish before firing the next one — if a
  // single runMaintenance() pass (backup copyFile of multi-GB .mov segments, directory scans)
  // ever takes longer than MAINTENANCE_INTERVAL_MS, invocations start overlapping and piling up
  // with no backpressure, each holding its own in-flight buffers/arrays in memory. Under
  // sustained load that's an unbounded leak, not just a slow tick — this crashed the process with
  // a V8 heap-limit OOM once TX_PLAYLIST_REFRESH_INTERVAL_MS (500ms) made the equivalent overlap
  // far more likely for updateLiveTxPlaylist(). Scheduling the *next* run only after the current
  // one settles (via setTimeout, not setInterval) makes overlap structurally impossible.
  scheduleMaintenance() {
    this.maintenanceHandle = setTimeout(async () => {
      if (this.maintenanceStopped) return;

      try {
        await this.runMaintenance();
      } finally {
        if (!this.maintenanceStopped) {
          this.scheduleMaintenance();
        }
      }
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceHandle.unref?.();
  }

  scheduleTxPlaylistUpdate() {
    this.txPlaylistHandle = setTimeout(async () => {
      if (this.maintenanceStopped) return;

      try {
        await this.updateLiveTxPlaylist();
      } finally {
        if (!this.maintenanceStopped) {
          this.scheduleTxPlaylistUpdate();
        }
      }
    }, TX_PLAYLIST_REFRESH_INTERVAL_MS);
    this.txPlaylistHandle.unref?.();
  }

  // Runs on every maintenance tick while a session is active (and once more on final
  // shutdown): mirrors finished segments to the backup drive, then enforces both size
  // quotas so overflow is trimmed continuously instead of only at session boundaries.
  async runMaintenance() {
    await this.updateLiveTxPlaylist();
    await this.reconcileSegments();

    if (this.backupDir) {
      await this.syncBackupSegments();
    }

    await enforceFolderQuota(this.recordingsPath, this.recordingSizeLimitBytes, this.sessionFolderName);

    // Evicting other, finished sessions above may not be enough — a single long recording can
    // exceed the whole-folder limit entirely on its own, with no other sessions left to delete.
    // Recording must never stop to enforce the quota, so once nothing else is left to evict, fall
    // back to trimming the active session's own oldest *finished* segments (never the one FFmpeg
    // is still writing) until the folder is back under the limit.
    if (this.recordingSizeLimitBytes && this.sessionFolderName) {
      const totalBytes = await getDirectorySize(this.recordingsPath);

      if (totalBytes > this.recordingSizeLimitBytes) {
        const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);
        await trimActiveSessionSegments(sessionDir, this.recordingSizeLimitBytes, totalBytes);
        // Re-sync immediately so the TX playlist never references a just-deleted .ts segment in
        // the window before the next maintenance tick.
        await this.updateLiveTxPlaylist();
      }
    }

    if (this.backupDir) {
      await enforceFolderQuota(this.backupDir, this.storageSizeLimitBytes, this.sessionFolderName);

      // Same gap as RECORDING_SIZE_LIMIT above, same fix: evicting other finished sessions'
      // backup copies alone isn't enough once a single long recording's own mirrored ProRes
      // segments exceed the backup drive's limit by themselves. Trim its oldest already-copied
      // (and, per syncBackupSegments, already-finished) segments instead of ever pausing the
      // backup sync or the recording itself.
      if (this.storageSizeLimitBytes && this.sessionFolderName) {
        const backupTotalBytes = await getDirectorySize(this.backupDir);

        if (backupTotalBytes > this.storageSizeLimitBytes) {
          const backupSessionDir = path.join(this.backupDir, this.sessionFolderName);
          await trimActiveSessionSegments(backupSessionDir, this.storageSizeLimitBytes, backupTotalBytes);
        }
      }
    }
  }

  // Records any emerald-NNN.mov segment that's actually finished (same "last one is still being
  // written" rule as syncBackupSegments) and isn't in the database yet — a plain size/filename
  // row immediately, then kicks off an ffprobe of the .mov in the background to fill in verified
  // codec/duration/audio details once it completes. Runs every maintenance tick regardless of
  // whether a backup drive is configured, unlike syncBackupSegments.
  async reconcileSegments() {
    if (!this.dbSessionId || !this.sessionFolderName) return;

    const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      return;
    }

    const pattern = /^emerald-(\d+)\.mov$/;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    const finishedSegments = this.ffmpegExited ? segments : segments.slice(0, -1);
    if (finishedSegments.length === 0) return;

    for (const segment of finishedSegments) {
      if (this.dbKnownSegments.has(segment.index)) continue;

      const movPath = path.join(sessionDir, segment.fileName);
      const mp4FileName = segment.fileName.replace(/\.mov$/, ".mp4");
      const mp4Path = path.join(sessionDir, mp4FileName);

      let movStat;
      try {
        movStat = await fs.promises.stat(movPath);
      } catch {
        continue;
      }

      let mp4Size = null;
      try {
        mp4Size = (await fs.promises.stat(mp4Path)).size;
      } catch {
        // mp4 leg can finish a beat later than mov — picked up on a later tick.
      }

      // Derived from the segment file's own birthtime rather than the old
      // sessionStart + index*segmentSeconds arithmetic, which assumed every segment came out at
      // exactly its nominal length and so drifted away from reality whenever a frame was dropped
      // upstream. This is the same reasoning the edit-capture path already documents at
      // editCaptureService.js's own reconciliation. birthtime comes from this machine's clock, so
      // it goes through timecodeAtLocalInstant to be expressed on the generator's.
      const startTimecode = this.timecodeMaster
        ? this.timecodeMaster.timecodeAtLocalInstant(movStat.birthtime)
        : formatWallClockTimecode(movStat.birthtime, this.dbFrameRate);

      let saved;
      try {
        saved = await db.upsertSegment(this.dbSessionId, {
          segmentIndex: segment.index,
          movFileName: segment.fileName,
          mp4FileName,
          movSizeBytes: movStat.size,
          mp4SizeBytes: mp4Size,
          startTimecode,
          createdAt: movStat.birthtime,
        });
      } catch (error) {
        console.error(`Unable to record segment '${segment.fileName}' in database:`, error.message);
        continue;
      }

      this.dbKnownSegments.add(segment.index);

      logEvent(`Recording segment created. Duration=${segmentSeconds} sec`, "info", "Recorder");
      logEvent(`${segment.fileName} created`, "info", "FileWriter");
      // mp4Size can still be null here (see the catch above) if the proxy leg hasn't finished
      // closing yet — this index won't be revisited (dbKnownSegments guards against that), so a
      // "created" line for it just doesn't fire this run rather than firing early/falsely.
      if (mp4Size != null) {
        logEvent(`${mp4FileName} created`, "info", "FileWriter");
      }

      probeSegment(movPath)
        .then((probed) => db.updateSegmentProbe(saved.id, probed))
        .catch((error) => console.error(`Unable to probe segment '${segment.fileName}':`, error.message));
    }
  }

  // Rewrites emerald-tx-live.m3u8 from whatever emerald-tx-NNN.ts segments exist on disk. See
  // the comment on TX_LIVE_PLAYLIST_NAME for why this exists instead of just using ffmpeg's own
  // hls muxer output directly.
  async updateLiveTxPlaylist() {
    if (!this.sessionFolderName) return;

    const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);

    try {
      await writeTxPlaylist(sessionDir, TX_HLS_SEGMENT_SECONDS, this.ffmpegExited, this.broadcastDelaySeconds || 0);
    } catch (error) {
      this.recordingStatus = { ...this.recordingStatus, lastMessage: `Unable to update TX playlist: ${error.message}` };
    }
  }

  // Mirrors completed ProRes 422 segments to the backup drive, preserving the same
  // per-session folder layout as the recordings drive. Runs on a poll instead of fs.watch
  // since the backup target is often a removable drive that can be unmounted mid-recording.
  async syncBackupSegments() {
    if (!this.backupDir || !this.sessionFolderName) return;

    const sessionDir = path.join(this.recordingsPath, this.sessionFolderName);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      return;
    }

    const pattern = /^emerald-(\d+)\.mov$/;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    // The last (highest-index) segment is still being written by FFmpeg — only mirror finished ones.
    const finishedSegments = this.ffmpegExited ? segments : segments.slice(0, -1);

    if (finishedSegments.length === 0) return;

    const backupSessionDir = path.join(this.backupDir, this.sessionFolderName);
    try {
      await fs.promises.mkdir(backupSessionDir, { recursive: true });
    } catch (error) {
      this.recordingStatus = { ...this.recordingStatus, lastMessage: `Unable to create backup folder: ${error.message}` };
      return;
    }

    for (const segment of finishedSegments) {
      if (this.copiedBackupSegments.has(segment.fileName)) continue;

      try {
        await fs.promises.copyFile(
          path.join(sessionDir, segment.fileName),
          path.join(backupSessionDir, segment.fileName),
        );
        this.copiedBackupSegments.add(segment.fileName);
      } catch (error) {
        this.recordingStatus = { ...this.recordingStatus, lastMessage: `Backup copy failed for '${segment.fileName}': ${error.message}` };
      }
    }
  }

  stopMaintenance({ finalSync = false } = {}) {
    this.maintenanceStopped = true;

    if (this.maintenanceHandle) {
      clearTimeout(this.maintenanceHandle);
      this.maintenanceHandle = null;
    }

    if (this.txPlaylistHandle) {
      clearTimeout(this.txPlaylistHandle);
      this.txPlaylistHandle = null;
    }

    if (finalSync) {
      this.runMaintenance().finally(() => {
        this.backupDir = null;
      });
    }
  }
}

module.exports = {
  ObsIngestService,
  TX_LIVE_PLAYLIST_NAME,
  startOrphanTxPlaylistWatcher,
  // Exported so the storage quota watchdog can find the backup volume without a recording being
  // in progress — it needs to police that volume whether or not this service has a session open.
  resolveBackupDir,
};

// Builds emerald-tx-live.m3u8's content from whatever emerald-tx-NNN.ts segments exist in
// `sessionDir`, then writes it in place (no rename — see the comment on TX_LIVE_PLAYLIST_NAME).
// Returns false if there are no eligible segments to write yet.
async function writeTxPlaylist(sessionDir, targetDuration, ffmpegExited, delaySeconds = 0) {
  const files = await fs.promises.readdir(sessionDir);

  const pattern = /^emerald-tx-(\d+)\.ts$/;
  const segments = files
    .map((fileName) => {
      const match = pattern.exec(fileName);
      return match ? { fileName, index: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  // Ffmpeg's hls muxer doesn't finalize a .ts segment until it rotates to the next one —
  // the same rule already applied to the mov/mp4 outputs in syncBackupSegments.
  const finishedSegments = ffmpegExited ? segments : segments.slice(0, -1);
  if (finishedSegments.length === 0) return false;

  // Broadcast delay: while still actively recording, hold each segment out of the live playlist
  // until it's at least `delaySeconds` old (by file mtime, so this is robust to any timing
  // irregularities rather than assuming exactly targetDuration per segment) — a deliberate,
  // rolling gap between "captured" and "eligible to air", e.g. so a producer has a window to
  // catch and cut something before it goes out. Once recording stops there's nothing left to
  // review, so release everything immediately instead of trickling out the last delaySeconds'
  // worth after the operator has already stopped.
  let eligibleSegments = finishedSegments;
  if (delaySeconds > 0 && !ffmpegExited) {
    const cutoffMs = Date.now() - delaySeconds * 1000;
    const withMtimes = await Promise.all(finishedSegments.map(async (segment) => {
      try {
        const stat = await fs.promises.stat(path.join(sessionDir, segment.fileName));
        return { ...segment, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }));
    eligibleSegments = withMtimes.filter((segment) => segment && segment.mtimeMs <= cutoffMs);
  }

  if (eligibleSegments.length === 0) return false;

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    // The storage quota's rolling-buffer trim (trimActiveSessionSegments) can delete the earliest
    // .ts segments out from under a still-recording session, so the first listed segment's index
    // is no longer reliably 0 — MEDIA-SEQUENCE must track whatever segment is actually first here,
    // per the HLS spec, or players/ffmpeg's hls demuxer will mis-map segment numbering.
    `#EXT-X-MEDIA-SEQUENCE:${eligibleSegments[0].index}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    ...eligibleSegments.flatMap((segment) => [`#EXTINF:${targetDuration.toFixed(6)},`, segment.fileName]),
  ];

  if (ffmpegExited) {
    lines.push("#EXT-X-ENDLIST");
  }

  await fs.promises.writeFile(path.join(sessionDir, TX_LIVE_PLAYLIST_NAME), lines.join("\n") + "\n", "utf8");
  return true;
}

// A session's emerald-tx-live.m3u8 only gets kept in sync with its .ts segments (and eventually
// gets its #EXT-X-ENDLIST) while an ObsIngestService instance owns it — see
// updateLiveTxPlaylist(). If the backend restarts or crashes mid-recording, the underlying
// ffmpeg process can be left running as an orphan (still writing new segments) with nobody
// updating its playlist, or the recording can simply have ended with the file never finalized.
// Either way, both the browser preview (hls.js) and the hardware TX decoder (DeltacastCaptureService,
// which reads this exact file straight off disk) are left waiting forever for a playlist update
// that will never come from the process that used to send it.
//
// This runs continuously (not just once at startup) and is intentionally ownership-agnostic: for
// every session folder `isOwnedActiveSession` says isn't the current in-process recording, it
// rewrites the live playlist from whatever .ts segments actually exist on disk, using the newest
// segment's mtime — not process identity — to decide whether the session is still growing (keep
// following it, no ENDLIST) or has gone idle long enough to be considered finished (finalize with
// ENDLIST). A one-shot startup-only check would miss the case where the orphaned recording is
// still actively producing new segments after the crash/restart.
const ORPHAN_PLAYLIST_STALE_MS = 15 * 60 * 1000;

function startOrphanTxPlaylistWatcher(recordingsPath, isOwnedActiveSession) {
  const run = () => reconcileUnownedTxPlaylists(recordingsPath, isOwnedActiveSession).catch(() => {});

  run();
  const handle = setInterval(run, MAINTENANCE_INTERVAL_MS);
  handle.unref?.();
  return handle;
}

async function reconcileUnownedTxPlaylists(recordingsPath, isOwnedActiveSession) {
  let entries;
  try {
    entries = await fs.promises.readdir(recordingsPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isOwnedActiveSession(entry.name)) continue;

    const sessionDir = path.join(recordingsPath, entry.name);
    let files;
    try {
      files = await fs.promises.readdir(sessionDir);
    } catch {
      continue;
    }

    const pattern = /^emerald-tx-(\d+)\.ts$/;
    const segments = files
      .map((fileName) => {
        const match = pattern.exec(fileName);
        return match ? { fileName, index: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (segments.length === 0) continue;

    let newestMtimeMs;
    try {
      newestMtimeMs = (await fs.promises.stat(path.join(sessionDir, segments[segments.length - 1].fileName))).mtimeMs;
    } catch {
      continue;
    }

    const ffmpegExited = Date.now() - newestMtimeMs > ORPHAN_PLAYLIST_STALE_MS;

    if (ffmpegExited) {
      // Don't keep rewriting an already-finalized playlist on every tick once it's done.
      try {
        const existing = await fs.promises.readFile(path.join(sessionDir, TX_LIVE_PLAYLIST_NAME), "utf8");
        if (existing.includes("#EXT-X-ENDLIST")) continue;
      } catch {
        // No playlist yet — fall through and write the finalized one below.
      }
    }

    await writeTxPlaylist(sessionDir, TX_HLS_SEGMENT_SECONDS, ffmpegExited).catch(() => {});
  }
}

// Backup path is a backend-only setting (EMERALD_BACKUP_PATH in backend/.env) — it is never
// accepted from the frontend request body.
function resolveBackupDir() {
  const backupPath = String(process.env.EMERALD_BACKUP_PATH || "E:\\").trim();

  try {
    // fs.mkdirSync throws EPERM on a drive root (e.g. "E:\") even with recursive:true,
    // since the root always exists and can't be "created" — only mkdir when it's missing.
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(backupPath, { recursive: true });
    }
    fs.accessSync(backupPath, fs.constants.W_OK);
    return { backupDir: backupPath, backupPath };
  } catch {
    // Backup drive not present/writable (e.g. removable drive unplugged) — record locally only.
    return { backupDir: null, backupPath };
  }
}

function waitForFfmpegStartup(process, ffmpegPath, getLastMessage, inputUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      process.off("error", onError);
      process.off("exit", onExit);
    };

    const fail = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const onError = (error) => {
      fail(formatFfmpegStartError(ffmpegPath, error));
    };

    const onExit = (code, signal) => {
      const detail = explainFfmpegMessage(getLastMessage?.(), inputUrl);
      fail(`FFmpeg stopped before it could start${formatExit(code, signal)}.${detail ? ` ${detail}` : " Check the FFmpeg path and stream URL."}`);
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    }, 750);

    process.once("error", onError);
    process.once("exit", onExit);
  });
}

function formatFfmpegStartError(ffmpegPath, error) {
  if (error?.code === "ENOENT") {
    return `Unable to start FFmpeg at '${ffmpegPath}'. FFmpeg was not found. Install FFmpeg and add it to PATH, set FFMPEG_PATH in backend/.env, or paste the full path to ffmpeg.exe in the FFmpeg Path field.`;
  }

  return `Unable to start FFmpeg at '${ffmpegPath}'. ${error?.message || "Check the FFmpeg path."}`;
}

function formatExit(code, signal) {
  const parts = [];

  if (code !== null) {
    const signedCode = code > 2147483647 ? code - 4294967296 : code;
    parts.push(`exit code ${signedCode}${signedCode !== code ? ` (${code})` : ""}`);
  }

  if (signal) {
    parts.push(signal);
  }

  return parts.length ? ` (${parts.join(", ")})` : "";
}

function explainFfmpegMessage(message, inputUrl) {
  if (message && message.toLowerCase().includes("error opening input")) {
    if (String(inputUrl || "").trim().toLowerCase().startsWith("udp://")) {
      return `${message} For a local UDP ingest from Deltacast, use udp://0.0.0.0:5000 or udp://@:5000 so FFmpeg listens on the port. Do not use udp://127.0.0.1:5000 unless another process is sending unicast UDP to that exact address.`;
    }

    return `${message} Check that the stream is streaming to rtmp://127.0.0.1:1935/live with stream key emerald, then start recording again.`;
  }

  if (message && /non-existing PPS|decode_slice_header error|no frame!/i.test(message)) {
    if (String(inputUrl || "").trim().toLowerCase().startsWith("udp://")) {
      return `${message} The UDP sender is likely not repeating H.264 SPS/PPS often enough. In your C# Deltacast encoder, make sure SPS/PPS are inserted at the start of the stream and repeated on each keyframe.`;
    }
  }

  return message;
}

function buildUdpInputArgs(inputUrl) {
  if (!isUdpInputUrl(inputUrl)) {
    return [];
  }

  // Declare MPEG-TS so FFmpeg skips format probing — the C# Deltacast bridge
  // always outputs H.264 MPEG-TS, so probing adds latency with no benefit.
  return [
    "-f", "mpegts",
    "-fflags", "+discardcorrupt",
    "-max_delay", "200000",
  ];
}
