import { Encoder, Decoder } from "cbor-x";
import type { AgentId } from "@peerkit/api";

export const MsgType = {
  RoomJoin: 1,
  RoomLeave: 2,
  RoomRoster: 3,
  ChatMsg: 4,
  WebRtcOffer: 5,
  WebRtcAnswer: 6,
  WebRtcIce: 7,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

export interface RosterEntry {
  agentId: AgentId;
  displayName: string;
}

interface EnvelopeBase {
  v: 1;
  from: AgentId;
  room: string;
  ts: number;
}

export interface RoomJoinMsg extends EnvelopeBase {
  type: typeof MsgType.RoomJoin;
  displayName: string;
}

export interface RoomLeaveMsg extends EnvelopeBase {
  type: typeof MsgType.RoomLeave;
}

export interface RoomRosterMsg extends EnvelopeBase {
  type: typeof MsgType.RoomRoster;
  members: RosterEntry[];
}

export interface ChatMsg extends EnvelopeBase {
  type: typeof MsgType.ChatMsg;
  body: string;
}

// Serializable payload carried over IPC and embedded in WebRTC envelope types.
export type WebRtcSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: string }; // JSON-encoded RTCIceCandidateInit

export interface WebRtcOfferMsg extends EnvelopeBase {
  type: typeof MsgType.WebRtcOffer;
  sdp: string;
}

export interface WebRtcAnswerMsg extends EnvelopeBase {
  type: typeof MsgType.WebRtcAnswer;
  sdp: string;
}

export interface WebRtcIceMsg extends EnvelopeBase {
  type: typeof MsgType.WebRtcIce;
  candidate: string;
}

export type Envelope =
  | RoomJoinMsg
  | RoomLeaveMsg
  | RoomRosterMsg
  | ChatMsg
  | WebRtcOfferMsg
  | WebRtcAnswerMsg
  | WebRtcIceMsg;

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ useRecords: false });

// Hard cap on inbound frame size. Envelopes are small (chat lines, rosters);
// reject anything larger before handing it to cbor-x so an oversized peer
// frame can't drive CPU/memory pressure in the decoder.
const MAX_ENVELOPE_BYTES = 64 * 1024;

export function encode(envelope: Envelope): Uint8Array {
  return encoder.encode(envelope);
}

export function decode(bytes: Uint8Array): Envelope | null {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) return null;
  let raw: unknown;
  try {
    raw = decoder.decode(bytes);
  } catch {
    return null;
  }
  return validate(raw);
}

function validate(raw: unknown): Envelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (r["v"] !== 1) return null;
  if (typeof r["from"] !== "string") return null;
  if (typeof r["room"] !== "string") return null;
  if (typeof r["ts"] !== "number") return null;

  switch (r["type"]) {
    case MsgType.RoomJoin:
      if (typeof r["displayName"] !== "string") return null;
      return r as unknown as RoomJoinMsg;
    case MsgType.RoomLeave:
      return r as unknown as RoomLeaveMsg;
    case MsgType.RoomRoster: {
      if (!Array.isArray(r["members"])) return null;
      for (const m of r["members"]) {
        if (m === null || typeof m !== "object") return null;
        const e = m as Record<string, unknown>;
        if (typeof e["agentId"] !== "string") return null;
        if (typeof e["displayName"] !== "string") return null;
      }
      return r as unknown as RoomRosterMsg;
    }
    case MsgType.ChatMsg:
      if (typeof r["body"] !== "string") return null;
      return r as unknown as ChatMsg;
    case MsgType.WebRtcOffer:
    case MsgType.WebRtcAnswer:
      if (typeof r["sdp"] !== "string") return null;
      return r as unknown as WebRtcOfferMsg | WebRtcAnswerMsg;
    case MsgType.WebRtcIce:
      if (typeof r["candidate"] !== "string") return null;
      return r as unknown as WebRtcIceMsg;
    default:
      return null;
  }
}
