import type { IncomingChat, RoomStateView } from "@peerkit-video-chat/core";

import { els, removeAllChildren } from "./dom.js";
import {
  closeAll,
  closePeer,
  initLocalMedia,
  initiateCall,
  setSpeakingCallback,
  setStreamCallback,
} from "./webrtc.js";

export let selfAgentId = "";
const knownPeers = new Set<string>();

// Peer video tiles currently in the grid (excludes the self-tile).
interface PeerTile {
  div: HTMLDivElement;
  video: HTMLVideoElement;
  nameEl: HTMLDivElement;
}
const peerTiles = new Map<string, PeerTile>();

// Streams that arrived before the tile was created (race: ICE can beat signaling).
const pendingStreams = new Map<string, MediaStream>();

// Track whether local media has been set up for the current session.
let localMediaReady = false;

// ---------------------------------------------------------------------------
// One-time callback wiring — call once at startup from main.ts
// ---------------------------------------------------------------------------

export function initViewCallbacks(): void {
  setStreamCallback((agentId, stream) => {
    if (stream === null) {
      pendingStreams.delete(agentId);
      return;
    }
    const tile = peerTiles.get(agentId);
    if (tile !== undefined) {
      tile.video.srcObject = stream;
    } else {
      // Tile not yet created — buffer and apply when tile is built.
      pendingStreams.set(agentId, stream);
    }
  });

  setSpeakingCallback((agentId, speaking) => {
    if (agentId === selfAgentId) {
      document.getElementById("self-tile")?.classList.toggle("speaking", speaking);
      return;
    }
    peerTiles.get(agentId)?.div.classList.toggle("speaking", speaking);
  });
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function setSelfAgent(agentId: string): void {
  selfAgentId = agentId;
  els.selfAgent.textContent = shortId(agentId);
}

export function shortId(agentId: string): string {
  return agentId.length > 12 ? `${agentId.slice(0, 12)}…` : agentId;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function showError(msg: string): void {
  els.globalError.textContent = msg;
  els.globalError.classList.remove("hidden");
}

export function clearError(): void {
  els.globalError.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Tile helpers
// ---------------------------------------------------------------------------

function createPeerTile(agentId: string, displayName: string): PeerTile {
  const div = document.createElement("div");
  div.className = "tile";
  div.dataset.agentId = agentId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  // Remote audio must NOT be muted — we want to hear the peer.
  div.appendChild(video);

  const nameEl = document.createElement("div");
  nameEl.className = "tile-name";
  nameEl.textContent = displayName;
  div.appendChild(nameEl);

  // Apply any stream that arrived before the tile was created.
  const pending = pendingStreams.get(agentId);
  if (pending !== undefined) {
    video.srcObject = pending;
    pendingStreams.delete(agentId);
  }

  els.videoGrid.appendChild(div);
  return { div, video, nameEl };
}

function removePeerTile(agentId: string): void {
  const tile = peerTiles.get(agentId);
  if (tile === undefined) return;
  tile.video.srcObject = null;
  tile.div.remove();
  peerTiles.delete(agentId);
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

export function renderState(view: RoomStateView): void {
  if (view.kind === "idle") {
    els.roomLabel.textContent = "not in a room";
    els.leaveBtn.classList.add("hidden");
    els.muteBtn.classList.add("hidden");
    els.videoGrid.classList.add("hidden");
    els.chatPane.classList.add("hidden");
    els.emptyPane.classList.remove("hidden");
    els.appMain.classList.remove("in-room");

    // Tear down self-video and clear chat log.
    els.selfVideo.srcObject = null;
    removeAllChildren(els.chatLog);

    closeAll();

    for (const agentId of [...peerTiles.keys()]) {
      removePeerTile(agentId);
    }
    knownPeers.clear();
    pendingStreams.clear();
    localMediaReady = false;
    return;
  }

  els.roomLabel.textContent = view.room;
  els.leaveBtn.classList.remove("hidden");
  els.muteBtn.classList.remove("hidden");
  els.videoGrid.classList.remove("hidden");
  els.chatPane.classList.remove("hidden");
  els.emptyPane.classList.add("hidden");
  els.appMain.classList.add("in-room");

  // Set up local media and self-preview on first entry.
  if (!localMediaReady) {
    localMediaReady = true;
    initLocalMedia(selfAgentId)
      .then((stream) => {
        els.selfVideo.srcObject = stream;
      })
      .catch((err: unknown) => {
        showError(`camera/mic: ${(err as Error).message}`);
      });
  }

  // Reconcile WebRTC peers.
  const currentIds = new Set(view.members.map((m) => m.agentId));
  for (const id of [...knownPeers]) {
    if (!currentIds.has(id)) {
      closePeer(id);
      removePeerTile(id);
      knownPeers.delete(id);
    }
  }
  for (const m of view.members) {
    if (m.agentId === selfAgentId) continue;
    if (!knownPeers.has(m.agentId)) {
      knownPeers.add(m.agentId);
      peerTiles.set(m.agentId, createPeerTile(m.agentId, m.displayName));
      // Lower agent ID is the offerer — prevents both sides offering simultaneously.
      if (selfAgentId < m.agentId) {
        initiateCall(m.agentId).catch((err: unknown) => {
          showError(`call: ${(err as Error).message}`);
        });
      }
    } else {
      // Update display name in case it changed.
      const tile = peerTiles.get(m.agentId);
      if (tile !== undefined) tile.nameEl.textContent = m.displayName;
    }
  }
}

export function appendChat(chat: IncomingChat): void {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-msg";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = chat.displayName + ":";
  const body = document.createElement("span");
  body.textContent = " " + chat.body;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = formatTime(chat.ts);
  wrapper.appendChild(who);
  wrapper.appendChild(body);
  wrapper.appendChild(ts);
  els.chatLog.appendChild(wrapper);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}
