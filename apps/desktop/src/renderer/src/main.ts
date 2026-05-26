import { els } from "./dom.js";
import {
  appendChat,
  clearError,
  initViewCallbacks,
  renderState,
  setSelfAgent,
  showError,
} from "./view.js";
import { handleSignal, setMuted } from "./webrtc.js";

// Wire stream + speaking callbacks once at module load (before any user action).
initViewCallbacks();

let initialized = false;
let initializing = false;

async function init(displayName: string): Promise<void> {
  if (initialized || initializing) return;
  initializing = true;
  try {
    const { agentId } = await window.app.init(displayName);
    setSelfAgent(agentId);
    els.nameEdit.value = displayName;

    els.nameModal.classList.add("hidden");
    els.appHeader.classList.remove("hidden");
    els.appMain.classList.remove("hidden");

    window.app.onState(renderState);
    window.app.onChat(appendChat);
    window.app.onSignal((fromAgent, signal) => {
      handleSignal(fromAgent, signal).catch((err: unknown) => {
        showError(`call: ${(err as Error).message}`);
      });
    });
    initialized = true;
  } catch (err) {
    els.nameError.textContent = (err as Error).message ?? String(err);
    els.nameError.classList.remove("hidden");
  } finally {
    initializing = false;
  }
}

els.nameSubmit.addEventListener("click", () => {
  const name = els.nameInput.value.trim();
  if (name === "") {
    els.nameError.textContent = "Display name cannot be empty.";
    els.nameError.classList.remove("hidden");
    return;
  }
  els.nameError.classList.add("hidden");
  void init(name);
});

els.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.nameSubmit.click();
});

els.nameEdit.addEventListener("change", () => {
  const name = els.nameEdit.value.trim();
  if (name === "") return;
  clearError();
  window.app.setDisplayName(name).catch((err: unknown) => {
    showError(`name update failed: ${(err as Error).message}`);
  });
});

els.joinBtn.addEventListener("click", () => {
  const name = els.roomInput.value.trim();
  if (name === "") return;
  clearError();
  window.app.joinRoom(name).catch((err: unknown) => {
    showError(`join failed: ${(err as Error).message}`);
  });
});

els.roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.joinBtn.click();
});

els.leaveBtn.addEventListener("click", () => {
  clearError();
  window.app.leaveRoom().catch((err: unknown) => {
    showError(`leave failed: ${(err as Error).message}`);
  });
});

els.chatSend.addEventListener("click", () => {
  const body = els.chatInput.value;
  if (body === "") return;
  els.chatInput.value = "";
  clearError();
  window.app.sendChat(body).catch((err: unknown) => {
    showError(`send failed: ${(err as Error).message}`);
  });
});

els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.chatSend.click();
});

let muted = false;
els.muteBtn.addEventListener("click", () => {
  muted = !muted;
  setMuted(muted);
  els.muteBtn.textContent = muted ? "🔇 Unmute" : "🎙 Mute";
});
