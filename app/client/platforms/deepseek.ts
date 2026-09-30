"use client";
// azure and openai, using same models. so using same LLMApi.
import { ApiPath, DEEPSEEK_BASE_URL, DeepSeek } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  ChatMessage,
  usePluginStore,
} from "@/app/store";
import { preProcessImageContent, streamWithThink } from "@/app/utils/chat";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  ChatCompletionMessage,
  SpeechOptions,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  getMessageTextContentWithoutThinking,
  getTimeoutMSByModel,
} from "@/app/utils";
import { fetch } from "@/app/utils/stream";

export class DeepSeekApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.deepseekUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.DeepSeek;
      baseUrl = isApp ? DEEPSEEK_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.DeepSeek)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...options.config,
    };
    const messages: ChatCompletionMessage[] = [];
    for (const message of options.messages) {
      const apiMessages = (message as ChatMessage).apiMessages;
      if (message.role === "assistant" && apiMessages?.length) {
        messages.push(...apiMessages);
      } else if (message.role === "assistant") {
        messages.push({
          role: "assistant",
          content: getMessageTextContentWithoutThinking(message),
          reasoning_content: "",
        });
      } else {
        const content =
          message.role === "user" && modelConfig.model === "deepseek-flash"
            ? await preProcessImageContent(message.content)
            : getMessageTextContent(message);
        messages.push({ role: message.role, content });
      }
    }

    let hasFoundFirstUser = false;
    const filteredMessages = messages.filter((message) => {
      if (message.role === "user") hasFoundFirstUser = true;
      return message.role === "system" || hasFoundFirstUser;
    });
    const requestPayload = {
      messages: filteredMessages,
      stream: options.config.stream,
      model: modelConfig.model,
      top_p: Math.min(1, Math.max(0.95, modelConfig.top_p ?? 1)),
    };

    const controller = new AbortController();
    options.onController?.(controller);
    const timeoutMs = getTimeoutMSByModel(modelConfig.model);
    const requestTimeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const clearRequestTimeout = () => clearTimeout(requestTimeoutId);
    controller.signal.addEventListener("abort", clearRequestTimeout, {
      once: true,
    });

    try {
      const chatPath = this.path(DeepSeek.ChatPath);
      const headers = getHeaders();
      if (options.config.stream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        const apiMessages: ChatCompletionMessage[] = [];
        let reasoningContent = "";
        let answerContent = "";
        return streamWithThink(
          chatPath,
          requestPayload,
          headers,
          tools as any,
          funcs,
          controller,
          (text: string, runTools: ChatMessageTool[]) => {
            const delta = JSON.parse(text).choices?.[0]?.delta;
            if (!delta) return { isThinking: false, content: "" };
            for (const tool of delta.tool_calls ?? []) {
              if (tool.id) {
                runTools.push({
                  id: tool.id,
                  index: tool.index,
                  type: tool.type,
                  function: {
                    name: tool.function?.name,
                    arguments: tool.function?.arguments ?? "",
                  },
                });
              } else {
                const pendingTool = runTools.find(
                  (pending) => pending.index === tool.index,
                );
                if (pendingTool?.function) {
                  pendingTool.function.arguments +=
                    tool.function?.arguments ?? "";
                }
              }
            }
            const reasoning = delta.reasoning_content ?? "";
            const content = delta.content ?? "";
            reasoningContent += reasoning;
            answerContent += content;
            return reasoning
              ? {
                  isThinking: true,
                  content: reasoning,
                  contentAfterThinking: content,
                }
              : { isThinking: false, content };
          },
          (payload, toolCallMessage, toolCallResult) => {
            const assistantMessage: ChatCompletionMessage = {
              role: "assistant",
              content: answerContent,
              reasoning_content: reasoningContent,
              tool_calls: toolCallMessage.tool_calls.map(
                (tool: ChatMessageTool) => ({
                  id: tool.id,
                  type: tool.type,
                  function: tool.function,
                }),
              ),
            };
            payload.messages.push(assistantMessage, ...toolCallResult);
            apiMessages.push(assistantMessage, ...toolCallResult);
            reasoningContent = "";
            answerContent = "";
          },
          {
            ...options,
            onFinish: (message: string, res: Response) => {
              clearRequestTimeout();
              controller.signal.removeEventListener(
                "abort",
                clearRequestTimeout,
              );
              apiMessages.push({
                role: "assistant",
                content: answerContent,
                reasoning_content: reasoningContent,
              });
              options.onFinish(message, res, apiMessages);
            },
            onError: (error: Error) => {
              clearRequestTimeout();
              controller.signal.removeEventListener(
                "abort",
                clearRequestTimeout,
              );
              options.onError?.(error);
            },
          },
          timeoutMs,
        );
      }

      const res = await fetch(chatPath, {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers,
      });
      const resJson = await res.json();
      const message = this.extractMessage(resJson);
      const reasoning = resJson.choices?.[0]?.message?.reasoning_content ?? "";
      options.onFinish(message, res, [
        { role: "assistant", content: message, reasoning_content: reasoning },
      ]);
    } catch (e) {
      clearRequestTimeout();
      options.onError?.(e as Error);
    } finally {
      if (!options.config.stream) {
        clearRequestTimeout();
        controller.signal.removeEventListener("abort", clearRequestTimeout);
      }
    }
  }
  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
