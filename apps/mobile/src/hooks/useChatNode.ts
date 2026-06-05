import {
  type ChatNode,
  MESH_RECOMMENDED_MAX,
  exceedsMeshRecommendation,
  startChatNode,
  type WebRtcSignal,
} from "@peerkit-video-chat/core";
import { createNode as createReactNativeNode } from "@peerkit/transport-libp2p-react-native";
import { useCallback, useRef, useState } from "react";
import { configuredIceServerUrls, configuredRelayMultiaddr } from "../config";
import type { ChatState } from "../types";

const INITIAL_CHAT_STATE: ChatState = {
  agentId: "",
  status: "idle",
  error: "",
  relayAddr: "",
  relayConnected: false,
  peerStats: null,
  room: { kind: "idle" },
  networkRooms: [],
  chatMessages: [],
};

export interface UseChatNodeResult {
  state: ChatState;
  start(displayName: string, onSignal: (fromAgent: string, signal: WebRtcSignal) => void): Promise<void>;
  joinRoom(roomName: string): Promise<void>;
  leaveRoom(): Promise<void>;
  sendChat(body: string): Promise<void>;
  sendSignal(toAgent: string, signal: WebRtcSignal): Promise<void>;
  setDisplayName(name: string): void;
  shutDown(): Promise<void>;
}

export function useChatNode(): UseChatNodeResult {
  const nodeRef = useRef<ChatNode | null>(null);
  const [state, setState] = useState<ChatState>(INITIAL_CHAT_STATE);

  const sendSignal = useCallback(async (toAgent: string, signal: WebRtcSignal) => {
    await nodeRef.current?.sendSignal(toAgent, signal);
  }, []);

  const shutDown = useCallback(async () => {
    await nodeRef.current?.shutDown();
    nodeRef.current = null;
    setState(INITIAL_CHAT_STATE);
  }, []);

  const start = useCallback(
    async (displayName: string, onSignal: (fromAgent: string, signal: WebRtcSignal) => void) => {
      const relay = configuredRelayMultiaddr();
      if (relay === "") {
        const error = "Set expo.extra.relayMultiaddr to a secure wss relay multiaddr.";
        setState((prev) => ({
          ...prev,
          status: "error",
          error,
        }));
        throw new Error(error);
      }

      await nodeRef.current?.shutDown();
      nodeRef.current = null;
      setState({
        ...INITIAL_CHAT_STATE,
        status: "starting",
        relayAddr: relay,
      });
      try {
        const node = await startChatNode({
          bootstrapRelays: [relay],
          displayName,
          events: {
            onState: (room) => {
              setState((prev) => ({ ...prev, room }));
              if (
                room.kind === "inRoom" &&
                exceedsMeshRecommendation(room.members.length)
              ) {
                console.warn(
                  `Room has ${room.members.length} members; recommended max is ${MESH_RECOMMENDED_MAX}`,
                );
              }
            },
            onChat: (incoming) => {
              setState((prev) => ({
                ...prev,
                chatMessages: [
                  ...prev.chatMessages,
                  {
                    id: `${incoming.ts}-${incoming.from}-${prev.chatMessages.length}`,
                    agentId: incoming.from,
                    displayName: incoming.displayName,
                    body: incoming.body,
                    t: incoming.ts,
                  },
                ],
              }));
            },
            onSignal,
          },
          onNetworkRooms: (networkRooms) => {
            setState((prev) => ({ ...prev, networkRooms }));
          },
          onPeerStats: (peerStats) => {
            setState((prev) => ({ ...prev, peerStats }));
          },
          onRelayConnected: () => {
            setState((prev) => ({ ...prev, relayConnected: true }));
          },
          transportFactory: (options) =>
            createReactNativeNode({
              ...options,
              iceServerUrls: configuredIceServerUrls(),
              // libp2p's React Native gater otherwise refuses to dial the
              // cleartext demo relay (insecure `/ws`) and LAN peers (private
              // addresses). Permit both for development. A production `wss`
              // deployment should drop this and keep the secure default.
              connectionGater: { denyDialMultiaddr: async () => false },
            }),
        });
        nodeRef.current = node;
        setState((prev) => ({
          ...prev,
          agentId: node.agentId,
          status: "online",
          error: "",
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Failed to start mobile node.";
        setState((prev) => ({
          ...prev,
          status: "error",
          error: message,
        }));
        throw new Error(message);
      }
    },
    [],
  );

  const joinRoom = useCallback(async (roomName: string) => {
    await nodeRef.current?.room.join(roomName);
  }, []);

  const leaveRoom = useCallback(async () => {
    await nodeRef.current?.room.leave();
    setState((prev) => ({ ...prev, chatMessages: [] }));
  }, []);

  const sendChat = useCallback(async (body: string) => {
    await nodeRef.current?.room.sendChat(body);
  }, []);

  const setDisplayName = useCallback((name: string) => {
    nodeRef.current?.setDisplayName(name);
  }, []);

  return {
    state,
    start,
    joinRoom,
    leaveRoom,
    sendChat,
    sendSignal,
    setDisplayName,
    shutDown,
  };
}
