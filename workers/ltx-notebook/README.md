# Conveyer LTX: GPU do Colab / Kaggle

Usa a GPU de um notebook do Google Colab (ou Kaggle) como gerador dos clipes LTX do
Conveyer, no lugar do Pod Runpod, pelo mesmo adaptador (`animateLtxScene`). O notebook
escolhe o perfil pela VRAM:

| GPU | perfil | grafo / modelos | saída |
|---|---|---|---|
| ≥ 40 GB (A100, H100, G4) | `full` | `workflow.json` / `models.json` — LTX 22B, igual ao Runpod | 1920×1088 → recorte 1080p |
| 16 GB (**T4 grátis**) | `lite` | `workflow-lite.json` / `models-lite.json` — LTX-Video 2B distilled 0.9.8 + T5 fp8 | 832×480, 121 quadros → ampliado para 1080p |

O perfil `lite` só usa nós nativos do ComfyUI e foi aceito sem erros pela validação de
prompt do ComfyUI 0.37.1 fixado (testado localmente em CPU com arquivos de modelo vazios —
a geração em si nunca rodou). A qualidade é bem menor que a do 22B: é a opção para quem
só tem acesso à T4.

```
Conveyer (Mac) ──https + Bearer──▶ túnel trycloudflare ──▶ conveyer_proxy.py ──▶ ComfyUI 127.0.0.1:8188
```

## Como testar

1. Abra `conveyer_ltx_notebook.ipynb` no Colab (*Arquivo → Fazer upload de notebook*) e
   escolha **GPUs: T4** (ou uma GPU maior, se a conta tiver).
2. Rode as células 1–6. A última mostra **Endereço** e **Token**.
3. No Conveyer: `/tools/ltx-scene-test` → *GPU do Colab ou Kaggle* → cole os dois →
   **Conectar notebook**.
4. Teste uma cena: escolha uma cena de vídeo pendente, aplique a imagem inicial (GPT ou
   upload) e clique **Gerar esta cena no notebook**. Ou rode um vídeo com `AI_PROVIDER=ltx`:
   com o notebook conectado, cada cena de vídeo pendente gera o quadro inicial (GPT) e o
   clipe no notebook automaticamente, uma de cada vez, sem pausar o run.

## O que é diferente do Runpod

- **Sem guardian e sem parada automática.** Nada é cobrado por hora pelo Conveyer: o tempo
  de GPU é a cota da conta Colab/Kaggle, e quem encerra o ambiente é você. O resultado é
  gravado com `source: "notebook-remote"`.
- **Controle de acesso = token.** O ComfyUI só escuta em 127.0.0.1 dentro do notebook; o
  túnel expõe apenas o proxy, que exige `Authorization: Bearer <token>` e repassa só
  `/upload/image`, `/queue`, `/prompt`, `/history/<id>`, `/view` e o próprio
  `/conveyer/health`. O token fica em `<DATA_DIR>/ltx-session/notebook.json` (0600) e nunca
  vai ao navegador. Endereços aceitos: `https://*.trycloudflare.com` ou ngrok.
- **sol-attn opcional.** O notebook não instala o nó `BlockSparseAttention`. O health
  informa se ele existe; sem ele o Conveyer remove só esse nó e a 2ª etapa roda densa
  (mesma saída esperada, mais lenta).
- Falha no notebook → a cena **pausa** (como sem GPU) e o log do run traz o motivo.
  Resume tenta de novo; a importação manual de MP4 continua disponível.

## Limites conhecidos (não verificados com GPU real)

- **Na T4 só roda o perfil `lite`.** O LTX 22B + Gemma 12B (~37 GB de pesos) não cabe em
  16 GB. No Kaggle, use a T4 (a P100 não foi considerada). O Colab grátis tem ~12 GB de RAM;
  se o ComfyUI cair ao carregar os modelos, é esse o limite.
- **NVFP4 só é nativo em Blackwell** (G4 / RTX PRO 6000). Em A100/H100 o ComfyUI precisa
  desquantizar — deve funcionar mais devagar, mas não foi testado.
- O repositório Hugging Face pode exigir login: coloque `HF_TOKEN` nos *Secrets* do
  Colab/Kaggle ou na célula 1.
- O endereço trycloudflare muda a cada execução da célula 6; conecte de novo no Conveyer.

## Manutenção

O notebook embute cópias de `conveyer_proxy.py` e `models.json`. Depois de mudar qualquer
um dos dois, rode `python3 workers/ltx-notebook/build_notebook.py`;
`notebook-build.test.ts` falha se o `.ipynb` estiver desatualizado.
