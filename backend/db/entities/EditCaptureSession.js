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
    // Wall-clock SMPTE-style HH:MM:SS:FF at the moment capture started — same
    // formatWallClockTimecode helper /api/capture/timecode and RecordingSession already use.
    startTimecode: { type: "varchar", length: 11 },
    frameRate: { type: "int" },
    segmentSeconds: { type: "int" },

    videoCodec: { type: "varchar", length: 64, default: "rawvideo" },
    pixelFormat: { type: "varchar", length: 32, default: "uyvy422" },
    videoWidth: { type: "int", nullable: true },
    videoHeight: { type: "int", nullable: true },

    audioCodec: { type: "varchar", length: 32, nullable: true },
    audioSampleRate: { type: "int", nullable: true },
    audioChannels: { type: "int", nullable: true },

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
