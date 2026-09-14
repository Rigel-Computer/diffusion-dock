# Flux / ComfyUI Manager

A lightweight web UI for managing local diffusion model inference via ComfyUI.
Spin up a ComfyUI container on demand, configure it per model, and open the
ComfyUI interface with a single click — without keeping a GPU-hungry process
running in the background when you don't need it.

## Architecture

```
Browser (Port 7644)
    └─> flux-manager [FastAPI] (Port 8000→7644)
            │  Static files (static/)
            │  Per-model configs (configs/)
            │  Extensions (extensions/ → custom_nodes/)
            │
            └─> Docker Socket Proxy (flux_socket_proxy)
                    │
                    └─> ComfyUI Container [flux_comfyui] (on demand)
                            yanwk/comfyui-boot:cu126-slim-20260914
                            GPU passthrough
                            Port 7643, ComfyUI Web UI
                            /weights (read-only, single model file)
```

## Requirements

- CUDA-capable GPU (developed on RTX 4070 Ti Super, 16 GB VRAM)
- Docker with GPU passthrough (`nvidia-container-toolkit`)
- Flux.1-dev Q6_K requires approx. 9–10 GB VRAM

## Supported Model Formats

| Format | Mount path in container | Notes |
|--------|------------------------|-------|
| `.gguf` | `models/unet/<filename>` | Requires ComfyUI-GGUF extension (see below) |
| `.safetensors` | `models/checkpoints/<filename>` | Natively supported |

## Quickstart

```bash
# 1. Pre-install GGUF extension (one-time, on the host)
mkdir -p extensions/ComfyUI-GGUF
git clone https://github.com/city96/ComfyUI-GGUF extensions/ComfyUI-GGUF

# 2. Build and start the manager
docker compose -f docker-compose-flux.yml up -d --build

# 3. Open the management UI
http://localhost:7644
```

## First Run

1. Click **"Image laden"** — downloads the ComfyUI image with a progress bar (one-time, ~13 GB)
2. Select a checkpoint → **Start**
3. Wait for the status indicator to turn green (`ComfyUI ready`)
4. Click **"Open ComfyUI ↗"** → build your workflow in the native ComfyUI UI

## Ports

| Port | Service |
|------|---------|
| 7644 | Flux Manager UI |
| 7643 | ComfyUI (active while container is running) |

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
- Weights volume is always mounted read-only (single file, not directory)
- Docker access is sandboxed via socket proxy (only container/image operations allowed)
- `EXEC=0` on the socket proxy — GGUF extension is pre-installed via host clone, no exec needed

---

*Built with the assistance of [Claude Code](https://claude.ai/code) (Anthropic).*
