import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.SAYGM_GITHUB_OWNER': JSON.stringify(process.env.SAYGM_GITHUB_OWNER || ''),
    'process.env.SAYGM_GITHUB_REPO': JSON.stringify(process.env.SAYGM_GITHUB_REPO || ''),
    'process.env.SAYGM_BUNDLE_NAME': JSON.stringify(process.env.SAYGM_BUNDLE_NAME || 'SayGM'),
  },
});
