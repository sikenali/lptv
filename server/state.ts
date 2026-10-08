import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../data');
const STATE_FILE = join(DATA_DIR, 'state.json');

export interface Reservation {
  id: string;
  pid: string;
  ch: string;
  name: string;
  s0: number;
  e0: number;
  made: number;
  notified?: number;
}

export interface UiState {
  lastPid?: string;
  favs?: string[];
  resumeLast?: boolean;
  autoFullscreen?: boolean;
  fit?: string;
  res?: Reservation[];
}

function readState(): UiState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(state: UiState) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export const StateManager = {
  async load(): Promise<UiState> {
    return readState();
  },

  async save(patch: Partial<UiState>): Promise<void> {
    const state = readState();
    Object.assign(state, patch);
    writeState(state);
  }
};
