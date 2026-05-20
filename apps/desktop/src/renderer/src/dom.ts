const q = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

export const els = {
  nameModal: q<HTMLDivElement>("name-modal"),
  nameInput: q<HTMLInputElement>("name-input"),
  nameSubmit: q<HTMLButtonElement>("name-submit"),
  nameError: q<HTMLDivElement>("name-error"),

  appHeader: q<HTMLElement>("app-header"),
  appMain: q<HTMLElement>("app-main"),
  selfAgent: q<HTMLSpanElement>("self-agent"),
  nameEdit: q<HTMLInputElement>("name-edit"),
  roomLabel: q<HTMLSpanElement>("room-label"),
  leaveBtn: q<HTMLButtonElement>("leave-btn"),

  rosterPane: q<HTMLElement>("roster-pane"),
  rosterList: q<HTMLUListElement>("roster"),

  emptyPane: q<HTMLDivElement>("empty"),
  roomInput: q<HTMLInputElement>("room-input"),
  joinBtn: q<HTMLButtonElement>("join-btn"),

  chatPane: q<HTMLDivElement>("chat"),
  chatLog: q<HTMLDivElement>("chat-log"),
  chatInput: q<HTMLInputElement>("chat-input"),
  chatSend: q<HTMLButtonElement>("chat-send"),

  globalError: q<HTMLDivElement>("global-error"),
};

export function removeAllChildren(el: HTMLElement): void {
  while (el.firstChild !== null) el.removeChild(el.firstChild);
}
