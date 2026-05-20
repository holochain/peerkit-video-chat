const selfEl = document.getElementById("self") as HTMLDivElement;
const remoteAddressInput = document.getElementById(
  "remote-address",
) as HTMLInputElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const toAgentInput = document.getElementById("to-agent") as HTMLInputElement;
const msgInput = document.getElementById("msg") as HTMLInputElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const logEl = document.getElementById("log") as HTMLPreElement;

function log(line: string): void {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function bootstrap(): Promise<void> {
  try {
    if (window.peer === undefined) {
      throw new Error("preload bridge missing: window.peer is undefined");
    }
    const port = 31_000 + Math.floor(Math.random() * 1_000);
    const listenAddress = `/ip4/127.0.0.1/tcp/${port}`;
    const { agentId } = await window.peer.start(listenAddress);
    selfEl.textContent = `agentId=${agentId} listening=${listenAddress}`;
    log(`peer started: ${agentId}`);
    log(`listening on ${listenAddress}`);
    connectBtn.disabled = false;
    sendBtn.disabled = false;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    selfEl.textContent = `peer failed to start: ${msg}`;
    log(`startup error: ${msg}`);
    console.error(err);
  }
}

connectBtn.addEventListener("click", () => {
  void (async () => {
    const remote = remoteAddressInput.value.trim();
    if (remote === "") return;
    try {
      await window.peer.connect(remote);
      log(`connected to ${remote}`);
    } catch (err) {
      log(`connect failed: ${(err as Error).message}`);
    }
  })();
});

sendBtn.addEventListener("click", () => {
  void (async () => {
    const to = toAgentInput.value.trim();
    const text = msgInput.value;
    if (to === "" || text === "") return;
    try {
      await window.peer.send(to, text);
      log(`-> ${to.slice(0, 12)}…: ${text}`);
      msgInput.value = "";
    } catch (err) {
      log(`send failed: ${(err as Error).message}`);
    }
  })();
});

window.peer.onMessage(({ fromAgent, text }) => {
  log(`<- ${fromAgent.slice(0, 12)}…: ${text}`);
});

void bootstrap();
