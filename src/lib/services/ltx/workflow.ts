import template from "./workflow.json";
import liteTemplate from "./workflow-lite.json";
import models from "./models.json";

export type LtxGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export const LTX_PROFILE = {
  model: "LTX-2.5 22B distilled · NVFP4",
  gpu: "RTX 5090 e RTX PRO 4500 Blackwell",
  frames: 145,
  fps: 24,
  width: 1920,
  height: 1080,
  budgetUsd: 2,
  stopAfterMinutes: 65,
  audio: "Narração do Conveyer; áudio original preservado separadamente",
} as const;

/** Fixed, previously exercised graph. No model/API fallback or extra generation. */
export function buildLtxWorkflow(prompt: string, imageName = "entrada.png", seed = 123456789,
  options: { sparseAttention?: boolean } = {}): LtxGraph {
  const text = prompt.trim();
  if (!text || text.length > 6000) throw new Error("Descreva a cena em até 6.000 caracteres.");
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(imageName)) throw new Error("Nome de imagem inválido.");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Semente inválida.");
  const graph: LtxGraph = structuredClone(template);
  const suffix = "Subtle handheld, micro-shakes only.";
  graph.pos.inputs.text = text.endsWith(suffix) ? text : `${text} ${suffix}`;
  graph.img.inputs.image = imageName;
  graph.n1.inputs.noise_seed = seed;
  if (options.sparseAttention === false) {
    // A Colab/Kaggle ComfyUI without the sol-attn custom node: second stage runs on the
    // dense model. Same checkpoints, sigmas and frames — only the speed-up is dropped.
    graph.g2.inputs.model = ["m", 0];
    delete graph.sol;
  }
  return graph;
}

/**
 * Free-tier notebook GPUs (Colab/Kaggle T4, 16 GB) cannot hold the 22B profile. This one
 * runs LTX-Video 2B distilled at 832x480 and the CPU finalize scales it to 1080p — a
 * visibly softer clip, chosen only because the GPU the operator has access to is a T4.
 * Built with core ComfyUI nodes only; models-lite.json pins the files.
 */
export const LTX_LITE_PROFILE = {
  model: "LTX-Video 2B distilled 0.9.8",
  gpu: "T4 16 GB (Colab/Kaggle grátis)",
  frames: 121,
  fps: 24,
  width: 832,
  height: 480,
} as const;
export type LtxProfileId = "full" | "lite";

export function buildLtxLiteWorkflow(prompt: string, imageName = "entrada.png", seed = 123456789): LtxGraph {
  const text = prompt.trim();
  if (!text || text.length > 6000) throw new Error("Descreva a cena em até 6.000 caracteres.");
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(imageName)) throw new Error("Nome de imagem inválido.");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Semente inválida.");
  const graph: LtxGraph = structuredClone(liteTemplate);
  const suffix = "Subtle handheld, micro-shakes only.";
  graph.pos.inputs.text = text.endsWith(suffix) ? text : `${text} ${suffix}`;
  graph.img.inputs.image = imageName;
  graph.n1.inputs.noise_seed = seed;
  return graph;
}

export function ltxPreparation(prompt: string) {
  return { mode: "preparation" as const, externalCalls: 0, profile: LTX_PROFILE,
    workflow: buildLtxWorkflow(prompt), models };
}
