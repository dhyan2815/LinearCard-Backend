// tests/templates-api.mjs
import 'dotenv/config';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

async function test() {
  console.log(`Connecting to ${BASE_URL}...`);
  const tenantsRes = await fetch(`${BASE_URL}/api/tenants`);
  const tenantsData = await tenantsRes.json();
  if (!tenantsData.success || !tenantsData.tenants || tenantsData.tenants.length === 0) {
    throw new Error('No tenants found — run seed data first');
  }
  const tenantId = tenantsData.tenants[0].id;
  console.log(`Using tenantId: ${tenantId}`);

  // 1. POST /api/templates
  const createRes = await fetch(`${BASE_URL}/api/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId,
      name: 'Test Loyalty Card',
      archetype: 'loyalty',
      classSuffix: `test_loyalty_${Date.now()}`,
      fieldRows: [{ id: 'row1', columns: [{ header: 'Points', body: '0' }, { header: 'Tier', body: 'Bronze' }] }],
      hexBackgroundColor: '#1A365D',
    }),
  });
  const createData = await createRes.json();
  console.assert(createData.success, `FAIL POST: ${JSON.stringify(createData)}`);
  console.assert(createData.template.status === 'draft', 'FAIL: should be draft');
  const templateId = createData.template.id;
  console.log('✅ POST /api/templates');

  // 2. GET /api/templates?tenantId=...
  const listRes = await fetch(`${BASE_URL}/api/templates?tenantId=${tenantId}`);
  const listData = await listRes.json();
  console.assert(listData.success, 'FAIL GET list');
  console.assert(listData.templates.some(t => t.id === templateId), 'FAIL: template missing in list');
  console.log('✅ GET /api/templates');

  // 3. GET /api/templates/[id]
  const getRes = await fetch(`${BASE_URL}/api/templates/${templateId}`);
  const getData = await getRes.json();
  console.assert(getData.success, 'FAIL GET by ID');
  console.assert(getData.template.id === templateId, 'FAIL: template ID mismatch in GET');
  console.log('✅ GET /api/templates/[id]');

  // 4. PATCH /api/templates/[id]
  const patchRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Updated Loyalty Card' }),
  });
  const patchData = await patchRes.json();
  console.assert(patchData.success, `FAIL PATCH: ${JSON.stringify(patchData)}`);
  console.assert(
    patchData.template.name === 'Updated Loyalty Card' || patchData.template.title === 'Updated Loyalty Card',
    'FAIL: name not updated'
  );
  console.log('✅ PATCH /api/templates/[id]');

  // 5. Archetype validation
  const badRes = await fetch(`${BASE_URL}/api/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, name: 'Bad', archetype: 'coupon', classSuffix: 'x' }),
  });
  console.assert(badRes.status === 400, 'FAIL: invalid archetype should be 400');
  console.log('✅ Archetype validation');

  // 6. POST /api/templates/[id]/publish
  const publishRes = await fetch(`${BASE_URL}/api/templates/${templateId}/publish`, {
    method: 'POST',
  });
  const publishData = await publishRes.json();
  console.assert(publishData.success, `FAIL PUBLISH: ${JSON.stringify(publishData)}`);
  console.assert(publishData.template.status === 'published', 'FAIL: status not published');
  console.assert(Boolean(publishData.template.googleClassId), 'FAIL: googleClassId missing');
  console.log('✅ POST /api/templates/[id]/publish');

  // 7. DELETE /api/templates/[id]
  const delRes = await fetch(`${BASE_URL}/api/templates/${templateId}`, { method: 'DELETE' });
  const delData = await delRes.json();
  console.assert(delData.success, 'FAIL DELETE');
  console.log('✅ DELETE /api/templates/[id]');

  console.log('All template API tests pass.');
}

test().catch(e => {
  console.error('Test execution failed:', e.message);
  process.exit(1);
});
