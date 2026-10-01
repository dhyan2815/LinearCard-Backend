/**
 * Phase 4 — "Proximity, honestly", plus AUTH-4.
 * One assertion per thing the phase promises.
 */
import * as fs from 'fs';
import * as path from 'path';

const readApi = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const readWeb = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../web', rel), 'utf8');

describe('AUTH-4 — the public barcode never carries a phone number', () => {
  it('the pass barcode is derived from passId, not from a caller-supplied value', () => {
    const src = readApi('wallet/wallet.service.ts');
    expect(src).toContain('const barcodeValue = `${barcodeBase}/m/${passId}`');
    // The hardcoded host is gone: the domain comes from the same origin list
    // the save link is signed against.
    expect(src).toContain('this.saveLinkOrigins()[0]');
  });

  it('no call site can inject a barcode payload', () => {
    // Removing the field from the options type is what makes this structural
    // rather than a convention every future caller has to remember.
    expect(readApi('wallet/wallet.service.ts')).not.toContain(
      'barcodeValue?: string;',
    );
    for (const file of [
      'passes/passes.controller.ts',
      'passes/p.controller.ts',
    ]) {
      expect(readApi(file)).not.toContain('barcodeValue:');
    }
  });

  it('no barcode field is built from a member phone number', () => {
    for (const file of [
      'wallet/wallet.service.ts',
      'passes/passes.controller.ts',
      'passes/p.controller.ts',
    ]) {
      const src = readApi(file);
      // The old shape was `barcode...: <something>.phone.replace(...)`.
      expect(src).not.toMatch(/barcode\w*:\s*[^,\n]*\bphone\b/);
    }
    expect(readWeb('app/enroll/EnrollFlow.tsx')).not.toMatch(
      /barcode\w*:\s*[^,\n]*onboardingPhone/,
    );
  });
});

describe('4.2 — proximity opt-in education (already shipped, kept honest)', () => {
  it('the enrollment success screen tells the member to turn notifications on', () => {
    const src = readWeb('app/enroll/EnrollFlow.tsx');
    expect(src).toContain('notifications for nearby passes');
    expect(src).toContain('support.google.com/wallet');
  });
});

describe('4.4 — store location map picker', () => {
  it('the picker sets both coordinates in one atomic update', () => {
    const src = readWeb('app/dashboard/_components/StoreLocationEntry.tsx');
    // A map click must not go through two single-field updates: the second
    // would close over pre-first-update state and drop the latitude.
    expect(src).toContain('onUpdate(index, { latitude: lat, longitude: lng })');
    // Leaflet reads `window` on import, so it must not be server-rendered.
    expect(src).toContain('ssr: false');
  });

  it('uses the Google Maps API, gated behind a configurable key', () => {
    // D8 switched the picker from keyless OpenStreetMap tiles to
    // @vis.gl/react-google-maps; the key is optional (degrades gracefully
    // when unset) rather than baked in unconditionally.
    const src = readWeb('app/dashboard/_components/StoreLocationMap.tsx');
    expect(src).toContain('@vis.gl/react-google-maps');
    expect(src).toContain('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
  });
});
