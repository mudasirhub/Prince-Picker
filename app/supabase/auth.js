/**
 * Supabase Authentication & Picker Verification
 */
(function(window) {
  async function verifyPicker(pickerName, pickerPin) {
    if (!pickerName || !pickerName.trim()) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }
    if (!pickerPin || !pickerPin.trim()) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }

    const cleanName = pickerName.trim();
    const cleanPin = pickerPin.trim();

    // Verify 4-digit numeric format
    if (!/^\d{4}$/.test(cleanPin)) {
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;

    if (!client) {
      console.warn('[Auth] Supabase client not active.');
      return { success: false, error: 'Supabase connection offline. Verification unavailable.' };
    }

    try {
      // Call server-side PostgreSQL RPC function fn_verify_picker
      const { data, error } = await client.rpc('fn_verify_picker', {
        p_name: cleanName,
        p_pin: cleanPin
      });

      if (error) {
        console.warn('[Auth] Supabase RPC query error:', error.message);
        return { success: false, error: 'Invalid PIN. Access denied.' };
      }

      if (data && data.success && data.picker) {
        const picker = data.picker;
        const pickerId = picker.id || ('P-' + Math.floor(Math.random() * 10000));
        await savePickerLocally(picker.name || cleanName, pickerId);
        return { 
          success: true, 
          picker: { 
            name: picker.name || cleanName, 
            id: pickerId,
            role: picker.role || 'picker'
          } 
        };
      } else {
        return { 
          success: false, 
          error: (data && data.error) ? data.error : 'Invalid PIN. Access denied.' 
        };
      }
    } catch (e) {
      console.error('[Auth] Verification exception:', e);
      return { success: false, error: 'Invalid PIN. Access denied.' };
    }
  }

  async function savePickerLocally(name, id) {
    let deviceId = localStorage.getItem('pa_device_id');
    if (!deviceId) {
      deviceId = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      localStorage.setItem('pa_device_id', deviceId);
    }
    localStorage.setItem('pa_picker', name);
    localStorage.setItem('picker_id', id);

    if (window.PICKER_DB) {
      await window.PICKER_DB.setMeta('pickerName', name);
      await window.PICKER_DB.setMeta('pickerId', id);
      await window.PICKER_DB.setMeta('deviceId', deviceId);
    }
  }

  async function getSavedPicker() {
    if (window.PICKER_DB) {
      const name = await window.PICKER_DB.getMeta('pickerName');
      const id = await window.PICKER_DB.getMeta('pickerId');
      if (name) return { name, id: id || localStorage.getItem('picker_id') };
    }
    const name = localStorage.getItem('pa_picker');
    const id = localStorage.getItem('picker_id');
    return name ? { name, id } : null;
  }

  window.SUPABASE_AUTH = {
    verifyPicker,
    savePickerLocally,
    getSavedPicker
  };
})(typeof window !== 'undefined' ? window : this);

