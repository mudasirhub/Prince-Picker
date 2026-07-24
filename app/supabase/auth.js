/**
 * Supabase Authentication & Picker Verification
 */
(function(window) {
  async function verifyPicker(pickerName) {
    if (!pickerName || !pickerName.trim()) {
      return { success: false, error: 'Picker name is required' };
    }
    const cleanName = pickerName.trim();
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;

    if (!client) {
      console.warn('[Auth] Supabase client not active. Storing picker locally.');
      const localId = 'P-' + Math.floor(Math.random() * 10000);
      await savePickerLocally(cleanName, localId);
      return { success: true, picker: { name: cleanName, id: localId }, offline: true };
    }

    try {
      const { data, error } = await client
        .from('pickers')
        .select('*')
        .ilike('name', cleanName);

      if (error) {
        console.warn('[Auth] Supabase query error, falling back to local session:', error.message);
        const localId = localStorage.getItem('picker_id') || ('P-' + Math.floor(Math.random() * 10000));
        await savePickerLocally(cleanName, localId);
        return { success: true, picker: { name: cleanName, id: localId }, offline: true };
      }

      if (data && data.length > 0) {
        const picker = data[0];
        const pickerId = picker.id || picker.picker_id || ('P-' + Math.floor(Math.random() * 10000));
        await savePickerLocally(picker.name || cleanName, pickerId);
        return { success: true, picker: { name: picker.name || cleanName, id: pickerId } };
      } else {
        return { success: false, error: `Picker "${cleanName}" not found in database.` };
      }
    } catch (e) {
      console.error('[Auth] Verification exception:', e);
      const localId = localStorage.getItem('picker_id') || ('P-' + Math.floor(Math.random() * 10000));
      await savePickerLocally(cleanName, localId);
      return { success: true, picker: { name: cleanName, id: localId }, offline: true };
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
