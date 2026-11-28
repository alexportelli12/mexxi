import type { Pending } from '../models';

export interface PermissionCopy {
  title: string;
  once: string;
  deny: string;
  /** What "Always allow" says on its button. */
  always: string;
  /** What the confirm step says will happen. */
  confirm: string;
}

/** The words around a permission prompt, by what is being asked: a command, a file change, a plan or a folder. */
export function permissionCopy(pending: Pick<Pending, 'kind' | 'asker' | 'permission'>): PermissionCopy {
  const permission = pending.permission;
  const rule = permission?.always ?? null;
  const session = rule?.scope === 'session';
  const always = session ? 'Allow for this session' : 'Always allow in this repo';
  const confirm = session
    ? 'This lasts until the session ends. Claude won’t ask again for what it covers.'
    : `This adds a permanent rule to ${pending.asker}. Claude won’t ask before calls that match it.`;
  if (pending.kind === 'plan') return { title: 'Claude has a plan', once: 'Approve the plan', deny: 'Not yet', always, confirm };
  if (pending.kind === 'trust') return { title: 'Claude asks to work in this folder', once: 'Trust this folder', deny: 'Don’t trust', always, confirm };
  const command = permission?.tool === 'Bash';
  return {
    title: `Claude wants to ${permission?.verb ?? 'make a change'}`,
    once: command ? 'Run once' : 'Allow once',
    deny: command ? 'Don’t run' : 'Don’t allow',
    always,
    confirm: command ? confirm.replace('calls that match', 'commands that match') : confirm,
  };
}
