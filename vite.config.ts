import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  // Deployment-specific values come from a git-ignored .env file, so the repository stays generic.
  const { D1_DATABASE_ID, CUSTOM_DOMAIN } = loadEnv(mode, process.cwd(), '');
  if (command === 'build' && !D1_DATABASE_ID) {
    // Without an ID, Wrangler would provision or connect a database by itself on deploy.
    throw new Error('Set D1_DATABASE_ID in .env. See .env.example.');
  }

  return {
    plugins: [
      cloudflare({
        // The plugin merges a returned object by joining arrays, so change the bindings in place instead.
        config: config => {
          for (const database of config.d1_databases) {
            database.database_id = D1_DATABASE_ID;
          }
          if (CUSTOM_DOMAIN) {
            config.routes = [{ pattern: CUSTOM_DOMAIN, custom_domain: true }];
          }
        },
      }),
      tailwindcss(),
    ],
    environments: {
      client: {
        build: {
          rolldownOptions: {
            input: { index: 'index.html', share: 'share.html' },
          },
        },
      },
    },
  };
});
