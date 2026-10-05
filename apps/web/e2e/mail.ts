import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAIL_FILE = path.resolve(import.meta.dirname, '../test-results/e2e-mail.jsonl');

interface CapturedEmail {
  kind: string;
  to: string;
  link?: string;
}

/** Waits for the newest email of a kind sent to an address and returns its link. */
export async function waitForLink(to: string, kind: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(MAIL_FILE)) {
      const emails = readFileSync(MAIL_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedEmail)
        .filter((email) => email.to === to && email.kind === kind);
      const link = emails.at(-1)?.link;
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No ${kind} email for ${to}`);
}
