interface LogEntry {
  level: string;
  message: string;
  timestamp: number;
}

const MAX_ENTRIES = 500;
const logs: LogEntry[] = [];

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};

function capture(level: string, args: unknown[]) {
  const message = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  logs.push({ level, message, timestamp: Date.now() });
  if (logs.length > MAX_ENTRIES) logs.shift();
}

export function startCapture() {
  console.log = (...args: unknown[]) => {
    capture("log", args);
    originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    capture("warn", args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    capture("error", args);
    originalConsole.error(...args);
  };
  console.info = (...args: unknown[]) => {
    capture("info", args);
    originalConsole.info(...args);
  };
  console.debug = (...args: unknown[]) => {
    capture("debug", args);
    originalConsole.debug(...args);
  };

  window.addEventListener("error", (event) => {
    capture("error", [`Uncaught ${event.error?.stack || event.message}`]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    capture("error", [`Unhandled rejection: ${event.reason}`]);
  });
}

export function getConsoleLogs(level?: string, limit = 50): LogEntry[] {
  let filtered = level ? logs.filter((l) => l.level === level) : logs;
  return filtered.slice(-limit);
}

export function getErrors(): LogEntry[] {
  return logs.filter((l) => l.level === "error");
}
