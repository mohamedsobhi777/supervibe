import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The platform runs `bun run dev` with PORT=8080 and expects the dev server
// bound on 0.0.0.0:8080, reachable via the sandbox preview host.
const port = Number(process.env.PORT) || 8080;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // bind 0.0.0.0
    port,
    strictPort: true,
    allowedHosts: true,  // accept the *.sandbox.superserve.ai preview host
  },
  preview: {
    host: true,
    port,
    strictPort: true,
    allowedHosts: true,
  },
});
