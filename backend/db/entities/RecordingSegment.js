const { EntitySchema } = require("typeorm");

// One row per emerald-NNN.mov/mp4 segment pair. Codec/sample-rate/channel fields here are
// ffprobe-verified against the actual finished .mov file (not assumed from the ffmpeg command
// line) — see obsIngestService.js's reconcileSegments — so this is ground truth even if the
// source drops in and out of having embedded audio across a long session.
module.exports = new EntitySchema({
  name: "RecordingSegment",
  tableName: "recording_segments",
  columns: {
    id: { primary: true, type: "int", generated: true },
    segmentIndex: { type: "int" },
    movFileName: { type: "varchar", length: 128 },
    mp4FileName: { type: "varchar", length: 128 },
    movSizeBytes: { type: "bigint", nullable: true },
    mp4SizeBytes: { type: "bigint", nullable: true },
    // Wall-clock SMPTE-style HH:MM:SS:FF at the moment this segment started — session.startTimecode
    // advanced by segmentIndex * segmentSeconds worth of wall-clock time.
    startTimecode: { type: "varchar", length: 11, nullable: true },
    durationSeconds: { type: "float", nullable: true },
    videoCodec: { type: "varchar", length: 32, nullable: true },
    audioCodec: { type: "varchar", length: 32, nullable: true },
    audioSampleRate: { type: "int", nullable: true },
    audioChannels: { type: "int", nullable: true },
    probedAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
  },
  relations: {
    session: {
      type: "many-to-one",
      target: "RecordingSession",
      inverseSide: "segments",
      onDelete: "CASCADE",
      nullable: false,
      joinColumn: { name: "sessionId" },
    },
  },
  // No DB-level unique constraint on (sessionId, segmentIndex) — db/index.js's upsertSegment
  // already finds-or-creates by that pair at the application level before every insert.
});
