# Flux / ComfyUI Manager

> **Work in progress** — not yet tested end-to-end. Use at your own risk.

A lightweight web UI for managing local diffusion model inference via ComfyUI.
Spin up a ComfyUI container on demand, configure it per model, and open the
ComfyUI interface with a single click — without keeping a GPU-hungry process
running in the background when you don't need it.

## Architecture

```
Browser (Port 7651)
    └─> flux-manager [FastAPI] (Port 8000→7651)
            │  Static files (static/)
            │  Per-model configs (configs/)
            │
            └─> Docker Socket Proxy (flux_socket_proxy)
                    │
                    └─> ComfyUI Container [flux_comfyui] (on demand)
                            yanwk/comfyui-boot:cu124
                            GPU passthrough
                            Port 7650, ComfyUI Web UI
                            /weights (read-only, GGUF + Safetensors)
```

## Requirements

- CUDA-capable GPU (developed on RTX 4070 Ti Super, 16 GB VRAM)
- Docker with GPU passthrough (`nvidia-container-toolkit`)
- Flux.1-dev Q6_K requires approx. 9–10 GB VRAM

## Supported Model Formats

| Format | Mount path in container | Notes |
|--------|------------------------|-------|
| `.gguf` | `models/unet/` | Requires ComfyUI-GGUF extension |
| `.safetensors` | `models/checkpoints/` | Natively supported |

## Quickstart

```bash
# Build and start the manager
docker compose -f docker-compose-flux.yml up -d --build

# Management UI
http://localhost:7651

# ComfyUI (once started via the UI)
http://localhost:7650
```

## First GGUF Workflow

1. Open the management UI → select a GGUF model → Start
2. Wait for the status indicator to turn green (`ComfyUI ready`)
3. Click "Install GGUF Extension" (one-time, persists in `extensions/`)
4. Restart the container (Stop → Start)
5. Click "Open ComfyUI ↗" → build your workflow in the native ComfyUI UI

## Ports

| Port | Service |
|------|---------|
| 7651 | Flux Manager UI |
| 7650 | ComfyUI (active while container is running) |

## Per-Model Configuration

Configs are saved as JSON files in `configs/`:

| Parameter | Description |
|-----------|-------------|
| `vram_mode` | `lowvram` / `normalvram` / `highvram` |
| `vae_precision` | `auto` / `fp16` / `bf16` / `fp32` |
| `force_fp16` | Saves ~20% VRAM |
| `disable_xformers` | Fall back to PyTorch attention |
| `preview_method` | `auto` / `latent2rgb` / `none` |

## Security

- Manager container runs as non-root (uid 1000) with a read-only filesystem
- Weights volume is always mounted read-only
- Docker access is sandboxed via socket proxy (only container/image operations allowed)
- `EXEC=1` on the socket proxy can be set to `0` after the GGUF extension is installed

---

*Built with the assistance of [Claude Code](https://claude.ai/code) (Anthropic).*
