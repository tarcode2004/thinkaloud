import { config } from './lib/config.ts';
import { createApp } from './app.ts';
import { startAppHost } from './apphost/server.ts';

createApp().listen(config.port, () => {
  console.log(`ThinkAloud API on http://localhost:${config.port}  (public: ${config.publicUrl})`);
});
startAppHost();
