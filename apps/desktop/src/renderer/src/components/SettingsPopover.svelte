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

  const DEVICE_OPTIONS = {
    camera: ['FaceTime HD Camera (built-in)', 'Logitech C920', 'OBS Virtual Camera'],
    microphone: ['MacBook Pro Microphone', 'AirPods Pro', 'Shure MV7'],
    speaker: ['MacBook Pro Speakers', 'AirPods Pro', 'External Display Audio'],
  };

  let popEl = $state<HTMLDivElement | null>(null);

  let devices = $state({
    camera: localStorage.getItem('pkvc:dev:camera') || DEVICE_OPTIONS.camera[0],
    microphone: localStorage.getItem('pkvc:dev:microphone') || DEVICE_OPTIONS.microphone[0],
    speaker: localStorage.getItem('pkvc:dev:speaker') || DEVICE_OPTIONS.speaker[0],
  });

  function setDevice(key: 'camera' | 'microphone' | 'speaker', value: string) {
    devices[key] = value;
    localStorage.setItem('pkvc:dev:' + key, value);
  }

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
  <label class="settings-row">
    <span class="settings-row-label">Camera</span>
    <select
      class="settings-row-select"
      value={devices.camera}
      onchange={(e) => setDevice('camera', (e.target as HTMLSelectElement).value)}
    >
      {#each DEVICE_OPTIONS.camera as opt}
        <option value={opt}>{opt}</option>
      {/each}
    </select>
  </label>
  <label class="settings-row">
    <span class="settings-row-label">Microphone</span>
    <select
      class="settings-row-select"
      value={devices.microphone}
      onchange={(e) => setDevice('microphone', (e.target as HTMLSelectElement).value)}
    >
      {#each DEVICE_OPTIONS.microphone as opt}
        <option value={opt}>{opt}</option>
      {/each}
    </select>
  </label>
  <label class="settings-row">
    <span class="settings-row-label">Speaker</span>
    <select
      class="settings-row-select"
      value={devices.speaker}
      onchange={(e) => setDevice('speaker', (e.target as HTMLSelectElement).value)}
    >
      {#each DEVICE_OPTIONS.speaker as opt}
        <option value={opt}>{opt}</option>
      {/each}
    </select>
  </label>
  <div class="settings-foot">Device settings apply to the next room you join.</div>
</div>
