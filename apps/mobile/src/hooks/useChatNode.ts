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
import { agentKeyStore } from "../storage";
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
  // Bumped on every start()/shutDown(); a completion whose captured generation
  // no longer matches is stale and must not touch nodeRef/state.
  const startGenRef = useRef(0);
  const [state, setState] = useState<ChatState>(INITIAL_CHAT_STATE);

  const sendSignal = useCallback(async (toAgent: string, signal: WebRtcSignal) => {
    await nodeRef.current?.sendSignal(toAgent, signal);
  }, []);

  const shutDown = useCallback(async () => {
    startGenRef.current += 1;
    await nodeRef.current?.shutDown();
    nodeRef.current = null;
    setState(INITIAL_CHAT_STATE);
  }, []);

  const start = useCallback(
    async (displayName: string, onSignal: (fromAgent: string, signal: WebRtcSignal) => void) => {
      const gen = (startGenRef.current += 1);
      const isCurrent = () => gen === startGenRef.current;

      const relay = configuredRelayMultiaddr();
      if (relay === "") {
        const error = "Set expo.extra.relayMultiaddr to a webrtc-direct relay multiaddr.";
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
          agentKeyStore,
          events: {
            onState: (room) => {
              if (!isCurrent()) return;
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
              if (!isCurrent()) return;
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
            onSignal: (fromAgent, signal) => {
              if (!isCurrent()) return;
              onSignal(fromAgent, signal);
            },
            // Remote camera on/off is not yet surfaced in the mobile call UI;
            // accept the event so the room contract is satisfied.
            onMediaState: () => {},
          },
          onNetworkRooms: (networkRooms) => {
            if (!isCurrent()) return;
            setState((prev) => ({ ...prev, networkRooms }));
          },
          onPeerStats: (peerStats) => {
            if (!isCurrent()) return;
            setState((prev) => ({ ...prev, peerStats }));
          },
          onRelayConnected: () => {
            if (!isCurrent()) return;
            setState((prev) => ({ ...prev, relayConnected: true }));
          },
          transportFactory: (options) =>
            createReactNativeNode({
              ...options,
              iceServerUrls: configuredIceServerUrls(),
              // libp2p's React Native gater otherwise refuses to dial peers
              // and a relay on LAN private addresses. Permit those dials for
              // development only; production keeps the secure default gater.
              ...(__DEV__
                ? { connectionGater: { denyDialMultiaddr: async () => false } }
                : {}),
            }),
        });
        if (!isCurrent()) {
          // A newer start() (or shutDown()) superseded this one while we were
          // awaiting. Tear down the orphan node and discard its state writes.
          await node.shutDown();
          return;
        }
        nodeRef.current = node;
        setState((prev) => ({
          ...prev,
          agentId: node.agentId,
          status: "online",
          error: "",
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Failed to start mobile node.";
        if (isCurrent()) {
          setState((prev) => ({
            ...prev,
            status: "error",
            error: message,
          }));
        }
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
