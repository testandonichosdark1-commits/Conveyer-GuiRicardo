import { describe, it, expect, vi } from "vitest";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));
vi.mock("./flow-browser", () => ({
  FlowBrowserError: class extends Error { code: string; constructor(m: string, c: string) { super(m); this.code = c; } },
  flowChromeContext: async () => { throw new Error("not used"); },
  validateFlowVideoFile: async () => ({}),
}));

import { classifyVidsFailure, vidsAspectLabel } from "./vids-browser";

describe("vidsAspectLabel", () => {
  it("maps the app's ratios to Vids' menu labels, defaulting to landscape", () => {
    expect(vidsAspectLabel("16:9")).toBe("Paisagem 16:9");
    expect(vidsAspectLabel("9:16")).toBe("Retrato 9:16");
    expect(vidsAspectLabel("1:1")).toBe("Quadrado 1:1");
    expect(vidsAspectLabel("weird")).toBe("Paisagem 16:9");
  });
});

describe("classifyVidsFailure", () => {
  it("never reads Vids' permanent banners as a failure (they say 'upgrade', 'limites' and 'não é possível' all the time)", () => {
    const page = [
      "Insira o comando em inglês para ter os melhores resultados. Ainda não é possível usar outros idiomas.",
      "Faça upgrade para editar vídeos",
      "Faça upgrade para ter limites de geração de vídeo maiores e recursos premium de IA.",
      "O Gemini no Workspace pode cometer erros.",
      "Seu clipe de vídeo está sendo gerado",
    ].join("\n");
    expect(classifyVidsFailure(page)).toBeNull();
  });

  it("recognises quota, policy and generic failures", () => {
    expect(classifyVidsFailure("Você atingiu o limite de gerações de hoje")?.code).toBe("credits");
    // The real message, observed live 2026-09-26 after ~8 videos in one session:
    expect(classifyVidsFailure("Você atingiu seu limite para gerar conteúdo no Vids.")?.code).toBe("credits");
    expect(classifyVidsFailure("Não foi possível gerar: isso pode violar nossas políticas")?.code).toBe("policy");
    expect(classifyVidsFailure("Algo deu errado. Tente novamente.")?.code).toBe("capture");
  });
});
