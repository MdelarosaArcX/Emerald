import { onBeforeUnmount, ref } from 'vue';

/**
 * Connects a <video> element to a WHEP (WebRTC-HTTP Egress Protocol) endpoint — used for both
 * the capture and on-air live previews, which are otherwise identical negotiate/reconnect logic
 * pointed at different URLs. Negotiates recvonly video AND audio, retries indefinitely on
 * failure (the publisher may not be live yet), and reconnects on stall/disconnect without
 * requiring a page reload.
 */

const STALL_TIMEOUT_MS = 8000;
const STALL_CHECK_INTERVAL_MS = 2000;
const AUDIO_STATS_INTERVAL_MS = 2000;
const RETRY_DELAY_MS = 1000;

export function useWhepPreview() {
  const videoRef = ref<HTMLVideoElement | null>(null);
  const connected = ref(false);
  const audioDetected = ref(false);

  let pc: RTCPeerConnection | null = null;
  let sessionUrl: string | null = null;
  let abortController: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let stallWatchdogHandle: number | null = null;
  let audioStatsHandle: number | null = null;
  let lastFrameTime = -1;
  let lastFrameProgressAt = 0;
  let lastAudioPacketsReceived = 0;
  let currentWhepUrl = '';

  function teardown() {
    abortController?.abort();
    abortController = null;
    stopStallWatchdog();
    stopAudioStatsWatch();

    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (pc) {
      pc.close();
      pc = null;
    }

    // Tell MediaMTX to drop the WHEP session so abandoned reconnect attempts don't pile up
    // orphaned sessions on the server (which itself can lead to "too many requests").
    if (sessionUrl) {
      fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
      sessionUrl = null;
    }

    if (videoRef.value) videoRef.value.srcObject = null;
    connected.value = false;
  }

  function scheduleReconnect(whepUrl: string) {
    if (reconnectTimer !== null) return;

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (currentWhepUrl !== whepUrl) return;
      teardown();
      connectInternal(whepUrl);
    }, RETRY_DELAY_MS);
  }

  async function connectInternal(whepUrl: string): Promise<void> {
    const ac = new AbortController();
    abortController = ac;

    const connection = new RTCPeerConnection();
    pc = connection;

    connection.addTransceiver('video', { direction: 'recvonly' });
    connection.addTransceiver('audio', { direction: 'recvonly' });

    connection.ontrack = (event) => {
      if (videoRef.value) videoRef.value.srcObject = event.streams[0];
    };

    connection.onconnectionstatechange = () => {
      if (ac.signal.aborted) return;
      if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) {
        scheduleReconnect(whepUrl);
      }
    };

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    while (!ac.signal.aborted) {
      let response: Response | null = null;
      try {
        response = await fetch(whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: connection.localDescription!.sdp,
          signal: ac.signal,
        });
      } catch {
        if (ac.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      if (response.ok) {
        const answerSdp = await response.text();
        const location = response.headers.get('Location');
        sessionUrl = location ? new URL(location, whepUrl).toString() : null;
        await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        connected.value = true;
        startStallWatchdog(whepUrl);
        startAudioStatsWatch(connection);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  // Backstop for a connection that reports "connected" but never actually delivers frames —
  // checks the video element's playback position keeps advancing, reconnects from scratch if
  // it's been frozen too long.
  function startStallWatchdog(whepUrl: string) {
    stopStallWatchdog();
    lastFrameTime = videoRef.value?.currentTime ?? -1;
    lastFrameProgressAt = Date.now();

    stallWatchdogHandle = window.setInterval(() => {
      if (!videoRef.value) return;

      const currentTime = videoRef.value.currentTime;
      if (currentTime !== lastFrameTime) {
        lastFrameTime = currentTime;
        lastFrameProgressAt = Date.now();
        return;
      }

      if (Date.now() - lastFrameProgressAt > STALL_TIMEOUT_MS) {
        teardown();
        if (currentWhepUrl === whepUrl) connectInternal(whepUrl);
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  function stopStallWatchdog() {
    if (stallWatchdogHandle !== null) {
      window.clearInterval(stallWatchdogHandle);
      stallWatchdogHandle = null;
    }
  }

  // Polls WebRTC receive stats rather than trusting track/transceiver existence — a recvonly
  // audio transceiver negotiates successfully even when the publisher never sends real audio.
  function startAudioStatsWatch(connection: RTCPeerConnection) {
    stopAudioStatsWatch();
    lastAudioPacketsReceived = 0;

    audioStatsHandle = window.setInterval(async () => {
      const audioReceiver = connection.getReceivers().find((receiver) => receiver.track.kind === 'audio');
      if (!audioReceiver) {
        audioDetected.value = false;
        return;
      }

      try {
        const stats = await audioReceiver.getStats();
        let packetsReceived = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsReceived = report.packetsReceived ?? 0;
          }
        });
        audioDetected.value = packetsReceived > lastAudioPacketsReceived;
        lastAudioPacketsReceived = packetsReceived;
      } catch {
        audioDetected.value = false;
      }
    }, AUDIO_STATS_INTERVAL_MS);
  }

  function stopAudioStatsWatch() {
    if (audioStatsHandle !== null) {
      window.clearInterval(audioStatsHandle);
      audioStatsHandle = null;
    }
    audioDetected.value = false;
  }

  function connect(whepUrl: string) {
    if (!whepUrl || currentWhepUrl === whepUrl) return;
    teardown();
    currentWhepUrl = whepUrl;
    connectInternal(whepUrl);
  }

  function disconnect() {
    currentWhepUrl = '';
    teardown();
  }

  onBeforeUnmount(() => disconnect());

  return { videoRef, connected, audioDetected, connect, disconnect };
}
