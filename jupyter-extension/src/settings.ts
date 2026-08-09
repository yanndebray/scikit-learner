import { Signal } from '@lumino/signaling';

import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { PartialJSONValue, ReadonlyPartialJSONObject } from '@lumino/coreutils';

import { DEFAULT_SETTINGS, SETTINGS_PLUGIN_ID } from './types.js';
import type { LearnerSettings, LearnerSettingsSource } from './types.js';

/* ------------------------------------------------------------------ *
 *  ISettingRegistry, coerced.                                         *
 *                                                                     *
 *  A settings file is user-editable JSON. The schema validator stops  *
 *  most nonsense, but a file written against an older schema still    *
 *  loads, and one bad value must never take a plugin down — every     *
 *  field is narrowed and clamped against DEFAULT_SETTINGS first.      *
 * ------------------------------------------------------------------ */

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

export function coerceSettings(raw: ReadonlyPartialJSONObject | null | undefined): LearnerSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    kernelName: str(o.kernelName, DEFAULT_SETTINGS.kernelName).trim(),
    autoInstall: bool(o.autoInstall, DEFAULT_SETTINGS.autoInstall),
    /* One fold is not cross-validation and cross_val_score refuses it; the
       upper bound guards a typo rather than recommending twenty. */
    cvFolds: Math.floor(num(o.cvFolds, DEFAULT_SETTINGS.cvFolds, 2, 20)),
    /* Leading and trailing slashes would produce '//pipeline.py' or an
       absolute path the contents manager rejects. */
    outputDir: str(o.outputDir, DEFAULT_SETTINGS.outputDir).trim().replace(/^\/+|\/+$/g, '')
  };
}

class RegistrySettings implements LearnerSettingsSource {
  private _current: LearnerSettings;
  private readonly _changed = new Signal<this, LearnerSettings>(this);

  constructor(private readonly _settings: ISettingRegistry.ISettings) {
    this._current = coerceSettings(_settings.composite);
    _settings.changed.connect(() => {
      this._current = coerceSettings(this._settings.composite);
      this._changed.emit(this._current);
    });
  }

  get current(): LearnerSettings {
    return this._current;
  }

  get changed(): Signal<this, LearnerSettings> {
    return this._changed;
  }

  async set<K extends keyof LearnerSettings>(key: K, value: LearnerSettings[K]): Promise<void> {
    await this._settings.set(key as string, value as PartialJSONValue);
  }
}

/** What we fall back to when there is no registry, or its schema failed to
 *  load. It still remembers a change for the session, so a command that sets
 *  one does something visible instead of quietly doing nothing. */
class MemorySettings implements LearnerSettingsSource {
  private _current: LearnerSettings = { ...DEFAULT_SETTINGS };
  private readonly _changed = new Signal<this, LearnerSettings>(this);

  get current(): LearnerSettings {
    return this._current;
  }

  get changed(): Signal<this, LearnerSettings> {
    return this._changed;
  }

  async set<K extends keyof LearnerSettings>(key: K, value: LearnerSettings[K]): Promise<void> {
    this._current = coerceSettings({
      ...this._current,
      [key]: value
    } as unknown as ReadonlyPartialJSONObject);
    this._changed.emit(this._current);
  }
}

export async function loadSettings(
  registry: ISettingRegistry | null | undefined
): Promise<LearnerSettingsSource> {
  if (!registry) {
    return new MemorySettings();
  }
  try {
    return new RegistrySettings(await registry.load(SETTINGS_PLUGIN_ID));
  } catch (err) {
    /* A missing schema means the labextension was built without schemaDir, or
       the plugin id and the schema filename have drifted apart. Neither is
       worth failing activation over — every default is usable. */
    console.warn(`scikit-learner: could not load ${SETTINGS_PLUGIN_ID} settings`, err);
    return new MemorySettings();
  }
}
