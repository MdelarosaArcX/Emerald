const { EntitySchema } = require("typeorm");

// One row per recording session (= one Recordings/emerald* folder). Codec/format fields record
// what the ffmpeg command was actually configured to do at the moment recording started
// (obsIngestService.js's args are the source of truth) — RecordingSegment separately records
// what ffprobe verified was *actually* written to disk, once a segment closes, since the two can
// diverge (e.g. a source with no embedded audio silently drops the optional "0:a:0?" map).
module.exports = new EntitySchema({
  name: "RecordingSession",
  tableName: "recording_sessions",
  columns: {
    id: { primary: true, type: "int", generated: true },
    folderName: { type: "varchar", length: 128, unique: true },
    startedAt: { type: "datetime" },
    stoppedAt: { type: "datetime", nullable: true },
    // SMPTE HH:MM:SS:FF read from the Timecode System generator at the instant ffmpeg was
    // spawned — the same value passed to ffmpeg's -timecode (so it lands in the .mov/.mp4 tmcd
    // track) and used for the standalone WAV's BWF stamp.
    startTimecode: { type: "varchar", length: 11 },
    // "master" when the generator was locked, "wallclock" when it was unreachable and the local
    // clock stood in — see timecodeMasterService.js. Lets a session recorded during an outage be
    // identified later rather than passing as genuinely locked.
    timecodeSource: { type: "varchar", length: 16, nullable: true },
    frameRate: { type: "int" },
    inputUrl: { type: "varchar", length: 512 },
    segmentSeconds: { type: "int" },
    broadcastDelaySeconds: { type: "int", default: 0 },

    videoCodecArchival: { type: "varchar", length: 64, default: "prores_ks" },
    videoProfileArchival: { type: "varchar", length: 64, nullable: true },
    pixelFormatArchival: { type: "varchar", length: 32, nullable: true },
    videoCodecPlayout: { type: "varchar", length: 64, default: "h264" },
    videoWidth: { type: "int", nullable: true },
    videoHeight: { type: "int", nullable: true },

    audioCodec: { type: "varchar", length: 32, nullable: true },
    audioBitrateKbps: { type: "int", nullable: true },
    audioSampleRate: { type: "int", nullable: true },
    audioChannels: { type: "int", nullable: true },
    // Null until the first segment has been ffprobed — distinguishes "not checked yet" from
    // "checked and confirmed absent" (a source with no embedded audio, EnableAudio disabled, etc).
    audioPresent: { type: "boolean", nullable: true },
    // The operator's lip-sync calibration in force when this session started, in milliseconds.
    // This pipeline records the UDP stream FfmpegStreamingService produces, and that encoder
    // already applies the offset to its audio input — so the correction is baked into these files
    // rather than applied here, and this column records which value it was.
    audioOffsetMs: { type: "float", nullable: true },
    // Standalone Broadcast WAV carrying this session's audio separately from the video files, one
    // continuous file for the whole session so its bext time_reference stamp conforms the lot to
    // picture by timecode. Note this pipeline's audio arrives already AAC-encoded over the UDP
    // preview stream, so the WAV is sample-accurate for sync but not an archival-quality master —
    // EditCaptureSession.audioFileName is the one lifted straight off SDI as PCM.
    audioFileName: { type: "varchar", length: 128, nullable: true },

    backupPath: { type: "varchar", length: 512, nullable: true },
    backupAvailable: { type: "boolean", default: false },

    status: { type: "varchar", length: 16, default: "recording" }, // recording | stopped | crashed
    lastMessage: { type: "text", nullable: true },
  },
  relations: {
    segments: {
      type: "one-to-many",
      target: "RecordingSegment",
      inverseSide: "session",
    },
  },
});
