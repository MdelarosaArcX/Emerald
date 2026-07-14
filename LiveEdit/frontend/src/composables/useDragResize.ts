import { ref } from 'vue';

export type DragMode = 'move' | 'resize-left' | 'resize-right';

interface DragState {
  mode: DragMode;
  startX: number;
  originStart: number;
  originDuration: number;
}

interface UseDragResizeOptions {
  pixelsPerFrame: () => number;
  minDurationFrames?: number;
  onChange: (next: { start: number; duration: number }) => void;
  onCommit?: (next: { start: number; duration: number }) => void;
}

/**
 * Encapsulates pointer-drag math for moving/trimming a timeline clip.
 * Consumers provide the current pixels-per-frame scale (so it can react
 * to zoom) and receive frame-quantized start/duration updates.
 */
export function useDragResize(options: UseDragResizeOptions) {
  const { pixelsPerFrame, minDurationFrames = 1, onChange, onCommit } = options;
  const isDragging = ref(false);
  let state: DragState | null = null;
  let lastValue: { start: number; duration: number } | null = null;

  function begin(event: PointerEvent, mode: DragMode, current: { start: number; duration: number }): void {
    state = {
      mode,
      startX: event.clientX,
      originStart: current.start,
      originDuration: current.duration,
    };
    lastValue = { ...current };
    isDragging.value = true;

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  function handleMove(event: PointerEvent): void {
    if (!state) return;

    const deltaPx = event.clientX - state.startX;
    const deltaFrames = Math.round(deltaPx / pixelsPerFrame());

    if (state.mode === 'move') {
      const start = Math.max(0, state.originStart + deltaFrames);
      lastValue = { start, duration: state.originDuration };
    } else if (state.mode === 'resize-left') {
      const start = Math.max(0, Math.min(state.originStart + deltaFrames, state.originStart + state.originDuration - minDurationFrames));
      const duration = state.originStart + state.originDuration - start;
      lastValue = { start, duration };
    } else {
      const duration = Math.max(minDurationFrames, state.originDuration + deltaFrames);
      lastValue = { start: state.originStart, duration };
    }

    onChange(lastValue);
  }

  function handleUp(event: PointerEvent): void {
    if (state) {
      handleMove(event);
      if (lastValue) onCommit?.(lastValue);
    }
    cleanup();
  }

  function cleanup(): void {
    state = null;
    isDragging.value = false;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
  }

  return { isDragging, begin };
}
