interface Session {
  userId: string;
  actor: string;
  lastSeenAt: number;
}

export const MCP_SESSION_IDLE_MS = 30 * 60_000;
export const MCP_SESSIONS_PER_CLIENT = 16;
export const MCP_SESSIONS_PER_USER = 64;

// Admissions include unfinished initialization requests so concurrent reconnects
// cannot bypass the limits. Protocol requests and open SSE streams pin sessions.
export class McpSessionRegistry<T extends Session> {
  readonly sessions = new Map<string, T>();
  private readonly reservations = new Set<{ userId: string; actor: string }>();
  private readonly active = new WeakMap<T, number>();
  private readonly timers = new Map<T, NodeJS.Timeout>();

  constructor(
    private readonly close: (session: T) => Promise<void>,
    private readonly limits = {
      idleMs: MCP_SESSION_IDLE_MS,
      perClient: MCP_SESSIONS_PER_CLIENT,
      perUser: MCP_SESSIONS_PER_USER,
    },
  ) {}

  reserve(userId: string, actor: string): (() => void) | undefined {
    const count = (clientOnly: boolean) =>
      [...this.sessions.values(), ...this.reservations].filter(
        (session) =>
          session.userId === userId && (!clientOnly || session.actor === actor),
      ).length;
    while (
      count(true) >= this.limits.perClient ||
      count(false) >= this.limits.perUser
    ) {
      const clientOnly = count(true) >= this.limits.perClient;
      const candidate = [...this.sessions]
        .filter(
          ([, session]) =>
            session.userId === userId &&
            (!clientOnly || session.actor === actor) &&
            !this.active.get(session),
        )
        .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!candidate) {
        return undefined;
      }
      this.evict(...candidate);
    }
    const reservation = { userId, actor };
    this.reservations.add(reservation);
    return () => {
      this.reservations.delete(reservation);
    };
  }

  register(id: string, session: T): void {
    this.sessions.set(id, session);
    this.touch(session);
  }

  forget(id: string, session: T): void {
    if (this.sessions.get(id) !== session) {
      return;
    }
    this.sessions.delete(id);
    this.clearTimer(session);
  }

  private evict(id: string, session: T): void {
    this.forget(id, session);
    void this.close(session).catch(() => undefined);
  }

  private clearTimer(session: T): void {
    clearTimeout(this.timers.get(session));
    this.timers.delete(session);
  }

  touch(session: T): void {
    session.lastSeenAt = Date.now();
    this.clearTimer(session);
    if (this.active.get(session)) {
      return;
    }
    const id = [...this.sessions].find(([, value]) => value === session)?.[0];
    if (!id) {
      return;
    }
    const timer = setTimeout(() => this.evict(id, session), this.limits.idleMs);
    timer.unref();
    this.timers.set(session, timer);
  }

  begin(session: T): () => void {
    this.active.set(session, (this.active.get(session) ?? 0) + 1);
    this.touch(session);
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      this.active.set(
        session,
        Math.max(0, (this.active.get(session) ?? 1) - 1),
      );
      this.touch(session);
    };
  }
}
