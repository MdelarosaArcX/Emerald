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
    // Wall-clock SMPTE-style HH:MM:SS:FF at the moment recording started — see
    // server.js's formatWallClockTimecode, the same helper /api/capture/timecode uses.
    startTimecode: { type: "varchar", length: 11 },
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
