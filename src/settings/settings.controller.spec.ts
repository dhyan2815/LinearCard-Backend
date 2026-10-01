import { DeveloperSettingsController } from './settings.controller';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('DeveloperSettingsController', () => {
  it('POST /admin/developer-settings no longer mints a plaintext key (410 Gone)', () => {
    const controller = new DeveloperSettingsController({} as any);
    expect(() => controller.generateApiKey()).toThrow(HttpException);
    try {
      controller.generateApiKey();
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.GONE);
    }
  });
});
