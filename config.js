// Shared frontend config for the chat page and the docs page. No secrets here.
// Replace the deployed Worker URL after your first `wrangler deploy` prints it.
window.APP_CONFIG = {
  WORKER_URL: ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:8787"
    : "https://jazz-fact-chat.jamalrizki.workers.dev",
};
