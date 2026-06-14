export type LogLevel = "debug" | "info" | "warn" | "error";

const severity: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel) {
    this.level = level;
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (severity[level] < severity[this.level]) return;
    const payload = {
      level,
      message,
      time: new Date().toISOString(),
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
