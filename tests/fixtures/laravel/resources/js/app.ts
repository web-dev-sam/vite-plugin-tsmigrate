// Laravel/Vue entry: mounted from a Blade template via `@vite('resources/js/app.ts')`.
// There is no root index.html — the crawl must find this via build config input.
import App from "./App.vue";

// Lazy pages registered by glob — the crawl must expand this to real nodes.
export const pages = import.meta.glob("./views/*.vue");

export default App;
