/**
 * Port for authentication emails. Implementations: in-memory (tests), log (development only),
 * and the notification/email provider pipeline (later phases). Auth services never talk to an
 * email provider directly.
 */
export type AuthEmail =
  | { kind: 'verify_email'; to: string; locale: string; name: string; link: string }
  | {
      kind: 'account_exists';
      to: string;
      locale: string;
      name: string;
      forgotPasswordLink: string;
    }
  | { kind: 'password_reset'; to: string; locale: string; name: string; link: string }
  | {
      kind: 'password_changed';
      to: string;
      locale: string;
      name: string;
    }
  | {
      kind: 'invitation';
      to: string;
      locale: string;
      organizationName: string;
      inviterName: string | null;
      link: string;
    };

export interface AuthMailer {
  send(email: AuthEmail): Promise<void>;
}

/** Captures emails for tests. */
export class MemoryMailer implements AuthMailer {
  readonly sent: AuthEmail[] = [];

  send(email: AuthEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }

  lastTo(to: string): AuthEmail | undefined {
    return this.sent.filter((email) => email.to === to).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Extracts the `token` query parameter from a link produced by the auth services. */
export function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error('link has no token');
  return token;
}
