const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { Pool } = require("pg");

class RuntimeServices {
  constructor(env = process.env) {
    this.env = env;
    this.redis = null;
    this.queue = null;
    this.pgPool = null;
  }

  getRedis() {
    if (!this.redis) {
      this.redis = new IORedis(this.env.REDIS_URL || "redis://127.0.0.1:6379", {
        lazyConnect: true,
        maxRetriesPerRequest: null,
      });
    }

    return this.redis;
  }

  getQueue() {
    if (!this.queue) {
      this.queue = new Queue(this.env.BULLMQ_QUEUE_NAME || "emerald.jobs", {
        connection: this.getRedis(),
      });
    }

    return this.queue;
  }

  getPostgresPool() {
    if (!this.pgPool) {
      this.pgPool = new Pool({
        connectionString: this.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/emerald",
      });
      // node-postgres crashes the whole process on an unhandled 'error' from an idle client
      // (a documented pg gotcha) unless something is listening — pingPostgres()'s try/catch only
      // covers the query promise itself, not this separate event.
      this.pgPool.on("error", () => {});
    }

    return this.pgPool;
  }

  async enqueue(name, data) {
    return this.getQueue().add(name, data, {
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  redisStatus() {
    return {
      configured: Boolean(this.env.REDIS_URL),
      url: redactUrl(this.env.REDIS_URL || "redis://127.0.0.1:6379"),
      status: this.redis?.status || "not_connected",
    };
  }

  queueStatus() {
    return {
      name: this.env.BULLMQ_QUEUE_NAME || "emerald.jobs",
      initialized: Boolean(this.queue),
    };
  }

  postgresStatus() {
    return {
      configured: Boolean(this.env.DATABASE_URL),
      url: redactUrl(this.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/emerald"),
      initialized: Boolean(this.pgPool),
    };
  }

  // Real connectivity probes (ping / SELECT 1) for the Capture page's "Database Connect"
  // indicator — distinct from the *Status() getters above, which only report whether a client
  // has ever been lazily constructed, not whether it can actually reach anything right now.
  //
  // Deliberately NOT reusing getRedis()'s shared singleton here: that client has no retryStrategy
  // override, so ioredis's default (retry forever with backoff) applies. Pinging it once on a
  // down Redis would leave it endlessly reconnecting in the background afterward, each failed
  // attempt logging "[ioredis] Unhandled error event" — forever, independent of this function's
  // own try/catch, which only ever covered that first ping's promise. A disposable client with
  // retries disabled avoids all of that: one attempt, one result, then torn down.
  async pingRedis() {
    const startedAt = Date.now();
    const probe = new IORedis(this.env.REDIS_URL || "redis://127.0.0.1:6379", {
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });
    probe.on("error", () => {});

    try {
      await probe.connect();
      await probe.ping();
      return { connected: true, latencyMs: Date.now() - startedAt, host: redactUrl(this.env.REDIS_URL || "redis://127.0.0.1:6379") };
    } catch (error) {
      return { connected: false, latencyMs: null, host: redactUrl(this.env.REDIS_URL || "redis://127.0.0.1:6379"), error: error.message };
    } finally {
      probe.disconnect();
    }
  }

  async pingPostgres() {
    const startedAt = Date.now();
    try {
      await this.getPostgresPool().query("SELECT 1");
      return { connected: true, latencyMs: Date.now() - startedAt, host: redactUrl(this.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/emerald") };
    } catch (error) {
      return { connected: false, latencyMs: null, host: redactUrl(this.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/emerald"), error: error.message };
    }
  }

  async close() {
    await Promise.allSettled([
      this.queue?.close(),
      this.redis?.quit(),
      this.pgPool?.end(),
    ]);
  }
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) {
      parsed.password = "****";
    }

    return parsed.toString();
  } catch {
    return value ? "[configured]" : null;
  }
}

module.exports = {
  RuntimeServices,
  runtimeServices: new RuntimeServices(),
};
