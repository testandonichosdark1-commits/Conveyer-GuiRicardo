"""Generates conveyer_ltx_notebook.ipynb from the repo's sources of truth.

The notebook cannot reach this repository, so it carries copies of
conveyer_proxy.py and src/lib/services/ltx/models.json. Building it from those files
(instead of hand-editing the .ipynb) keeps the copies identical; notebook-build.test.ts
fails when the committed notebook is stale.

    python3 workers/ltx-notebook/build_notebook.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
COMFY_COMMIT = "3f767e7f67bc587e88d6de6668eb424f725d4649"  # same pin as workers/ltx-pod/README.md


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(keepends=True)}


def build():
    with open(os.path.join(ROOT, "src/lib/services/ltx/models.json")) as fh:
        models = json.load(fh)
    with open(os.path.join(ROOT, "src/lib/services/ltx/models-lite.json")) as fh:
        models_lite = json.load(fh)
    # One shape for both: every file carries its own repo/revision/file-in-repo.
    full = {"profile": "full", "files": [dict(item, repo=models["repo"], revision=models["revision"], file=item["path"])
                                          for item in models["files"]]}
    with open(os.path.join(HERE, "conveyer_proxy.py")) as fh:
        proxy = fh.read()

    cells = [
        md("""
# Conveyer · GPU LTX no Colab / Kaggle

Este notebook transforma a GPU do Colab (ou Kaggle) no gerador de clipes LTX do Conveyer.
Ele escolhe o perfil pela VRAM:

| GPU | perfil | modelo | saída |
|---|---|---|---|
| ≥ 40 GB (A100, H100, G4) | **full** | LTX 22B (o mesmo do Runpod), ~37 GB de pesos | 1080p nativo |
| 16 GB (**T4 grátis** do Colab/Kaggle) | **lite** | LTX-Video 2B distilled, ~11,5 GB de pesos | 832×480, ampliado para 1080p |

1. **Ambiente de execução → Alterar tipo → GPUs: T4** (ou melhor, se tiver). No Kaggle: *Settings → Accelerator → GPU T4* e **Internet ligada**.
2. Rode as células **em ordem**. A primeira execução baixa os modelos (perfil lite: ~5–10 min).
3. A célula 6 mostra um **endereço https** e um **token**. Cole os dois no Conveyer em
   `/tools/ltx-scene-test` → *GPU do Colab ou Kaggle* → **Conectar notebook**.
4. Deixe esta aba aberta enquanto o Conveyer gera. Para encerrar, *Ambiente → Desconectar e excluir*.

O ComfyUI escuta só dentro do notebook (127.0.0.1). O túnel expõe apenas um proxy que exige o token
e repassa somente as rotas que o Conveyer usa.
"""),
        code("""
# 1 · Configuração e checagem da GPU
import os, shutil, subprocess, sys, json, secrets, time, re, hashlib
HF_TOKEN = ""          # opcional: token do Hugging Face, se o download pedir login
VERIFY_SHA256 = True   # confere os hashes dos arquivos baixados; desligue só se já conferiu
PROFILE = ""           # vazio = automático pela VRAM; "lite" força o modelo pequeno

ON_KAGGLE = os.path.exists("/kaggle")
WORK = "/tmp/conveyer" if ON_KAGGLE else "/content/conveyer"
os.makedirs(WORK, exist_ok=True)
COMFY_DIR = f"{WORK}/ComfyUI"
if not HF_TOKEN:
    try:
        if ON_KAGGLE:
            from kaggle_secrets import UserSecretsClient
            HF_TOKEN = UserSecretsClient().get_secret("HF_TOKEN")
        else:
            from google.colab import userdata
            HF_TOKEN = userdata.get("HF_TOKEN")
    except Exception:
        HF_TOKEN = ""

smi = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                     capture_output=True, text=True)
if smi.returncode != 0:
    raise SystemExit("Nenhuma GPU encontrada. Ative uma GPU (T4) no tipo de ambiente e rode de novo.")
gpu_name, vram_mb = [x.strip() for x in smi.stdout.strip().splitlines()[0].split(",")]
vram_gb = int(vram_mb) / 1024
if not PROFILE:
    PROFILE = "full" if vram_gb >= 40 else "lite"
if vram_gb < 14:
    raise SystemExit(f"{gpu_name} tem só {vram_gb:.0f} GB de VRAM; o perfil lite precisa de uma T4 (16 GB) ou maior.")
need_gb = 45 if PROFILE == "full" else 16
free_gb = shutil.disk_usage(WORK).free / 1024**3
print(f"GPU: {gpu_name} · {vram_gb:.0f} GB VRAM · perfil: {PROFILE} · disco livre: {free_gb:.0f} GB")
if free_gb < need_gb:
    raise SystemExit(f"Espaço em disco insuficiente: o perfil {PROFILE} precisa de ~{need_gb} GB livres.")
"""),
        code(f"""
# 2 · ComfyUI fixado no commit validado
COMFY_COMMIT = "{COMFY_COMMIT}"
if not os.path.isdir(f"{{COMFY_DIR}}/.git"):
    subprocess.run(["git", "clone", "https://github.com/comfyanonymous/ComfyUI.git", COMFY_DIR], check=True)
subprocess.run(["git", "-C", COMFY_DIR, "fetch", "--quiet", "origin", COMFY_COMMIT], check=False)
subprocess.run(["git", "-C", COMFY_DIR, "checkout", "--quiet", COMFY_COMMIT], check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-r", f"{{COMFY_DIR}}/requirements.txt",
                "huggingface_hub", "aiohttp"], check=True)
print("ComfyUI pronto em", COMFY_DIR)
"""),
        code(f"""
# 3 · Modelos (cópias de src/lib/services/ltx/models.json e models-lite.json)
ALL_MODELS = json.loads(r'''{json.dumps({"full": full, "lite": models_lite}, indent=1)}''')
MODELS = ALL_MODELS[PROFILE]
MODELS_JSON = f"{{WORK}}/models.json"
with open(MODELS_JSON, "w") as fh:
    json.dump(MODELS, fh)
from huggingface_hub import hf_hub_download
models_dir = f"{{COMFY_DIR}}/models"
for item in MODELS["files"]:
    target = f"{{models_dir}}/{{item['path']}}"
    marker = target + ".conveyer-sha256-ok"
    if os.path.isfile(marker) and os.path.getsize(target) == item["bytes"]:
        print("ok (já conferido):", item["path"]); continue
    if not (os.path.isfile(target) and os.path.getsize(target) == item["bytes"]):
        print("baixando:", item["path"], f"({{item['bytes'] / 1024**3:.1f}} GB)")
        staging = f"{{WORK}}/hf/{{item['repo'].replace('/', '__')}}"
        downloaded = hf_hub_download(item["repo"], item["file"], revision=item["revision"], local_dir=staging,
                                     token=HF_TOKEN or None)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.replace(downloaded, target)
    if os.path.getsize(target) != item["bytes"]:
        raise SystemExit(f"Tamanho inesperado em {{item['path']}}")
    if VERIFY_SHA256:
        digest = hashlib.sha256()
        with open(target, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 24), b""):
                digest.update(block)
        if digest.hexdigest() != item["sha256"]:
            os.remove(target)
            raise SystemExit(f"SHA-256 diferente em {{item['path']}} — arquivo removido; rode a célula de novo.")
    open(marker, "w").close()
    print("ok:", item["path"])
"""),
        code("""
# 4 · Inicia o ComfyUI (só em 127.0.0.1)
import urllib.request
comfy_log = open(f"{WORK}/comfyui.log", "a")
# Na T4 (16 GB) os pesos não ficam todos na VRAM ao mesmo tempo: --lowvram deixa o ComfyUI alternar.
comfy_args = ["--listen", "127.0.0.1", "--port", "8188"] + (["--lowvram"] if PROFILE == "lite" else [])
comfy = subprocess.Popen([sys.executable, "main.py", *comfy_args],
                         cwd=COMFY_DIR, stdout=comfy_log, stderr=subprocess.STDOUT)
for _ in range(180):
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2); break
    except Exception:
        if comfy.poll() is not None:
            raise SystemExit("O ComfyUI encerrou. Veja " + f"{WORK}/comfyui.log")
        time.sleep(2)
else:
    raise SystemExit("O ComfyUI não respondeu em 6 minutos. Veja " + f"{WORK}/comfyui.log")
print("ComfyUI no ar.")
"""),
        code(f"""
# 5 · Proxy com token (cópia de workers/ltx-notebook/conveyer_proxy.py)
PROXY_SOURCE = r'''{proxy}'''
with open(f"{{WORK}}/conveyer_proxy.py", "w") as fh:
    fh.write(PROXY_SOURCE)
CONVEYER_TOKEN = secrets.token_urlsafe(32)
proxy_env = dict(os.environ, CONVEYER_TOKEN=CONVEYER_TOKEN, CONVEYER_PROFILE=PROFILE, MODELS_DIR=f"{{COMFY_DIR}}/models",
                 MODELS_JSON=MODELS_JSON, PROXY_PORT="8189")
proxy = subprocess.Popen([sys.executable, f"{{WORK}}/conveyer_proxy.py"], env=proxy_env,
                         stdout=open(f"{{WORK}}/proxy.log", "a"), stderr=subprocess.STDOUT)
time.sleep(3)
if proxy.poll() is not None:
    raise SystemExit("O proxy encerrou. Veja " + f"{{WORK}}/proxy.log")
print("Proxy no ar em 127.0.0.1:8189")
"""),
        code("""
# 6 · Túnel Cloudflare (gratuito, sem conta) → mostra endereço e token
cf = f"{WORK}/cloudflared"
if not os.path.exists(cf):
    subprocess.run(["wget", "-q", "-O", cf,
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"], check=True)
    os.chmod(cf, 0o755)
tunnel_log = f"{WORK}/tunnel.log"
tunnel = subprocess.Popen([cf, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8189"],
                          stdout=open(tunnel_log, "w"), stderr=subprocess.STDOUT)
TUNNEL_URL = None
for _ in range(60):
    found = re.findall(r"https://[a-z0-9-]+\\.trycloudflare\\.com", open(tunnel_log).read())
    if found:
        TUNNEL_URL = found[0]; break
    time.sleep(1)
if not TUNNEL_URL:
    raise SystemExit("O túnel não informou endereço. Veja " + tunnel_log)
print("\\nCole no Conveyer (/tools/ltx-scene-test → GPU do Colab ou Kaggle):\\n")
print("  Endereço:", TUNNEL_URL)
print("  Token:   ", CONVEYER_TOKEN)
print("\\nO token muda a cada execução desta célula 5.")
"""),
        code("""
# 7 · Acompanhar (opcional): mostra o fim do log do ComfyUI a cada 30 s. Interrompa quando quiser.
while True:
    for name, proc in (("ComfyUI", comfy), ("proxy", proxy), ("túnel", tunnel)):
        if proc.poll() is not None:
            print(f"ATENÇÃO: {name} parou (código {proc.returncode}). Rode de novo as células 4–6.")
    print("".join(open(f"{WORK}/comfyui.log").readlines()[-8:]))
    time.sleep(30)
"""),
    ]
    notebook = {
        "cells": cells,
        "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                     "kernelspec": {"name": "python3", "display_name": "Python 3"},
                     "language_info": {"name": "python"}},
        "nbformat": 4, "nbformat_minor": 0,
    }
    out = os.path.join(HERE, "conveyer_ltx_notebook.ipynb")
    with open(out, "w") as fh:
        json.dump(notebook, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    return out


if __name__ == "__main__":
    print(build())
