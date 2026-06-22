const NodeMediaServer = require("node-media-server");
const mediaLogger = require("node-media-server/src/core/logger");

class RtmpIngestService {
  constructor(options = {}) {
    this.port = Number(options.port || process.env.EMERALD_RTMP_PORT || 1935);
    this.bind = options.bind || process.env.EMERALD_RTMP_BIND || "0.0.0.0";
    this.server = null;
    this.status = {
      isRunning: false,
      port: this.port,
      publishUrl: `rtmp://127.0.0.1:${this.port}/live/emerald`,
      lastMessage: null,
      activeStreams: [],
    };
  }

  start() {
    if (this.server || this.port <= 0) {
      return this.status;
    }

    this.server = new NodeMediaServer({
      bind: this.bind,
      auth: {
        play: false,
        publish: false,
      },
      rtmp: {
        port: this.port,
      },
    });
    mediaLogger.level = process.env.EMERALD_RTMP_LOG_LEVEL || "warn";
    this.server.rtmpServer?.tcpServer?.on("error", (error) => {
      this.status = {
        ...this.status,
        isRunning: false,
        lastMessage: error.code === "EADDRINUSE"
          ? `RTMP ingest port ${this.port} is already in use. Stop the other Emerald/RTMP process or set EMERALD_RTMP_PORT to another port.`
          : `RTMP ingest error: ${error.message}`,
      };
    });

    this.server.on("postPublish", (session) => {
      const streamPath = session?.streamPath || session?.publishStreamPath || "/live/emerald";
      this.status = {
        ...this.status,
        lastMessage: `OBS publishing ${streamPath}.`,
        activeStreams: upsert(this.status.activeStreams, streamPath),
      };
    });

    this.server.on("donePublish", (session) => {
      const streamPath = session?.streamPath || session?.publishStreamPath || "/live/emerald";
      this.status = {
        ...this.status,
        lastMessage: `OBS stopped publishing ${streamPath}.`,
        activeStreams: this.status.activeStreams.filter((stream) => stream !== streamPath),
      };
    });

    try {
      this.server.run();
      this.status = {
        ...this.status,
        isRunning: true,
        lastMessage: `RTMP ingest listening on port ${this.port}.`,
      };
    } catch (error) {
      this.server = null;
      this.status = {
        ...this.status,
        isRunning: false,
        lastMessage: error.message,
      };
    }

    return this.status;
  }

  stop() {
    if (this.server?.rtmpServer?.tcpServer) {
      this.server.rtmpServer.tcpServer.close();
    }

    this.server = null;
    this.status = {
      ...this.status,
      isRunning: false,
      activeStreams: [],
      lastMessage: "RTMP ingest stopped.",
    };

    return this.status;
  }
}

function upsert(values, value) {
  return values.includes(value) ? values : [...values, value];
}

module.exports = {
  RtmpIngestService,
};
