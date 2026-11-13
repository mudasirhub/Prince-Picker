-- =============================================================================
-- PRINCE PICKER: Cloudflare R2 Development Domain to Production Worker Migration
-- Migration Script: 20261113_migrate_r2_image_urls_to_worker.sql
-- 
-- DESCRIPTION:
-- Migrates product image URLs stored in the Supabase PostgreSQL database
-- from legacy Cloudflare R2 development domains:
--   - https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev
--   - https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev
-- to the production Cloudflare Worker endpoint:
--   - https://prince-picker-image-worker.prince-picker.workers.dev
--
-- TARGET TABLE & COLUMNS:
--   1. Table: public.products
--      - Column: image  (TEXT)  -- Primary product image URL
--      - Column: images (JSONB) -- Array of image metadata objects / URL strings
--
-- EXECUTION INSTRUCTIONS:
--   1. Open the Supabase Dashboard -> Project "Prince Picker" (jzwpbiqiplsuuukbxhnq).
--   2. In the left navigation, click "SQL Editor".
--   3. Create a new query.
--   4. Step 1 (PREVIEW): Run the "PREVIEW QUERIES" section first to review all records that will be updated.
--   5. Step 2 (EXECUTE MIGRATION): Run the "TRANSACTIONAL UPDATE" block inside BEGIN / COMMIT.
--   6. Step 3 (VERIFY): Run the "POST-MIGRATION VERIFICATION" queries to confirm 0 legacy URLs remain.
-- =============================================================================

-- =============================================================================
-- SECTION 1: PRE-MIGRATION PREVIEW QUERIES (READ ONLY)
-- Run these queries first to inspect affected rows before executing the migration.
-- =============================================================================

-- 1.1 Summary count of affected products by column and legacy domain
SELECT 
  COUNT(*) FILTER (WHERE image LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%') AS count_image_pub091,
  COUNT(*) FILTER (WHERE image LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%') AS count_image_pubf1e,
  COUNT(*) FILTER (WHERE images::text LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%') AS count_images_json_pub091,
  COUNT(*) FILTER (WHERE images::text LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%') AS count_images_json_pubf1e,
  COUNT(*) FILTER (
    WHERE image LIKE '%r2.dev%' OR images::text LIKE '%r2.dev%'
  ) AS total_products_with_legacy_r2_dev
FROM products;

-- 1.2 Preview individual rows with affected 'image' column
SELECT 
  id, 
  sku, 
  name, 
  image AS current_image_url,
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          image, 
          'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev', 
          'https://prince-picker-image-worker.prince-picker.workers.dev'
        ),
        'http://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev', 
        'https://prince-picker-image-worker.prince-picker.workers.dev'
      ),
      'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev', 
      'https://prince-picker-image-worker.prince-picker.workers.dev'
    ),
    'http://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev', 
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  ) AS proposed_image_url
FROM products
WHERE image LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%'
   OR image LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%'
LIMIT 20;

-- 1.3 Preview individual rows with affected 'images' JSONB column
SELECT 
  id, 
  sku, 
  name, 
  images AS current_images_json,
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          images::text, 
          'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev', 
          'https://prince-picker-image-worker.prince-picker.workers.dev'
        ),
        'http://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev', 
        'https://prince-picker-image-worker.prince-picker.workers.dev'
      ),
      'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev', 
      'https://prince-picker-image-worker.prince-picker.workers.dev'
    ),
    'http://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev', 
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  )::jsonb AS proposed_images_json
FROM products
WHERE images::text LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%'
   OR images::text LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%'
LIMIT 20;


-- =============================================================================
-- SECTION 2: TRANSACTIONAL MIGRATION (MANUAL EXECUTION)
-- Wraps all updates in an atomic database transaction.
-- If any error occurs, the transaction rolls back cleanly.
-- =============================================================================

BEGIN;

-- 2.1 Update 'image' column: replace primary old R2 development URL (pub-091b1d2070306c80f830d33d243cf4f0)
UPDATE products
SET image = REPLACE(
  REPLACE(
    image,
    'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev',
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  ),
  'http://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev',
  'https://prince-picker-image-worker.prince-picker.workers.dev'
)
WHERE image LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%';

-- 2.2 Update 'image' column: replace secondary old R2 development URL (pub-f1e8b42c57c64598b4251559ff578b2e)
UPDATE products
SET image = REPLACE(
  REPLACE(
    image,
    'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev',
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  ),
  'http://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev',
  'https://prince-picker-image-worker.prince-picker.workers.dev'
)
WHERE image LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%';

-- 2.3 Update 'images' JSONB column: replace primary old R2 development URL
UPDATE products
SET images = REPLACE(
  REPLACE(
    images::text,
    'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev',
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  ),
  'http://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev',
  'https://prince-picker-image-worker.prince-picker.workers.dev'
)::jsonb
WHERE images::text LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%';

-- 2.4 Update 'images' JSONB column: replace secondary old R2 development URL
UPDATE products
SET images = REPLACE(
  REPLACE(
    images::text,
    'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev',
    'https://prince-picker-image-worker.prince-picker.workers.dev'
  ),
  'http://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev',
  'https://prince-picker-image-worker.prince-picker.workers.dev'
)::jsonb
WHERE images::text LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%';

-- Commit the transaction
COMMIT;


-- =============================================================================
-- SECTION 3: POST-MIGRATION VERIFICATION QUERIES
-- Run these queries after committing to verify that migration succeeded completely.
-- =============================================================================

-- 3.1 Verification Check 1: Must return 0 for all legacy domains
SELECT 
  COUNT(*) FILTER (WHERE image LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%') AS remaining_image_pub091,
  COUNT(*) FILTER (WHERE image LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%') AS remaining_image_pubf1e,
  COUNT(*) FILTER (WHERE images::text LIKE '%pub-091b1d2070306c80f830d33d243cf4f0.r2.dev%') AS remaining_images_json_pub091,
  COUNT(*) FILTER (WHERE images::text LIKE '%pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev%') AS remaining_images_json_pubf1e,
  COUNT(*) FILTER (WHERE image LIKE '%r2.dev%' OR images::text LIKE '%r2.dev%') AS remaining_total_r2_dev
FROM products;

-- 3.2 Verification Check 2: Inspect active production Worker image URLs
SELECT 
  id, 
  sku, 
  name, 
  image, 
  images
FROM products
WHERE image LIKE '%prince-picker-image-worker.prince-picker.workers.dev%'
   OR images::text LIKE '%prince-picker-image-worker.prince-picker.workers.dev%'
ORDER BY updated_at DESC
LIMIT 10;
