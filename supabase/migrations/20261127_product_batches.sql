-- =============================================================================
-- PRINCE PICKER: BATCH ID & MULTI-MRP SUPPORT MIGRATION
-- Supports multiple batches (batch_id + mrp + stock_qty + location) per SKU/product
-- while remaining 100% backward compatible with legacy single-MRP products.
-- =============================================================================

-- 1. Add JSONB batches cache & total_stock columns on products for single-fetch offline sync
ALTER TABLE products ADD COLUMN IF NOT EXISTS batches JSONB DEFAULT '[]'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_stock INTEGER DEFAULT 0;

-- 2. Create normalized product_batches table
CREATE TABLE IF NOT EXISTS product_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL,
  sku TEXT,
  batch_id TEXT NOT NULL,
  mrp NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  location TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_product_batches_product_id ON product_batches (product_id);
CREATE INDEX IF NOT EXISTS idx_product_batches_sku ON product_batches (sku);
CREATE INDEX IF NOT EXISTS idx_product_batches_fifo ON product_batches (product_id, created_at ASC);

-- Enable RLS & permissive authenticated/anon policies matching existing tables
ALTER TABLE product_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read product_batches" ON product_batches;
CREATE POLICY "Allow read product_batches" ON product_batches
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow insert product_batches" ON product_batches;
CREATE POLICY "Allow insert product_batches" ON product_batches
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow update product_batches" ON product_batches;
CREATE POLICY "Allow update product_batches" ON product_batches
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow delete product_batches" ON product_batches;
CREATE POLICY "Allow delete product_batches" ON product_batches
  FOR DELETE USING (true);

-- 3. Backfill default B1 batch for existing products that have no rows in product_batches
-- Uses to_jsonb(p) for optional columns (qty, loc, created_at) so missing columns never fail.
INSERT INTO product_batches (product_id, sku, batch_id, mrp, stock_qty, location, created_at, updated_at)
SELECT
  p.id,
  COALESCE(NULLIF(p.sku, ''), p.barcode, p.id),
  'B1',
  COALESCE(p.mrp, 0),
  GREATEST(0, COALESCE(p.stock, NULLIF(to_jsonb(p)->>'qty', '')::NUMERIC, 0)::INTEGER),
  COALESCE(NULLIF(p.primary_location, ''), NULLIF(p.location, ''), NULLIF(to_jsonb(p)->>'loc', ''), ''),
  COALESCE(NULLIF(to_jsonb(p)->>'created_at', '')::TIMESTAMPTZ, NOW()),
  COALESCE(p.updated_at, NOW())
FROM products p
WHERE NOT EXISTS (
  SELECT 1 FROM product_batches pb WHERE pb.product_id = p.id
)
ON CONFLICT (product_id, batch_id) DO NOTHING;

-- Sync products.total_stock and products.batches from product_batches after backfill
UPDATE products p
SET
  total_stock = COALESCE((
    SELECT SUM(CASE WHEN pb.stock_qty > 0 THEN pb.stock_qty ELSE 0 END)
    FROM product_batches pb WHERE pb.product_id = p.id
  ), COALESCE(p.stock, 0)::INTEGER),
  batches = COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', pb.id,
        'product_id', pb.product_id,
        'sku', pb.sku,
        'batch_id', pb.batch_id,
        'mrp', pb.mrp,
        'stock_qty', pb.stock_qty,
        'location', pb.location,
        'created_at', pb.created_at,
        'updated_at', pb.updated_at
      ) ORDER BY pb.created_at ASC
    )
    FROM product_batches pb WHERE pb.product_id = p.id
  ), '[]'::jsonb);

-- 4. Track batch_id and unit_mrp on inventory_movements (optional / backward compatible)
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS batch_id TEXT DEFAULT '';
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_mrp NUMERIC(12, 2) DEFAULT NULL;

-- 5. Drop legacy 7-param overload before creating 9-param function to prevent PostgREST PGRST203 ambiguity
DROP FUNCTION IF EXISTS fn_process_inventory_movement(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION fn_process_inventory_movement(
  p_type TEXT,
  p_sku TEXT,
  p_qty NUMERIC,
  p_location TEXT DEFAULT '',
  p_picker TEXT DEFAULT 'Picker',
  p_session_id TEXT DEFAULT '',
  p_transaction_id TEXT DEFAULT NULL,
  p_batch_id TEXT DEFAULT NULL,
  p_unit_mrp NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_new_stock NUMERIC;
  v_movement_id UUID;
  v_clean_type TEXT;
  v_clean_qty NUMERIC;
  v_product_id TEXT;
  v_target_batch TEXT;
BEGIN
  v_clean_type := UPPER(COALESCE(p_type, 'DROP'));
  v_clean_qty := COALESCE(p_qty, 1);

  -- Step 1: Idempotency Check
  IF p_transaction_id IS NOT NULL AND p_transaction_id != '' THEN
    SELECT * INTO v_existing
    FROM inventory_movements
    WHERE transaction_id = p_transaction_id
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transaction_id', p_transaction_id,
        'movement_id', v_existing.id,
        'type', v_existing.type,
        'sku', v_existing.sku,
        'qty', v_existing.qty,
        'location', v_existing.location,
        'batch_id', v_existing.batch_id,
        'unit_mrp', v_existing.unit_mrp,
        'message', 'Duplicate transaction ID skipped at database level'
      );
    END IF;
  END IF;

  -- Locate parent product
  SELECT id INTO v_product_id
  FROM products
  WHERE sku = p_sku OR barcode = p_sku OR id = p_sku
  LIMIT 1;

  v_target_batch := NULLIF(TRIM(COALESCE(p_batch_id, '')), '');

  -- FIFO batch fallback if product has explicit batches and no batch_id was provided
  IF v_product_id IS NOT NULL AND v_target_batch IS NULL THEN
    IF v_clean_type = 'PICK' THEN
      SELECT batch_id INTO v_target_batch
      FROM product_batches
      WHERE product_id = v_product_id AND stock_qty > 0
      ORDER BY created_at ASC
      LIMIT 1;
    ELSE
      SELECT batch_id INTO v_target_batch
      FROM product_batches
      WHERE product_id = v_product_id
      ORDER BY created_at ASC
      LIMIT 1;
    END IF;
  END IF;

  -- Step 2: Atomic Batch & Parent Stock Update
  IF v_product_id IS NOT NULL AND v_target_batch IS NOT NULL THEN
    IF v_clean_type = 'DROP' THEN
      INSERT INTO product_batches (product_id, sku, batch_id, mrp, stock_qty, location, updated_at)
      VALUES (v_product_id, p_sku, v_target_batch, COALESCE(p_unit_mrp, 0), v_clean_qty::INTEGER, COALESCE(p_location, ''), NOW())
      ON CONFLICT (product_id, batch_id) DO UPDATE SET
        stock_qty = GREATEST(0, product_batches.stock_qty + v_clean_qty::INTEGER),
        updated_at = NOW();
    ELSIF v_clean_type = 'PICK' THEN
      UPDATE product_batches
      SET stock_qty = GREATEST(0, stock_qty - v_clean_qty::INTEGER),
          updated_at = NOW()
      WHERE product_id = v_product_id AND batch_id = v_target_batch;
    END IF;

    -- Keep parent product total_stock & batches JSONB synced to active batch quantities (> 0)
    SELECT COALESCE(SUM(CASE WHEN stock_qty > 0 THEN stock_qty ELSE 0 END), 0)
    INTO v_new_stock
    FROM product_batches
    WHERE product_id = v_product_id;

    UPDATE products
    SET stock = v_new_stock,
        total_stock = v_new_stock,
        batches = COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', pb.id,
              'product_id', pb.product_id,
              'sku', pb.sku,
              'batch_id', pb.batch_id,
              'mrp', pb.mrp,
              'stock_qty', pb.stock_qty,
              'location', pb.location,
              'created_at', pb.created_at,
              'updated_at', pb.updated_at
            ) ORDER BY pb.created_at ASC
          )
          FROM product_batches pb WHERE pb.product_id = v_product_id
        ), '[]'::jsonb),
        updated_at = NOW()
    WHERE id = v_product_id;

    UPDATE inventory
    SET available_qty = v_new_stock,
        updated_at = NOW()
    WHERE sku = p_sku;
  ELSE
    IF v_clean_type = 'DROP' THEN
      UPDATE inventory
      SET available_qty = COALESCE(available_qty, 0) + v_clean_qty,
          updated_at = NOW()
      WHERE sku = p_sku
      RETURNING available_qty INTO v_new_stock;

      UPDATE products
      SET stock = COALESCE(stock, 0) + v_clean_qty,
          total_stock = COALESCE(stock, 0) + v_clean_qty,
          updated_at = NOW()
      WHERE sku = p_sku OR barcode = p_sku;
    ELSIF v_clean_type = 'PICK' THEN
      UPDATE inventory
      SET available_qty = GREATEST(0, COALESCE(available_qty, 0) - v_clean_qty),
          updated_at = NOW()
      WHERE sku = p_sku
      RETURNING available_qty INTO v_new_stock;

      UPDATE products
      SET stock = GREATEST(0, COALESCE(stock, 0) - v_clean_qty),
          total_stock = GREATEST(0, COALESCE(stock, 0) - v_clean_qty),
          updated_at = NOW()
      WHERE sku = p_sku OR barcode = p_sku;
    END IF;
  END IF;

  -- Step 3: Insert movement record
  INSERT INTO inventory_movements (
    type, sku, qty, location, picker, session_id, transaction_id, batch_id, unit_mrp, created_at
  ) VALUES (
    v_clean_type, p_sku, v_clean_qty, p_location, p_picker, p_session_id, p_transaction_id, COALESCE(v_target_batch, ''), p_unit_mrp, NOW()
  )
  RETURNING id INTO v_movement_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'transaction_id', p_transaction_id,
    'movement_id', v_movement_id,
    'sku', p_sku,
    'qty', v_clean_qty,
    'batch_id', v_target_batch,
    'unit_mrp', p_unit_mrp,
    'new_stock', v_new_stock
  );
EXCEPTION WHEN UNIQUE_VIOLATION THEN
  SELECT * INTO v_existing
  FROM inventory_movements
  WHERE transaction_id = p_transaction_id
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', true,
    'transaction_id', p_transaction_id,
    'movement_id', v_existing.id,
    'message', 'Concurrent duplicate transaction ID handled gracefully'
  );
END;
$$;
