const previewVideo = document.getElementById("previewVideo");
const obsInputUrl = document.getElementById("obsInputUrl");
const recordingContainer = document.getElementById("recordingContainer");
const segmentSeconds = document.getElementById("segmentSeconds");
const ffmpegPath = document.getElementById("ffmpegPath");
const startPreviewButton = document.getElementById("startPreviewButton");
const stopRecordingButton = document.getElementById("stopRecordingButton");
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
let lastProbeAt = 0;
let activePreviewUrl = "";
let webrtcPeerConnection = null;
let webrtcSessionUrl = null;

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
    segmentSeconds.value = settings.segmentSeconds || "300";
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

const getWebrtcInputUrl = () => {
  const inputUrl = obsInputUrl.value.trim();

  // A unicast UDP socket only delivers to one listener. DeltacastCaptureService relays the
  // same H.264 stream to (recording port + 1) via Streaming:WebRtcRelayUrl in appsettings.json
  // specifically so the WebRTC publisher doesn't fight the recorder ffmpeg for port 5000.
  if (inputUrl.toLowerCase().startsWith("udp://")) {
    try {
      const parsed = new URL(inputUrl);
      parsed.port = String(Number(parsed.port || 5000) + 1);
      return parsed.toString();
    } catch {
      return inputUrl;
    }
  }

  return inputUrl;
};

const startWebrtcPreview = async () => {
  const response = await fetch("/api/webrtc-preview/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputUrl: getWebrtcInputUrl(),
      ffmpegPath: ffmpegPath.value.trim() || "ffmpeg",
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || "Unable to start the WebRTC preview.");
  }

  return result.whepUrl;
};

const stopWebrtcPeerConnection = () => {
  if (webrtcPeerConnection) {
    webrtcPeerConnection.close();
    webrtcPeerConnection = null;
  }

  if (webrtcSessionUrl) {
    fetch(webrtcSessionUrl, { method: "DELETE" }).catch(() => {});
    webrtcSessionUrl = null;
  }
};

const playWebRtcPreview = async (whepUrl) => {
  const pc = new RTCPeerConnection();
  webrtcPeerConnection = pc;

  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (event) => {
    previewVideo.srcObject = event.streams[0];
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  let lastError = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(whepUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
      },
      body: pc.localDescription.sdp,
    });

    if (response.ok) {
      const answerSdp = await response.text();
      const location = response.headers.get("Location");
      webrtcSessionUrl = location ? new URL(location, whepUrl).toString() : null;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return;
    }

    lastError = await response.text().catch(() => "");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }

  pc.close();
  webrtcPeerConnection = null;
  throw new Error(lastError || "WebRTC preview did not become available in time.");
};

const resetPreviewPlayer = () => {
  stopWebrtcPeerConnection();
  previewVideo.srcObject = null;
  previewVideo.removeAttribute("src");
  previewVideo.load();
  previewVideo.muted = true;
  previewVideo.hidden = false;
  emptyState.hidden = true;
};

const startPreview = async () => {
  await fetch("/api/webrtc-preview/stop", { method: "POST" });
  setMessage("Starting WebRTC preview...");
  const whepUrl = await startWebrtcPreview();
  resetPreviewPlayer();
  activePreviewUrl = whepUrl;
  await playWebRtcPreview(whepUrl);
  await previewVideo.play();
  setMessage("Preview started (WebRTC).");
};

const restoreServerPreview = async () => {
  const webrtcResponse = await fetch("/api/webrtc-preview/status", { cache: "no-store" }).catch(() => null);
  const webrtcStatus = webrtcResponse?.ok ? await webrtcResponse.json() : null;

  if (webrtcStatus?.isRunning && webrtcStatus.whepUrl && activePreviewUrl !== webrtcStatus.whepUrl) {
    try {
      resetPreviewPlayer();
      activePreviewUrl = webrtcStatus.whepUrl;
      await playWebRtcPreview(webrtcStatus.whepUrl);
      await previewVideo.play();
      setMessage("Preview restored (WebRTC).");
    } catch (error) {
      setMessage(error.message || "Unable to restore WebRTC preview.");
    }
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
  await fetch("/api/webrtc-preview/stop", { method: "POST" });
  resetPreviewPlayer();
  activePreviewUrl = "";
  applyRecorderStatus(result);
  await loadSegments();
};

startPreviewButton?.addEventListener("click", startRecording);
stopRecordingButton?.addEventListener("click", stopRecording);
[obsInputUrl, recordingContainer, segmentSeconds, ffmpegPath].forEach((element) => {
  element?.addEventListener("change", () => {
    segmentLength.textContent = `${segmentSeconds.value} seconds`;
    saveSettings();
  });
});

loadSettings();
loadIngestStatus();
pollStatus();
loadSegments();
restoreServerPreview();
statusPollHandle = window.setInterval(pollStatus, 3000);

window.addEventListener("beforeunload", () => {
  window.clearInterval(statusPollHandle);
  window.clearInterval(timerHandle);
});
