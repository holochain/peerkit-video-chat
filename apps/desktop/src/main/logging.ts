// Logging bootstrap for the main process.
//
// IMPORTANT: this module must be imported *first* in main/index.ts. Its
// top-level code sets process.env.DEBUG before @peerkit-video-chat/core (and so
// libp2p / weald) is imported — weald reads DEBUG when its logger is created, so
// setting it after the import would be too late.
//
// Two logging pipelines are wired up so testers running the packaged app — who
// won't have a terminal — still get useful diagnostics in a file:
//   - peerkit logs through @logtape/logtape, which is silent until configured.
//   - libp2p logs through weald/debug, gated by the DEBUG env var.
// Both, plus our own console.* and the renderer's forwarded logs, are tee'd into
// a single rotating-per-session log file.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";

import { enable as enableLibp2pLogs } from "@libp2p/logger";
import {
  configure,
  getConsoleSink,
  defaultTextFormatter,
  type LogLevel,
} from "@logtape/logtape";

// Enable libp2p (weald/debug) namespaces unless the user already chose some.
// Default to all libp2p channels minus the very chatty per-channel trace level.
// NOTE: setting process.env.DEBUG here is best-effort — in the bundled main
// process the external libp2p/weald modules may have already parsed DEBUG before
// this runs, so the authoritative enable is the runtime enableLibp2pLogs() call
// in initLogging() (which happens before the node, and its loggers, are built).
if (process.env["DEBUG"] === undefined || process.env["DEBUG"].trim() === "") {
  process.env["DEBUG"] = "libp2p:*,-*:trace";
}

const VALID_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
];

function peerkitLevel(): LogLevel {
  const raw = process.env["PEERKIT_LOG_LEVEL"]?.trim().toLowerCase();
  return VALID_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : "info";
}

let fileStream: WriteStream | undefined;
let logDir: string | undefined;
let logFile: string | undefined;

/** The canonical per-OS logs directory in use (set once initLogging runs). */
export function getLogDir(): string | undefined {
  return logDir;
}

/** Full path to the current session's log file (set once initLogging runs). */
export function getLogFile(): string | undefined {
  return logFile;
}

/** Append a line straight to the log file (no stdout, to avoid the tee echo). */
function writeFile(line: string): void {
  fileStream?.write(line.endsWith("\n") ? line : line + "\n");
}

// Matches ANSI escape sequences (colour/formatting codes) that weald/debug emit
// when stderr is a TTY. Readable in a terminal, but garbage in a log file.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

// Mirror a writable stream's output into the log file while preserving its
// normal behaviour. Captures our own console.*, peerkit (logtape → console) and
// libp2p (weald → stderr) without each pipeline needing its own file sink. ANSI
// codes are stripped from the file copy only; the live terminal keeps colour.
function teeStream(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString("utf8")
            : undefined;
      if (text !== undefined) fileStream?.write(text.replace(ANSI_RE, ""));
    } catch {
      // Never let a logging failure break real output.
    }
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write;
}

/**
 * Open the session log file, start tee-ing stdout/stderr into it, and configure
 * logtape so peerkit logs are no longer discarded. Returns the log file path.
 *
 * `logsDir` should be the OS-canonical logs directory (Electron's
 * `app.getPath("logs")`): `~/Library/Logs/<app>` on macOS, `<userData>/logs`
 * elsewhere.
 */
export async function initLogging(logsDir: string): Promise<string> {
  const dir = logsDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "main.log");
  logDir = dir;
  logFile = path;

  // Rotate so the file name stays stable (findable via Open Logs Folder) while
  // bounding growth: keep the current session as main.log and the previous one
  // as main.log.1. A single append-only file would grow without limit; per-
  // session filenames would instead grow the file count without limit.
  try {
    if (existsSync(path)) renameSync(path, join(dir, "main.log.1"));
  } catch {
    // Best effort — fall through and just open (truncating) the current file.
  }
  fileStream = createWriteStream(path, { flags: "w" });
  writeFile(`\n=== session start ${new Date().toISOString()} ===`);
  writeFile(`DEBUG=${process.env["DEBUG"] ?? ""}  PEERKIT_LOG_LEVEL=${peerkitLevel()}`);

  teeStream(process.stdout);
  teeStream(process.stderr);

  // Authoritatively turn on libp2p logging at runtime, before the node's loggers
  // are created (node build happens later, on chat:init). Respects a user-set
  // DEBUG; otherwise applies our default from the top of this module.
  try {
    enableLibp2pLogs(process.env["DEBUG"] ?? "libp2p:*,-*:trace");
  } catch {
    // weald not present / signature change — DEBUG env still applies as fallback.
  }

  await configure({
    reset: true,
    sinks: {
      // Console sink with a plain text formatter (no ANSI) so the tee'd file
      // stays clean; the line still prints to the terminal in dev.
      console: getConsoleSink({ formatter: defaultTextFormatter }),
    },
    loggers: [
      { category: ["peerkit"], lowestLevel: peerkitLevel(), sinks: ["console"] },
      // Silence logtape's own "no configuration" meta warnings.
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["console"] },
    ],
  });

  return path;
}

// Strip control characters (newlines, CR, etc.) from untrusted log fields so a
// peer-supplied display name or message can't forge extra log lines on disk.
function sanitizeLogField(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** Record a log line forwarded from the renderer (webrtc / UI diagnostics). */
export function appendRendererLog(level: string, line: string): void {
  // File only: the renderer already shows these in its own DevTools console, and
  // echoing to stdout here would duplicate them in the file via the tee.
  writeFile(
    `${new Date().toISOString()} [renderer:${sanitizeLogField(level)}] ${sanitizeLogField(line)}`,
  );
}

/** Flush and close the log file on shutdown. */
export function closeLogging(): void {
  fileStream?.end();
  fileStream = undefined;
}
