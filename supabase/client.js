/**
 * Supabase Client Singleton for Prince Picker
 */
(function(window) {
  let client = null;

  function getSupabaseClient() {
    if (client) return client;
    const config = window.SUPABASE_CONFIG || {};
    if (typeof supabase !== 'undefined' && supabase.createClient) {
      try {
        client = supabase.createClient(config.url, config.anonKey);
      } catch (err) {
        console.error('[SupabaseClient] Error initializing Supabase client:', err);
      }
    } else {
      console.warn('[SupabaseClient] Supabase SDK (supabase.createClient) not loaded.');
    }
    return client;
  }

  window.SUPABASE_CLIENT = {
    getClient: getSupabaseClient,
    get instance() { return getSupabaseClient(); }
  };
})(typeof window !== 'undefined' ? window : this);
