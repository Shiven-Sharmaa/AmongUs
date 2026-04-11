// Runtime override for backend API base URL.
// Leave empty for same-origin API calls.
window.API_BASE_URL = "";

// Optional API key for protected backend endpoints.
// Prefer setting BACKEND_API_KEY as a Fly secret and then passing api_key
// as a URL query param when loading the client (not committing it here).
window.API_AUTH_KEY = "";
