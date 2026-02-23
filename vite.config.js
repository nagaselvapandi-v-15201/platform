import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/catalyst': {
        target: 'https://platform-60065907345.development.catalystserverless.in',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/catalyst/, '/server/FunctionFetch/execute'),
        secure: true,
      },
    },
  },
})
