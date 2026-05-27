<script lang="ts">
  import Topbar from './components/Topbar.svelte';
  import IdentityScreen from './screens/IdentityScreen.svelte';
  import LobbyScreen from './screens/LobbyScreen.svelte';
  import PreJoinScreen from './screens/PreJoinScreen.svelte';
  import CallScreen from './screens/CallScreen.svelte';
  import {
    setStreamCallback,
    setSpeakingCallback,
    setMuted,
    setCamMuted,
    handleSignal,
    closeAll,
  } from './webrtc.js';
  import { remoteStreams, speakingPeers } from './lib/stores.js';

  type Screen = 'identity' | 'lobby' | 'prejoin' | 'call';
  type ThemePref = 'system' | 'light' | 'dark';
  type ThemeResolved = 'dark' | 'light';

  interface SavedRoom {
    name: string;
    lastUsed: number;
  }

  interface RoomMember {
    agentId: string;
    displayName: string;
  }

  interface ChatMessage {
    id: string;
    agentId: string;
    displayName: string;
    body: string;
    t: number;
  }

  // ── State ───────────────────────────────────────────────────────

  let screen = $state<Screen>('identity');
  let selfName = $state('');
  let selfAgentId = $state('');
  let currentRoom = $state<string | null>(null);
  let joinTime = $state(0);
  let selfMic = $state(true);
  let selfCam = $state(true);
  interface ActiveRoom {
    name: string;
    members: Array<{ agentId: string; displayName: string }>;
  }

  let roomMembers = $state<RoomMember[]>([]);
  let chatMessages = $state<ChatMessage[]>([]);
  let savedRooms = $state<SavedRoom[]>(loadSavedRooms());
  let activeRooms = $state<ActiveRoom[]>([]);

  // Theme
  let themePref = $state<ThemePref>(
    (localStorage.getItem('pkvc:theme') as ThemePref) || 'system'
  );
  let systemDark = $state(
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  );
  const themeResolved = $derived<ThemeResolved>(
    themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref
  );

  // ── Persistence helpers ─────────────────────────────────────────

  function loadSavedRooms(): SavedRoom[] {
    try {
      return JSON.parse(localStorage.getItem('pkvc:savedRooms') ?? '[]') as SavedRoom[];
    } catch {
      return [];
    }
  }

  function persistSavedRooms(rooms: SavedRoom[]) {
    localStorage.setItem('pkvc:savedRooms', JSON.stringify(rooms));
  }

  // ── Theme setup ─────────────────────────────────────────────────

  $effect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { systemDark = mq.matches; };
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  });

  // ── WebRTC callbacks ────────────────────────────────────────────

  $effect(() => {
    setStreamCallback((agentId, stream) => {
      if (stream === null) {
        remoteStreams.update(m => {
          const n = new Map(m);
          n.delete(agentId);
          return n;
        });
      } else {
        remoteStreams.update(m => {
          const n = new Map(m);
          n.set(agentId, stream);
          return n;
        });
      }
    });

    setSpeakingCallback((agentId, speaking) => {
      speakingPeers.update(s => {
        const n = new Set(s);
        if (speaking) n.add(agentId); else n.delete(agentId);
        return n;
      });
    });
  });

  // ── IPC event handlers ──────────────────────────────────────────

  $effect(() => {
    const unsubState = window.app.onState((view) => {
      if (view.kind === 'inRoom') {
        roomMembers = view.members.map(m => ({
          agentId: m.agentId,
          displayName: m.displayName,
        }));
      } else {
        roomMembers = [];
      }
    });

    const unsubNetworkRooms = window.app.onNetworkRooms((rooms) => {
      activeRooms = rooms;
    });

    const unsubChat = window.app.onChat((incoming) => {
      chatMessages = [
        ...chatMessages,
        {
          id: 'chat-' + Date.now() + '-' + Math.random(),
          agentId: incoming.from,
          displayName: incoming.displayName,
          body: incoming.body,
          t: incoming.ts,
        },
      ];
    });

    const unsubSignal = window.app.onSignal((fromAgent, signal) => {
      handleSignal(fromAgent, signal).catch((err: unknown) => {
        console.warn('handleSignal error:', err);
      });
    });

    return () => {
      unsubState();
      unsubNetworkRooms();
      unsubChat();
      unsubSignal();
    };
  });

  // ── State machine handlers ──────────────────────────────────────

  async function onSetUsername(name: string) {
    selfName = name;
    try {
      const result = await window.app.init(name);
      selfAgentId = result.agentId;
    } catch (err) {
      console.error('Failed to init chat node:', err);
      // Use a fallback placeholder agentId so UI still works
      selfAgentId = 'pk1_' + Math.random().toString(36).slice(2, 12);
    }
    screen = 'lobby';
  }

  function onJoinRoom(roomName: string) {
    // Bump or add saved room
    const existing = savedRooms.find(r => r.name === roomName);
    if (existing) {
      savedRooms = [
        { ...existing, lastUsed: Date.now() },
        ...savedRooms.filter(r => r.name !== roomName),
      ];
    } else {
      savedRooms = [{ name: roomName, lastUsed: Date.now() }, ...savedRooms];
    }
    persistSavedRooms(savedRooms);
    currentRoom = roomName;
    screen = 'prejoin';
  }

  function onCreateRoom(roomName: string) {
    onJoinRoom(roomName);
  }

  function onRemoveSaved(name: string) {
    savedRooms = savedRooms.filter(r => r.name !== name);
    persistSavedRooms(savedRooms);
  }

  async function onConfirmJoin(audio: boolean, video: boolean) {
    selfMic = audio;
    selfCam = video;
    setMuted(!audio);
    setCamMuted(!video);
    await window.app.joinRoom(currentRoom!);
    joinTime = Date.now();
    screen = 'call';
  }

  async function onLeave() {
    try {
      await window.app.leaveRoom();
    } catch (err) {
      console.warn('leaveRoom error:', err);
    }
    closeAll();
    currentRoom = null;
    chatMessages = [];
    screen = 'lobby';
  }

  function onToggleMic() {
    selfMic = !selfMic;
    setMuted(!selfMic);
  }

  function onToggleCam() {
    selfCam = !selfCam;
    setCamMuted(!selfCam);
  }

  async function onSendChat(body: string) {
    try {
      await window.app.sendChat(body);
      // Also show in our own chat immediately (optimistic)
      chatMessages = [
        ...chatMessages,
        {
          id: 'self-chat-' + Date.now(),
          agentId: selfAgentId,
          displayName: selfName,
          body,
          t: Date.now(),
        },
      ];
    } catch (err) {
      console.warn('sendChat error:', err);
    }
  }

  function onSetTheme(pref: ThemePref) {
    themePref = pref;
    localStorage.setItem('pkvc:theme', pref);
  }
</script>

<div class="app" data-theme={themeResolved} data-density="spacious">
  {#if screen !== 'identity'}
    <Topbar
      {selfName}
      {selfAgentId}
      {themePref}
      {onSetTheme}
    />
  {/if}
  <div class="page">
    {#if screen === 'identity'}
      <IdentityScreen onContinue={onSetUsername} />
    {:else if screen === 'lobby'}
      <LobbyScreen
        {selfName}
        {savedRooms}
        {activeRooms}
        onJoin={onJoinRoom}
        onCreate={onCreateRoom}
        {onRemoveSaved}
      />
    {:else if screen === 'prejoin'}
      <PreJoinScreen
        {selfAgentId}
        {selfName}
        {currentRoom}
        {selfMic}
        {selfCam}
        activeMembers={activeRooms.find(r => r.name === currentRoom)?.members ?? []}
        onToggleAudio={onToggleMic}
        onToggleVideo={onToggleCam}
        onJoin={onConfirmJoin}
        onBack={() => { currentRoom = null; screen = 'lobby'; }}
      />
    {:else if screen === 'call'}
      <CallScreen
        {selfAgentId}
        {selfName}
        {selfMic}
        {selfCam}
        {currentRoom}
        {roomMembers}
        {joinTime}
        {chatMessages}
        {onToggleMic}
        {onToggleCam}
        {onLeave}
        onSendChat={onSendChat}
      />
    {/if}
  </div>
</div>
