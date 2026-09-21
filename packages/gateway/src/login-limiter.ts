export class LoginLimiter {
  private readonly failures = new Map<
    string,
    { count: number; firstAt: number }
  >();
  private readonly windowMs = 15 * 60_000;

  blocked(key: string): boolean {
    this.cleanup();
    if (this.failures.size >= 10_000 && !this.failures.has(key)) {
      return true;
    }
    return (this.failures.get(key)?.count ?? 0) >= 8;
  }
  failed(key: string): void {
    this.cleanup();
    const entry = this.failures.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      this.failures.set(key, { count: 1, firstAt: Date.now() });
    }
  }
  succeeded(key: string): void {
    this.failures.delete(key);
  }
  private cleanup(): void {
    for (const [key, entry] of this.failures) {
      if (Date.now() - entry.firstAt >= this.windowMs) {
        this.failures.delete(key);
      }
    }
  }
}

export function credentialRateKey(
  ip: string | undefined,
  username: string,
): string {
  return `${ip ?? "unknown"}:${username.trim().toLowerCase().slice(0, 40)}`;
}
