import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { capture, fetch, list, persist, replace, token } from './store.js';
import { workspace } from './support.js';
import { realpathSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-rewind';
export const inject = ['tools'];
export interface Config { root?: string }
export const Config = Schema.object({ root: Schema.string() });
const busy = new Set<string>();

export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(defineTool({
    name: 'rewind', description: 'Explicit-file Git-backed checkpoints. checkpoint(paths), list, preview(id), restore(id, token). Restore preserves index/HEAD, saves a redo checkpoint, and refuses changes since preview. Local host filesystem only.',
    parameters: { action: { type: 'string', enum: ['checkpoint', 'list', 'preview', 'restore'], required: true }, paths: { type: 'array', items: { type: 'string' } }, id: { type: 'string' }, token: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', required: true }, id: { type: 'string', required: true }, token: { type: 'string', required: true }, backupId: { type: 'string', required: true },
      ids: { type: 'array', items: { type: 'string' }, required: true }, files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, changed: { type: 'boolean', required: true }, before: { type: 'string', required: true }, after: { type: 'string', required: true },
      } }, required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const root = realpathSync(workspace(ctx, exec, config.root));
      exec.signal.throwIfAborted();
      if (busy.has(root)) throw new Error('Another checkpoint operation is active');
      busy.add(root);
      const ids: string[] = [];
      const files: { path: string; changed: boolean; before: string; after: string }[] = [];
      const result = { action: args.action, id: '', token: '', backupId: '', ids, files };
      try {
        if (args.action === 'list') { result.ids = await list(root, exec.signal); return result; }
        if (args.action === 'checkpoint') {
          const snapshot = await capture(root, args.paths ?? [], exec.signal);
          result.id = await persist(snapshot, exec.signal);
          result.files = snapshot.files.map(file => ({ path: file.path, changed: false, before: '', after: '' }));
          return result;
        }
        if (!args.id) throw new Error('id is required');
        const snapshot = await fetch(root, args.id, exec.signal);
        const current = await capture(root, snapshot.files.map(file => file.path), exec.signal);
        if (snapshot.head !== current.head || snapshot.branch !== current.branch) throw new Error('HEAD or branch changed since checkpoint');
        result.id = args.id;
        result.token = token(args.id, current);
        result.files = snapshot.files.map((file, index) => {
          const before = current.files[index];
          if (!before) throw new Error('Missing current file');
          return { path: file.path, changed: file.content !== before.content || file.mode !== before.mode, before: before.content, after: file.content };
        });
        if (args.action === 'preview') return result;
        if (!args.token || args.token !== result.token) throw new Error('Missing or stale preview token; preview again');
        result.backupId = await persist(current, exec.signal);
        const latest = await capture(root, snapshot.files.map(file => file.path), exec.signal);
        if (token(args.id, latest) !== args.token) throw new Error(`Workspace changed; redo checkpoint ${result.backupId}`);
        try { replace(snapshot, current, exec.signal); }
        catch (error) { throw new Error(`Restore failed; recover with redo checkpoint ${result.backupId}: ${String(error)}`); }
        return result;
      } finally { busy.delete(root); }
    },
  }));
}
