const { EntitySchema } = require("typeorm");

// One row per edit-capture session (= one EditCaptures/editcapture* folder). Unlike
// RecordingSession, there's no separate archival/playout codec split and no HLS/backup legs —
// this pipeline writes exactly two synchronized files per segment: an uncompressed rawvideo
// master (frame-accurate edit source) and a small H.264 proxy (what LiveEdit's browser timeline
// actually plays for scrubbing/cutting, since browsers have no decoder for raw UYVY).
module.exports = new EntitySchema({
  name: "EditCaptureSession",
  tableName: "edit_capture_sessions",
  columns: {
    id: { primary: true, type: "int", generated: true },
    folderName: { type: "varchar", length: 128, unique: true },
    startedAt: { type: "datetime" },
    stoppedAt: { type: "datetime", nullable: true },
    // SMPTE HH:MM:SS:FF read from the Timecode System generator at the instant EditCaptureService
    // spawned ffmpeg — the same value written into the .mov's tmcd track and the .wav's BWF stamp,
    // reported back by the C# service rather than re-derived here so all three agree exactly.
    startTimecode: { type: "varchar", length: 11 },
    // "master" when the generator was locked, "wallclock" when it was unreachable and the local
    // clock stood in. Without this a session recorded during a generator outage is
    // indistinguishable after the fact from one that was genuinely locked.
    timecodeSource: { type: "varchar", length: 16, nullable: true },
    frameRate: { type: "int" },
    segmentSeconds: { type: "int" },

    videoCodec: { type: "varchar", length: 64, default: "rawvideo" },
    pixelFormat: { type: "varchar", length: 32, default: "uyvy422" },
    videoWidth: { type: "int", nullable: true },
    videoHeight: { type: "int", nullable: true },

    audioCodec: { type: "varchar", length: 32, nullable: true },
    audioSampleRate: { type: "int", nullable: true },
    audioChannels: { type: "int", nullable: true },
    // Standalone Broadcast WAV holding this session's audio on its own, separate from the video
    // files. One continuous file for the whole session rather than per-segment, so its single
    // bext time_reference stamp stays exact and an NLE can conform the entire session's audio to
    // picture by timecode in one drop. Null when the session was captured without audio.
    audioFileName: { type: "varchar", length: 128, nullable: true },
    // The lip-sync calibration this take was started with, in milliseconds, as reported back by
    // the C# service — fixed for the take's duration even if the live control moves afterwards,
    // so a later sync complaint can be checked against the value actually used.
    audioOffsetMs: { type: "float", nullable: true },

    proxyVideoCodec: { type: "varchar", length: 32, default: "h264" },
    proxyBitrateKbps: { type: "int", nullable: true },

    status: { type: "varchar", length: 16, default: "recording" }, // recording | stopped | crashed
    lastMessage: { type: "text", nullable: true },
  },
  relations: {
    segments: {
      type: "one-to-many",
      target: "EditCaptureSegment",
      inverseSide: "session",
    },
  },
});
