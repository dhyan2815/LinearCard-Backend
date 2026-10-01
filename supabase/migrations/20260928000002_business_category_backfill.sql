-- Hand-reviewed business categories for the tenants that existed before
-- Phase 1 (plan Section 5). No-ops on any database without these rows.
UPDATE "Tenant" SET "businessCategory" = 'salon_spa_fitness'
  WHERE "id" = 'f1ab8b36-fc7f-4a92-9787-7e841ee3d09c'; -- IronCore Fitness
UPDATE "Tenant" SET "businessCategory" = 'food_beverage'
  WHERE "id" = 'a7ab209e-cbc4-4e6e-9b90-16911dbaba83'; -- BeanHouse Coffee
UPDATE "Tenant" SET "businessCategory" = 'food_beverage'
  WHERE "id" = 'dd1309a1-080c-46de-865b-b820c0ab29f7'; -- Bistro Cafe
UPDATE "Tenant" SET "businessCategory" = 'test'
  WHERE "id" = '1830d14e-973d-4d4e-94c0-33a622340497'; -- LinearCard Demo Pass
