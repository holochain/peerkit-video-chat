<script lang="ts">
  export interface Toast {
    id: string;
    message: string;
    kind: 'error' | 'warn';
  }

  interface Props {
    toasts: Toast[];
    onDismiss: (id: string) => void;
  }

  const { toasts, onDismiss }: Props = $props();
</script>

{#if toasts.length > 0}
  <div class="toast-stack" aria-live="assertive" aria-atomic="false">
    {#each toasts as toast (toast.id)}
      <div class="toast toast-{toast.kind}" role="alert">
        <span class="toast-msg">{toast.message}</span>
        <button
          class="toast-x"
          type="button"
          onclick={() => onDismiss(toast.id)}
          aria-label="Dismiss"
        >×</button>
      </div>
    {/each}
  </div>
{/if}
