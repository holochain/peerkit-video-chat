// Renderer-side logging. Mirrors a line to the DevTools console (for live dev)
// and forwards it to the main process so it lands in the shared log file — the
// packaged app has no terminal, and webrtc/connection diagnostics live here in
// the renderer.

type Level = "info" | "warn" | "error";

export function rendererLog(level: Level, message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
  try {
    window.app.log(level, message);
  } catch {
    // No bridge (e.g. in a test harness) — console output already happened.
  }
}
