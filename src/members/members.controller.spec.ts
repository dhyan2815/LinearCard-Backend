import { Test, TestingModule } from '@nestjs/testing';
import { MembersController } from './members.controller';
import { SupabaseService } from '../supabase/supabase.service';
import { NotifyService } from '../notification/notify.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';

describe('MembersController.getMembers', () => {
  let controller: MembersController;
  let rangeMock: jest.Mock;
  let orderMock: jest.Mock;
  let orMock: jest.Mock;
  let eqMock: jest.Mock;
  let selectMock: jest.Mock;
  let fromMock: jest.Mock;
  let supabaseServiceMock: any;
  let capturedEqArgs: any[];
  let capturedOrArgs: any[];

  const buildChain = (result: any) => {
    capturedEqArgs = [];
    capturedOrArgs = [];
    rangeMock = jest.fn().mockResolvedValue(result);
    // Two .order() calls now (name, then createdAt) before .range().
    orderMock = jest.fn(() => ({ order: orderMock, range: rangeMock }));
    orMock = jest.fn().mockImplementation((arg: any) => {
      capturedOrArgs.push(arg);
      return { order: orderMock };
    });
    eqMock = jest.fn().mockImplementation((...args: any[]) => {
      capturedEqArgs.push(args);
      return { or: orMock, order: orderMock };
    });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    fromMock = jest.fn().mockReturnValue({ select: selectMock });
    supabaseServiceMock = { client: { from: fromMock } };
  };

  const setup = async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: SupabaseService, useValue: supabaseServiceMock },
        { provide: NotifyService, useValue: {} },
        { provide: WalletService, useValue: {} },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    controller = module.get<MembersController>(MembersController);
  };

  it('only returns the requesting tenant members', async () => {
    buildChain({
      data: [{ id: 'm1', tenantId: 'tenant-A' }],
      error: null,
    });
    await setup();

    const req: any = { tenantId: 'tenant-A' };
    const res = await controller.getMembers(req);

    expect(fromMock).toHaveBeenCalledWith('Member');
    expect(capturedEqArgs[0]).toEqual(['tenantId', 'tenant-A']);
    expect(res).toEqual({
      success: true,
      members: [{ id: 'm1', tenantId: 'tenant-A' }],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it('applies default limit/offset when none provided', async () => {
    buildChain({ data: [], error: null });
    await setup();

    await controller.getMembers({ tenantId: 'tenant-A' } as any);

    expect(rangeMock).toHaveBeenCalledWith(0, 49);
  });

  it('applies custom limit/offset', async () => {
    buildChain({ data: [], error: null });
    await setup();

    await controller.getMembers({ tenantId: 'tenant-A' } as any, '10', '20');

    expect(rangeMock).toHaveBeenCalledWith(20, 29);
  });

  it('filters by q against name/phone via ilike', async () => {
    buildChain({ data: [], error: null });
    await setup();

    await controller.getMembers(
      { tenantId: 'tenant-A' } as any,
      undefined,
      undefined,
      'john',
    );

    expect(capturedOrArgs[0]).toEqual('name.ilike.%john%,phone.ilike.%john%');
  });
});

describe('MembersController.adjustBalance', () => {
  const passRow = {
    id: 'pass1',
    tenantId: 'tenant-A',
    balance: 10,
    fullPassId: 'obj1',
    tier: 'Bronze',
    Program: { walletType: 'loyalty' },
  };

  // Second .eq() (tenantId) governs whether the tenant-scoped lookup finds
  // the pass: passes it through so the cross-tenant test can prove rejection.
  const buildPassFromMock = (foundForTenant: string | null) =>
    jest.fn().mockImplementation((table: string) => {
      if (table === 'Pass') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest
                .fn()
                .mockImplementation((_col: string, tenantId: string) => ({
                  single: jest
                    .fn()
                    .mockResolvedValue(
                      tenantId === foundForTenant
                        ? { data: passRow, error: null }
                        : { data: null, error: { message: 'not found' } },
                    ),
                })),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {};
    });

  const buildController = async (
    fromMock: jest.Mock,
    auditRecordMock: jest.Mock,
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembersController],
      providers: [
        { provide: SupabaseService, useValue: { client: { from: fromMock } } },
        { provide: NotifyService, useValue: { logNotification: jest.fn() } },
        {
          provide: WalletService,
          useValue: {
            updateGenericObject: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { record: auditRecordMock } },
      ],
    }).compile();
    return module.get<MembersController>(MembersController);
  };

  it('writes the AuditLog via AuditService with the caller tenantId', async () => {
    const auditRecordMock = jest.fn().mockResolvedValue(undefined);
    const controller = await buildController(
      buildPassFromMock('tenant-A'),
      auditRecordMock,
    );

    await controller.adjustBalance(
      'member1',
      { newBalance: 15, note: 'test', passId: 'pass1', adminId: 'admin1' },
      { tenantId: 'tenant-A' } as any,
    );

    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-A',
        memberId: 'member1',
        passId: 'pass1',
        actor: 'admin1',
        action: 'balance_adjusted',
      }),
    );
  });

  it('rejects adjusting a pass that belongs to another tenant', async () => {
    const auditRecordMock = jest.fn().mockResolvedValue(undefined);
    const controller = await buildController(
      buildPassFromMock('tenant-A'),
      auditRecordMock,
    );

    await expect(
      controller.adjustBalance(
        'member1',
        { newBalance: 15, note: 'test', passId: 'pass1', adminId: 'admin1' },
        { tenantId: 'tenant-B' } as any,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'Pass not found' }),
    });

    expect(auditRecordMock).not.toHaveBeenCalled();
  });
});
