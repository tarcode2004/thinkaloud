const env = process.env;
export const config = {
  port: Number(env.PORT || 4000),
  appHostPort: Number(env.APP_HOST_PORT || 4001),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
  appHostUrl: (env.APP_HOST_URL || `http://localhost:${env.APP_HOST_PORT || 4001}`).replace(/\/$/, ''),
  openaiKey: env.OPENAI_API_KEY || '',
  realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
  realtimeVoice: env.OPENAI_REALTIME_VOICE || 'marin',
  realtimeEffort: env.OPENAI_REALTIME_REASONING_EFFORT || 'low',
  transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
  textModel: env.OPENAI_TEXT_MODEL || 'gpt-5-mini',
  buildMode: (env.BUILD_MODE || 'docker') as 'docker' | 'local',
  isProd: env.NODE_ENV === 'production',
  sessionSecret: env.SESSION_SECRET || 'dev-secret',
};
