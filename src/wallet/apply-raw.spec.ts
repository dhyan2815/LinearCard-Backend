/**
 * Part 4 — the Passmint `applyRaw` escape hatch.
 */
import { applyRaw, deepMergeRaw, RAW_PROTECTED_KEYS } from './wallet.service';

describe('deepMergeRaw', () => {
  it('merges nested objects key by key instead of replacing the branch', () => {
    const merged = deepMergeRaw(
      { logo: { sourceUri: { uri: 'a' } }, hexBackgroundColor: '#000' },
      { logo: { contentDescription: 'Brand logo' } },
    );
    // The existing uri survives a merge that only sets a sibling.
    expect(merged.logo.sourceUri.uri).toBe('a');
    expect(merged.logo.contentDescription).toBe('Brand logo');
    expect(merged.hexBackgroundColor).toBe('#000');
  });

  it('replaces arrays wholesale rather than merging them by index', () => {
    const merged = deepMergeRaw(
      { merchantLocations: [{ latitude: 1 }, { latitude: 2 }] },
      { merchantLocations: [{ latitude: 9 }] },
    );
    // Index-wise merging would leave a stale second location behind.
    expect(merged.merchantLocations).toEqual([{ latitude: 9 }]);
  });

  it('leaves the base untouched when raw is absent or not an object', () => {
    const base = { id: 'x' };
    for (const raw of [undefined, null, 'string', 42, ['a']]) {
      expect(deepMergeRaw(base, raw)).toEqual(base);
    }
  });

  it('does not mutate the payload it was given', () => {
    const base = { logo: { sourceUri: { uri: 'a' } } };
    deepMergeRaw(base, { logo: { sourceUri: { uri: 'b' } } });
    expect(base.logo.sourceUri.uri).toBe('a');
  });

  it('ignores undefined values so raw cannot blank a field by accident', () => {
    expect(deepMergeRaw({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
    // An explicit null is a deliberate clear and does go through.
    expect(deepMergeRaw({ a: 1 }, { a: null })).toEqual({ a: null });
  });
});

describe('applyRaw — protected keys', () => {
  it('refuses to let raw repoint the class callback (the ENV-4 guard)', () => {
    const { payload, refused } = applyRaw(
      { id: 'iss.prod_coffee', callbackOptions: { url: 'https://real/hook' } },
      { callbackOptions: { url: 'http://localhost:3001/hook' } },
    );
    expect(payload.callbackOptions.url).toBe('https://real/hook');
    expect(refused).toContain('callbackOptions');
  });

  it('refuses to let raw change which class or object is written', () => {
    const { payload, refused } = applyRaw(
      { id: 'iss.mine', classId: 'iss.my_class' },
      { id: 'iss.someone_else', classId: 'iss.their_class' },
    );
    expect(payload.id).toBe('iss.mine');
    expect(payload.classId).toBe('iss.my_class');
    expect(refused).toEqual(expect.arrayContaining(['id', 'classId']));
  });

  it('still applies the unprotected keys in the same call', () => {
    const { payload, refused } = applyRaw(
      { id: 'iss.mine', hexBackgroundColor: '#000' },
      { id: 'hijack', notifyPreference: 'NOTIFY_ON_UPDATE' },
    );
    // A refused key must not cause the whole merge to be dropped.
    expect(payload.id).toBe('iss.mine');
    expect(payload.notifyPreference).toBe('NOTIFY_ON_UPDATE');
    expect(refused).toEqual(['id']);
  });

  it('reports nothing refused for an ordinary unmodelled field', () => {
    const { payload, refused } = applyRaw(
      { id: 'x' },
      { linksModuleData: { uris: [{ uri: 'https://brand.example' }] } },
    );
    expect(payload.linksModuleData.uris).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it('protects exactly the documented keys, so the list cannot drift silently', () => {
    expect(RAW_PROTECTED_KEYS).toEqual(['id', 'classId', 'callbackOptions']);
  });
});
