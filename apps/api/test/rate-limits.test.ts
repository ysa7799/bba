import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { createTestContext, loginAs, TEST_PASSWORD, TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;

beforeAll(async () => {
  ctx = await createTestContext({ strictRateLimits: true });
  world = await createTestWorld(ctx.db.db);
});

afterAll(async () => {
  await ctx.close();
});

describe('authentication rate limits', () => {
  it('locks an account after repeated failures even from different IPs', async () => {
    const user = world.orgA.users.admin;
    await loginAs(ctx, user);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/app/auth/login',
        payload: { email: user.email, password: `wrong password ${i}` },
        headers: { origin: 'http://localhost:3000' },
        remoteAddress: `10.0.0.${i + 1}`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Even the correct password is refused while locked.
    const locked = await new TestClient(ctx.app).post('/app/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits password reset requests per account without revealing existence', async () => {
    const email = `limited.${uniqueSuffix()}@example.com`;
    const client = new TestClient(ctx.app);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await client.post('/app/auth/forgot-password', { email })).statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('limits registrations per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/app/auth/register',
        payload: {
          name: 'Spam',
          email: `spam${i}.${uniqueSuffix()}@example.com`,
          password: TEST_PASSWORD,
        },
        headers: { origin: 'http://localhost:3000' },
        remoteAddress: '203.0.113.9',
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 202));
    expect(statuses[10]).toBe(429);
  });
});
