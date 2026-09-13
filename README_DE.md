# Flux / ComfyUI Manager

> **Work in progress** — not yet tested end-to-end. Use at your own risk.

Lokales Management-UI für ComfyUI auf einer RTX 4070 Ti Super.
Analog zum [LLM-Manager](../README.md) – gleiche Architektur, gleicher Glacier-Look,
aber für Bildgenerierung mit Flux und anderen Diffusionsmodellen.

## Architektur

```
Browser (Port 7651)
    └─> flux-manager [FastAPI] (Port 8000→7651)
            │  Statische Files (static/)
            │  Per-Modell-Configs (configs/)
            │
            └─> Docker Socket Proxy (flux_socket_proxy)
                    │
                    └─> ComfyUI Container [flux_comfyui] (on demand)
                            yanwk/comfyui-boot:cu124
                            GPU passthrough
                            Port 7650, ComfyUI-Web-UI
                            /weights (read-only, GGUF + Safetensors)
```

## Hardware-Voraussetzungen

- GPU mit CUDA-Support (getestet: RTX 4070 Ti Super, 16 GB VRAM)
- Docker mit GPU-Passthrough (`nvidia-container-toolkit`)
- Flux.1-dev Q6_K benötigt ca. 9–10 GB VRAM

## Unterstützte Modell-Formate

| Format | Mount-Pfad im Container | Hinweis |
|--------|------------------------|---------|
| `.gguf` | `models/unet/` | Erfordert ComfyUI-GGUF Extension |
| `.safetensors` | `models/checkpoints/` | Nativ unterstützt |

## Quickstart

```bash
# Manager bauen und starten
docker compose -f docker-compose-flux.yml up -d --build

# Management-UI
http://localhost:7651

# ComfyUI (nach Start über das UI)
http://localhost:7650
```

## Erster GGUF-Workflow

1. Management-UI öffnen → GGUF-Modell auswählen → Start
2. Warten bis Status grün (`ComfyUI bereit`)
3. „GGUF Extension installieren" klicken (einmalig, danach persistiert)
4. Container neu starten (Stop → Start)
5. „ComfyUI öffnen ↗" → Workflow im ComfyUI-UI bauen

## Ports

| Port | Dienst |
|------|--------|
| 7651 | Flux Manager UI |
| 7650 | ComfyUI (aktiv wenn Container läuft) |

## Konfiguration pro Modell

Configs werden als JSON in `configs/` gespeichert:

| Parameter | Bedeutung |
|-----------|-----------|
| `vram_mode` | `lowvram` / `normalvram` / `highvram` |
| `vae_precision` | `auto` / `fp16` / `bf16` / `fp32` |
| `force_fp16` | ~20% VRAM sparen |
| `disable_xformers` | Fallback auf PyTorch Attention |
| `preview_method` | `auto` / `latent2rgb` / `none` |

## Sicherheit

- Manager-Container läuft als non-root (uid 1000), read-only Filesystem
- Weights-Volume immer read-only gemountet
- Docker-Zugriff über Socket-Proxy (nur Container/Image-Operationen erlaubt)
- `EXEC=1` am Socket-Proxy kann nach der GGUF-Extension-Installation auf `0` gesetzt werden

---

*Erstellt mit Unterstützung von [Claude Code](https://claude.ai/code) (Anthropic).*
