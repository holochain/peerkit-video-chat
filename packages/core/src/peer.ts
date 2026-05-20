import type { AgentId } from "@peerkit/api";
import { PeerkitNodeBuilder, type PeerkitNode } from "@peerkit/peerkit";

export interface PeerOptions {
  id: string;
  listenAddress?: string;
  onMessage?: (fromAgent: AgentId, text: string) => void;
}

export interface Peer {
  node: PeerkitNode;
  agentId: AgentId;
  listenAddress?: string;
  sendText(toAgent: AgentId, text: string): Promise<void>;
  connect(remoteAddress: string): Promise<void>;
  shutDown(): Promise<void>;
}

export async function startPeer(options: PeerOptions): Promise<Peer> {
  const builder = new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async (fromAgent, data) => {
      const text = new TextDecoder().decode(data);
      options.onMessage?.(fromAgent, text);
    },
  }).withId(options.id);

  if (options.listenAddress !== undefined) {
    builder.withAddresses([options.listenAddress]);
  }

  const node = await builder.build();

  return {
    node,
    agentId: node.keyPair.agentId(),
    listenAddress: options.listenAddress,
    async sendText(toAgent, text) {
      await node.send(toAgent, new TextEncoder().encode(text));
    },
    async connect(remoteAddress) {
      await node.transport.connect(remoteAddress);
    },
    async shutDown() {
      await node.shutDown();
    },
  };
}
