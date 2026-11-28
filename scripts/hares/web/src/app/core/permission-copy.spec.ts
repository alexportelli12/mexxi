import type { Pending } from '../models';
import { permissionCopy } from './permission-copy';

const ask = (extra: Partial<Pending> & { tool?: string; scope?: 'rule' | 'session' } = {}) =>
  ({ kind: 'permission', asker: 'my-repo', permission: { tool: extra.tool ?? 'Bash', verb: 'run a command', always: { text: 'Bash(pnpm add:*)', scope: extra.scope ?? 'rule' } }, ...extra }) as Pending;

describe('permission copy', () => {
  it('says a command is run and a file is allowed, so the button matches what is asked', () => {
    expect(permissionCopy(ask())).toMatchObject({ title: 'Claude wants to run a command', once: 'Run once', deny: 'Don’t run' });
    expect(permissionCopy(ask({ tool: 'Edit' }))).toMatchObject({ once: 'Allow once', deny: 'Don’t allow' });
  });

  it('says a rule is permanent for the repo, and a session grant ends with the session', () => {
    expect(permissionCopy(ask())).toMatchObject({ always: 'Always allow in this repo', confirm: 'This adds a permanent rule to my-repo. Claude won’t ask before commands that match it.' });
    expect(permissionCopy(ask({ scope: 'session' }))).toMatchObject({ always: 'Allow for this session', confirm: expect.stringContaining('until the session ends') });
  });

  it('words a plan and a folder trust in their own terms', () => {
    expect(permissionCopy(ask({ kind: 'plan' })).once).toBe('Approve the plan');
    expect(permissionCopy(ask({ kind: 'trust' })).once).toBe('Trust this folder');
  });
});
