import { Test, TestingModule } from '@nestjs/testing';
import { PassesController } from './passes.controller';
import { SupabaseService } from '../supabase/supabase.service';
import { OtpService } from '../notification/otp.service';
import { WhatsappService } from '../notification/whatsapp.service';
import { WalletService } from '../wallet/wallet.service';
import { NotifyService } from '../notification/notify.service';
import { TenantGuard } from '../auth/tenant.guard';
import { AuditService } from '../audit/audit.service';
import { WebhookService } from '../developers/webhook.service';

/**
 * Regression guard for the demo-mode gate on POST /passes/generate-pass: it
 * must only ever bite a tenant explicitly marked 'demo'. Defaulting existing
 * tenants/members to 'demo' would have blocked issuance for the whole live
 * system with no unblock path.
 */
describe('PassesController.postgeneratepass demo gate', () => {
  const mockRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const build = async (publishStatus: any, member: any) => {
    const createGoogleWalletPass = jest
      .fn()
      .mockResolvedValue({ success: true, fullPassId: 'iss.obj1' });

    const fromMock = jest.fn().mockImplementation((table: string) => {
      if (table === 'Member') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: member }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'Tenant') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { publishStatus } }) }),
          }),
        };
      }
      // Pass
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'p1' }, error: null }),
          }),
        }),
      };
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassesController],
      providers: [
        { provide: SupabaseService, useValue: { client: { from: fromMock } } },
        { provide: OtpService, useValue: {} },
        { provide: WhatsappService, useValue: {} },
        {
          provide: WalletService,
          useValue: {
            resolveTenantPassDesign: jest.fn().mockResolvedValue({
              hexBackgroundColor: '#1A365D',
            }),
            forTenant: jest.fn().mockResolvedValue({ createGoogleWalletPass }),
          },
        },
        { provide: NotifyService, useValue: {} },
        { provide: TenantGuard, useValue: {} },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: WebhookService, useValue: { dispatch: jest.fn() } },
      ],
    }).compile();

    return {
      controller: module.get<PassesController>(PassesController),
      createGoogleWalletPass,
    };
  };

  const req = () =>
    ({ body: { tenantId: 't1', phone: '+919999999999' } }) as any;

  it('issues a pass for a production tenant and a non-test member', async () => {
    const { controller, createGoogleWalletPass } = await build('production', {
      id: 'm1',
      isTestAccount: false,
    });
    const res = mockRes();
    await controller.postgeneratepass(req(), res);

    expect(createGoogleWalletPass).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not block when publishStatus is missing/unreadable (fails open)', async () => {
    const { controller, createGoogleWalletPass } = await build(undefined, {
      id: 'm1',
      isTestAccount: false,
    });
    const res = mockRes();
    await controller.postgeneratepass(req(), res);

    expect(createGoogleWalletPass).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('blocks only an explicitly-demo tenant issuing to a non-test member', async () => {
    const { controller, createGoogleWalletPass } = await build('demo', {
      id: 'm1',
      isTestAccount: false,
    });
    const res = mockRes();
    await controller.postgeneratepass(req(), res);

    expect(createGoogleWalletPass).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('still allows a demo tenant to issue to a registered test account', async () => {
    const { controller, createGoogleWalletPass } = await build('demo', {
      id: 'm1',
      isTestAccount: true,
    });
    const res = mockRes();
    await controller.postgeneratepass(req(), res);

    expect(createGoogleWalletPass).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
