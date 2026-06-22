const previewVideo = document.getElementById("previewVideo");
const obsInputUrl = document.getElementById("obsInputUrl");
const obsPreviewUrl = document.getElementById("obsPreviewUrl");
const recordingContainer = document.getElementById("recordingContainer");
const segmentSeconds = document.getElementById("segmentSeconds");
const ffmpegPath = document.getElementById("ffmpegPath");
const startPreviewButton = document.getElementById("startPreviewButton");
const stopRecordingButton = document.getElementById("stopRecordingButton");
const copyPreviewUrlButton = document.getElementById("copyPreviewUrlButton");
const recordingBadge = document.getElementById("recordingBadge");
const recordingTimer = document.getElementById("recordingTimer");
const emptyState = document.getElementById("emptyState");
const permissionStatus = document.getElementById("permissionStatus");
const segmentLength = document.getElementById("segmentLength");
const outputPattern = document.getElementById("outputPattern");
const sourceCodec = document.getElementById("sourceCodec");
const currentBitrate = document.getElementById("currentBitrate");
const currentFps = document.getElementById("currentFps");
const currentResolution = document.getElementById("currentResolution");
const recordingCodec = document.getElementById("recordingCodec");
const segmentsList = document.getElementById("segmentsList");

let statusPollHandle = null;
let timerHandle = null;
let recordingStartedAt = null;
let segmentNames = new Set();
let hlsPlayer = null;
let lastProbeAt = 0;
let currentPreviewPath = "/hls/obs-preview/index.m3u8";
let activePreviewUrl = "";

const obsSettingsKey = "emerald.streaming.obs";

const setStatus = (text, state = "") => {
  permissionStatus.textContent = text;
  permissionStatus.classList.toggle("is-live", state === "live");
  permissionStatus.classList.toggle("is-recording", state === "recording");
};

const setMessage = (message) => {
  sourceCodec.textContent = message || "--";
};

const formatDuration = (milliseconds) => {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const updateTimer = () => {
  if (!recordingStartedAt) {
    recordingTimer.value = "00:00";
    return;
  }

  recordingTimer.value = formatDuration(Date.now() - recordingStartedAt.getTime());
};

const saveSettings = () => {
  localStorage.setItem(obsSettingsKey, JSON.stringify({
    inputUrl: obsInputUrl.value,
    container: recordingContainer.value,
    segmentSeconds: segmentSeconds.value,
    ffmpegPath: ffmpegPath.value,
  }));
};

const loadSettings = () => {
  try {
    const settings = JSON.parse(localStorage.getItem(obsSettingsKey) || "null");

    if (!settings) {
      return;
    }

    obsInputUrl.value = settings.inputUrl || obsInputUrl.value;
    recordingContainer.value = settings.container || "mp4";
    segmentSeconds.value = settings.segmentSeconds || "120";
    ffmpegPath.value = settings.ffmpegPath || "ffmpeg";
    segmentLength.textContent = `${segmentSeconds.value} seconds`;
  } catch {
    localStorage.removeItem(obsSettingsKey);
  }
};

const loadIngestStatus = async () => {
  try {
    const response = await fetch("/api/rtmp-ingest/status", { cache: "no-store" });

    if (!response.ok) {
      return;
    }

    const status = await response.json();

    if (status?.lastMessage) {
      setMessage(status.lastMessage);
    }
  } catch {
    // The recorder can still run against an external OBS URL.
  }
};

const startServerPreview = async () => {
  const response = await fetch("/api/obs-preview/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputUrl: obsInputUrl.value.trim(),
      ffmpegPath: ffmpegPath.value.trim() || "ffmpeg",
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Unable to start server HLS preview.");
  }

  return result.previewUrl;
};

const getSharePreviewUrl = () => {
  return new URL(currentPreviewPath, window.location.origin).toString();
};

const refreshSharePreviewUrl = () => {
  obsPreviewUrl.value = getSharePreviewUrl();
};

const copySharePreviewUrl = async () => {
  refreshSharePreviewUrl();

  try {
    await navigator.clipboard.writeText(obsPreviewUrl.value);
    setMessage("Preview URL copied.");
  } catch {
    obsPreviewUrl.select();
    document.execCommand("copy");
    setMessage("Preview URL copied.");
  }
};

const waitForPlaylist = async (playlistUrl) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${playlistUrl}?t=${Date.now()}`, { cache: "no-store" });

    if (response.ok) {
      return;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }

  throw new Error("Preview HLS playlist was not created yet. Check that OBS is streaming and FFmpeg can read the OBS Recording URL.");
};

const resetPreviewPlayer = () => {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  previewVideo.removeAttribute("src");
  previewVideo.load();
  previewVideo.muted = true;
  previewVideo.hidden = false;
  emptyState.hidden = true;
};

const playPreviewUrl = async (previewUrl) => {
  activePreviewUrl = previewUrl;
  resetPreviewPlayer();

  if (previewUrl.toLowerCase().includes(".m3u8") && window.Hls?.isSupported()) {
    await waitForPlaylist(previewUrl);
    hlsPlayer = new Hls({
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
      maxLiveSyncPlaybackRate: 1.2,
      manifestLoadingMaxRetry: 8,
      levelLoadingMaxRetry: 8,
      fragLoadingMaxRetry: 8,
    });
    hlsPlayer.loadSource(previewUrl);
    hlsPlayer.attachMedia(previewVideo);
    await new Promise((resolve, reject) => {
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, resolve);
      hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          reject(new Error(data.details || "HLS preview failed."));
        }
      });
    });
  } else {
    previewVideo.src = previewUrl;
  }

  await previewVideo.play();
};

const startPreview = async () => {
  setMessage("Creating local HLS preview from OBS recording URL...");
  await fetch("/api/obs-preview/stop", { method: "POST" });
  const previewUrl = await startServerPreview();
  currentPreviewPath = previewUrl || currentPreviewPath;
  refreshSharePreviewUrl();

  try {
    await playPreviewUrl(previewUrl);
    setMessage("Preview started.");
  } catch (error) {
    throw error;
  }
};

const restoreServerPreview = async () => {
  const response = await fetch("/api/obs-preview/status", { cache: "no-store" });

  if (!response.ok) {
    return;
  }

  const status = await response.json();

  if (!status.isRunning || !status.previewUrl || activePreviewUrl === status.previewUrl) {
    return;
  }

  currentPreviewPath = status.previewUrl;
  refreshSharePreviewUrl();

  try {
    await playPreviewUrl(status.previewUrl);
    setMessage("Preview restored.");
  } catch (error) {
    setMessage(error.message || "Unable to restore preview.");
  }
};

const addSavedSegment = (recording) => {
  if (segmentNames.has(recording.fileName)) {
    return;
  }

  segmentNames.add(recording.fileName);

  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = recording.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = recording.fileName;

  item.append(link, ` (${Math.round(recording.size / 1024)} KB)`);
  segmentsList.prepend(item);
};

const loadSegments = async () => {
  const response = await fetch("/api/obs-recordings");

  if (!response.ok) {
    return;
  }

  const recordings = await response.json();
  recordings.reverse().forEach(addSavedSegment);
};

const updateStreamProbe = async (force = false) => {
  const now = Date.now();

  if (!force && now - lastProbeAt < 10000) {
    return;
  }

  lastProbeAt = now;

  const response = await fetch("/api/obs-stream/probe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputUrl: obsInputUrl.value.trim(),
      ffmpegPath: ffmpegPath.value.trim() || "ffmpeg",
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    currentBitrate.textContent = "--";
    currentFps.textContent = "--";
    currentResolution.textContent = "--";
    setMessage(result.message || "Unable to probe OBS stream.");
    return;
  }

  recordingCodec.textContent = result.codec ? `${result.codec} via FFmpeg -c copy` : "Same as OBS input via FFmpeg -c copy";
  currentBitrate.textContent = result.bitrateText || "--";
  currentFps.textContent = result.fps ? `${result.fps.toFixed(2)} fps` : "Not reported";
  currentResolution.textContent = result.resolutionText || "--";
};

const applyRecorderStatus = (status) => {
  if (status.isRecording) {
    recordingStartedAt = status.startedAt ? new Date(status.startedAt) : new Date();
    recordingBadge.hidden = false;
    stopRecordingButton.disabled = false;
    startPreviewButton.disabled = true;
    outputPattern.textContent = status.outputPattern || "--";
    segmentLength.textContent = `${status.segmentSeconds} seconds`;
    setStatus("Recording OBS", "recording");
    window.clearInterval(timerHandle);
    timerHandle = window.setInterval(updateTimer, 250);
    updateTimer();
  } else {
    recordingStartedAt = null;
    recordingBadge.hidden = true;
    stopRecordingButton.disabled = true;
    startPreviewButton.disabled = false;
    setStatus("Recorder idle");
    window.clearInterval(timerHandle);
    timerHandle = null;
    updateTimer();
  }

  setMessage(status.lastMessage);
};

const pollStatus = async () => {
  try {
    const response = await fetch("/api/obs-recording/status");

    if (!response.ok) {
      return;
    }

    const status = await response.json();
    applyRecorderStatus(status);
    await loadSegments();

    if (status.isRecording) {
      await updateStreamProbe();
    }
  } catch (error) {
    setMessage(error.message || "Unable to read recorder status.");
  }
};

const startRecording = async () => {
  saveSettings();

  try {
    await startPreview();
  } catch (error) {
    setMessage(error.message || "Preview failed, but recording will still start.");
  }

  const response = await fetch("/api/obs-recording/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputUrl: obsInputUrl.value.trim(),
      segmentSeconds: Number(segmentSeconds.value),
      container: recordingContainer.value,
      ffmpegPath: ffmpegPath.value.trim() || "ffmpeg",
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    setStatus("Recorder error");
    setMessage(result.message || "Unable to start OBS recording.");
    return;
  }

  applyRecorderStatus(result);
  await updateStreamProbe(true);
};

const stopRecording = async () => {
  const response = await fetch("/api/obs-recording/stop", { method: "POST" });
  const result = await response.json();
  await fetch("/api/obs-preview/stop", { method: "POST" });
  applyRecorderStatus(result);
  await loadSegments();
};

startPreviewButton?.addEventListener("click", startRecording);
stopRecordingButton?.addEventListener("click", stopRecording);
copyPreviewUrlButton?.addEventListener("click", copySharePreviewUrl);
[obsInputUrl, recordingContainer, segmentSeconds, ffmpegPath].forEach((element) => {
  element?.addEventListener("change", () => {
    segmentLength.textContent = `${segmentSeconds.value} seconds`;
    saveSettings();
  });
});

loadSettings();
refreshSharePreviewUrl();
loadIngestStatus();
pollStatus();
loadSegments();
restoreServerPreview();
statusPollHandle = window.setInterval(pollStatus, 3000);

window.addEventListener("beforeunload", () => {
  window.clearInterval(statusPollHandle);
  window.clearInterval(timerHandle);
});
