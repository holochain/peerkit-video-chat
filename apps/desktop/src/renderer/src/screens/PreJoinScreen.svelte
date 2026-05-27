<script lang="ts">
  import AvatarMini from '../components/AvatarMini.svelte';
  import { initLocalMedia } from '../webrtc.js';

  interface RoomMember {
    agentId: string;
    displayName: string;
  }

  let {
    selfAgentId,
    selfName,
    currentRoom,
    selfMic,
    selfCam,
    activeMembers,
    onToggleAudio,
    onToggleVideo,
    onJoin,
    onBack,
  }: {
    selfAgentId: string;
    selfName: string;
    currentRoom: string | null;
    selfMic: boolean;
    selfCam: boolean;
    activeMembers: RoomMember[];
    onToggleAudio: () => void;
    onToggleVideo: () => void;
    onJoin: (audio: boolean, video: boolean) => void;
    onBack: () => void;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let micLevel = $state(0);
  let audioCtxRef: AudioContext | null = null;
  let analyserRef: AnalyserNode | null = null;
  let sourceRef: MediaStreamAudioSourceNode | null = null;
  let rafRef = 0;
  let localStream: MediaStream | null = null;

  $effect(() => {
    initLocalMedia(selfAgentId).then((stream) => {
      localStream = stream;
      startMicLevel(stream);
    }).catch(() => {
      // fallback: stream not available
    });

    return () => { stopMicLevel(); };
  });

  // Update srcObject when videoEl changes
  $effect(() => {
    if (videoEl && localStream) {
      videoEl.srcObject = localStream;
    }
  });

  function startMicLevel(stream: MediaStream) {
    stopMicLevel();
    try {
      audioCtxRef = new AudioContext();
      sourceRef = audioCtxRef.createMediaStreamSource(stream);
      analyserRef = audioCtxRef.createAnalyser();
      analyserRef.fftSize = 512;
      analyserRef.smoothingTimeConstant = 0.4;
      sourceRef.connect(analyserRef);
      const buf = new Float32Array(analyserRef.fftSize);
      let smoothed = 0;
      function tick() {
        analyserRef!.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        smoothed = smoothed * 0.85 + rms * 0.15;
        micLevel = Math.min(1, smoothed * 6);
        rafRef = requestAnimationFrame(tick);
      }
      rafRef = requestAnimationFrame(tick);
    } catch (_) {
      // AudioContext not available
    }
  }

  function stopMicLevel() {
    if (rafRef) { cancelAnimationFrame(rafRef); rafRef = 0; }
    try { sourceRef?.disconnect(); } catch (_) {}
    try { audioCtxRef?.close(); } catch (_) {}
    sourceRef = null;
    analyserRef = null;
    audioCtxRef = null;
    micLevel = 0;
  }
</script>

<div class="prejoin">
  <div class="prejoin-card">
    <div class="prejoin-head">
      <div class="info">
        <span class="label">Joining room</span>
        <h2 class="font-display">#{currentRoom}</h2>
      </div>
      <button class="prejoin-back" onclick={onBack} type="button">← back to lobby</button>
    </div>

    <div class="prejoin-preview">
      <div class="tile-content {selfCam ? '' : 'cam-off'}">
        {#if selfCam}
          <video
            bind:this={videoEl}
            autoplay
            muted
            playsinline
            style="width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)"
          ></video>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="initials">{selfName.slice(0, 2).toUpperCase()}</span>
        {/if}
      </div>
      <div class="tile-meta">
        <AvatarMini agentId={selfAgentId} size={18} withBorder={false} />
        <span class="name">{selfName}</span>
        <span class="self-tag">you</span>
      </div>
      <div style="position:absolute;top:12px;left:12px;font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;background:rgba(0,0,0,0.4);padding:3px 7px;border-radius:4px">
        preview · not broadcasting
      </div>
    </div>

    <div class="miclevel">
      <div
        class="miclevel-fill"
        style="width:{micLevel * 100}%;opacity:{selfMic ? 1 : 0.2}"
      ></div>
    </div>

    <div class="prejoin-controls">
      <button
        class="av-toggle"
        data-on={selfMic ? 'true' : 'false'}
        onclick={onToggleAudio}
        type="button"
      >
        <span class="icon-box">
          {#if selfMic}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          {:else}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3l18 18" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
              <path d="M15 12V6a3 3 0 0 0-6 0v1" />
              <path d="M19 11a7 7 0 0 1-.78 3.2" />
              <path d="M12 18v3" />
              <path d="M5 11a7 7 0 0 0 10.42 6.12" />
            </svg>
          {/if}
        </span>
        <span class="label-col">
          <span>{selfMic ? 'Microphone on' : 'Microphone off'}</span>
        </span>
      </button>
      <button
        class="av-toggle"
        data-on={selfCam ? 'true' : 'false'}
        onclick={onToggleVideo}
        type="button"
      >
        <span class="icon-box">
          {#if selfCam}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="6" width="13" height="12" rx="2" />
              <path d="M16 10l5-3v10l-5-3z" />
            </svg>
          {:else}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3l18 18" />
              <path d="M16 16H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
              <path d="M11 6h3a2 2 0 0 1 2 2v2.5" />
              <path d="M16 10l5-3v10l-3-1.8" />
            </svg>
          {/if}
        </span>
        <span class="label-col">
          <span>{selfCam ? 'Camera on' : 'Camera off'}</span>
        </span>
      </button>
    </div>

    <div class="prejoin-foot">
      <div class="note">
        {#if activeMembers.length > 0}
          <div style="display:flex;align-items:center;gap:8px">
            <div style="display:inline-flex;align-items:center">
              {#each activeMembers.slice(0, 5) as member (member.agentId)}
                <AvatarMini agentId={member.agentId} size={22} title={member.displayName} />
              {/each}
            </div>
            <span>
              {activeMembers.length}
              {activeMembers.length === 1 ? 'participant is' : 'participants are'}
              already in this room
            </span>
          </div>
        {:else}
          <span>You'll be the first one in <code>#{currentRoom}</code></span>
        {/if}
      </div>
      <button
        class="btn primary"
        onclick={() => onJoin(selfMic, selfCam)}
        type="button"
      >
        Join room
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  </div>
</div>
