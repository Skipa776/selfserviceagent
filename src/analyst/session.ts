import { randomBytes } from 'node:crypto';

type Session = { id: string; csrfToken: string; approver: 'synthetic-demo-operator'; expiresAt: number };

export class AnalystSessionStore {
  private bootstrapAvailable = true;
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly bootstrapToken: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly newSessionId: () => string = () => randomBytes(24).toString('hex'),
    private readonly ttlMs = 30 * 60_000,
  ) {}

  login(token: string): Omit<Session, 'expiresAt'> | null {
    const now = this.clock().getTime();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    if (this.bootstrapAvailable === false && this.sessions.size === 0) this.bootstrapAvailable = true;
    if (!this.bootstrapAvailable || token !== this.bootstrapToken) return null;
    this.bootstrapAvailable = false;
    const session: Session = {
      id: this.newSessionId(),
      csrfToken: randomBytes(24).toString('hex'),
      approver: 'synthetic-demo-operator',
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return { id: session.id, csrfToken: session.csrfToken, approver: session.approver };
  }

  authenticate(id: string): Omit<Session, 'expiresAt'> | null {
    const session = this.sessions.get(id);
    if (session === undefined || session.expiresAt <= this.clock().getTime()) {
      this.sessions.delete(id);
      if (this.sessions.size === 0) this.bootstrapAvailable = true;
      return null;
    }
    return { id: session.id, csrfToken: session.csrfToken, approver: session.approver };
  }

  authorizeMutation(id: string, csrfToken: string): Omit<Session, 'expiresAt'> | null {
    const session = this.authenticate(id);
    return session !== null && session.csrfToken === csrfToken ? session : null;
  }

  logout(id: string): void {
    this.sessions.delete(id);
  }
}
