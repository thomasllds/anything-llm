# Streaming SSE avec le fournisseur OpenAI

Ce document décrit, pour un·e développeur·e expérimenté·e, comment AnythingLLM garantit le streaming SSE lorsqu’on sélectionne **OpenAI** comme fournisseur LLM.

## Chemin d’exécution

1. **Sélection du fournisseur**
   - Le fournisseur actif est déterminé par `getLLMProvider`, qui instancie `OpenAiLLM` lorsque `LLM_PROVIDER` vaut `openai` (valeur par défaut).【F:server/utils/helpers/index.js†L76-L119】

2. **Entrée API côté serveur**
   - L’endpoint `POST /workspace/:slug/stream-chat` (et sa variante thread) prépare la réponse SSE via `setSseHeaders` avant tout traitement, garantissant des en-têtes `text/event-stream`, `keep-alive` et la désactivation du buffering reverse-proxy.【F:server/endpoints/chat.js†L21-L79】【F:server/utils/helpers/chat/responses.js†L260-L279】
   - Après validation, il délègue à `streamChatWithWorkspace` qui pilote l’échange avec le LLM et relaie chaque chunk vers le client.【F:server/endpoints/chat.js†L60-L106】【F:server/utils/chats/stream.js†L244-L308】

3. **Demande de complétion en streaming**
   - `streamChatWithWorkspace` détecte si le provider supporte le streaming via `streamingEnabled()` (présent dans `OpenAiLLM`) puis appelle `streamGetChatCompletion` pour ouvrir un flux chez OpenAI en mode `stream: true` et avec la température configurée.【F:server/utils/chats/stream.js†L249-L274】【F:server/utils/AiProviders/openAi/index.js†L63-L119】【F:server/utils/AiProviders/openAi/index.js†L160-L193】
   - L’appel est enveloppé par `LLMPerformanceMonitor.measureStream`, qui renvoie un flux instrumenté et collectera des métriques finales (tokens, durée) à la clôture du flux.【F:server/utils/AiProviders/openAi/index.js†L171-L190】

4. **Propagation des tokens au client**
   - `OpenAiLLM.handleStream` itère sur chaque chunk SSE renvoyé par OpenAI. Les deltas `response.output_text.delta` sont ajoutés au buffer `fullText` et immédiatement émis vers le client via `writeResponseChunk`, en conservant l’UUID de la requête et les sources éventuelles.【F:server/utils/AiProviders/openAi/index.js†L193-L245】
   - Quand OpenAI envoie `response.completed`, les métriques d’usage (tokens) sont extraites si disponibles, le flux de mesure est clôturé (`endMeasurement`), puis un chunk de fermeture est envoyé pour signaler la fin du stream.【F:server/utils/AiProviders/openAi/index.js†L245-L277】
   - En cas d’exception ou d’abandon client, `handleStream` capture l’erreur, publie un événement `abort` SSE et résout avec le texte cumulé afin que l’appelant puisse terminer proprement.【F:server/utils/AiProviders/openAi/index.js†L277-L295】

5. **Finalisation côté AnythingLLM**
   - Une fois `handleStream` résolu, `streamChatWithWorkspace` écrit le message complet dans la base via `WorkspaceChats.new`, puis pousse un dernier événement SSE `finalizeResponseStream` incluant l’ID du chat et les métriques collectées avant de finir la réponse.【F:server/utils/chats/stream.js†L274-L309】

## Garanties clés pour le fonctionnement SSE

- **En-têtes SSE forcés** : `setSseHeaders` applique explicitement les en-têtes SSE et désactive le buffering (`X-Accel-Buffering: no`), évitant que des proxys n’attendent le corps complet avant de transférer les chunks.【F:server/utils/helpers/chat/responses.js†L260-L279】
- **Émission chunkée immédiate** : `writeResponseChunk` force le flush des en-têtes et du socket après chaque chunk, ce qui pousse les tokens au fur et à mesure sans attendre la fin de la réponse.【F:server/utils/helpers/chat/responses.js†L244-L259】
- **Support natif OpenAI** : `OpenAiLLM.streamingEnabled()` est vrai et la requête `responses.create` est effectuée avec `stream: true`; en l’absence de streaming, le flux serait court-circuité vers une réponse unique, mais ce chemin ne s’applique pas à OpenAI.【F:server/utils/AiProviders/openAi/index.js†L53-L66】【F:server/utils/AiProviders/openAi/index.js†L171-L190】【F:server/utils/chats/stream.js†L244-L274】
- **Tolérance aux arrêts** : écoute de l’événement `close` sur la réponse HTTP pour détecter les déconnexions client et terminer proprement les métriques/flux (`endMeasurement`), évitant des fuites de ressources ou des pendaisons de connexion.【F:server/utils/AiProviders/openAi/index.js†L200-L229】【F:server/utils/AiProviders/openAi/index.js†L255-L277】

En combinant ces étapes, la sélection d’OpenAI déclenche un flux SSE bout-en-bout : la requête cliente reçoit immédiatement des tokens, les proxys ne tamponnent pas, et les métriques de performance sont enregistrées à la clôture du flux.
