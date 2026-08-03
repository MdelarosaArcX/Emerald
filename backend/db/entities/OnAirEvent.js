const { EntitySchema } = require("typeorm");

// One row per "Push On Air" session — start/stop wall-clock timecode plus the frame counters
// DeltacastTxService.cs reports at stop time, so there's a durable record of what actually aired
// and when, independent of the in-memory TxStatus that resets on every backend restart.
module.exports = new EntitySchema({
  name: "OnAirEvent",
  tableName: "onair_events",
  columns: {
    id: { primary: true, type: "int", generated: true },
    startedAt: { type: "datetime" },
    stoppedAt: { type: "datetime", nullable: true },
    startTimecode: { type: "varchar", length: 11 },
    sourceType: { type: "varchar", length: 24 }, // live | clip | finished-session
    sourceFolder: { type: "varchar", length: 128, nullable: true },
    sourceFile: { type: "varchar", length: 128, nullable: true },
    broadcastDelaySeconds: { type: "int", nullable: true },
    framesSent: { type: "int", nullable: true },
    framesDropped: { type: "int", nullable: true },
    lastMessage: { type: "text", nullable: true },
  },
});
