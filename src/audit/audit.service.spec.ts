import { AuditService } from './audit.service';

describe('AuditService.record', () => {
  let insertMock: jest.Mock;
  let service: AuditService;

  beforeEach(() => {
    insertMock = jest.fn().mockResolvedValue({ error: null });
    const supabaseServiceMock: any = {
      client: { from: jest.fn().mockReturnValue({ insert: insertMock }) },
    };
    service = new AuditService(supabaseServiceMock);
  });

  it('inserts all columns, folding passId into details', async () => {
    await service.record({
      tenantId: 't1',
      memberId: 'm1',
      passId: 'p1',
      actor: 'admin1',
      action: 'balance_adjusted',
      details: { amount: 5 },
    });

    expect(insertMock).toHaveBeenCalledWith({
      tenantId: 't1',
      memberId: 'm1',
      // Phase 8 — a real column; NULL when the caller has no program.
      programId: null,
      actor: 'admin1',
      action: 'balance_adjusted',
      details: { passId: 'p1', amount: 5 },
    });
  });

  it('omits passId from details when not given', async () => {
    await service.record({
      tenantId: 't1',
      memberId: 'm1',
      actor: 'admin1',
      action: 'balance_adjusted',
      details: { amount: 5 },
    });

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: { amount: 5 } }),
    );
  });
});
