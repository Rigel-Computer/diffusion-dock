> **⚠ Work in Progress** — funktionsfähig, aber nicht vollständig.
> Grundbetrieb (ComfyUI starten/stoppen, GGUF-Modelle laden) funktioniert.
> Text-Encoder und VAE müssen manuell bereitgestellt werden (siehe [Weights-Verzeichnis](#weights-verzeichnis)).

# Flux / ComfyUI Manager

Lokales Management-UI für ComfyUI auf einer RTX 4070 Ti Super.
Analog zum [LLM-Manager](../README.md) – gleiche Architektur, gleicher Glacier-Look,
aber für Bildgenerierung mit Flux und anderen Diffusionsmodellen.

## Architektur

```
Browser (Port 7644)
    └─> flux-manager [FastAPI] (Port 8000→7644)
            │  Statische Files (static/)
            │  Per-Modell-Configs (configs/)
            │  Extensions (extensions/ → custom_nodes/)
            │
            └─> Docker Socket Proxy (flux_socket_proxy)
                    │
                    └─> ComfyUI Container [flux_comfyui] (on demand)
                            yanwk/comfyui-boot:cu126-slim-20260914
                            GPU passthrough
                            Port 7643, ComfyUI-Web-UI
                            /weights (read-only, Diffusions-Checkpoint)
                            /extra_models (read-only, Encoder + VAE)
                            /output → flux-manager/outputs/ (read-write)
```

## Hardware-Voraussetzungen

- GPU mit CUDA-Support (getestet: RTX 4070 Ti Super, 16 GB VRAM)
- Docker mit GPU-Passthrough (`nvidia-container-toolkit`)
- Flux.1-dev Q6_K benötigt ca. 9–10 GB VRAM

## Unterstützte Modell-Formate

| Format | Mount-Pfad im Container | Hinweis |
|--------|------------------------|---------|
| `.gguf` | `models/unet/<dateiname>` | Erfordert ComfyUI-GGUF Extension (siehe unten) |
| `.safetensors` | `models/checkpoints/<dateiname>` | Nativ unterstützt |

## Weights-Verzeichnis

Das weights-Verzeichnis liegt neben diesem Repo (`../weights/`).
Diffusions-Checkpoints kommen direkt ins Root, unterstützende Modelle in Unterordner:

```
weights/
├── mein-modell-Q6_K.gguf        ← erscheint im Dropdown des Managers
├── clip/
│   ├── clip_l.safetensors       ← CLIP Text-Encoder (modellübergreifend nutzbar)
│   └── t5xxl_fp16.safetensors   ← T5-XXL Text-Encoder (läuft auf CPU/RAM)
├── vae/
│   └── ae.safetensors           ← VAE-Decoder
├── loras/
└── upscale_models/
```

Dateien in Unterordnern erscheinen nicht im Checkpoint-Dropdown, werden aber von
ComfyUI automatisch über `extra_model_paths.yaml` gefunden.

Für Flux.1-dev die drei unterstützenden Dateien von
[black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev)
auf Hugging Face herunterladen.

## Quickstart

```bash
# 1. GGUF Extension vorinstallieren (einmalig, auf dem Host)
mkdir -p extensions/ComfyUI-GGUF
git clone https://github.com/city96/ComfyUI-GGUF extensions/ComfyUI-GGUF

# 2. Manager bauen und starten
docker compose -f docker-compose-flux.yml up -d --build

# 3. Management-UI öffnen
http://localhost:7644
```

## Erster Start

1. **„Image laden"** klicken — lädt das ComfyUI-Image mit Ladebalken (einmalig, ~13 GB)
2. Checkpoint auswählen → **Start**
3. Warten bis Status grün (`ComfyUI bereit`)
4. **„ComfyUI öffnen ↗"** → Workflow im ComfyUI-UI bauen

## Ports

| Port | Dienst |
|------|--------|
| 7644 | Flux Manager UI |
| 7643 | ComfyUI (aktiv wenn Container läuft) |

## Konfiguration pro Modell

Configs werden als JSON in `configs/` gespeichert:

| Parameter | Bedeutung |
|-----------|-----------|
| `vram_mode` | `lowvram` / `normalvram` / `highvram` |
| `vae_precision` | `auto` / `fp16` / `bf16` / `fp32` |
| `force_fp16` | ~20% VRAM sparen |
| `disable_xformers` | Fallback auf PyTorch Attention |
| `preview_method` | `auto` / `latent2rgb` / `none` |

## Generierte Bilder

ComfyUI speichert generierte Bilder in `flux-manager/outputs/` auf dem Host.
Das Verzeichnis wird beim ersten Container-Start automatisch angelegt.
Kein `docker cp` oder Container-Zugriff nötig — Dateien erscheinen direkt im Ordner.

## Sicherheit

- Manager-Container läuft als non-root (uid 1000), read-only Filesystem
- Weights immer read-only gemountet (einzelne Checkpoint-Datei + Encoder-Verzeichnis)
- Docker-Zugriff über Socket-Proxy (nur Container/Image-Operationen erlaubt)
- `EXEC=0` am Socket-Proxy — GGUF-Extension per Host-Clone vorinstalliert, kein exec nötig

---

*Erstellt mit Unterstützung von [Claude Code](https://claude.ai/code) (Anthropic).*
