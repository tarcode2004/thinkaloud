# OpenAI Realtime (gpt-realtime-2) — integration notes

Verified working pattern (from a production project on this machine using `gpt-realtime-2`):

1. Server mints an ephemeral key: `POST https://api.openai.com/v1/realtime/client_secrets` with
   `Authorization: Bearer $OPENAI_API_KEY`, body `{ session: { type: 'realtime', model, reasoning?: {effort:'low'}, audio: { input: { noise_reduction:{type:'near_field'}, transcription:{model:'gpt-4o-transcribe', language:'en'}, turn_detection:{ type:'semantic_vad', eagerness:'low', create_response:false, interrupt_response:true } }, output: { voice: 'marin' } }, instructions, tools, tool_choice:'auto' } }`.
   Response JSON: `{ value: 'ek_...', expires_at, session }` (older shape: `client_secret.value`). Accept both.
2. Browser: `RTCPeerConnection`, add mic track, `pc.createDataChannel('oai-events')`, play remote audio track via an `<audio autoplay>` element, create offer,
   `POST https://api.openai.com/v1/realtime/calls` body = offer SDP, headers `Authorization: Bearer ek_...`, `Content-Type: application/sdp`; response text = answer SDP → `setRemoteDescription({type:'answer', sdp})`.
3. Data channel JSON events (client → server): `session.update {session:{type:'realtime', instructions, tools, tool_choice}}`, `conversation.item.create {item:{type:'message', role:'user'|'system', content:[{type:'input_text', text}]}}`, `conversation.item.create {item:{type:'function_call_output', call_id, output: JSON string}}`, `response.create {response?:{instructions?}}`, `response.cancel`, `output_audio_buffer.clear`.
4. Server → client events of interest: `session.created/updated`, `input_audio_buffer.speech_started|speech_stopped`, `conversation.item.input_audio_transcription.completed {item_id, transcript}`, `response.output_audio_transcript.delta|done {transcript}`, `response.function_call_arguments.done {call_id, name, arguments}` (same call also arrives as `response.output_item.done` with `item.type==='function_call'` — dedupe on call_id), `response.done {response:{status, output, usage}}`, `output_audio_buffer.started|stopped` (WebRTC: AI audio actually playing), `error`.
5. Tools: `{ type:'function', name, description, parameters: JSONSchema }`. After a function call, send `function_call_output`, then `response.create` so the model continues.
6. Never let the model speak in the same response as a tool call when the tool result determines what to say: instruct "call the tool first, then speak".
