<script lang="ts">
  let {
    themePref,
    onSetTheme,
    onClose,
  }: {
    themePref: 'system' | 'light' | 'dark';
    onSetTheme: (pref: 'system' | 'light' | 'dark') => void;
    onClose: () => void;
  } = $props();

  type DeviceKind = 'camera' | 'microphone' | 'speaker';
  interface DeviceEntry { id: string; label: string; }

  let availDevices = $state<Record<DeviceKind, DeviceEntry[]>>({
    camera: [],
    microphone: [],
    speaker: [],
  });

  let selectedIds = $state<Record<DeviceKind, string>>({
    camera: localStorage.getItem('pkvc:dev:camera') ?? '',
    microphone: localStorage.getItem('pkvc:dev:microphone') ?? '',
    speaker: localStorage.getItem('pkvc:dev:speaker') ?? '',
  });

  let popEl = $state<HTMLDivElement | null>(null);

  function setDevice(kind: DeviceKind, id: string) {
    selectedIds[kind] = id;
    localStorage.setItem('pkvc:dev:' + kind, id);
  }

  function refreshDevices() {
    navigator.mediaDevices?.enumerateDevices().then((list) => {
      availDevices = {
        camera: list
          .filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
        microphone: list
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
        speaker: list
          .filter((d) => d.kind === 'audiooutput')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` })),
      };
      // pick first as default if nothing stored yet
      for (const kind of ['camera', 'microphone', 'speaker'] as const) {
        if (!selectedIds[kind] && availDevices[kind][0]) {
          setDevice(kind, availDevices[kind][0].id);
        }
      }
    }).catch(() => {
      // mediaDevices unavailable (no permission yet; labels empty until granted)
    });
  }

  $effect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
    };
  });

  $effect(() => {
    const onDown = (e: MouseEvent) => {
      if (popEl && !popEl.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  });
</script>

<div class="settings-pop" bind:this={popEl}>
  <div class="settings-pop-title">Appearance</div>
  <div class="settings-seg">
    {#each (['system', 'light', 'dark'] as const) as opt}
      <button
        type="button"
        data-on={themePref === opt ? '1' : '0'}
        onclick={() => onSetTheme(opt)}
      >
        {opt[0].toUpperCase() + opt.slice(1)}
      </button>
    {/each}
  </div>
  <div class="settings-sep"></div>
  <div class="settings-pop-title">Devices</div>

  {#each (['camera', 'microphone', 'speaker'] as const) as kind}
    {@const entries = availDevices[kind]}
    {@const kindLabel = kind[0].toUpperCase() + kind.slice(1)}
    <label class="settings-row">
      <span class="settings-row-label">{kindLabel}</span>
      {#if entries.length === 0}
        <span style="color:var(--fg-3);font-size:12px;flex:1;text-align:right;padding-right:4px">
          No devices found
        </span>
      {:else}
        <select
          class="settings-row-select"
          value={selectedIds[kind]}
          onchange={(e) => setDevice(kind, (e.target as HTMLSelectElement).value)}
        >
          {#each entries as d (d.id)}
            <option value={d.id}>{d.label}</option>
          {/each}
        </select>
      {/if}
    </label>
  {/each}

  <div class="settings-foot">Device settings apply to the next room you join.</div>
</div>
