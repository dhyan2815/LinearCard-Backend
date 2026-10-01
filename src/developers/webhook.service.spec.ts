import * as crypto from 'crypto';
import {
  WebhookService,
  signPayload,
  isPublicWebhookUrl,
} from './webhook.service';

function makeSupabaseMock() {
  const deliveryInserts: any[] = [];
  const client: any = {};
  const endpointQuery: any = {
    select: () => endpointQuery,
    eq: () => endpointQuery,
    is: () => endpointQuery,
    single: async () => ({ data: client.__endpoint || null }),
  };
  client.from = jest.fn((table: string) => {
    if (table === 'WebhookEndpoint') return endpointQuery;
    if (table === 'WebhookDelivery') {
      return {
        insert: async (row: any) => {
          deliveryInserts.push(row);
          return { error: null };
        },
      };
    }
    return client;
  });
  return { client, deliveryInserts };
}

describe('WebhookService', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('signs the payload with HMAC-SHA256 verifiable independently', () => {
    const secret = 'shh';
    const body = JSON.stringify({
      event: 'test.ping',
      payload: {},
      timestamp: 1,
    });
    const sig = signPayload(secret, body);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('retries up to 3 times on failure then gives up without throwing', async () => {
    jest.useFakeTimers();
    const { client, deliveryInserts } = makeSupabaseMock();
    client.__endpoint = {
      id: 'ep1',
      url: 'https://example.com/hook',
      secret: 's3cret',
    };

    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });
    global.fetch = fetchMock as any;

    const service = new WebhookService({ client } as any);
    const promise = service.sendTest('t1', 'ep1');
    // Flush the two backoff delays (500ms, 2000ms) between the 3 attempts.
    await jest.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(deliveryInserts).toHaveLength(3);
    expect(deliveryInserts.map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(deliveryInserts.every((d) => d.statusCode === 500)).toBe(true);
  });

  it('dispatch never rejects even when everything fails', async () => {
    const client: any = {
      from: jest.fn(() => {
        throw new Error('db is down');
      }),
    };
    const service = new WebhookService({ client } as any);
    await expect(
      service.dispatch('t1', 'points.awarded', { foo: 'bar' }),
    ).resolves.toBeUndefined();
  });

  it('dispatch only calls endpoints subscribed to the event', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    global.fetch = fetchMock as any;

    const insert = jest.fn().mockResolvedValue({ error: null });
    const endpointsResult = {
      data: [
        {
          id: 'ep1',
          url: 'https://a.test',
          secret: 's1',
          events: ['points.awarded'],
          active: true,
        },
        {
          id: 'ep2',
          url: 'https://b.test',
          secret: 's2',
          events: ['tier.changed'],
          active: true,
        },
      ],
      error: null,
    };
    const endpointQuery: any = {
      select: () => endpointQuery,
      eq: () => endpointQuery,
      then: (resolve: any) => Promise.resolve(endpointsResult).then(resolve),
    };
    const client: any = {
      from: jest.fn((table: string) => {
        if (table === 'WebhookEndpoint') return endpointQuery;
        return { insert };
      }),
    };

    const service = new WebhookService({ client } as any);
    await service.dispatch('t1', 'points.awarded', { amount: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://a.test',
      expect.any(Object),
    );
  });
});

describe('isPublicWebhookUrl', () => {
  it('accepts public http/https URLs', () => {
    for (const url of [
      'https://example.com/hook',
      'http://hooks.example.co.uk:8080/x?y=1',
      'https://203.0.113.7/hook',
      'https://fd-api.example.com/hook',
    ]) {
      expect(isPublicWebhookUrl(url)).toBe(true);
    }
  });

  it('rejects loopback, private, link-local and non-http schemes', () => {
    for (const url of [
      'http://localhost/hook',
      'http://LOCALHOST:3000/hook',
      'http://api.localhost/hook',
      'http://127.0.0.1/hook',
      'http://127.1.2.3/hook',
      'http://0.0.0.0/hook',
      'http://10.1.2.3/hook',
      'http://172.16.0.1/hook',
      'http://172.31.255.255/hook',
      'http://192.168.1.1/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hook',
      'http://[fd00::1]/hook',
      'http://[fe80::1]/hook',
      'file:///etc/passwd',
      'ftp://example.com/hook',
      'not a url',
      '',
    ]) {
      expect(isPublicWebhookUrl(url)).toBe(false);
    }
  });

  it('still allows 172.32.x (outside the private /12 range)', () => {
    expect(isPublicWebhookUrl('http://172.32.0.1/hook')).toBe(true);
  });
});

describe('WebhookService delivery hardening', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('aborts a hanging delivery with a timeout signal and reuses one timestamp', async () => {
    const client: any = {};
    const endpointQuery: any = {
      select: () => endpointQuery,
      eq: () => endpointQuery,
      single: async () => ({
        data: { id: 'ep1', url: 'https://example.com/h', secret: 's' },
      }),
    };
    client.from = jest.fn((table: string) =>
      table === 'WebhookEndpoint'
        ? endpointQuery
        : { insert: async () => ({ error: null }) },
    );

    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    global.fetch = fetchMock as any;

    const service = new WebhookService({ client } as any);
    await service.sendTest('t1', 'ep1');

    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.headers['X-LinearCard-Timestamp'])).toBe(
      String(JSON.parse(init.body).timestamp),
    );
  });
});
