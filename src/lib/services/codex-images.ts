import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

type Message = { id?: number; method?: string; params?: any; result?: any; error?: unknown };
/** Transport is injected. Importing this module never launches Codex or calls a service. */
export interface CodexImageWire {
  send(message: Message): void;
  subscribe(listener: (message: Message) => void): () => void;
}

export class CodexImageRpc {
  private nextId = 0;
  constructor(private readonly wire: CodexImageWire, private readonly timeoutMs = 120_000, private readonly imageTimeoutMs = timeoutMs) {}
  notify(method: string, params: unknown) { this.wire.send({ method, params }); }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Codex: tempo esgotado em ${method}. Não reenviar automaticamente.`)); }, this.timeoutMs);
      const off = this.wire.subscribe(message => {
        if (message.id !== id) return;
        clearTimeout(timer); off();
        if (message.error) reject(new Error(`Codex recusou ${method}.`));
        else resolve(message.result);
      });
      try { this.wire.send({ id, method, params }); }
      catch { clearTimeout(timer); off(); reject(new Error(`Falha de comunicação em ${method}.`)); }
    });
  }
  /** Subscribe before turn/start: notifications may arrive before its RPC response. */
  watchImage(threadId: string) {
    let close = () => {};
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error("Imagem não recebida. Recuperar o turno antes de tentar novamente.")); }, this.imageTimeoutMs);
      const off = this.wire.subscribe(message => {
        const p = message.params;
        if (p?.threadId !== threadId) return;
        if (message.method === "item/completed" && p.item?.type === "imageGeneration") {
          close();
          if (p.item.status === "completed" && !p.item.error) resolve(p.item);
          else reject(new Error("A geração de imagem falhou."));
        } else if (message.method === "turn/completed") {
          close(); reject(new Error("O turno terminou sem uma imagem válida."));
        }
      });
      close = () => { clearTimeout(timer); off(); };
    });
    // A transport failure can occur before the caller awaits the image.
    void promise.catch(() => {});
    return { promise, close };
  }
}

export async function initializeCodexImages(rpc: CodexImageRpc) {
  await rpc.request("initialize", { clientInfo: { name: "conveyer", title: "Conveyer", version: "0.4.2" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
}

const blockedFeatures = ["shell_tool", "web_search_request", "standalone_web_search", "apps", "plugins", "browser_use", "computer_use", "multi_agent", "tool_search", "request_permissions_tool"];
export function codexImageThreadParams(model: string, emptyWorkspace: string) {
  if (!model.trim() || !path.isAbsolute(emptyWorkspace)) throw new Error("Modelo e pasta isolada são obrigatórios.");
  return { model, cwd: emptyWorkspace, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    baseInstructions: "Execute somente geração de uma imagem via ferramenta oficial. Não pesquise, não edite arquivos e não chame ferramentas externas. Gere exatamente uma imagem horizontal 16:9.",
    dynamicTools: [], environments: [], runtimeWorkspaceRoots: [emptyWorkspace],
    config: { features: { ...Object.fromEntries(blockedFeatures.map(key => [key, false])), image_generation: true } } };
}

/** Removes credential overrides; authentication stays in the explicitly selected Codex home. */
export function codexImageEnvironment(base: NodeJS.ProcessEnv, accountHome: string): NodeJS.ProcessEnv {
  if (!path.isAbsolute(accountHome)) throw new Error("Pasta da conta inválida.");
  const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: accountHome, CODEX_DISABLE_AUTO_UPDATE: "1" };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ACCESS_TOKEN", "OPENAI_BASE_URL"]) delete env[key];
  return env;
}

/** One explicit approval consumes exactly one turn/start. A failure never retries generation. */
const active = new WeakSet<CodexImageRpc>();
export async function generateCodexImage(rpc: CodexImageRpc, options: {
  model: string; emptyWorkspace: string; prompt: string; approved: boolean;
  recordThread: (threadId: string) => Promise<void>;
}) {
  if (options.approved !== true) throw new Error("A geração real exige autorização explícita.");
  if (!options.prompt.trim() || options.prompt.length > 20_000) throw new Error("Prompt inválido.");
  if (active.has(rpc)) throw new Error("Já existe uma geração em andamento neste conector.");
  active.add(rpc);
  try {
  const start = await rpc.request("thread/start", codexImageThreadParams(options.model, options.emptyWorkspace));
  const threadId = start?.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("Codex não retornou a conversa.");
  await options.recordThread(threadId); // Persist before the billable/plan-consuming operation.
  const watcher = rpc.watchImage(threadId);
  let turnId: string | undefined;
  try {
    const turn = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }], effort: "low", summary: "none" });
    turnId = turn?.turn?.id;
    if (!turnId) throw new Error("Turno não identificado. Recuperar a conversa antes de tentar novamente.");
    const image = await watcher.promise;
    let interrupted = false;
    try { await rpc.request("turn/interrupt", { threadId, turnId: turn.turn.id }); interrupted = true; }
    catch { /* Preserve a valid image even if the text turn already ended. */ }
    return { threadId, turnId: turn.turn.id as string, image, interrupted };
  } catch (error) {
    if (turnId) {
      try { await rpc.request("turn/interrupt", { threadId, turnId }); } catch { /* Recovery is required; never submit again. */ }
    }
    throw error;
  } finally { watcher.close(); }
  } finally { active.delete(rpc); }
}

/** Read existing history only; never sends turn/start. */
export async function recoverCodexImage(rpc: CodexImageRpc, threadId: string, turnId?: string) {
  const result = await rpc.request("thread/read", { threadId, includeTurns: true });
  const turns = result?.thread?.turns ?? [];
  return turns.filter((turn: any) => !turnId || turn.id === turnId)
    .flatMap((turn: any) => turn.items ?? [])
    .find((item: any) => item.type === "imageGeneration" && item.status === "completed" && !item.error) ?? null;
}

/** Accept only PNGs inside Codex's generated_images tree; reject traversal and symlinks outside it. */
export async function saveCodexImage(accountHome: string, image: { savedPath?: string | null }, outPath: string) {
  if (!image.savedPath || !path.isAbsolute(image.savedPath)) throw new Error("Resultado sem caminho de imagem válido.");
  const root = await fs.realpath(path.join(accountHome, "generated_images"));
  const source = await fs.realpath(image.savedPath);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Imagem fora da pasta autorizada.");
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error("Arquivo de imagem inválido.");
  const buffer = await fs.readFile(source);
  const metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < 256 || Math.abs(metadata.width / metadata.height - 16 / 9) > 0.02) throw new Error("A imagem precisa ser PNG horizontal 16:9, com no mínimo 256 pixels por lado.");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const temp = `${outPath}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, buffer, { mode: 0o600 }); await fs.rename(temp, outPath); }
  finally { await fs.rm(temp, { force: true }); }
  return { filePath: outPath, width: metadata.width, height: metadata.height, sha256: createHash("sha256").update(buffer).digest("hex") };
}
