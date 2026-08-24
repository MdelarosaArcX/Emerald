import { defineStore } from "pinia";

/**
 * The SDI hardware actually installed, as reported by DeltacastCaptureService.
 *
 * Read rather than configured so the Recording and Playback pickers offer real boards and real
 * channels: the counts come from the board itself (VHD_CORE_BP_NB_RX/TXCHANNELS) and the name from
 * VHD_GetBoardModel, so a 2-channel card never offers 8 selections and a 12-output card doesn't
 * hide four of them behind an assumed limit of 8.
 */

/** One channel on a board. `hasSignal` is only meaningful for RX — a TX output has none to lock. */
export interface DeltacastChannel {
  channelIndex: number;
  channelType: number;
  /** False for a connector that isn't SDI at all — it can never be a valid selection. */
  isSdi: boolean;
  status: number;
  hasSignal: boolean;
  error: string | null;
}

export interface DeltacastBoard {
  boardIndex: number;
  /** e.g. "DELTA-12G-elp-h 20". */
  model: string | null;
  /** Family from VHD_BOARDTYPE, e.g. "DELTA-12G" — a fallback when the model is unknown. */
  boardType: string;
  /** Ready for a picker: "1. DELTA-12G-elp-h 20". */
  label: string;
  rxChannelCount: number;
  txChannelCount: number;
  rxChannels: DeltacastChannel[];
  txChannels: DeltacastChannel[];
  error: string | null;
}

interface LegInUse {
  boardIndex: number;
  channelIndex: number;
  active: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  detectedWidth?: number | null;
  detectedHeight?: number | null;
  detectedFrameRate?: number | null;
  detectedStandard?: string | null;
  enabled?: boolean;
}

interface HardwareState {
  boards: DeltacastBoard[];
  /** False when the service couldn't inventory the hardware — the pickers say so rather than showing nothing. */
  inventoryAvailable: boolean;
  inUse: { capture: LegInUse; transmit: LegInUse; onAirPreview: LegInUse } | null;
  message: string | null;
  loading: boolean;
}

export const useDeltacastHardwareStore = defineStore("deltacastHardware", {
  state: (): HardwareState => ({
    boards: [],
    inventoryAvailable: false,
    inUse: null,
    message: null,
    loading: false,
  }),

  getters: {
    /** Boards that have at least one SDI input — the only ones worth offering for capture. */
    rxBoards(state): DeltacastBoard[] {
      return state.boards.filter((board) => board.rxChannels.some((channel) => channel.isSdi));
    },
    /** Boards with at least one SDI output. */
    txBoards(state): DeltacastBoard[] {
      return state.boards.filter((board) => board.txChannels.some((channel) => channel.isSdi));
    },
  },

  actions: {
    /** SDI inputs on one board, in index order. Non-SDI connectors are excluded, not disabled. */
    rxChannels(boardIndex: number): DeltacastChannel[] {
      const board = this.boards.find((entry) => entry.boardIndex === boardIndex);
      return board?.rxChannels.filter((channel) => channel.isSdi) ?? [];
    },

    txChannels(boardIndex: number): DeltacastChannel[] {
      const board = this.boards.find((entry) => entry.boardIndex === boardIndex);
      return board?.txChannels.filter((channel) => channel.isSdi) ?? [];
    },

    /**
     * How a channel should be labelled in a picker: what it is, whether it carries signal, and
     * whether something already has it. "In use" matters most — selecting a channel another leg
     * holds is the mistake the picker exists to prevent.
     */
    channelLabel(boardIndex: number, channelIndex: number, direction: "rx" | "tx"): string {
      const prefix = direction === "rx" ? "RX" : "TX";
      const parts = [`${prefix}${channelIndex}`];

      if (direction === "rx") {
        const channel = this.rxChannels(boardIndex).find((entry) => entry.channelIndex === channelIndex);
        if (channel) parts.push(channel.hasSignal ? "signal" : "no signal");
      }

      for (const [leg, usage] of Object.entries(this.inUse ?? {})) {
        const inUse = usage as LegInUse;
        if (inUse.boardIndex !== boardIndex || inUse.channelIndex !== channelIndex) continue;
        // The on-air loopback is an RX leg and transmit is a TX leg, so a match only counts when it
        // is the same direction as the list being labelled.
        const isRxLeg = leg === "capture" || leg === "onAirPreview";
        if ((direction === "rx") !== isRxLeg) continue;
        if (leg === "onAirPreview" && inUse.enabled === false) continue;
        parts.push(inUse.active ? `in use — ${leg}` : `assigned to ${leg}`);
      }

      return `${parts[0]} (${parts.slice(1).join(", ")})`;
    },

    async fetch(): Promise<void> {
      this.loading = true;
      try {
        const response = await fetch("/api/deltacast/boards");
        const data = await response.json();
        this.boards = Array.isArray(data?.boards) ? data.boards : [];
        this.inventoryAvailable = Boolean(data?.inventoryAvailable);
        this.inUse = data?.inUse ?? null;
        this.message = data?.message ?? null;
      } catch (error) {
        this.boards = [];
        this.inventoryAvailable = false;
        this.message = error instanceof Error ? error.message : "Could not read the SDI hardware.";
      } finally {
        this.loading = false;
      }
    },
  },
});
