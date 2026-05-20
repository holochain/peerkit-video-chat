import type { IncomingChat, RoomStateView } from "@peerkit-video-chat/core";

import { els, removeAllChildren } from "./dom.js";

let selfAgentId = "";

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
    els.rosterPane.classList.add("hidden");
    els.chatPane.classList.add("hidden");
    els.emptyPane.classList.remove("hidden");
    removeAllChildren(els.rosterList);
    removeAllChildren(els.chatLog);
    return;
  }
  els.roomLabel.textContent = view.room;
  els.leaveBtn.classList.remove("hidden");
  els.rosterPane.classList.remove("hidden");
  els.chatPane.classList.remove("hidden");
  els.emptyPane.classList.add("hidden");

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
