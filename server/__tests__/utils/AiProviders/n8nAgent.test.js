/* eslint-env jest, node */
const { ReadableStream } = require("stream/web");
const { N8nAgentLLM } = require("../../../utils/AiProviders/n8nAgent");

const originalEnv = { ...process.env };

function buildSSEStream(chunks = []) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("N8nAgentLLM", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.N8N_AGENT_BASE_URL = "https://example.com";
    process.env.N8N_AGENT_MODEL_PREF = "test-model";
    process.env.N8N_AGENT_TIMEOUT_MS = "1000";
    process.env.N8N_AGENT_WEBHOOK_PATH = "/webhook/chat-agent-stream";
    process.env.N8N_AGENT_BUFFER_STREAM = undefined;
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  test("collects full response from SSE stream", async () => {
    const sseChunks = [
      'data: {"type":"item","id":"1","content":"Hello "}\n\n',
      'data: {"type":"item","id":"1","content":"World"}\n\n',
      'data: {"type":"end","id":"1"}\n\n',
    ];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    const result = await provider.getChatCompletion(
      [{ role: "user", content: "Hi" }],
      { temperature: 0.2 }
    );

    expect(result.textResponse).toBe("Hello World");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/webhook/chat-agent-stream",
      expect.objectContaining({ method: "POST" })
    );
  });

  test("requests SSE responses via Accept header", async () => {
    const sseChunks = ['data: {"type":"done","id":"1","finished":true}\n\n'];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    await provider.getChatCompletion([{ role: "user", content: "Hi" }], {});

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers["Accept"]).toBe("text/event-stream");
  });

  test("sends session id when provided", async () => {
    const sseChunks = ['data: {"type":"done","id":"1","finished":true}\n\n'];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    await provider.getChatCompletion(
      [{ role: "user", content: "Hi" }],
      { temperature: 0.2, sessionId: "abc-123" }
    );

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe("abc-123");
  });

  test("adds chatInput from latest user message", async () => {
    const sseChunks = ['data: {"type":"done","id":"1","finished":true}\n\n'];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    await provider.getChatCompletion(
      [
        { role: "system", content: "setup" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "latest request" },
      ],
      { temperature: 0.1 }
    );

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.chatInput).toBe("latest request");
  });

  test("streams chunks as they arrive", async () => {
    const sseChunks = [
      '{"type":"item","id":"1","content":"Hello"}\n\n',
      '{"type":"item","id":"1","content":"!"}\n\n',
      'data: {"type":"done","id":"1","finished":true}\n\n',
    ];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    const stream = await provider.streamGetChatCompletion([
      { role: "user", content: "Hello?" },
    ]);

    const tokens = [];
    for await (const chunk of stream) {
      const token = chunk?.choices?.[0]?.delta?.content;
      if (token) tokens.push(token);
    }

    expect(tokens).toEqual(["Hello", "!"]);
  });

  test("does not buffer when CRLF delimiters are used", async () => {
    const sseChunks = [
      'data: {"type":"item","id":"1","content":"He"}\r\n\r\n',
      'data: {"type":"item","id":"1","content":"llo"}\r\n\r\n',
      'data: {"type":"done","id":"1","finished":true}\r\n\r\n',
    ];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    const stream = await provider.streamGetChatCompletion([
      { role: "user", content: "Hello?" },
    ]);

    const tokens = [];
    for await (const chunk of stream) {
      const token = chunk?.choices?.[0]?.delta?.content;
      if (token) tokens.push(token);
    }

    expect(tokens).toEqual(["He", "llo"]);
  });

  test("handles openai-style chunk events for backwards compatibility", async () => {
    const sseChunks = [
      'data: {"type":"chunk","id":"1","delta":{"content":"Hi"}}\n\n',
      'data: [DONE]\n\n',
    ];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    const provider = new N8nAgentLLM();
    const result = await provider.getChatCompletion([
      { role: "user", content: "Hello" },
    ]);

    expect(result.textResponse).toBe("Hi");
  });

  test("can disable streaming when configured to buffer responses", async () => {
    const sseChunks = ['data: {"type":"done","id":"1","finished":true}\n\n'];

    global.fetch = jest.fn().mockResolvedValue(
      new Response(buildSSEStream(sseChunks), { status: 200 })
    );

    process.env.N8N_AGENT_BUFFER_STREAM = "true";
    const provider = new N8nAgentLLM();

    expect(provider.streamingEnabled()).toBe(false);
    const result = await provider.getChatCompletion([
      { role: "user", content: "Hello" },
    ]);

    expect(result.textResponse).toBe("");
  });

  test("throws on non-200 responses", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response("bad", { status: 500 })
    );

    const provider = new N8nAgentLLM();
    await expect(
      provider.getChatCompletion([{ role: "user", content: "Hi" }], {})
    ).rejects.toThrow(/status 500/);
  });
});
