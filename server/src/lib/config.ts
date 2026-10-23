const env = process.env;
export const config = {
  port: Number(env.PORT || 4000),
  appHostPort: Number(env.APP_HOST_PORT || 4001),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
  appHostUrl: (env.APP_HOST_URL || `http://localhost:${env.APP_HOST_PORT || 4001}`).replace(/\/$/, ''),
  /**
   * Front-end origins allowed to call the API cross-origin (CORS, bearer auth), e.g. a Firebase-hosted
   * SPA talking to an API tunnel. The PUBLIC_URL origin is always included. Comma-separated.
   */
  corsOrigins: [...new Set([env.PUBLIC_URL || '', ...(env.CORS_ORIGINS || '').split(',')].map((u) => {
    try {
      return u.trim() ? new URL(u.trim()).origin : '';
    } catch {
      return '';
    }
  }).filter(Boolean))],
  openaiKey: env.OPENAI_API_KEY || '',
  realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
  /** Realtime API base. Point at a self-hosted OpenRealtime server (openrealtime/) to moderate without OpenAI. */
  realtimeBaseUrl: (env.REALTIME_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  /** Base the participant's browser uses for the SDP exchange (defaults to realtimeBaseUrl). */
  realtimePublicUrl: (env.REALTIME_PUBLIC_URL || env.REALTIME_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  realtimeKey: env.REALTIME_API_KEY || env.OPENAI_API_KEY || '',
  /** ICE servers for the participant's WebRTC connection to a self-hosted realtime server (comma list of stun:/turn: URLs). */
  realtimeIceServers: (env.REALTIME_ICE_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  realtimeVoice: env.OPENAI_REALTIME_VOICE || 'marin',
  realtimeEffort: env.OPENAI_REALTIME_REASONING_EFFORT || 'low',
  transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
  textModel: env.OPENAI_TEXT_MODEL || 'gpt-5-mini',
  buildMode: (env.BUILD_MODE || 'docker') as 'docker' | 'local',
  isProd: env.NODE_ENV === 'production',
  sessionSecret: env.SESSION_SECRET || 'dev-secret',
};
