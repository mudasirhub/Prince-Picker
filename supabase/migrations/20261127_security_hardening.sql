-- =============================================================================
-- PRINCE PICKER: SECURITY & DATA INTEGRITY HARDENING MIGRATION
-- Hardens RLS policies, RPC input validation, row-level locking, and
-- non-negative constraints across pickers, products, product_batches,
-- inventory, inventory_movements, and orders.
-- =============================================================================

BEGIN;

-- 1. Lock down `pickers` table: never expose `pin_hash` to anon/authenticated REST queries
ALTER TABLE IF EXISTS pickers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public pickers read policy" ON pickers;
REVOKE ALL ON TABLE pickers FROM anon, authenticated;

-- Harden fn_verify_picker with fixed search_path and strict 4-digit PIN format validation
CREATE OR REPLACE FUNCTION fn_verify_picker(
  p_name TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_picker RECORD;
  v_clean_name TEXT;
  v_clean_pin TEXT;
BEGIN
  v_clean_name := LOWER(TRIM(COALESCE(p_name, '')));
  v_clean_pin := TRIM(COALESCE(p_pin, ''));

  IF v_clean_name = '' OR length(v_clean_name) > 64 OR v_clean_pin !~ '^\d{4}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid PIN. Access denied.'
    );
  END IF;

  SELECT id, name, role, pin_hash INTO v_picker
  FROM pickers
  WHERE LOWER(TRIM(name)) = v_clean_name AND active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid PIN. Access denied.'
    );
  END IF;

  IF v_picker.pin_hash IS NOT NULL AND v_picker.pin_hash = crypt(v_clean_pin, v_picker.pin_hash) THEN
    RETURN jsonb_build_object(
      'success', true,
      'picker', jsonb_build_object(
        'id', v_picker.id,
        'name', v_picker.name,
        'role', v_picker.role
      )
    );
  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid PIN. Access denied.'
    );
  END IF;
END;
$$;

-- 2. Non-negative integrity constraints on products, product_batches, and inventory
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'product_batches') THEN
    UPDATE product_batches SET mrp = GREATEST(0, COALESCE(mrp, 0)), stock_qty = GREATEST(0, COALESCE(stock_qty, 0))
    WHERE mrp < 0 OR stock_qty < 0;

    ALTER TABLE product_batches DROP CONSTRAINT IF EXISTS chk_product_batches_mrp_nonneg;
    ALTER TABLE product_batches ADD CONSTRAINT chk_product_batches_mrp_nonneg CHECK (mrp >= 0);

    ALTER TABLE product_batches DROP CONSTRAINT IF EXISTS chk_product_batches_qty_nonneg;
    ALTER TABLE product_batches ADD CONSTRAINT chk_product_batches_qty_nonneg CHECK (stock_qty >= 0);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
    UPDATE products SET stock = GREATEST(0, COALESCE(stock, 0)), mrp = GREATEST(0, COALESCE(mrp, 0))
    WHERE stock < 0 OR mrp < 0;

    ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_stock_nonneg;
    ALTER TABLE products ADD CONSTRAINT chk_products_stock_nonneg CHECK (COALESCE(stock, 0) >= 0);

    ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_mrp_nonneg;
    ALTER TABLE products ADD CONSTRAINT chk_products_mrp_nonneg CHECK (COALESCE(mrp, 0) >= 0);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'inventory') THEN
    UPDATE inventory SET available_qty = GREATEST(0, COALESCE(available_qty, 0))
    WHERE available_qty < 0;

    ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_qty_nonneg;
    ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_nonneg CHECK (COALESCE(available_qty, 0) >= 0);
  END IF;
END;
$$;

-- 3. Tighten RLS policies: prevent anonymous wipe/delete on audit trails and batches, validate writes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'product_batches') THEN
    ALTER TABLE product_batches ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "Allow read product_batches" ON product_batches;
    CREATE POLICY "Allow read product_batches" ON product_batches
      FOR SELECT USING (true);

    DROP POLICY IF EXISTS "Allow insert product_batches" ON product_batches;
    CREATE POLICY "Allow insert product_batches" ON product_batches
      FOR INSERT WITH CHECK (
        length(trim(product_id)) > 0
        AND length(trim(batch_id)) > 0
        AND mrp >= 0
        AND stock_qty >= 0
      );

    DROP POLICY IF EXISTS "Allow update product_batches" ON product_batches;
    CREATE POLICY "Allow update product_batches" ON product_batches
      FOR UPDATE
      USING (length(trim(product_id)) > 0)
      WITH CHECK (
        length(trim(product_id)) > 0
        AND length(trim(batch_id)) > 0
        AND mrp >= 0
        AND stock_qty >= 0
      );

    DROP POLICY IF EXISTS "Allow delete product_batches" ON product_batches;
    CREATE POLICY "Allow authenticated delete product_batches" ON product_batches
      FOR DELETE TO authenticated, service_role USING (true);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'inventory_movements') THEN
    ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "Allow read inventory_movements" ON inventory_movements;
    CREATE POLICY "Allow read inventory_movements" ON inventory_movements
      FOR SELECT USING (true);

    DROP POLICY IF EXISTS "Allow insert inventory_movements" ON inventory_movements;
    CREATE POLICY "Allow insert inventory_movements" ON inventory_movements
      FOR INSERT WITH CHECK (
        UPPER(COALESCE(type, '')) IN ('PICK', 'DROP')
        AND COALESCE(qty, 0) > 0
        AND length(trim(COALESCE(sku, ''))) > 0
      );

    -- Immutable audit log: disallow UPDATE/DELETE by anon
    DROP POLICY IF EXISTS "Deny anon update inventory_movements" ON inventory_movements;
    DROP POLICY IF EXISTS "Allow update inventory_movements" ON inventory_movements;
    DROP POLICY IF EXISTS "Allow delete inventory_movements" ON inventory_movements;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
    ALTER TABLE products ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "Allow read products" ON products;
    CREATE POLICY "Allow read products" ON products
      FOR SELECT USING (true);

    DROP POLICY IF EXISTS "Allow insert products" ON products;
    CREATE POLICY "Allow insert products" ON products
      FOR INSERT WITH CHECK (
        length(trim(COALESCE(id, ''))) > 0
        AND COALESCE(mrp, 0) >= 0
        AND COALESCE(stock, 0) >= 0
      );

    DROP POLICY IF EXISTS "Allow update products" ON products;
    CREATE POLICY "Allow update products" ON products
      FOR UPDATE
      USING (length(trim(COALESCE(id, ''))) > 0)
      WITH CHECK (
        length(trim(COALESCE(id, ''))) > 0
        AND COALESCE(mrp, 0) >= 0
        AND COALESCE(stock, 0) >= 0
      );

    DROP POLICY IF EXISTS "Allow delete products" ON products;
    CREATE POLICY "Allow authenticated delete products" ON products
      FOR DELETE TO authenticated, service_role USING (true);
  END IF;
END;
$$;

-- 4. Harden fn_process_inventory_movement against negative qty/MRP exploits & race conditions
DROP FUNCTION IF EXISTS fn_process_inventory_movement(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC);

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing RECORD;
  v_new_stock NUMERIC;
  v_movement_id UUID;
  v_clean_type TEXT;
  v_clean_qty INTEGER;
  v_clean_sku TEXT;
  v_product_id TEXT;
  v_target_batch TEXT;
BEGIN
  v_clean_type := UPPER(TRIM(COALESCE(p_type, '')));
  v_clean_sku := TRIM(COALESCE(p_sku, ''));

  IF v_clean_type NOT IN ('PICK', 'DROP') THEN
    RAISE EXCEPTION 'Invalid movement type: %. Expected PICK or DROP.', v_clean_type;
  END IF;

  IF v_clean_sku = '' OR length(v_clean_sku) > 128 THEN
    RAISE EXCEPTION 'Invalid SKU / identifier.';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 OR p_qty > 100000 THEN
    RAISE EXCEPTION 'Invalid movement quantity: %. Must be between 1 and 100000.', p_qty;
  END IF;

  v_clean_qty := ROUND(p_qty)::INTEGER;
  IF v_clean_qty <= 0 THEN
    RAISE EXCEPTION 'Invalid rounded quantity: %.', v_clean_qty;
  END IF;

  IF p_unit_mrp IS NOT NULL AND p_unit_mrp < 0 THEN
    RAISE EXCEPTION 'Invalid unit MRP: %. Must be >= 0.', p_unit_mrp;
  END IF;

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

  -- Lock parent product row to prevent concurrent stock race conditions
  SELECT id INTO v_product_id
  FROM products
  WHERE sku = v_clean_sku OR barcode = v_clean_sku OR id = v_clean_sku
  LIMIT 1
  FOR UPDATE;

  v_target_batch := NULLIF(TRIM(COALESCE(p_batch_id, '')), '');

  -- FIFO batch fallback if product has explicit batches and no batch_id was provided
  IF v_product_id IS NOT NULL AND v_target_batch IS NULL THEN
    IF v_clean_type = 'PICK' THEN
      SELECT batch_id INTO v_target_batch
      FROM product_batches
      WHERE product_id = v_product_id AND stock_qty > 0
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
    ELSE
      SELECT batch_id INTO v_target_batch
      FROM product_batches
      WHERE product_id = v_product_id
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
    END IF;
  END IF;

  -- Step 2: Atomic Batch & Parent Stock Update
  IF v_product_id IS NOT NULL AND v_target_batch IS NOT NULL THEN
    IF v_clean_type = 'DROP' THEN
      INSERT INTO product_batches (product_id, sku, batch_id, mrp, stock_qty, location, updated_at)
      VALUES (v_product_id, v_clean_sku, v_target_batch, GREATEST(0, COALESCE(p_unit_mrp, 0)), v_clean_qty, LEFT(COALESCE(p_location, ''), 64), NOW())
      ON CONFLICT (product_id, batch_id) DO UPDATE SET
        stock_qty = GREATEST(0, product_batches.stock_qty + v_clean_qty),
        updated_at = NOW();
    ELSIF v_clean_type = 'PICK' THEN
      UPDATE product_batches
      SET stock_qty = GREATEST(0, stock_qty - v_clean_qty),
          updated_at = NOW()
      WHERE product_id = v_product_id AND batch_id = v_target_batch;
    END IF;

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
    WHERE sku = v_clean_sku;
  ELSE
    IF v_clean_type = 'DROP' THEN
      UPDATE inventory
      SET available_qty = COALESCE(available_qty, 0) + v_clean_qty,
          updated_at = NOW()
      WHERE sku = v_clean_sku
      RETURNING available_qty INTO v_new_stock;

      UPDATE products
      SET stock = COALESCE(stock, 0) + v_clean_qty,
          total_stock = COALESCE(stock, 0) + v_clean_qty,
          updated_at = NOW()
      WHERE sku = v_clean_sku OR barcode = v_clean_sku;
    ELSIF v_clean_type = 'PICK' THEN
      UPDATE inventory
      SET available_qty = GREATEST(0, COALESCE(available_qty, 0) - v_clean_qty),
          updated_at = NOW()
      WHERE sku = v_clean_sku
      RETURNING available_qty INTO v_new_stock;

      UPDATE products
      SET stock = GREATEST(0, COALESCE(stock, 0) - v_clean_qty),
          total_stock = GREATEST(0, COALESCE(stock, 0) - v_clean_qty),
          updated_at = NOW()
      WHERE sku = v_clean_sku OR barcode = v_clean_sku;
    END IF;
  END IF;

  -- Step 3: Insert movement record
  INSERT INTO inventory_movements (
    type, sku, qty, location, picker, session_id, transaction_id, batch_id, unit_mrp, created_at
  ) VALUES (
    v_clean_type,
    v_clean_sku,
    v_clean_qty,
    LEFT(COALESCE(p_location, ''), 64),
    LEFT(COALESCE(p_picker, 'Picker'), 64),
    LEFT(COALESCE(p_session_id, ''), 64),
    NULLIF(LEFT(COALESCE(p_transaction_id, ''), 128), ''),
    COALESCE(LEFT(v_target_batch, 64), ''),
    p_unit_mrp,
    NOW()
  )
  RETURNING id INTO v_movement_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'transaction_id', p_transaction_id,
    'movement_id', v_movement_id,
    'sku', v_clean_sku,
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

COMMIT;
