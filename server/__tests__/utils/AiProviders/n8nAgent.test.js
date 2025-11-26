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
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  test("collects full response from SSE stream", async () => {
    const sseChunks = [
      'data: {"type":"chunk","id":"1","delta":{"content":"Hello "}}\n\n',
      'data: {"type":"chunk","id":"1","delta":{"content":"World"}}\n\n',
      'data: {"type":"done","id":"1","finished":true}\n\n',
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

  test("streams chunks as they arrive", async () => {
    const sseChunks = [
      'data: {"type":"chunk","id":"1","delta":{"content":"Hello"}}\n\n',
      'data: {"type":"chunk","id":"1","delta":{"content":"!"}}\n\n',
      "data: [DONE]\n\n",
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
