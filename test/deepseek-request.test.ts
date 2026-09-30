import { jest } from "@jest/globals";
import type { fetchEventSource } from "@fortaine/fetch-event-source";
import type { ChatOptions } from "../app/client/api";

jest.unstable_mockModule("@/app/utils/indexedDB-storage", () => ({
  indexedDBStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
const sse = jest.fn<typeof fetchEventSource>();
jest.unstable_mockModule("@fortaine/fetch-event-source", () => ({
  fetchEventSource: sse,
  EventStreamContentType: "text/event-stream",
}));

const { DeepSeekApi } = await import("../app/client/platforms/deepseek");
const { getClientApi } = await import("../app/client/api");
const { DEFAULT_CONFIG, useAppConfig } = await import("../app/store/config");
const { useChatStore, createMessage } = await import("../app/store/chat");
const { useAccessStore } = await import("../app/store/access");
const { usePluginStore } = await import("../app/store/plugin");
const { ServiceProvider } = await import("../app/constant");
const { streamWithThink } = await import("../app/utils/chat");
const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;

function response(body: unknown, contentType = "application/json") {
  const res = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => res,
  };
  return res as Response;
}

function options(model = "deepseek-flash", stream = true) {
  return {
    messages: [{ role: "user" as const, content: "Hello" }],
    config: { model, providerName: ServiceProvider.DeepSeek, stream },
    onFinish: jest.fn<ChatOptions["onFinish"]>(),
    onError: jest.fn<(error: Error) => void>(),
    onController: jest.fn<(controller: AbortController) => void>(),
  };
}

async function emit(chunks: unknown[], index = 0) {
  const init = sse.mock.calls[index][1];
  await init.onopen!(response({}, "text/event-stream"));
  chunks.forEach((chunk) =>
    init.onmessage!({ data: JSON.stringify(chunk), event: "", id: "" }),
  );
  init.onmessage!({ data: "[DONE]", event: "", id: "" });
  await Promise.resolve();
}

describe("DeepSeek chat requests", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    sse.mockReset();
    sse.mockResolvedValue(undefined);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      response({
        choices: [
          { message: { content: "Answer", reasoning_content: "Reasoning" } },
        ],
      }),
    );
    useAppConfig.setState({
      ...DEFAULT_CONFIG,
      modelConfig: {
        ...DEFAULT_CONFIG.modelConfig,
        model: "deepseek-flash",
        providerName: ServiceProvider.DeepSeek,
      },
    });
    useAccessStore.setState({
      needCode: false,
      customModels: "",
      defaultModel: "",
      visionModels: "",
      useCustomConfig: false,
    });
    const session = useChatStore.getState().currentSession();
    useChatStore.setState({
      sessions: [
        {
          ...session,
          mask: {
            ...session.mask,
            modelConfig: { ...useAppConfig.getState().modelConfig },
          },
          messages: [],
          memoryPrompt: "",
        },
      ],
      currentSessionIndex: 0,
    });
    usePluginStore.setState({ getAsTools: () => [[], {}] });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("preserves Flash user images and omits ineffective thinking parameters", async () => {
    useAppConfig.setState({
      modelConfig: { ...useAppConfig.getState().modelConfig, top_p: 0.5 },
    });
    useChatStore.getState().currentSession().mask.modelConfig.top_p = 0.5;
    const content = [
      { type: "text" as const, text: "Describe this" },
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,aGVsbG8=" },
      },
    ];
    await new DeepSeekApi().chat({
      ...options("deepseek-flash", false),
      messages: [{ role: "user", content }],
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => url === "/api/deepseek/chat/completions",
    )!;
    const payload = JSON.parse(call[1]!.body as string);
    expect(payload.messages[0].content).toEqual(content);
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("presence_penalty");
    expect(payload).not.toHaveProperty("frequency_penalty");
    expect(payload.top_p).toBe(0.95);
  });

  test.each(["deepseek-flash", "deepseek-v4-pro", "provider-alias"])(
    "uses thinking sampling parameters for %s",
    async (model) => {
      const opts = options(model, false);
      const parameters = {
        temperature: 0.4,
        presence_penalty: 0.2,
        frequency_penalty: 0.3,
        top_p: 0.5,
      };
      await new DeepSeekApi().chat({
        ...opts,
        config: { ...opts.config, ...parameters },
      });
      const call = fetchMock.mock.calls.find(
        ([url]) => url === "/api/deepseek/chat/completions",
      )!;
      const payload = JSON.parse(call[1]!.body as string);
      expect(payload.top_p).toBe(0.95);
      expect(payload).not.toHaveProperty("temperature");
      expect(payload).not.toHaveProperty("presence_penalty");
      expect(payload).not.toHaveProperty("frequency_penalty");
    },
  );

  test("sends text content for Pro image messages", async () => {
    await new DeepSeekApi().chat({
      ...options("deepseek-v4-pro", false),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
      ],
    });
    const call = fetchMock.mock.calls.find(
      ([url]) => url === "/api/deepseek/chat/completions",
    )!;
    expect(JSON.parse(call[1]!.body as string).messages[0].content).toBe(
      "Describe this",
    );
  });

  test.each(["deepseek-flash", "deepseek-v4-pro"])(
    "caps top_p at one for %s",
    async (model) => {
      const opts = options(model, false);
      await new DeepSeekApi().chat({
        ...opts,
        config: { ...opts.config, top_p: 1.2 },
      });
      const call = fetchMock.mock.calls.find(
        ([url]) => url === "/api/deepseek/chat/completions",
      )!;
      expect(JSON.parse(call[1]!.body as string).top_p).toBe(1);
    },
  );

  test("stores structured reasoning for non-streaming responses", async () => {
    const opts = options("deepseek-v4-pro", false);
    await new DeepSeekApi().chat(opts);
    expect(opts.onFinish.mock.calls[0][0]).toBe("Answer");
    expect(opts.onFinish.mock.calls[0][2]).toEqual([
      { role: "assistant", content: "Answer", reasoning_content: "Reasoning" },
    ]);
  });

  test("handles empty choices and reasoning and answer in the same delta", async () => {
    const opts = options();
    await new DeepSeekApi().chat(opts);
    await emit([
      { choices: [] },
      {
        choices: [
          { delta: { reasoning_content: "Thought", content: "Answer" } },
        ],
      },
    ]);
    expect(opts.onError).not.toHaveBeenCalled();
    expect(opts.onFinish.mock.calls[0][0]).toContain("Answer");
    expect(opts.onFinish.mock.calls[0][2]).toEqual([
      { role: "assistant", content: "Answer", reasoning_content: "Thought" },
    ]);
  });

  test("keeps thinking requests open past 60 seconds and aborts at five minutes", async () => {
    const opts = options();
    await new DeepSeekApi().chat(opts);
    const controller = opts.onController.mock.calls[0][0] as AbortController;
    await jest.advanceTimersByTimeAsync(60001);
    expect(controller.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(240000);
    expect(controller.signal.aborted).toBe(true);
  });

  test("clears the request timeout after a completed stream", async () => {
    const opts = options();
    await new DeepSeekApi().chat(opts);
    await emit([
      { choices: [{ delta: { content: "Done", reasoning_content: "" } }] },
    ]);
    await jest.advanceTimersByTimeAsync(300001);
    expect(
      (opts.onController.mock.calls[0][0] as AbortController).signal.aborted,
    ).toBe(false);
    expect(opts.onFinish).toHaveBeenCalledTimes(1);
  });

  test("passes all tool-round reasoning into continuation requests", async () => {
    const run = jest.fn(async () => ({ status: 200, data: "Result" }));
    usePluginStore.setState({
      getAsTools: () =>
        [
          [{ type: "function", function: { name: "lookup", parameters: {} } }],
          { lookup: run },
        ] as any,
    });
    const opts = options();
    await new DeepSeekApi().chat(opts);
    await emit([
      {
        choices: [
          { delta: { reasoning_content: "Tool thought", content: "Checking" } },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: "{" },
                },
                {
                  index: 1,
                  id: "call-2",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
          },
        ],
      },
    ]);
    await jest.advanceTimersByTimeAsync(61);
    expect(run).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(sse.mock.calls[1][1].body as string);
    expect(payload.messages[1]).toMatchObject({
      role: "assistant",
      content: "Checking",
      reasoning_content: "Tool thought",
    });
    expect(payload.messages[1].tool_calls).toHaveLength(2);
    expect(payload.messages[1].tool_calls[0]).not.toHaveProperty("index");
    expect(payload.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: "Result",
    });
    await emit(
      [
        { choices: [{ delta: { reasoning_content: "Final thought" } }] },
        { choices: [{ delta: { content: "Final answer" } }] },
      ],
      1,
    );
    const saved = opts.onFinish.mock.calls[0][2]!;
    expect(saved).toHaveLength(4);
    expect(saved[3]).toMatchObject({
      content: "Final answer",
      reasoning_content: "Final thought",
    });
    sse.mockClear();
    await new DeepSeekApi().chat({
      ...options(),
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Rendered output", apiMessages: saved },
        { role: "user", content: "Next question" },
      ] as any,
    });
    const next = JSON.parse(sse.mock.calls[0][1].body as string);
    expect(
      next.messages.some((m: any) => m.reasoning_content === "Tool thought"),
    ).toBe(true);
    expect(
      next.messages.some((m: any) => m.reasoning_content === "Final thought"),
    ).toBe(true);
  });

  test("uses Flash for titles and respects a disabled Flash model", async () => {
    const session = useChatStore.getState().currentSession();
    session.mask.modelConfig.model = "deepseek-v4-pro";
    session.mask.modelConfig.compressModel = "";
    session.messages = [createMessage({ role: "user", content: "Hello" })];
    useChatStore.getState().summarizeSession(true, session);
    await jest.advanceTimersByTimeAsync(0);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).model).toBe(
      "deepseek-flash",
    );
    fetchMock.mockClear();
    useAccessStore.setState({ customModels: "-deepseek-flash@deepseek" });
    useChatStore.getState().summarizeSession(true, session);
    await Promise.resolve();
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).model).toBe(
      "deepseek-v4-pro",
    );
  });

  test("keeps third-party DeepSeek models on their selected provider", async () => {
    const session = useChatStore.getState().currentSession();
    session.mask.modelConfig.model = "deepseek-v4-pro";
    session.mask.modelConfig.providerName = ServiceProvider.OpenAI;
    session.mask.modelConfig.compressModel = "";
    useChatStore.getState().summarizeSession(true, session);
    await Promise.resolve();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/openai/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).model).toBe(
      "deepseek-v4-pro",
    );
  });

  test("stops continuation requests when a running tool is cancelled", async () => {
    let resolveTool!: (result: { status: number; data: string }) => void;
    const run = () =>
      new Promise<{ status: number; data: string }>((resolve) => {
        resolveTool = resolve;
      });
    usePluginStore.setState({
      getAsTools: () =>
        [
          [{ type: "function", function: { name: "lookup", parameters: {} } }],
          { lookup: run },
        ] as any,
    });
    const opts = options();
    await new DeepSeekApi().chat(opts);
    await emit([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    ]);
    opts.onController.mock.calls[0][0].abort();
    resolveTool({ status: 200, data: "Late result" });
    await jest.advanceTimersByTimeAsync(100);
    expect(sse).toHaveBeenCalledTimes(1);
    expect(opts.onFinish).toHaveBeenCalledTimes(1);
  });

  test("clears connection timers after streaming errors", async () => {
    const opts = options();
    await new DeepSeekApi().chat(opts);
    const init = sse.mock.calls[0][1];
    const error = new Error("Connection failed");
    expect(() => init.onerror!(error)).toThrow(error);
    jest.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
    await jest.advanceTimersByTimeAsync(300001);
    expect(opts.onController.mock.calls[0][0].signal.aborted).toBe(false);
    expect(opts.onError).toHaveBeenCalledTimes(1);
  });

  test("keeps only the final answer in history summaries", async () => {
    useAppConfig.setState({ enableAutoGenerateTitle: false });
    const session = useChatStore.getState().currentSession();
    session.mask.modelConfig.compressMessageLengthThreshold = 1;
    session.mask.modelConfig.sendMemory = true;
    session.messages = [
      createMessage({ role: "user", content: "Summarize this conversation" }),
    ];
    useChatStore.getState().summarizeSession(false, session);
    await jest.advanceTimersByTimeAsync(0);
    await emit([
      { choices: [{ delta: { reasoning_content: "Internal thought" } }] },
      { choices: [{ delta: { content: "Summary" } }] },
    ]);
    expect(session.memoryPrompt).toBe("Summary");
  });

  test("persists structured completions with chat messages", async () => {
    useAppConfig.setState({ enableAutoGenerateTitle: false });
    useChatStore.getState().currentSession().mask.modelConfig.sendMemory =
      false;
    await useChatStore.getState().onUserInput("Hello");
    await jest.advanceTimersByTimeAsync(0);
    await emit([
      {
        choices: [
          { delta: { reasoning_content: "Thought", content: "Answer" } },
        ],
      },
    ]);
    const assistant = useChatStore.getState().currentSession().messages.at(-1)!;
    expect(assistant.apiMessages).toEqual([
      { role: "assistant", content: "Answer", reasoning_content: "Thought" },
    ]);
    expect(assistant.streaming).toBe(false);
  });

  test.each([
    [ServiceProvider.OpenAI, "gpt-4o-mini"],
    [ServiceProvider.Azure, "gpt-4o-mini"],
    [ServiceProvider.Alibaba, "qwen-turbo"],
    [ServiceProvider.ByteDance, "Doubao-lite-4k"],
    [ServiceProvider.SiliconFlow, "Qwen/Qwen2.5-7B-Instruct"],
  ] as const)(
    "preserves streaming responses for %s",
    async (provider, model) => {
      const session = useChatStore.getState().currentSession();
      session.mask.modelConfig.providerName = provider;
      session.mask.modelConfig.model = model;
      const opts = options(model);
      await getClientApi(provider).llm.chat({
        ...opts,
        config: { ...opts.config, providerName: provider },
      });
      const chunk =
        provider === ServiceProvider.Alibaba
          ? {
              output: {
                choices: [{ message: { content: "Existing provider answer" } }],
              },
            }
          : { choices: [{ delta: { content: "Existing provider answer" } }] };
      await emit([chunk]);
      expect(opts.onFinish.mock.calls[0][0]).toBe("Existing provider answer");
      expect(opts.onError).not.toHaveBeenCalled();
    },
  );

  test("keeps the default shared timeout for existing providers", async () => {
    const controller = new AbortController();
    streamWithThink(
      "/api/openai/v1/chat/completions",
      { model: "gpt-4o-mini", messages: [] },
      {},
      [],
      {},
      controller,
      () => ({ isThinking: false, content: "" }),
      () => {},
      { onFinish: jest.fn() },
    );
    await jest.advanceTimersByTimeAsync(60001);
    expect(controller.signal.aborted).toBe(true);
  });
});
