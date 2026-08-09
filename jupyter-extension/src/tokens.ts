import { Token } from '@lumino/coreutils';

import type { LearnerKernel } from './kernelSession.js';
import type { LearnerRuntime } from './runtime.js';
import type { LearnerSession } from './session.js';
import type { LearnerSettingsSource } from './types.js';

/* The one thing every other plugin needs: the model, the Python behind it,
 *  and the settings both read. It lives apart from types.ts because a Token
 *  is a JupyterLab concept and types.ts is deliberately framework-free — the
 *  session model and the runtime have to compile without ever learning that
 *  JupyterLab exists. */

export interface ILearnerWorkbench {
  /** The state every surface renders. */
  readonly session: LearnerSession;
  /** The kernel that state lives in, started lazily. */
  readonly kernel: LearnerKernel;
  /** The protocol on top of that kernel. */
  readonly runtime: LearnerRuntime;
  readonly settings: LearnerSettingsSource;
}

export const ILearnerWorkbench = new Token<ILearnerWorkbench>(
  'scikit-learner-jupyter:ILearnerWorkbench',
  'The Scikit-Learner session, its kernel and its settings.'
);
