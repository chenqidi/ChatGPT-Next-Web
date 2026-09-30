import { jest } from "@jest/globals";
import {
  DEFAULT_MODELS,
  DEEPSEEK_SUMMARIZE_MODEL,
  KnowledgeCutOffDate,
} from "../app/constant";
import { collectModels, isModelNotavailableInServer } from "../app/utils/model";
jest.unstable_mockModule("@/app/utils/indexedDB-storage", () => ({
  indexedDBStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

const { getTimeoutMSByModel, isVisionModel } = await import("../app/utils");
const { useAppConfig, DEFAULT_CONFIG } = await import("../app/store/config");
const { useAccessStore } = await import("../app/store/access");

const currentModels = ["deepseek-flash", "deepseek-v4-pro"];

describe("DeepSeek model configuration", () => {
  const originalDisableGPT4 = process.env.DISABLE_GPT4;

  beforeEach(() => {
    delete process.env.DISABLE_GPT4;
    useAppConfig.setState({ customModels: "", models: [...DEFAULT_MODELS] });
    useAccessStore.setState({ customModels: "", defaultModel: "" });
  });

  afterAll(() => {
    if (originalDisableGPT4 === undefined) delete process.env.DISABLE_GPT4;
    else process.env.DISABLE_GPT4 = originalDisableGPT4;
  });

  test("offers only the current built-in DeepSeek models", () => {
    expect(
      DEFAULT_MODELS.filter((m) => m.provider.id === "deepseek").map(
        (m) => m.name,
      ),
    ).toEqual(currentModels);
    expect(DEEPSEEK_SUMMARIZE_MODEL).toBe("deepseek-flash");
    expect(
      Object.keys(KnowledgeCutOffDate).filter((name) =>
        name.startsWith("deepseek-"),
      ),
    ).toEqual(currentModels);
    currentModels.forEach((name) => {
      expect(KnowledgeCutOffDate[name]).toBe("Not published");
    });
  });

  test.each(currentModels)(
    "allows %s while unrelated models are restricted",
    (model) => {
      expect(isModelNotavailableInServer("-gpt-4", model, "DeepSeek")).toBe(
        false,
      );
      expect(isModelNotavailableInServer("-all", model, "DeepSeek")).toBe(true);
      expect(
        isModelNotavailableInServer(
          `-all,+${model}@DeepSeek`,
          model,
          "DeepSeek",
        ),
      ).toBe(false);
      expect(
        isModelNotavailableInServer(`-${model}@deepseek`, model, "DeepSeek"),
      ).toBe(true);
      process.env.DISABLE_GPT4 = "1";
      expect(isModelNotavailableInServer("-gpt-4", model, "DeepSeek")).toBe(
        false,
      );
    },
  );

  test("keeps unknown models and mismatched providers restricted", () => {
    expect(
      isModelNotavailableInServer("-gpt-4", "deepseek-unknown", "DeepSeek"),
    ).toBe(true);
    expect(
      isModelNotavailableInServer(
        "-all,+deepseek-flash@OpenAI",
        "deepseek-flash",
        "DeepSeek",
      ),
    ).toBe(true);
  });

  test("enables vision only for Flash and extends both thinking timeouts", () => {
    expect(isVisionModel("deepseek-flash")).toBe(true);
    expect(isVisionModel("deepseek-v4-pro")).toBe(false);
    currentModels.forEach((model) =>
      expect(getTimeoutMSByModel(model)).toBe(300000),
    );
    expect(getTimeoutMSByModel("gpt-4o-mini")).toBe(60000);
  });

  test.each(["deepseek-ai/DeepSeek-R1", "Pro/deepseek-ai/DeepSeek-R1"])(
    "preserves SiliconFlow's thinking timeout for %s",
    (model) => {
      expect(getTimeoutMSByModel(model)).toBe(300000);
    },
  );

  test.each([
    { name: "cached-model", available: true },
    { name: "deepseek-flash", available: false },
  ])(
    "uses current DeepSeek definitions instead of cached $name ($available)",
    (cached) => {
      const flash = DEFAULT_MODELS.find(
        (model) =>
          model.name === "deepseek-flash" && model.provider.id === "deepseek",
      )!;
      const state = { ...DEFAULT_CONFIG, models: [{ ...flash, ...cached }] };
      const merged = useAppConfig.persist.getOptions().merge!(
        state,
        useAppConfig.getState(),
      );
      expect(
        merged.models.filter((model) => model.provider.id === "deepseek"),
      ).toEqual(
        DEFAULT_MODELS.filter((model) => model.provider.id === "deepseek"),
      );
      expect(
        collectModels(merged.models, "")
          .filter((model) => model.provider?.id === "deepseek")
          .map((model) => model.name),
      ).toEqual(currentModels);
    },
  );

  test("preserves cached models from other providers", () => {
    const model = DEFAULT_MODELS.find(
      (model) => model.provider.id === "openai",
    )!;
    const cached = { ...model, name: "cached-other-model", available: false };
    const merged = useAppConfig.persist.getOptions().merge!(
      { ...DEFAULT_CONFIG, models: [cached] },
      useAppConfig.getState(),
    );
    expect(merged.models).toContainEqual(cached);
  });

  test("keeps custom model declarations independent of the cached list", () => {
    const customModels = "+provider-alias@DeepSeek";
    const merged = useAppConfig.persist.getOptions().merge!(
      { ...DEFAULT_CONFIG, customModels, models: [] },
      useAppConfig.getState(),
    );
    expect(merged.customModels).toBe(customModels);
    expect(
      collectModels(merged.models, merged.customModels).find(
        (model) => model.name === "provider-alias",
      ),
    ).toMatchObject({ available: true, provider: { id: "deepseek" } });
  });
});
