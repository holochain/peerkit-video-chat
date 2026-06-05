/**
 * Browser binding for the shared media controller.
 *
 * Supplies the WHATWG WebRTC constructors, `navigator.mediaDevices.getUserMedia`,
 * and a Web Audio (`AudioContext` + `AnalyserNode`) speaking detector. All call
 * logic — the recovery ladder, DTLS watchdog, candidate buffering — lives in
 * {@link SharedMediaController}; this file only wires platform globals to it.
 */

import type {
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
} from "./index.js";
import {
  SharedMediaController,
  type MediaPlatform,
  type SpeakingDetector,
  type SpeakingSource,
} from "./peer-connection.js";

export type {
  MediaAccess,
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
  SpeakingCallback,
  StreamCallback,
} from "./index.js";

/** Speaking detection via AudioContext + AnalyserNode (read off the stream). */
class AudioContextSpeakingDetector implements SpeakingDetector {
  private audioCtx: AudioContext | null = null;
  // Cleanup functions for per-agent AnalyserNode loops (keyed by agentId, incl. "self").
  private readonly cleanups = new Map<string, () => void>();

  private getCtx(): AudioContext {
    if (this.audioCtx === null) this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
    return this.audioCtx;
  }

  start(
    agentId: string,
    source: SpeakingSource,
    onChange: (speaking: boolean) => void,
  ): void {
    const ctx = this.getCtx();
    const node = ctx.createMediaStreamSource(source.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    // Smooth rapidly to reduce flicker without hiding speech bursts.
    analyser.smoothingTimeConstant = 0.4;
    node.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let smoothedRms = 0;
    let speaking = false;
    let rafId = 0;

    const tick = (): void => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const instantRms = Math.sqrt(sum / buf.length);
      // Additional smoothing on top of the native smoothingTimeConstant.
      smoothedRms = smoothedRms * 0.85 + instantRms * 0.15;

      const nowSpeaking = smoothedRms > 0.015;
      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking;
        onChange(speaking);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    this.cleanups.set(agentId, () => {
      cancelAnimationFrame(rafId);
      node.disconnect();
      if (speaking) onChange(false);
    });
  }

  stop(agentId: string): void {
    this.cleanups.get(agentId)?.();
    this.cleanups.delete(agentId);
  }

  stopAll(): void {
    for (const agentId of [...this.cleanups.keys()]) this.stop(agentId);
  }
}

function webPlatform(): MediaPlatform {
  return {
    RTCPeerConnection,
    RTCIceCandidate,
    MediaStream: MediaStream as new () => MediaStreamLike,
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    speaking: new AudioContextSpeakingDetector(),
  };
}

export function createMediaController(deps: MediaControllerDeps): MediaController {
  return new SharedMediaController(deps, webPlatform());
}
