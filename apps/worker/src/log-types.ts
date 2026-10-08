// The logger shape worker modules depend on (pino's `Logger` satisfies it; tests pass stubs).
// Log objects carry ids, mime, byte sizes, durations and error categories only: never photo
// bytes, EXIF values, coordinates, notes, signed URLs or credentials.
export interface WorkerLog {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
