/**
 * Persistência mínima de salas em jogo (Fase 4).
 * JSON em server/data/rooms.json — sobrevive reinício do processo.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "rooms.json");

let saveTimer = null;

function serializeRoom(room) {
  if (!room || room.status !== "playing") return null;
  return {
    code: room.code,
    createdAt: room.createdAt,
    status: room.status,
    heroes: room.heroes,
    winPoints: room.winPoints,
    ready: room.ready,
    lastSnapshot: room.lastSnapshot,
    gameState: room.gameState,
    eventLog: room.eventLog || [],
    actionSeq: room.actionSeq || 0,
    turnDeadline: room.turnDeadline || null,
  };
}

export function loadPersistedRooms() {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.warn("[room-persist] load failed:", e.message);
    return [];
  }
}

export function schedulePersistRooms(getPlayingRooms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const rooms = getPlayingRooms().map(serializeRoom).filter(Boolean);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify(rooms, null, 0), "utf8");
    } catch (e) {
      console.warn("[room-persist] save failed:", e.message);
    }
  }, 400);
}

export function flushPersistRooms(getPlayingRooms) {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const rooms = getPlayingRooms().map(serializeRoom).filter(Boolean);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(rooms, null, 0), "utf8");
  } catch (e) {
    console.warn("[room-persist] flush failed:", e.message);
  }
}
