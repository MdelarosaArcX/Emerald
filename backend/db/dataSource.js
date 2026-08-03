const path = require("node:path");
const fs = require("node:fs");
require("reflect-metadata");
const { DataSource } = require("typeorm");
const RecordingSession = require("./entities/RecordingSession");
const RecordingSegment = require("./entities/RecordingSegment");
const OnAirEvent = require("./entities/OnAirEvent");
const EditCaptureSession = require("./entities/EditCaptureSession");
const EditCaptureSegment = require("./entities/EditCaptureSegment");

const entities = [RecordingSession, RecordingSegment, OnAirEvent, EditCaptureSession, EditCaptureSegment];

// DATABASE_TYPE picks the engine: "sqlite" (default — zero-config, a single local file, no
// server to install/run, matches this app's single-workstation deployment) or "mysql" (point it
// at an existing server via DATABASE_HOST/PORT/USER/PASSWORD/NAME for a multi-machine setup).
function buildDataSourceOptions(env = process.env) {
  const type = String(env.DATABASE_TYPE || "sqlite").trim().toLowerCase();

  if (type === "mysql") {
    return {
      type: "mysql",
      host: env.DATABASE_HOST || "127.0.0.1",
      port: Number(env.DATABASE_PORT || 3306),
      username: env.DATABASE_USER || "root",
      password: env.DATABASE_PASSWORD || "",
      database: env.DATABASE_NAME || "emerald",
      entities,
      // Fine for a single-app-owns-the-schema setup like this one — no separate migration
      // workflow to maintain. Switch to migrations if this database ever gets a second writer.
      synchronize: true,
      logging: env.DATABASE_LOG === "1" ? ["error", "warn"] : ["error"],
    };
  }

  if (type !== "sqlite") {
    throw new Error(`Unsupported DATABASE_TYPE '${type}'. Use 'sqlite' or 'mysql'.`);
  }

  const databasePath = path.resolve(env.DATABASE_PATH || path.join(__dirname, "..", "data", "emerald.sqlite"));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  return {
    type: "better-sqlite3",
    database: databasePath,
    entities,
    synchronize: true,
    logging: env.DATABASE_LOG === "1" ? ["error", "warn"] : ["error"],
  };
}

let dataSource = null;

async function getDataSource(env = process.env) {
  if (dataSource) {
    return dataSource;
  }

  dataSource = new DataSource(buildDataSourceOptions(env));
  await dataSource.initialize();
  return dataSource;
}

async function closeDataSource() {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }

  dataSource = null;
}

module.exports = {
  getDataSource,
  closeDataSource,
  buildDataSourceOptions,
};
