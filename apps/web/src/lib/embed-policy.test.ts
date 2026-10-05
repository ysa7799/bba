import { describe, expect, it } from 'vitest';
import { EMBED_PATH, frameAncestors } from './embed-policy';

describe('embed policy', () => {
  it('only matches the embed route of a well-formed slug', () => {
    expect(EMBED_PATH.exec('/f/contact-us-abc123/embed')?.[1]).toBe('contact-us-abc123');
    expect(EMBED_PATH.exec('/f/contact-us/embed/')?.[1]).toBe('contact-us');
    expect(EMBED_PATH.test('/f/Contact/embed')).toBe(false);
    expect(EMBED_PATH.test('/f/contact-us')).toBe(false);
    expect(EMBED_PATH.test('/f/../embed')).toBe(false);
  });

  it('lists allowed origins and fails closed on anything unexpected', () => {
    expect(frameAncestors(['https://www.example.com', 'https://*.shop.bh'])).toBe(
      'https://www.example.com https://*.shop.bh',
    );
    expect(frameAncestors([])).toBe("'none'");
    expect(frameAncestors(null)).toBe("'none'");
    expect(frameAncestors('https://example.com')).toBe("'none'");
    // One injected value poisons the whole list rather than being silently dropped.
    expect(
      frameAncestors(['https://ok.example', "https://x.example; script-src 'unsafe-inline'"]),
    ).toBe("'none'");
    expect(frameAncestors(['*'])).toBe("'none'");
    expect(frameAncestors(Array.from({ length: 11 }, (_, i) => `https://s${i}.example.com`))).toBe(
      "'none'",
    );
  });
});
