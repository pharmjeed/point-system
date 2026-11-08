import { create } from 'zustand';

/**
 * In-page sound state for the banners (02 §1.10, D-15 د; PNT-066), memory only:
 * - `locked`: no unlock tap in this page yet (after a reload the browser asks for a new tap);
 * - `running`: the AudioContext runs — sounds play;
 * - `blocked`: the context exists but is suspended / interrupted, or refused to resume.
 */
export type AudioStatus = 'locked' | 'running' | 'blocked';

interface AudioState {
  status: AudioStatus;
  setStatus: (status: AudioStatus) => void;
}

export const useAudioStore = create<AudioState>()((set) => ({
  status: 'locked',
  setStatus: (status) => set((s) => (s.status === status ? s : { status })),
}));
