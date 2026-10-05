import { createContact, type CrmContext } from '@businessos/crm';
import {
  entitlementOverrides,
  files,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
} from '@businessos/database';
import { createOrganization } from '@businessos/organizations';
import {
  EntitlementExceededError,
  NotFoundError,
  PayloadTooLargeError,
  ProviderError,
  ValidationError,
} from '@businessos/shared';
import { createTestDatabase, createTestUser, uniqueSuffix } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteFile,
  getFileRow,
  listFiles,
  LocalFileStorage,
  MAX_FILE_BYTES,
  MemoryFileStorage,
  readFileContent,
  runFilesMaintenance,
  S3FileStorage,
  nameForType,
  sanitizeName,
  signV4,
  sniffType,
  storageUsedBytes,
  uploadFile,
  type FileServices,
} from '../src';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 1),
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 2)]);

describe('type sniffing and names', () => {
  it('accepts allowed types by their bytes, whatever they are called', () => {
    expect(sniffType(PNG, 'photo.png')).toBe('image/png');
    expect(sniffType(PNG, 'renamed.txt')).toBe('image/png');
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'x.jpg')).toBe('image/jpeg');
    expect(sniffType(PDF, 'contract.pdf')).toBe('application/pdf');
    expect(sniffType(ZIP, 'quote.docx')).toContain('wordprocessingml');
    expect(sniffType(Buffer.from('name,amount\nAli,12.500\n'), 'export.csv')).toBe('text/csv');
    expect(sniffType(Buffer.from('مرحبا بكم'), 'notes.txt')).toBe('text/plain');
  });

  it('refuses scriptable and unknown formats', () => {
    expect(sniffType(Buffer.from('<html><script>alert(1)</script>'), 'page.png')).toBeNull();
    expect(sniffType(Buffer.from('<svg onload="alert(1)"/>'), 'logo.svg')).toBeNull();
    expect(sniffType(Buffer.from('  <!doctype html>'), 'readme.txt')).toBeNull();
    expect(sniffType(Buffer.from('MZ\x90\x00'), 'setup.exe')).toBeNull();
    expect(sniffType(ZIP, 'archive.zip')).toBeNull();
    expect(sniffType(Buffer.from([0x61, 0x00, 0x62]), 'binary.txt')).toBeNull();
  });

  it('keeps names safe for display and download headers', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('C:\\Users\\me\\report "final".pdf')).toBe('report final.pdf');
    expect(sanitizeName('a\u0000b\r\nc.txt')).toBe('abc.txt');
    expect(sanitizeName('...')).toBe('file');
    const long = sanitizeName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('removes bidirectional overrides that disguise extensions', () => {
    // Displayed as "invoiceexe.pdf" if the override survived.
    expect(sanitizeName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeName('\u2067report\u2069.pdf')).toBe('report.pdf');
    expect(sanitizeName('عقد الخدمة.pdf')).toBe('عقد الخدمة.pdf');
  });

  it('gives every stored name the extension of its real type', () => {
    expect(nameForType('scan.pdf', 'application/pdf')).toBe('scan.pdf');
    expect(nameForType('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG');
    // A PNG (possibly an HTML polyglot) named .html is never saved as HTML.
    expect(nameForType('page.html', 'image/png')).toBe('page.html.png');
    expect(nameForType('notes', 'text/plain')).toBe('notes.txt');
    const long = nameForType('y'.repeat(200), 'application/pdf');
    expect(long).toHaveLength(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('storage adapters', () => {
  it('signs requests exactly as AWS documents (SigV4 GET Object example)', () => {
    const authorization = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('S3 is CONFIGURATION_REQUIRED without keys and sends signed requests with them', async () => {
    const key = `${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/${'1'.repeat(8)}-1111-7111-8111-${'1'.repeat(12)}`;
    const unconfigured = new S3FileStorage({
      endpoint: 'https://s3.me-south-1.amazonaws.com',
      region: 'me-south-1',
      bucket: 'bos-files',
      accessKeyId: null,
      secretAccessKey: null,
    });
    expect(unconfigured.status()).toBe('configuration_required');
    await expect(unconfigured.put(key, PNG, 'image/png')).rejects.toBeInstanceOf(ProviderError);

    const calls: { url: string; init: RequestInit }[] = [];
    const storage = new S3FileStorage({
      endpoint: 'https://s3.me-south-1.amazonaws.com',
      region: 'me-south-1',
      bucket: 'bos-files',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example-key',
      now: () => new Date('2026-03-01T10:00:00Z'),
      fetch: (input, init) => {
        calls.push({
          url: input instanceof URL ? input.toString() : (input as string),
          init: init ?? {},
        });
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });
    expect(storage.status()).toBe('ready');
    await storage.put(key, PNG, 'image/png');
    const [call] = calls;
    expect(call?.url).toBe(`https://s3.me-south-1.amazonaws.com/bos-files/${key}`);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-amz-date']).toBe('20260301T100000Z');
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260301\/me-south-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(headers)).not.toContain('secret-example-key');
  });

  it('local disk storage stays inside its root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bos-files-'));
    try {
      const storage = new LocalFileStorage(root);
      const key = `${'2'.repeat(8)}-2222-7222-8222-${'2'.repeat(12)}/${'3'.repeat(8)}-3333-7333-8333-${'3'.repeat(12)}`;
      await storage.put(key, PDF, 'application/pdf');
      expect((await storage.get(key)).equals(PDF)).toBe(true);
      await storage.delete(key);
      await storage.delete(key);
      await expect(storage.get(key)).rejects.toBeInstanceOf(ProviderError);
      await expect(storage.put('../../escape', PDF, 'application/pdf')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('file service', () => {
  let handle: DatabaseHandle;
  let storage: MemoryFileStorage;
  let services: FileServices;

  beforeAll(() => {
    handle = createTestDatabase(10);
    storage = new MemoryFileStorage();
    services = { db: handle.db, storage };
  });

  afterAll(async () => {
    await handle.close();
  });

  async function org(): Promise<{ organization: Organization; ownerId: string }> {
    const owner = await createTestUser(handle.db, { name: `Owner ${uniqueSuffix()}` });
    const { organization } = await createOrganization(handle.db, owner.id, {
      name: `Files ${uniqueSuffix()}`,
    });
    return { organization, ownerId: owner.id };
  }

  function ctx(o: { organization: Organization; ownerId: string }): CrmContext {
    return {
      organizationId: o.organization.id,
      countryCode: o.organization.countryCode,
      defaultCurrency: o.organization.defaultCurrency,
      timezone: o.organization.timezone,
      actor: { type: 'user', userId: o.ownerId },
    };
  }

  const scope = (o: { organization: Organization; ownerId: string }) => ({
    organizationId: o.organization.id,
    userId: o.ownerId,
  });

  async function contactIn(o: { organization: Organization; ownerId: string }) {
    return withTenant(handle.db, scope(o), (tx) =>
      createContact(tx, ctx(o), { firstName: 'Layla', lastName: `Saeed ${uniqueSuffix()}` }),
    );
  }

  async function limitStorage(organizationId: string, bytes: number) {
    await withSystem(handle.db, (tx) =>
      tx.insert(entitlementOverrides).values({
        organizationId,
        key: 'storage.bytes',
        value: { value: bytes },
        reason: 'test limit',
      }),
    );
  }

  it('stores, lists, reads and deletes an attachment', async () => {
    const o = await org();
    const contact = await contactIn(o);
    const entity = { type: 'contact' as const, id: contact.id };
    const uploaded = await uploadFile(services, scope(o), {
      name: '../ID card.png',
      body: PNG,
      entity,
    });
    expect(uploaded).toMatchObject({
      name: 'ID card.png',
      contentType: 'image/png',
      sizeBytes: String(PNG.length),
      inline: true,
      entityType: 'contact',
    });
    expect(uploaded.uploadedBy?.id).toBe(o.ownerId);
    const listed = await withTenant(handle.db, scope(o), (tx) =>
      listFiles(tx, o.organization.id, entity),
    );
    expect(listed.map((file) => file.id)).toEqual([uploaded.id]);
    const row = await withTenant(handle.db, scope(o), (tx) =>
      getFileRow(tx, o.organization.id, uploaded.id),
    );
    expect((await readFileContent(services, row)).equals(PNG)).toBe(true);
    expect(row.storageKey).toBe(`${o.organization.id}/${uploaded.id}`);

    await deleteFile(services, scope(o), uploaded.id);
    expect(storage.objects.has(row.storageKey)).toBe(false);
    await expect(
      withTenant(handle.db, scope(o), (tx) => getFileRow(tx, o.organization.id, uploaded.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await withTenant(handle.db, scope(o), (tx) => storageUsedBytes(tx, o.organization.id)),
    ).toBe(0n);
  });

  it('refuses empty, oversized and disallowed uploads', async () => {
    const o = await org();
    await expect(
      uploadFile(services, scope(o), { name: 'a.txt', body: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uploadFile(services, scope(o), { name: 'big.pdf', body: Buffer.alloc(MAX_FILE_BYTES + 1) }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      uploadFile(services, scope(o), { name: 'x.html', body: Buffer.from('<html></html>') }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces the storage quota, also for parallel uploads', async () => {
    const o = await org();
    await limitStorage(o.organization.id, PDF.length * 3);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        uploadFile(services, scope(o), { name: `doc-${index}.pdf`, body: PDF }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(EntitlementExceededError);
      }
    }
    expect(
      await withTenant(handle.db, scope(o), (tx) => storageUsedBytes(tx, o.organization.id)),
    ).toBe(BigInt(PDF.length * 3));
  });

  it('releases the reservation when storage fails, and detects damaged objects', async () => {
    const o = await org();
    storage.failNextPut = true;
    await expect(
      uploadFile(services, scope(o), { name: 'a.pdf', body: PDF }),
    ).rejects.toBeInstanceOf(ProviderError);
    const rows = await withSystem(handle.db, (tx) =>
      tx.select().from(files).where(eq(files.organizationId, o.organization.id)),
    );
    expect(rows).toHaveLength(0);

    const uploaded = await uploadFile(services, scope(o), { name: 'b.pdf', body: PDF });
    const row = await withTenant(handle.db, scope(o), (tx) =>
      getFileRow(tx, o.organization.id, uploaded.id),
    );
    storage.objects.set(row.storageKey, { body: Buffer.from('tampered'), contentType: 'x' });
    await expect(readFileContent(services, row)).rejects.toBeInstanceOf(ProviderError);
  });

  it('keeps files inside their organization', async () => {
    const a = await org();
    const b = await org();
    const contact = await contactIn(a);
    const uploaded = await uploadFile(services, scope(a), {
      name: 'a.pdf',
      body: PDF,
      entity: { type: 'contact', id: contact.id },
    });
    await expect(
      withTenant(handle.db, scope(b), (tx) => getFileRow(tx, b.organization.id, uploaded.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteFile(services, scope(b), uploaded.id)).rejects.toBeInstanceOf(NotFoundError);
    // Attaching to another organization's record is refused as unknown.
    await expect(
      uploadFile(services, scope(b), {
        name: 'b.pdf',
        body: PDF,
        entity: { type: 'contact', id: contact.id },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const listed = await withTenant(handle.db, scope(b), (tx) =>
      listFiles(tx, b.organization.id, { type: 'contact', id: contact.id }),
    );
    expect(listed).toEqual([]);
  });

  it('cleans up abandoned uploads and retries deferred deletions', async () => {
    const o = await org();
    const kept = await uploadFile(services, scope(o), { name: 'keep.pdf', body: PDF });
    const removed = await uploadFile(services, scope(o), { name: 'gone.pdf', body: PDF });
    const removedRow = await withTenant(handle.db, scope(o), (tx) =>
      getFileRow(tx, o.organization.id, removed.id),
    );
    // A deletion whose object removal failed, and an upload that never finished.
    await withSystem(handle.db, async (tx) => {
      await tx
        .update(files)
        .set({ status: 'deleted', deletedAt: new Date(), purgedAt: null })
        .where(eq(files.id, removed.id));
      await tx
        .update(files)
        .set({ status: 'pending', updatedAt: new Date(Date.now() - 2 * 3_600_000) })
        .where(eq(files.id, kept.id));
    });
    const result = await runFilesMaintenance(services);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(removedRow.storageKey)).toBe(false);
    const remaining = await withSystem(handle.db, (tx) =>
      tx.select().from(files).where(eq(files.organizationId, o.organization.id)),
    );
    expect(remaining.map((row) => [row.id, row.status, row.purgedAt !== null])).toEqual([
      [removed.id, 'deleted', true],
    ]);
  });
});
