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
