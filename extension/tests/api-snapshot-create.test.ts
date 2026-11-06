import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/modules/api/client';

describe('createSnapshot', () => {
  it('maps the current period object to the server-required snapshot fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { snapshot_id: 'snapshot-1', created: true }, error: null, request_id: 'r1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient({
      getBaseUrl: async () => 'http://localhost:8000',
      getAuth: async () => ({ client_id: null, client_token: null }),
      maxRetries: 0,
    });

    await api.createSnapshot({
      request_id: 'request-1',
      query: {
        source: 'ECHOTIK',
        region: 'MX',
        rankingVariant: 'top-sold',
        period: { type: 'daily', startDate: '2026-11-06' },
        startRank: 1,
        limit: 100,
      },
      filter_json: {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      ranking_type: 'daily',
      ranking_variant: 'top-sold',
      period_start: '2026-11-06',
    });
  });
});
