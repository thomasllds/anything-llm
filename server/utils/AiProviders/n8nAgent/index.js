const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  formatChatHistory,
  writeResponseChunk,
} = require("../../helpers/chat/responses");
const { getAnythingLLMUserAgent } = require("../../../endpoints/utils");
const { LLMPerformanceMonitor } = require("../../helpers/chat/LLMPerformanceMonitor");

class N8nAgentLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.N8N_AGENT_BASE_URL)
      throw new Error("N8n Agent must have a valid base URL set.");

    this.className = "N8nAgentLLM";
    this.baseUrl = process.env.N8N_AGENT_BASE_URL;
    this.webhookPath =
      process.env.N8N_AGENT_WEBHOOK_PATH || "/webhook/chat-agent-stream";
    this.apiKey = process.env.N8N_AGENT_API_KEY ?? null;
    this.model = modelPreference ?? process.env.N8N_AGENT_MODEL_PREF ?? null;
    this.timeoutMs = Number(process.env.N8N_AGENT_TIMEOUT_MS || 600000);
    this.tokenLimit = Number(process.env.N8N_AGENT_MODEL_TOKEN_LIMIT || 4096);
    this.bufferSseResponses =
      String(process.env.N8N_AGENT_BUFFER_STREAM).toLowerCase() === "true";

    if (!this.model)
      throw new Error("N8n Agent must have a valid model preference set.");

    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
    this.log(
      `Inference API: ${this.baseUrl}${this.webhookPath} Model: ${this.model}`
    );
    this.log(
      "Configuration snapshot",
      this.#configurationSnapshot({ maskApiKey: true })
    );
  }

  #configurationSnapshot({ maskApiKey = false } = {}) {
    const maskValue = (value) => {
      if (!value || !maskApiKey) return value;
      if (value.length <= 4) return "***";
      return `***${value.slice(-4)}`;
    };

    return {
      baseUrl: this.baseUrl,
      webhookPath: this.webhookPath,
      model: this.model,
      timeoutMs: this.timeoutMs,
      tokenLimit: this.tokenLimit,
      apiKey: maskValue(this.apiKey),
      bufferSseResponses: this.bufferSseResponses,
    };
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  streamingEnabled() {
    return this.bufferSseResponses !== true;
  }

  promptWindowLimit() {
    if (!this.tokenLimit || isNaN(Number(this.tokenLimit))) return 4096;
    return Number(this.tokenLimit);
  }

  isValidChatCompletionModel(_modelName = "") {
    return true;
  }

  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };

    const formattedHistory = formatChatHistory(chatHistory, ({ userPrompt }) => {
      return userPrompt;
    });

    const userMessage = {
      role: "user",
      content: userPrompt,
      ...(attachments?.length ? { attachments } : {}),
    };

    return [prompt, ...formattedHistory, userMessage];
  }

  #buildUrl() {
    const base = this.baseUrl.endsWith("/")
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    const path = this.webhookPath.startsWith("/")
      ? this.webhookPath
      : `/${this.webhookPath}`;
    return `${base}${path}`;
  }

  #buildHeaders() {
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": getAnythingLLMUserAgent(),
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  #getChatInput(messages = []) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "user" && typeof message?.content === "string") {
        return message.content;
      }
    }
    return null;
  }

  #buildPayload(messages = [], temperature = 0.7, sessionId = null) {
    const chatInput = this.#getChatInput(messages);
    this.log("Preparing request payload", {
      url: this.#buildUrl(),
      model: this.model,
      sessionId,
      temperature,
      chatInput,
      messageCount: messages?.length || 0,
    });
    return {
      model: this.model,
      messages,
      stream: true,
      temperature,
      ...(sessionId ? { sessionId } : {}),
      ...(chatInput ? { chatInput } : {}),
    };
  }

  #createAbortController() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    return { controller, timeout };
  }

  async #performRequest(messages = [], temperature = 0.7, sessionId = null) {
    const { controller, timeout } = this.#createAbortController();
    const response = await fetch(this.#buildUrl(), {
      method: "POST",
      headers: this.#buildHeaders(),
      body: JSON.stringify(this.#buildPayload(messages, temperature, sessionId)),
      signal: controller.signal,
    }).catch((error) => {
      clearTimeout(timeout);
      throw error;
    });

    if (!response.ok) {
      clearTimeout(timeout);
      const errorBody = await response.text();
      throw new Error(
        `n8n Agent request failed with status ${response.status}: ${errorBody}`
      );
    }
    return { response, controller, timeout };
  }

  #createSSEStream(response, controller, timeout) {
    const { Readable } = require("stream");
    const decoder = new TextDecoder();
    const nodeStream = Readable.fromWeb(response.body);
    const log = this.log.bind(this);
    const streamIterable = {
      async *[Symbol.asyncIterator]() {
        let buffer = "";
        let ended = false;

        const emitChunk = function* (payload) {
          const rawLine = payload.trim();
          if (!rawLine) return;

          const afterData = rawLine.startsWith("data:")
            ? rawLine.replace(/^data:\s*/, "").trim()
            : rawLine;

          if (!afterData) return;
          if (afterData === "[DONE]") {
            ended = true;
            return yield {
              choices: [
                {
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
          }

          try {
            const parsed = JSON.parse(afterData);

            // n8n may emit begin/item/end events without "data:" prefixes.
            const content = parsed?.delta?.content ?? parsed?.content ?? null;

            if (content && ["chunk", "item"].includes(parsed?.type)) {
              log("[SSE] chunk", {
                id: parsed?.id,
                type: parsed?.type,
                finished: parsed?.finished,
                content,
              });
              return yield {
                id: parsed?.id,
                choices: [
                  {
                    delta: { content },
                    finish_reason: null,
                  },
                ],
              };
            }

            if (
              ["done", "end"].includes(parsed?.type) ||
              parsed?.finished === true
            ) {
              log("[SSE] completion signal", {
                id: parsed?.id,
                type: parsed?.type,
                finished: parsed?.finished,
              });
              ended = true;
              return yield {
                id: parsed?.id,
                choices: [
                  {
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };
            }
          } catch (_error) {
            return;
          }
        };

        for await (const chunk of nodeStream) {
          if (ended) break;
          const decoded = decoder.decode(chunk, { stream: true });
          log(`[SSE RAW ${new Date().toISOString()}] segment`, decoded);
          buffer += decoded;
          const segments = buffer.split("\n\n");
          buffer = segments.pop();
          for (const segment of segments) {
            const lines = segment.split("\n");
            for (const line of lines) {
              for (const emitted of emitChunk(line)) {
                yield emitted;
              }
            }
          }
        }

        if (!ended && buffer.length) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            for (const emitted of emitChunk(line)) {
              yield emitted;
            }
          }
        }

        clearTimeout(timeout);
        controller?.abort?.();
      },
    };

    return streamIterable;
  }

  async getChatCompletion(
    messages = null,
    { temperature = 0.7, sessionId = null } = {}
  ) {
    const { response, controller, timeout } = await this.#performRequest(
      messages,
      temperature,
      sessionId
    );
    const stream = this.#createSSEStream(response, controller, timeout);
    let textResponse = "";
    const start = Date.now();

    for await (const chunk of stream) {
      const token = chunk?.choices?.[0]?.delta?.content || "";
      textResponse += token;
      if (chunk?.choices?.[0]?.finish_reason) break;
    }

    const duration = (Date.now() - start) / 1000;
    return {
      textResponse,
      metrics: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        outputTps: textResponse.length / (duration || 1),
        duration,
      },
    };
  }

  async streamGetChatCompletion(
    messages = null,
    { temperature = 0.7, sessionId = null } = {}
  ) {
    const { response, controller, timeout } = await this.#performRequest(
      messages,
      temperature,
      sessionId
    );
    const stream = this.#createSSEStream(response, controller, timeout);
    this.log("Streaming chat completion started", {
      model: this.model,
      sessionId,
      temperature,
    });
    return await LLMPerformanceMonitor.measureStream(
      Promise.resolve(stream),
      messages
    );
  }

  handleStream(response, stream, responseProps) {
    return new Promise(async (resolve) => {
      const { uuid } = responseProps;
      let fullText = "";
      let completionTokens = 0;

      try {
        for await (const chunk of stream) {
          const token = chunk?.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            completionTokens++;
            this.log("[SSE] emitting token", { uuid, token });
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: token,
              close: false,
              error: false,
            });
          }

          if (chunk?.choices?.[0]?.finish_reason) {
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: "",
              close: true,
              error: false,
            });
            stream?.endMeasurement?.({ completion_tokens: completionTokens });
            resolve(fullText);
            break;
          }
        }
      } catch (e) {
        writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        stream?.endMeasurement?.({ completion_tokens: completionTokens });
        resolve(fullText);
      }
    });
  }

  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = { N8nAgentLLM };
