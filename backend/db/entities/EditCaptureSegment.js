const { EntitySchema } = require("typeorm");

// One row per editcapture-NNN.mov/editcapture-proxy-NNN.mp4 segment pair. sizeBytes/proxySizeBytes
// are filled in as soon as reconciliation notices the finished files on disk; durationSeconds/
// videoCodec/audioCodec are ffprobe-verified against the master once probed, same pattern as
// RecordingSegment.
module.exports = new EntitySchema({
  name: "EditCaptureSegment",
  tableName: "edit_capture_segments",
  columns: {
    id: { primary: true, type: "int", generated: true },
    segmentIndex: { type: "int" },
    fileName: { type: "varchar", length: 128 },
    sizeBytes: { type: "bigint", nullable: true },
    proxyFileName: { type: "varchar", length: 128, nullable: true },
    proxySizeBytes: { type: "bigint", nullable: true },
    // Wall-clock SMPTE-style HH:MM:SS:FF this segment actually started — derived from the
    // segment file's own fs.stat().birthtime, not session start + index*segmentSeconds
    // arithmetic, since -use_wallclock_as_timestamps is specifically what keeps segment
    // boundaries tracking true elapsed time even under upstream frame drops.
    startTimecode: { type: "varchar", length: 11, nullable: true },
    durationSeconds: { type: "float", nullable: true },
    videoCodec: { type: "varchar", length: 32, nullable: true },
    audioCodec: { type: "varchar", length: 32, nullable: true },
    probedAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
  },
  relations: {
    session: {
      type: "many-to-one",
      target: "EditCaptureSession",
      inverseSide: "segments",
      onDelete: "CASCADE",
      nullable: false,
      joinColumn: { name: "sessionId" },
    },
  },
});
