import type { IncomingChat, RoomStateView } from "@peerkit-video-chat/core";

import { els, removeAllChildren } from "./dom.js";
import { closeAll, closePeer, initiateCall } from "./webrtc.js";

export let selfAgentId = "";
const knownPeers = new Set<string>();

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

export function renderState(view: RoomStateView): void {
  if (view.kind === "idle") {
    els.roomLabel.textContent = "not in a room";
    els.leaveBtn.classList.add("hidden");
    els.muteBtn.classList.add("hidden");
    els.rosterPane.classList.add("hidden");
    els.chatPane.classList.add("hidden");
    els.emptyPane.classList.remove("hidden");
    removeAllChildren(els.rosterList);
    removeAllChildren(els.chatLog);
    closeAll();
    knownPeers.clear();
    return;
  }
  els.roomLabel.textContent = view.room;
  els.leaveBtn.classList.remove("hidden");
  els.muteBtn.classList.remove("hidden");
  els.rosterPane.classList.remove("hidden");
  els.chatPane.classList.remove("hidden");
  els.emptyPane.classList.add("hidden");

  // Reconcile WebRTC peers.
  const currentIds = new Set(view.members.map((m) => m.agentId));
  for (const id of knownPeers) {
    if (!currentIds.has(id)) {
      closePeer(id);
      knownPeers.delete(id);
    }
  }
  for (const m of view.members) {
    if (m.agentId === selfAgentId) continue;
    if (!knownPeers.has(m.agentId)) {
      knownPeers.add(m.agentId);
      // Lower agent ID is the offerer — prevents both sides offering simultaneously.
      if (selfAgentId < m.agentId) {
        initiateCall(m.agentId).catch((err: unknown) => {
          showError(`audio: ${(err as Error).message}`);
        });
      }
    }
  }

  removeAllChildren(els.rosterList);
  for (const m of view.members) {
    const li = document.createElement("li");
    li.textContent =
      m.displayName + (m.agentId === selfAgentId ? " (you)" : "");
    const idEl = document.createElement("span");
    idEl.className = "id";
    idEl.textContent = shortId(m.agentId);
    li.appendChild(idEl);
    els.rosterList.appendChild(li);
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
