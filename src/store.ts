import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateArgs, type InferArgs } from '@deepseek-ai/dsh-tools';

const fileSpec = { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true }, mode: { type: 'integer', required: true } } } as const;
const manifestSpec = { version: { type: 'integer', required: true }, root: { type: 'string', required: true }, head: { type: 'string', required: true }, branch: { type: 'string', required: true }, files: { type: 'array', items: fileSpec, required: true } } as const;
export type Manifest = InferArgs<typeof manifestSpec>;
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const prefix = 'refs/dsh-rewind/';

export function git(root: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  signal.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-C', root, ...args], { env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; let exceeded = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { if (output.length + data.length > 20 * 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); } else output += data; });
    child.stderr.on('data', (data: string) => { errors = (errors + data).slice(-8000); });
    let failure: Error | undefined;
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => failure || exceeded || code !== 0 ? reject(failure ?? new Error(exceeded ? 'Git output limit exceeded' : errors || `Git exited ${code}`)) : resolvePromise(output.trimEnd()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function checked(root: string, path: string): string {
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('.git')) throw new Error('Path escapes workspace or names Git metadata');
  let cursor = root;
  for (const part of rel.split(sep)) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are unsupported'); }
  return file;
}

export function read(root: string, path: string) {
  const file = checked(root, path);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Expected a single-link regular file at most 1 MiB');
    return { path: relative(root, file), content: readFileSync(fd).toString('base64'), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export async function capture(root: string, paths: string[], signal: AbortSignal): Promise<Manifest> {
  const canonical = realpathSync(root);
  const top = await git(canonical, ['rev-parse', '--show-toplevel'], signal);
  if (realpathSync(top) !== canonical) throw new Error('Workspace must be the Git repository root');
  const head = await git(canonical, ['rev-parse', 'HEAD'], signal);
  const branch = await git(canonical, ['symbolic-ref', '-q', 'HEAD'], signal);
  if (!paths.length || paths.length > 100) throw new Error('Select 1..100 existing files explicitly');
  signal.throwIfAborted();
  const files = paths.map(path => read(canonical, path));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate paths');
  const result = { version: 1, root: canonical, head, branch, files };
  if (JSON.stringify(result).length > 8 * 1024 * 1024) throw new Error('Checkpoint exceeds 8 MiB');
  return result;
}

export async function persist(snapshot: Manifest, signal: AbortSignal): Promise<string> {
  const id = randomUUID();
  const oid = await git(snapshot.root, ['hash-object', '-w', '--stdin'], signal, JSON.stringify(snapshot));
  await git(snapshot.root, ['update-ref', `${prefix}${id}`, oid, '0'.repeat(oid.length)], signal);
  return id;
}

function ref(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid checkpoint id');
  return `${prefix}${id}`;
}

export async function fetch(root: string, id: string, signal: AbortSignal): Promise<Manifest> {
  const text = await git(root, ['cat-file', 'blob', ref(id)], signal);
  const value: unknown = JSON.parse(text);
  const errors = validateArgs(manifestSpec, value);
  if (errors.length) throw new Error(`Invalid checkpoint: ${errors.join(', ')}`);
  // The same runtime schema used above proves this transport value's shape.
  const snapshot = value as Manifest;
  if (snapshot.version !== 1 || snapshot.root !== realpathSync(root) || !snapshot.files.length || snapshot.files.length > 100) throw new Error('Checkpoint belongs to another workspace or version');
  for (const file of snapshot.files) {
    if (file.mode < 0 || file.mode > 0o777 || Buffer.from(file.content, 'base64').toString('base64') !== file.content || file.content.length > 1400000) throw new Error('Invalid snapshot file');
    checked(snapshot.root, file.path);
  }
  return snapshot;
}

export async function list(root: string, signal: AbortSignal): Promise<string[]> {
  const refs = await git(root, ['for-each-ref', '--format=%(refname:strip=2)', prefix], signal);
  return refs ? refs.split('\n') : [];
}

export function token(id: string, current: Manifest): string { return hash(JSON.stringify({ id, current })); }

export function replace(snapshot: Manifest, expected: Manifest, signal: AbortSignal): void {
  const temps: { temp: string; file: string }[] = [];
  try {
    for (const file of snapshot.files) {
      signal.throwIfAborted();
      const path = checked(snapshot.root, file.path);
      const temp = join(dirname(path), `.dsh-rewind-${randomUUID()}`);
      writeFileSync(temp, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: 0o600 });
      temps.push({ temp, file: path });
      chmodSync(temp, file.mode);
    }
    const now = expected.files.map(file => read(expected.root, file.path));
    if (JSON.stringify(now) !== JSON.stringify(expected.files)) throw new Error('Workspace changed after preview');
    signal.throwIfAborted();
    for (const item of temps) { checked(snapshot.root, relative(snapshot.root, item.file)); renameSync(item.temp, item.file); }
  } finally {
    for (const item of temps) { try { unlinkSync(item.temp); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } }
  }
}
