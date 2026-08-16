-- =============================================================================
-- PRINCE PICKER INVENTORY MOVEMENT & IDEMPOTENCY SCHEMA PATCH
-- =============================================================================

-- 1. Ensure multi-location columns exist on products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS locations JSONB DEFAULT '[]'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS primary_storage TEXT DEFAULT 'SHOP';
ALTER TABLE products ADD COLUMN IF NOT EXISTS primary_location TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_type TEXT DEFAULT 'SHOP';

-- 2. Ensure transaction_id column exists on inventory_movements table with a UNIQUE constraint
ALTER TABLE inventory_movements 
ADD COLUMN IF NOT EXISTS transaction_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_transaction_id 
ON inventory_movements (transaction_id) 
WHERE transaction_id IS NOT NULL AND transaction_id != '';

-- 2. Atomic PostgreSQL Function for Inventory Movement Processing & Idempotency
CREATE OR REPLACE FUNCTION fn_process_inventory_movement(
  p_type TEXT,
  p_sku TEXT,
  p_qty NUMERIC,
  p_location TEXT DEFAULT '',
  p_picker TEXT DEFAULT 'Picker',
  p_session_id TEXT DEFAULT '',
  p_transaction_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_current_stock NUMERIC;
  v_new_stock NUMERIC;
  v_movement_id UUID;
  v_clean_type TEXT;
  v_clean_qty NUMERIC;
BEGIN
  v_clean_type := UPPER(COALESCE(p_type, 'DROP'));
  v_clean_qty := COALESCE(p_qty, 1);

  -- Step 1: Idempotency Check
  -- If p_transaction_id is provided, check if a movement with this transaction_id already exists.
  IF p_transaction_id IS NOT NULL AND p_transaction_id != '' THEN
    SELECT * INTO v_existing 
    FROM inventory_movements 
    WHERE transaction_id = p_transaction_id 
    LIMIT 1;

    IF FOUND THEN
      -- Return existing movement as successful idempotent retry without mutating inventory again
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transaction_id', p_transaction_id,
        'movement_id', v_existing.id,
        'type', v_existing.type,
        'sku', v_existing.sku,
        'qty', v_existing.qty,
        'location', v_existing.location,
        'message', 'Duplicate transaction ID skipped at database level'
      );
    END IF;
  END IF;

  -- Step 2: Atomic Inventory Update
  IF v_clean_type = 'DROP' THEN
    UPDATE inventory 
    SET available_qty = COALESCE(available_qty, 0) + v_clean_qty,
        updated_at = NOW()
    WHERE sku = p_sku
    RETURNING available_qty INTO v_new_stock;

    UPDATE products 
    SET stock = COALESCE(stock, 0) + v_clean_qty,
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
        updated_at = NOW()
    WHERE sku = p_sku OR barcode = p_sku;
  END IF;

  -- Step 3: Insert exactly ONE movement record
  INSERT INTO inventory_movements (
    type,
    sku,
    qty,
    location,
    picker,
    session_id,
    transaction_id,
    created_at
  ) VALUES (
    v_clean_type,
    p_sku,
    v_clean_qty,
    p_location,
    p_picker,
    p_session_id,
    p_transaction_id,
    NOW()
  )
  RETURNING id INTO v_movement_id;

  -- Step 4: Commit result
  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'transaction_id', p_transaction_id,
    'movement_id', v_movement_id,
    'sku', p_sku,
    'qty', v_clean_qty,
    'new_stock', v_new_stock
  );
EXCEPTION WHEN UNIQUE_VIOLATION THEN
  -- Handles race condition under concurrent requests with the exact same transaction_id
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

-- =============================================================================
-- 3. PICKER PIN AUTHENTICATION SCHEMA & VERIFICATION FUNCTION
-- =============================================================================

-- Enable pgcrypto extension for bcrypt hash verification
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ensure pickers table structure with required security fields
CREATE TABLE IF NOT EXISTS pickers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'picker',
  pin_hash TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pickers ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'picker';
ALTER TABLE pickers ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE pickers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- Enable Row Level Security (RLS) on pickers
ALTER TABLE pickers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public pickers read policy" ON pickers;
CREATE POLICY "Public pickers read policy" ON pickers 
  FOR SELECT USING (active = true);

-- Atomic PostgreSQL RPC function for PIN verification
-- Executes with SECURITY DEFINER privileges to compare bcrypt hash securely without exposing pin_hash to frontend client
CREATE OR REPLACE FUNCTION fn_verify_picker(
  p_name TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_picker RECORD;
  v_clean_name TEXT;
  v_clean_pin TEXT;
BEGIN
  v_clean_name := LOWER(TRIM(COALESCE(p_name, '')));
  v_clean_pin := TRIM(COALESCE(p_pin, ''));

  IF v_clean_name = '' OR v_clean_pin = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid PIN. Access denied.'
    );
  END IF;

  -- Query active picker by case-insensitive name match
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

  -- Verify PIN using pgcrypto crypt() function
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

-- Seed / Upsert Initial Pickers with bcrypt hashed PINs
INSERT INTO pickers (name, pin_hash, role, active)
VALUES 
  ('Admin', crypt('3363', gen_salt('bf')), 'admin', true),
  ('Picker Admin', crypt('3363', gen_salt('bf')), 'admin', true),
  ('Mudasir', crypt('1627', gen_salt('bf')), 'picker', true),
  ('Mujeeb Khan', crypt('1627', gen_salt('bf')), 'picker', true),
  ('Akram Khan', crypt('1627', gen_salt('bf')), 'picker', true)
ON CONFLICT (name) DO UPDATE SET 
  pin_hash = EXCLUDED.pin_hash,
  role = EXCLUDED.role,
  active = EXCLUDED.active,
  updated_at = NOW();

