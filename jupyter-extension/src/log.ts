import { Signal } from '@lumino/signaling';

/* ------------------------------------------------------------------ *
 *  The log.                                                           *
 *                                                                     *
 *  The VS Code extension writes to an OutputChannel, which is a       *
 *  first-class surface there and has no equivalent here. A ring       *
 *  buffer plus a command that shows it is the honest substitute: the  *
 *  point of the log is that "Training failed" in the panel has        *
 *  somewhere to point at, and that survives without a dedicated pane. *
 *                                                                     *
 *  Everything also goes to the browser console, which is where a      *
 *  developer will look first and where a user can be asked to look.   *
 * ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  /** Milliseconds since the page loaded — a wall clock would need a Date,
   *  and relative time is what you actually read in a log like this. */
  at: number;
  text: string;
}

const CAP = 500;

class Log {
  readonly changed = new Signal<Log, LogLine>(this);

  get lines(): readonly LogLine[] {
    return this._lines;
  }

  debug(text: string): void {
    this._push('debug', text);
  }
  info(text: string): void {
    this._push('info', text);
  }
  warn(text: string): void {
    this._push('warn', text);
  }
  error(text: string): void {
    this._push('error', text);
  }

  /** The whole buffer as text, for the "Show log" dialog and for copying. */
  toText(): string {
    return this._lines
      .map(line => `${(line.at / 1000).toFixed(2).padStart(8)}s  ${line.level.padEnd(5)} ${line.text}`)
      .join('\n');
  }

  private _push(level: LogLevel, text: string): void {
    const line: LogLine = { level, at: performance.now(), text };
    this._lines.push(line);
    if (this._lines.length > CAP) {
      this._lines.splice(0, this._lines.length - CAP);
    }
    const say = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    say(`[scikit-learner] ${text}`);
    this.changed.emit(line);
  }

  private readonly _lines: LogLine[] = [];
}

export const log = new Log();
