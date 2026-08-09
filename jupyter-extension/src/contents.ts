import type { Contents } from '@jupyterlab/services';

/* ------------------------------------------------------------------ *
 *  The contents manager, in the four shapes this extension needs.     *
 *                                                                     *
 *  The VS Code extension reaches for vscode.workspace.fs and          *
 *  showSaveDialog. Neither exists here, and the substitution is not   *
 *  cosmetic: in JupyterLite there is no filesystem at all, only an    *
 *  in-browser contents manager. Everything — reading the CSV the user *
 *  picked, writing pipeline.py, saving a joblib — goes through this   *
 *  one interface, so the extension behaves identically whether the    *
 *  files live on a disk or in IndexedDB.                              *
 * ------------------------------------------------------------------ */

/** Read a file as base64, whatever its bytes are.
 *
 *  Deliberately not `format: 'text'`: that decodes as UTF-8 and replaces
 *  anything that is not, so a CSV exported from Excel in latin-1 would reach
 *  pandas with mojibake in its column names. Base64 hands the bytes to
 *  learner.py untouched, which is the same contract as the web app's
 *  `pyCallBinary` and the VS Code extension's `buf` field.
 */
export async function readBase64(contents: Contents.IManager, path: string): Promise<string> {
  const model = await contents.get(path, { content: true, type: 'file', format: 'base64' });
  return String(model.content ?? '');
}

export async function writeText(
  contents: Contents.IManager,
  path: string,
  text: string
): Promise<Contents.IModel> {
  await ensureDirectory(contents, parentOf(path));
  return contents.save(path, { type: 'file', format: 'text', content: text });
}

export async function writeBase64(
  contents: Contents.IManager,
  path: string,
  b64: string
): Promise<Contents.IModel> {
  await ensureDirectory(contents, parentOf(path));
  return contents.save(path, { type: 'file', format: 'base64', content: b64 });
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export function joinPath(...parts: string[]): string {
  return parts.filter(part => part !== '').join('/');
}

/** Create `path` and every missing directory above it. No-op for ''.
 *
 *  The contents API has no mkdir: `newUntitled` picks the name and you rename
 *  afterwards. Doing that per level is the whole of this function.
 */
export async function ensureDirectory(contents: Contents.IManager, path: string): Promise<void> {
  if (!path) {
    return;
  }
  const segments = path.split('/').filter(Boolean);
  let sofar = '';
  for (const segment of segments) {
    const parent = sofar;
    sofar = joinPath(sofar, segment);
    try {
      await contents.get(sofar, { content: false });
      continue;
    } catch {
      /* Not there — or not readable, in which case creating it will fail with
         the more informative error anyway.

         This is the one place the extension puts a red line in the browser's
         network log: asking is a GET, and "no such directory" is a 404. There
         is no HEAD or exists() on the contents API, so the 404 IS the answer.
         It happens once per directory per artifact write. */
    }
    const created = await contents.newUntitled({ path: parent, type: 'directory' });
    await contents.rename(created.path, sofar);
  }
}

/** The delimited-text files in one directory, newest listing order preserved
 *  as the server gave it and then sorted by name. Mirrors the VS Code
 *  extension's `workspace.findFiles('**​/*.csv')`, minus the recursion: a
 *  contents manager has no glob, and walking a whole tree over HTTP for a
 *  picker that shows twelve entries is not a trade worth making. */
export async function listTables(
  contents: Contents.IManager,
  directory: string,
  limit = 50
): Promise<{ path: string; name: string }[]> {
  let listing: Contents.IModel;
  try {
    listing = await contents.get(directory || '', { content: true });
  } catch {
    return [];
  }
  const children = (listing.content as Contents.IModel[] | null) ?? [];
  return children
    .filter(child => child.type === 'file' && /\.(csv|tsv)$/i.test(child.name))
    .slice(0, limit)
    .map(child => ({ path: child.path, name: child.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
