import { ref, watch } from 'vue';

/**
 * Whether the operator wants to hear the monitors, and at what level — shared by every player on
 * the page (capture preview, playback deck, the two monitor feeds).
 *
 * Module-level rather than per-component state on purpose: these players sit on screen together
 * and all carry the same programme audio, so unmuting one and leaving the others silent is never
 * what is wanted, and unmuting several at once produces slap-back echo from the slightly
 * different latencies of each path.
 *
 * Every <video> stays muted in markup regardless of this. Browsers block autoplay for media with
 * sound, and the capture preview must autoplay to be useful — so the element attribute stays
 * muted forever and the *property* is what this drives, applied only after a real click. That is
 * the click that satisfies the autoplay policy.
 */

const STORAGE_KEY = 'emerald.monitorAudio';

interface StoredState {
  enabled: boolean;
  volume: number;
}

function load(): StoredState {
  // Deliberately defaults to off. This is a broadcast gallery: something that started making
  // noise on its own every time the page loaded would be worse than having to ask for it.
  const fallback: StoredState = { enabled: false, volume: 0.8 };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      enabled: Boolean(parsed.enabled),
      volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : fallback.volume,
    };
  } catch {
    return fallback;
  }
}

const initial = load();
const enabled = ref(initial.enabled);
const volume = ref(initial.volume);

watch([enabled, volume], () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: enabled.value, volume: volume.value }));
  } catch {
    // Private browsing or a full quota — the preference just won't persist, which is harmless.
  }
});

/**
 * Which player is currently allowed to make sound. Only one at a time: the capture preview, the
 * playback deck and the on-air monitor all carry the same audio down paths with different delays,
 * so letting two through at once sounds like an echo rather than louder.
 */
const soloOwner = ref<string | null>(null);

export function useMonitorAudio(ownerId: string) {
  const isOwner = ref(soloOwner.value === ownerId);
  watch(soloOwner, (owner) => { isOwner.value = owner === ownerId; });

  /** Audible only when the operator has asked for audio AND this player holds it. */
  function shouldSound(): boolean {
    return enabled.value && soloOwner.value === ownerId;
  }

  /**
   * Applies the current state to an element. Called after a user gesture and whenever the state
   * or the element changes — setting .muted/.volume as properties, never as attributes, so the
   * markup stays autoplay-safe.
   */
  function apply(element: HTMLVideoElement | null): void {
    if (!element) return;
    element.muted = !shouldSound();
    element.volume = volume.value;
  }

  /** Take audio for this player, enabling it globally if it was off. */
  function claim(): void {
    soloOwner.value = ownerId;
    enabled.value = true;
  }

  /** Give up audio (mute this player). Leaves the global preference alone. */
  function release(): void {
    if (soloOwner.value === ownerId) soloOwner.value = null;
  }

  function toggle(): void {
    if (shouldSound()) release();
    else claim();
  }

  return { enabled, volume, isOwner, shouldSound, apply, claim, release, toggle };
}
