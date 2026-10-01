import { WhatsappService } from './whatsapp.service';

describe('WhatsappService', () => {
  let service: WhatsappService;
  let notifyService: any;

  beforeEach(() => {
    process.env.WAHA_BASE_URL = 'http://waha.local';
    process.env.WAHA_API_KEY = 'test-key';
    process.env.WAHA_SESSION = 'default';

    notifyService = {
      logNotification: jest.fn().mockResolvedValue(undefined),
    };
    const supabaseService: any = {
      client: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      },
    };
    service = new WhatsappService(notifyService, supabaseService);

    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sendTierUpgradeMessage', () => {
    it('sends the tier-upgrade WhatsApp text and logs success', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg-1' }),
      });

      await service.sendTierUpgradeMessage(
        '+919876543210',
        'Silver',
        'Acme Cafe',
        {
          tenantId: 'tenant-1',
          memberId: 'member-1',
        },
      );

      const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(requestInit.body);
      expect(body.chatId).toBe('919876543210@c.us');
      expect(body.text).toContain('Silver');
      expect(notifyService.logNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          memberId: 'member-1',
          type: 'tier_upgrade',
          channel: 'whatsapp',
          status: 'sent',
        }),
      );
    });

    it('logs a failure and rethrows when the WAHA request fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'waha down',
      });

      await expect(
        service.sendTierUpgradeMessage('+919876543210', 'Gold', 'Acme Cafe', {
          tenantId: 'tenant-1',
          memberId: 'member-1',
        }),
      ).rejects.toThrow();

      expect(notifyService.logNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tier_upgrade', status: 'failed' }),
      );
    });
  });
});
