import type { LearnerRuntime } from './runtime.js';
import type { LearnerSession } from './session.js';
import type { CommandID } from './types.js';

/* ------------------------------------------------------------------ *
 *  What the panel's React tree is handed.                             *
 *                                                                     *
 *  The model plus the three things that are the *view's* and must not *
 *  go in the model: which rows are open, what the kernel last said it *
 *  was doing, and the CSV listing the empty state offers. All three   *
 *  have to survive the re-render that every model change triggers,    *
 *  which is why they live on a long-lived object rather than in React *
 *  state.                                                             *
 *                                                                     *
 *  `execute` is the only way out. Every click in the panel resolves   *
 *  to a command id — the same rule the VS Code sidebar follows, and   *
 *  what makes the command palette a complete alternative to the UI.   *
 * ------------------------------------------------------------------ */

export interface PanelContext {
  readonly session: LearnerSession;
  readonly runtime: LearnerRuntime;

  /** Delimited-text files in the current file-browser directory, for the
   *  DATASET empty state. Refreshed by the panel, not by the components. */
  tables: { path: string; name: string }[];

  /** Run keys whose metrics and hyperparameters are showing. */
  readonly expanded: Set<string>;
  /** Model categories that are folded away. */
  readonly collapsed: Set<string>;

  /** The last `::` line the kernel-side runner wrote, or null. */
  progressLine: string | null;

  execute(command: CommandID, args?: Record<string, unknown>): void;
  /** Redraw every section. Cheap — Lumino coalesces to one animation frame. */
  refresh(): void;
}
