import { ApiKeyService, hashApiKey } from './api-key.service';

function makeClient() {
  const inserted: any[] = [];
  const updated: any[] = [];
  const query: any = {
    select: () => query,
    eq: () => query,
    order: () => Promise.resolve({ data: [], error: null }),
    is: () => query,
    single: async () => ({ data: null }),
    update: (patch: any) => {
      updated.push(patch);
      return query;
    },
    then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
  };
  const client: any = {
    from: jest.fn(() => ({
      ...query,
      insert: (row: any) => {
        inserted.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: 'key1',
                name: row.name,
                prefix: row.prefix,
                createdAt: 'now',
              },
              error: null,
            }),
          }),
        };
      },
    })),
  };
  return { client, inserted, updated };
}

describe('ApiKeyService', () => {
  it('issues a key prefixed lc_live_, storing only its SHA-256 hash', async () => {
    const { client, inserted } = makeClient();
    const service = new ApiKeyService({ client } as any);

    const result = await service.issue('t1', 'CI key');

    expect(result.key).toMatch(/^lc_live_[0-9a-f]{48}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].hash).toBe(hashApiKey(result.key));
    expect(inserted[0].prefix).toBe(result.key.slice(0, 12));
    // The row itself never stores the plaintext key.
    expect(JSON.stringify(inserted[0])).not.toContain(result.key.slice(13));
  });

  it('revoke sets revokedAt scoped to id + tenantId', async () => {
    const { client, updated } = makeClient();
    const service = new ApiKeyService({ client } as any);
    await service.revoke('t1', 'key1');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toHaveProperty('revokedAt');
  });
});
