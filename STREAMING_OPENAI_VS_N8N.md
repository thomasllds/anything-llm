# Comparatif du streaming SSE : OpenAI vs n8n Agent

Ce document décrit le parcours des données lorsqu'on utilise le provider **OpenAI** puis **n8n Agent** dans AnythingLLM, et explique pourquoi le streaming incrémental fonctionne avec OpenAI mais peut ne pas apparaître avec n8n.

## Tronc commun côté AnythingLLM
- Les endpoints `/workspace/:slug/stream-chat` configurent systématiquement les en-têtes SSE (no-cache, `text/event-stream`, `X-Accel-Buffering: no`, keep-alive) via `setSseHeaders`, ce qui désactive le buffering proxy et force l'envoi chunké.【F:server/utils/helpers/chat/responses.js†L278-L287】
- `streamChatWithWorkspace` choisit dynamiquement le provider. Si `streamingEnabled()` est faux, une réponse unique est envoyée ; sinon, `streamGetChatCompletion` est appelé puis `handleStream` relaie chaque chunk vers le client via `writeResponseChunk` avant de finaliser le stream et de journaliser les métriques.【F:server/utils/chats/stream.js†L243-L309】

## Flux SSE avec le provider OpenAI
- **Activation streaming** : `OpenAiLLM.streamingEnabled()` est toujours vrai car la classe expose `streamGetChatCompletion`.【F:server/utils/AiProviders/openAi/index.js†L52-L54】
- **Ouverture du flux** : la requête `openai.responses.create` est effectuée avec `stream: true`, directement via le SDK OpenAI ; le flux retourné est instrumenté par `LLMPerformanceMonitor.measureStream`.【F:server/utils/AiProviders/openAi/index.js†L182-L200】
- **Parsing & émission** : `handleStream` consomme les événements typés `response.output_text.delta` et pousse immédiatement chaque delta vers le client avec `writeResponseChunk`, en incrémentant les tokens si les métriques OpenAI ne sont pas encore connues.【F:server/utils/AiProviders/openAi/index.js†L203-L236】
- **Clôture** : lorsqu'un `response.completed` arrive, les usages sont lus (prompt/completion/total tokens), le chunk de fermeture est émis, puis la mesure est terminée via `endMeasurement`.【F:server/utils/AiProviders/openAi/index.js†L237-L275】
- **Tolérance aux arrêts** : un handler `close` déclenche `clientAbortedHandler`, ferme le flux mesuré et résout avec le texte accumulé pour éviter les fuites.【F:server/utils/AiProviders/openAi/index.js†L214-L219】

**Conséquence** : le SDK OpenAI découpe lui-même la réponse en deltas (`response.output_text.delta`), envoyés ligne par ligne au format SSE standard ; chaque delta est flushé immédiatement, ce qui produit côté client des mots apparaissant au fil de l'eau.

## Flux SSE avec le provider n8n Agent
- **Activation streaming** : `streamingEnabled()` dépend de l'option `N8N_AGENT_BUFFER_STREAM` (activée = pas de streaming). Si la variable est à `true`, AnythingLLM repasse en mode réponse unique car le provider se déclare non-streaming.【F:server/utils/AiProviders/n8nAgent/index.js†L22-L24】【F:server/utils/AiProviders/n8nAgent/index.js†L79-L81】【F:server/utils/chats/stream.js†L243-L277】
- **Ouverture du flux** : l'appel est un `fetch` POST vers le webhook n8n avec `stream: true` dans le body et les en-têtes `Accept: text/event-stream`. Le flux brut (`ReadableStream`) est enveloppé par `LLMPerformanceMonitor.measureStream`.【F:server/utils/AiProviders/n8nAgent/index.js†L117-L194】【F:server/utils/AiProviders/n8nAgent/index.js†L354-L373】
- **Parsing & émission** : `#createSSEStream` lit manuellement le body, concatène dans un buffer et découpe maintenant sur **chaque saut de ligne** (`\n` ou `\r\n`) pour éviter tout buffering lorsque n8n envoie du NDJSON sans double ligne vide. Chaque segment non vide est ensuite parsé :
  - Les payloads `type: "chunk"|"item"` alimentent `delta.content` et sont émis vers le client via `writeResponseChunk` depuis `handleStream`.
  - Les payloads `type: "done"|"end"` ou `finished: true` forcent un chunk de fermeture (finish_reason = stop).【F:server/utils/AiProviders/n8nAgent/index.js†L201-L319】【F:server/utils/AiProviders/n8nAgent/index.js†L375-L427】
- **Clôture & métriques** : un compteur local `completionTokens` est maintenu (n8n ne renvoie pas d'usage). `endMeasurement` est appelé à la fermeture, et un handler `close` envoie un événement `abort` si le client se déconnecte.【F:server/utils/AiProviders/n8nAgent/index.js†L375-L441】

**Conséquence** : AnythingLLM accepte désormais le flux n8n sous forme NDJSON (un JSON par ligne, ex. `{"type":"item","content":"RA"}`) **sans exiger de double saut de ligne** ; chaque ligne reçue est flushée dès lecture, ce qui aligne le comportement sur OpenAI pour afficher les mots progressivement.

## Synthèse des différences clés
- **Responsable du découpage** : OpenAI découpe les deltas et les envoie en SSE standard ; n8n peut envoyer soit du SSE (`data: ...` + ligne vide) soit du NDJSON (une ligne par chunk). AnythingLLM découpe maintenant sur chaque saut de ligne pour ne plus dépendre d'un double séparateur.
- **Signalisation de fin** : OpenAI envoie un événement `response.completed` avec des métriques complètes ; n8n émet un indicateur `done/end/finished` sans tokens, ce qui limite la télémétrie et la détection de complétion si le format diverge.【F:server/utils/AiProviders/openAi/index.js†L237-L275】【F:server/utils/AiProviders/n8nAgent/index.js†L251-L270】
- **Comportement de secours** : une configuration `N8N_AGENT_BUFFER_STREAM=true` désactive explicitement le streaming côté AnythingLLM, alors que le provider OpenAI force toujours le mode stream. Vérifier cette variable est essentiel lorsque les chunks n'arrivent pas.【F:server/utils/AiProviders/n8nAgent/index.js†L22-L24】【F:server/utils/chats/stream.js†L243-L277】
- **Format attendu** : OpenAI utilise `response.output_text.delta` natif ; n8n attend `type: "chunk"|"item"` avec `delta.content` ou `content` à chaque événement. Toute divergence (ex. payload unique ou type différent) empêche l'émission immédiate côté AnythingLLM.【F:server/utils/AiProviders/openAi/index.js†L220-L249】【F:server/utils/AiProviders/n8nAgent/index.js†L227-L249】

## Pistes de vérification quand les chunks n'apparaissent pas avec n8n
- Confirmer que `N8N_AGENT_BUFFER_STREAM` est absent ou différent de `true` pour laisser `streamingEnabled()` actif.【F:server/utils/AiProviders/n8nAgent/index.js†L22-L24】【F:server/utils/AiProviders/n8nAgent/index.js†L79-L81】
- Inspecter le webhook n8n : doit envoyer des événements SSE séparés par `\n\n` ou `\r\n\r\n` avec `data:` ou un JSON contenant `type: "chunk"|"item"` et `delta.content`.
- Vérifier que le proxy (Nginx, etc.) ne recompose pas les segments ; AnythingLLM émet désormais à chaque saut de ligne, mais un proxy qui retarde ou fusionne les paquets peut encore lisser le flux et retarder l'affichage.
