import { describe, expect, it } from 'vitest';

import { AnalystSessionStore } from '../src/analyst/session';

describe('analyst operator sessions', () => {
  it('exchanges the bootstrap token once for a short-lived session', () => {
    let now = Date.parse('2026-09-11T12:00:00.000Z');
    const sessions = new AnalystSessionStore('bootstrap-secret', () => new Date(now), () => 'session-1');

    expect(sessions.login('wrong')).toBeNull();
    const session = sessions.login('bootstrap-secret');
    expect(session).toEqual({ id: 'session-1', csrfToken: expect.any(String), approver: 'synthetic-demo-operator' });
    expect(sessions.login('bootstrap-secret')).toBeNull();
    expect(sessions.authenticate('session-1')?.approver).toBe('synthetic-demo-operator');

    now += 31 * 60_000;
    expect(sessions.authenticate('session-1')).toBeNull();
    expect(sessions.login('bootstrap-secret')).not.toBeNull();
  });

  it('requires the session CSRF token for mutation', () => {
    const sessions = new AnalystSessionStore('bootstrap-secret', () => new Date('2026-09-11T12:00:00.000Z'), () => 'session-1');
    const session = sessions.login('bootstrap-secret');
    expect(session).not.toBeNull();
    expect(sessions.authorizeMutation('session-1', 'wrong')).toBeNull();
    expect(sessions.authorizeMutation('session-1', session?.csrfToken ?? '')?.approver).toBe('synthetic-demo-operator');
  });

  it('allows a new login after an abandoned session expires', () => {
    let now = Date.parse('2026-09-11T12:00:00.000Z');
    let id = 0;
    const sessions = new AnalystSessionStore('bootstrap-secret', () => new Date(now), () => `session-${++id}`);
    expect(sessions.login('bootstrap-secret')?.id).toBe('session-1');

    now += 31 * 60_000;
    expect(sessions.login('bootstrap-secret')?.id).toBe('session-2');
  });
});
