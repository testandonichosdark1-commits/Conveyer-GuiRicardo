# SPEC — DeepSeek como provedor de LLM (redução de custo do Gemini)

> Para o Claude Code. Leia o `CLAUDE.md` antes, em especial as seções de Cost Monitoring e
> `gemini-models.ts`.
> Tudo fica atrás de configuração, com **Gemini como default** e regressão zero quando a opção
> estiver desligada.

## 1. Onde o Gemini é usado hoje (fluxo Studio)

| # | Função (arquivo) | Entrada | Modelo default | Roda quando |
|---|---|---|---|---|
| 1 | `requestPlanChunk` (`studio-plan.ts`) — planner: visual query, aiPrompt, overlays, aiMedia, footageKind, product_label por beat | texto | `SCENE_SPLIT_MODEL` = gemini-3.5-flash (tarifa cheia) | todo vídeo |
| 2 | `scoreLocalImage` (`visual-source.ts`) — nota 0–100 de cada imagem IA vs. a cena; regenera até `AI_REGEN_ATTEMPTS` (5) se < `AI_MATCH_THRESHOLD` (75) | imagem | `VISION_MATCH_MODEL` = gemini-3.1-flash-lite | cada imagem IA gerada |
| 3 | `scoreAndPick` — nota dos candidatos de footage real pelas thumbnails | imagens | flash-lite | só com fonte real |
| 4 | `detectTextRegion` — detecta texto queimado em frames de footage | imagem | flash-lite | só com fonte real/YouTube |
| 5 | `rerankByTitle` — ranqueia resultados do YouTube por canal/título/duração | **texto** | flash-lite | só com YouTube ligado |
| 6 | `scene-split.ts`, `avatar-plan.ts`, `library.findSimilarClips` | texto | — | pipelines antigos, fora do nav |

Os itens 1 e 5 são só texto, então trocar para DeepSeek é direto. Os itens 2, 3 e 4 são de visão:
o `deepseek-flash` (V4.1-Flash) anuncia multimodal nativo, mas isso precisa ser validado antes de
trocar (ver fase 2).

## 2. Fase 1 — texto (planner + rerank)

### 2.1 Abstração

Criar `services/llm-text.ts` com:

```ts
callLLMJson<T>(opts: {
  runId: string;
  task: "planner" | "rerank";
  system?: string;
  prompt: string;
  validate: (raw: string) => T;   // reaproveitar os validadores atuais
  timeoutMs: number;
}): Promise<{ value: T; provider: "gemini" | "deepseek"; model: string; usage: {in:number; out:number; cacheHit?:number} }>
```

- **Roteamento:** pela setting `LLM_PROVIDER_PLANNER` / `LLM_PROVIDER_RERANK`, com valores
  `gemini` (default) | `deepseek`. Também configurável por canal (override de channels, como as
  outras settings).
- **Implementação Gemini:** delega ao `callGemini` atual **sem mudar nada**.
- **Implementação DeepSeek:**
  - Endpoint compatível com OpenAI: `POST https://api.deepseek.com/chat/completions`.
  - Modelo pela setting `DEEPSEEK_MODEL` (default `deepseek-flash`).
  - Chave em `DEEPSEEK_API_KEY`.
  - Saída em modo JSON. **Confirme na doc oficial** (https://api-docs.deepseek.com) o formato
    atual de `response_format` e se o prompt precisa conter a palavra "json".
  - **Diferença crítica:** o Gemini recebe `responseSchema` (enum de tipos etc.); o DeepSeek não
    garante schema. Por isso, colocar o schema em texto no prompt e manter o `validate` +
    retry/repair que já existem.
  - **Prefixo estável:** manter o prefixo do prompt igual entre chunks (instruções primeiro,
    conteúdo variável no fim) para aproveitar o cache de contexto do DeepSeek, que é cobrado
    mais barato.
  - **Retry:** 429/5xx com backoff exponencial; timeout com AbortController.
- **Fallback:** se o DeepSeek falhar depois dos retries, ou devolver JSON inválido 2 vezes,
  cair para o Gemini **naquele chunk** e registrar no log. Configurável por
  `LLM_FALLBACK_TO_GEMINI` (default 1).

### 2.2 Custos (`pricing.ts`, `cost-ledger.ts`, página `/costs`)

- Nova categoria `deepseekText`.
- Tarifas em settings editáveis, **sem números hardcoded**: `COST_DEEPSEEK_IN_HIT_PER_1M`,
  `COST_DEEPSEEK_IN_MISS_PER_1M`, `COST_DEEPSEEK_OUT_PER_1M`.
  - O operador preenche a partir de https://api-docs.deepseek.com/quick_start/pricing.
  - O DeepSeek tem desconto em horário de baixa demanda. Ou modelar isso, ou documentar que o
    ledger é uma estimativa conservadora.
- Respeitar o invariante de "read-time pricing" do `CLAUDE.md`.

### 2.3 UI de Settings

- Campo da chave DeepSeek.
- Seletor de provedor por tarefa.
- Botão "Testar conexão", que faz uma chamada mínima e mostra o modelo e a latência.

### 2.4 Aceite da fase 1

1. **Regressão zero:** com o provedor = gemini, o plano é idêntico ao de hoje e os testes atuais
   passam.
2. **Comparação A/B:** script `scripts/llm-bakeoff.ts` que roda o planner no mesmo roteiro com
   Gemini e com DeepSeek e compara:
   - % de chunks válidos de primeira;
   - distribuição de tipos de overlay e aiMedia;
   - tamanho dos `aiPrompt`;
   - custo estimado.
   Mostrar os resultados lado a lado. Usar a transcrição do Maglite em
   `~/RadarBrechas/transcricoes/qZVqPRuOIa8.txt`.
3. **Compatibilidade com a spec de motion graphics:** se `SPEC-motion-graphics.md` já estiver
   implementada, o planner com DeepSeek também precisa preencher os campos dos templates graphic
   e passar no zod.

## 3. Fase 2 — visão (opcional, só depois da fase 1)

- **Abstração:** `services/llm-vision.ts` com a mesma lógica de roteamento:
  `LLM_PROVIDER_VISION` = `gemini` (default) | `deepseek`.
- **Envio de imagens:** como base64 no formato que a doc da DeepSeek indicar.
- **Bakeoff primeiro:** antes de trocar, rodar 100 imagens já geradas (com notas do Gemini
  guardadas no log ou no DB) também no DeepSeek. Medir:
  - correlação das notas;
  - taxa de concordância no corte de 75;
  - custo.
  **Só trocar se a concordância for ≥ 85%.**
- **Circuit breaker:** `vision-circuit.ts` precisa contar falhas por provedor.

## 4. Atalho sem código (testar já)

O `scoreLocalImage` regenera a imagem até 5 vezes, e cada regeneração é mais uma chamada de visão
(e mais uma imagem gerada). Antes de qualquer código, vale medir em `/costs` quanto vem de
`geminiText` versus `geminiVision`. Se o grosso for visão, dois ajustes de configuração podem
cortar mais do que a troca de provedor:

- baixar `AI_REGEN_ATTEMPTS` para 2;
- ajustar `AI_MATCH_THRESHOLD`.
