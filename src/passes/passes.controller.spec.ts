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
 * Phase 7.2 — the controller now verifies every callback against Google's
 * root signing keys. The signature scheme itself is exercised against real
 * generated EC keys in idempotency-and-wallet-jws.spec.ts; here it is stubbed so these tests
 * stay about the controller's routing and side effects.
 */
jest.mock('../wallet/google-jws', () => ({
  SignatureError: class SignatureError extends Error {},
  verifyWalletCallback: jest.fn(async (envelope: any) => {
    if (verificationFails) throw new Error('forged');
    return JSON.parse(envelope.signedMessage);
  }),
}));

let verificationFails = false;

describe('PassesController.postGoogleWalletWebhook', () => {
  let controller: PassesController;
  let logNotificationMock: jest.Mock;
  let sendWalletSaveConfirmationMock: jest.Mock;
  let updateMock: jest.Mock;
  let insertMock: jest.Mock;
  let fromMock: jest.Mock;
  let passRow: any;
  let auditRecordMock: jest.Mock;

  const mockRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const setup = async (pass: any) => {
    passRow = pass;
    logNotificationMock = jest.fn().mockResolvedValue(undefined);
    sendWalletSaveConfirmationMock = jest.fn().mockResolvedValue(undefined);
    updateMock = jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
    insertMock = jest.fn().mockResolvedValue({ error: null });
    auditRecordMock = jest.fn().mockResolvedValue(undefined);

    fromMock = jest.fn().mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest
                .fn()
                .mockResolvedValue({ data: passRow, error: null }),
            }),
          }),
          update: updateMock,
        };
      }
      if (table === 'AuditLog') {
        return { insert: insertMock };
      }
      return { insert: insertMock };
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassesController],
      providers: [
        { provide: SupabaseService, useValue: { client: { from: fromMock } } },
        { provide: OtpService, useValue: {} },
        {
          provide: WhatsappService,
          useValue: {
            sendWalletSaveConfirmationWithLog: sendWalletSaveConfirmationMock,
          },
        },
        { provide: WalletService, useValue: {} },
        {
          provide: NotifyService,
          useValue: { logNotification: logNotificationMock },
        },
        { provide: TenantGuard, useValue: {} },
        { provide: AuditService, useValue: { record: auditRecordMock } },
        {
          provide: WebhookService,
          useValue: { dispatch: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    controller = module.get<PassesController>(PassesController);
  };

  it('fires WhatsApp confirmation on a valid save event', async () => {
    await setup({
      id: 'p1',
      tenantId: 't1',
      memberId: 'm1',
      fullPassId: 'obj1',
      Member: { phone: '+911234567890' },
      Tenant: { name: 'Acme' },
    });
    const req: any = {
      body: {
        signedMessage: JSON.stringify({ objectId: 'obj1', eventType: 'save' }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(sendWalletSaveConfirmationMock).toHaveBeenCalledWith(
      '+911234567890',
      'Acme',
      { tenantId: 't1', memberId: 'm1' },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sets deletedAt and writes AuditLog on a del event, no WhatsApp', async () => {
    await setup({
      id: 'p1',
      tenantId: 't1',
      memberId: 'm1',
      fullPassId: 'obj1',
      Member: { phone: '+91' },
      Tenant: {},
    });
    const req: any = {
      body: {
        signedMessage: JSON.stringify({ objectId: 'obj1', eventType: 'del' }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(String) }),
    );
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pass_deleted',
        tenantId: 't1',
        passId: 'p1',
      }),
    );
    expect(sendWalletSaveConfirmationMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // SEC-2: a forged `del` must not soft-delete a pass. Phase 7.2 replaced
  // the shared-secret gate with real signature verification, so an
  // unverifiable callback is rejected before any branch runs.
  it('rejects an unverified del event with 401 and touches nothing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    verificationFails = true;
    await setup({
      id: 'p1',
      tenantId: 't1',
      memberId: 'm1',
      fullPassId: 'obj1',
      Member: { phone: '+91' },
      Tenant: {},
    });
    const req: any = {
      body: {
        signedMessage: JSON.stringify({ objectId: 'obj1', eventType: 'del' }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(updateMock).not.toHaveBeenCalled();
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    verificationFails = false;
    warnSpy.mockRestore();
  });

  it('clears deletedAt when a previously-removed pass is saved again', async () => {
    await setup({
      id: 'p1',
      tenantId: 't1',
      memberId: 'm1',
      fullPassId: 'obj1',
      deletedAt: '2026-01-01T00:00:00.000Z',
      Member: { phone: '+911234567890' },
      Tenant: { name: 'Acme' },
    });
    const req: any = {
      body: {
        signedMessage: JSON.stringify({ objectId: 'obj1', eventType: 'save' }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(updateMock).toHaveBeenCalledWith({ deletedAt: null });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('warns (and never attempts a NotificationLog insert) for an unknown objectId', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setup(null);
    const req: any = {
      body: {
        signedMessage: JSON.stringify({
          objectId: 'missing',
          eventType: 'save',
        }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    // A NotificationLog row for an unknown objectId has no tenantId/memberId
    // to satisfy its NOT NULL FKs, so no insert must be attempted at all.
    expect(logNotificationMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing'));
    expect(sendWalletSaveConfirmationMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    warnSpy.mockRestore();
  });

  it('returns 400 when the envelope carries no signedMessage at all', async () => {
    await setup({ id: 'p1' });
    const req: any = { body: {} };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 and logs a failed NotificationLog for an unhandled eventType', async () => {
    await setup({
      id: 'p1',
      tenantId: 't1',
      memberId: 'm1',
      fullPassId: 'obj1',
      Member: {},
      Tenant: {},
    });
    const req: any = {
      body: {
        signedMessage: JSON.stringify({
          objectId: 'obj1',
          eventType: 'expire',
        }),
      },
    };
    const res = mockRes();

    await controller.postGoogleWalletWebhook(req, res);

    expect(logNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', tenantId: 't1' }),
    );
    expect(sendWalletSaveConfirmationMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('PassesController.postgeneratepass — rows default to passDesign.fieldRows', () => {
  let controller: PassesController;
  let createGoogleWalletPassCalls: any[];
  const giftCardFieldRows = [
    { id: 'row1', columns: [{ key: 'balance', header: 'Balance', body: '0' }] },
  ];

  const setup = async () => {
    createGoogleWalletPassCalls = [];
    const fromMock = jest.fn().mockImplementation((table: string) => {
      if (table === 'Member') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'member-1', phone: '+911234567890' },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'Tenant') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { publishStatus: 'production' } }),
            }),
          }),
        };
      }
      if (table === 'Pass') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'pass-1' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const walletServiceMock = {
      resolveTenantPassDesign: async () => ({
        hexBackgroundColor: '#123456',
        cardTitle: 'Bistro Cafe · Gift Card',
        classSuffix: 'bistro_cafe_gift_card',
        fieldRows: giftCardFieldRows,
      }),
      forTenant: async () => ({
        createGoogleWalletPass: async (data: any) => {
          createGoogleWalletPassCalls.push(data);
          return {
            success: true,
            fullPassId: 'issuer.pass-1',
            googleWalletUrl: 'https://pay.google.com/gp/v/save/t',
          };
        },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PassesController],
      providers: [
        { provide: SupabaseService, useValue: { client: { from: fromMock } } },
        { provide: OtpService, useValue: {} },
        {
          provide: WhatsappService,
          useValue: { sendPassLinkWithLog: jest.fn() },
        },
        { provide: WalletService, useValue: walletServiceMock },
        { provide: NotifyService, useValue: { logNotification: jest.fn() } },
        { provide: TenantGuard, useValue: {} },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: WebhookService, useValue: { dispatch: jest.fn() } },
      ],
    }).compile();
    controller = module.get<PassesController>(PassesController);
  };

  const mockRes = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('uses passDesign.fieldRows when body.rows is not supplied', async () => {
    await setup();
    const req: any = {
      body: { tenantId: 't1', phone: '+911234567890', memberName: 'Aniket' },
    };
    await controller.postgeneratepass(req, mockRes());
    expect(createGoogleWalletPassCalls[0].rows).toBe(giftCardFieldRows);
  });

  it('still prefers an explicit body.rows over passDesign.fieldRows', async () => {
    await setup();
    const customRows = [
      { id: 'row1', columns: [{ key: 'custom', header: 'Custom', body: 'x' }] },
    ];
    const req: any = {
      body: {
        tenantId: 't1',
        phone: '+911234567890',
        memberName: 'Aniket',
        rows: customRows,
      },
    };
    await controller.postgeneratepass(req, mockRes());
    expect(createGoogleWalletPassCalls[0].rows).toBe(customRows);
  });
});
