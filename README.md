> **Status:** Core workflow fully functional. Prompt Interface operational end-to-end.

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
            │  Workflows (workflows/*.json)
            │
            ├─> flux-translator [MarianMT] (internal, no host port)
            │       Helsinki-NLP/opus-mt-de-en, baked into image
            │       POST /translate — offline, no external API
            │
            └─> Docker Socket Proxy (flux_socket_proxy)
                    │
                    └─> ComfyUI Container [flux_comfyui] (on demand)
                            yanwk/comfyui-boot:cu126-slim-20260914
                            GPU passthrough
                            Port 7643, ComfyUI Web UI + WebSocket
                            /weights (read-only, diffusion checkpoint)
                            /extra_models (read-only, encoders + VAE)
                            /output → flux-manager/outputs/ (read-write)
```

## Prompt Interface (`prompt.html`)

The real differentiator: a browser-native prompt UI that replaces the ComfyUI
node editor for the standard text-to-image workflow. No node wiring, no ComfyUI
knowledge required.

**Key features:**
- **Workflow selector** — picks up any `workflows/*.json` file automatically;
  model names (UNET, CLIP, VAE) are read from the workflow, no hardcoding
- **Dual-prompt input** — separate T5-XXL (sentences) and CLIP-L (keywords) fields,
  matching Flux's actual dual-encoder architecture
- **Offline DE→EN translation** — local MarianMT model, zero latency, no API key,
  no data leaving the machine. Two-step flow: translate → review/edit → confirm generate
- **Real-time progress bar** — live step counter via ComfyUI WebSocket
  (`executing` events: "model loading…" → "generating…" → progress fill)
- **Stop button** — aborts a running generation cleanly via `/interrupt`
- **All KSampler parameters** — steps, CFG, denoise, sampler, scheduler, seed
  (with dice button for random seeds)

Open at: `http://localhost:7644/prompt.html`

**Gallery & parameter recall:**
- Every generated image automatically gets a JSON sidecar in `outputs/json-files/`
  containing the full prompt and all sampler parameters
- Gallery (toggleable below the result) shows all images from `outputs/`; click any
  thumbnail to open the lightbox, click **"Parameter laden"** to restore all settings
- Delete button removes PNG + JSON in one step — no confirmation, images are
  reproducible from their JSON

## Requirements

- CUDA-capable GPU (developed on RTX 4070 Ti Super, 16 GB VRAM)
- Docker with GPU passthrough (`nvidia-container-toolkit`)
- Flux.1-dev Q6_K requires approx. 9–10 GB VRAM

## Supported Model Formats

| Format | Mount path in container | Notes |
|--------|------------------------|-------|
| `.gguf` | `models/unet/<filename>` | Requires ComfyUI-GGUF extension (see below) |
| `.safetensors` | `models/checkpoints/<filename>` | Natively supported |

## Weights Directory

The weights directory lives next to this repository (`../weights/`).
Diffusion checkpoints go in the root; supporting models in subdirectories:

```
weights/
├── my-model-Q6_K.gguf       ← selectable in the manager UI
├── clip/
│   ├── clip_l.safetensors   ← CLIP text encoder (shared across models)
│   └── t5xxl_fp16.safetensors  ← T5-XXL text encoder (runs on CPU/RAM)
├── vae/
│   └── ae.safetensors       ← VAE decoder
├── loras/
└── upscale_models/
```

Files in subdirectories are invisible to the checkpoint dropdown but are
automatically discovered by ComfyUI via `extra_model_paths.yaml`.

For Flux.1-dev, download the three supporting files from
[black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev)
on Hugging Face.

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
4. Open **`http://localhost:7644/prompt.html`** — the Prompt Interface is the primary UI
5. Select a workflow, enter your prompt, click **"Generieren →"**

> **Note:** "Open ComfyUI ↗" is still available for advanced workflow editing,
> but day-to-day generation runs entirely through the Prompt Interface.

## Ports

| Port | Service |
|------|---------|
| 7644 | Flux Manager UI + Prompt Interface |
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

## Generated Images

ComfyUI saves generated images to `flux-manager/outputs/` on the host.
The directory is created automatically on first container start.
No `docker cp` or container access needed — files appear directly in the folder.

## Security

- Manager container runs as non-root (uid 1000) with a read-only filesystem
- Weights are always mounted read-only (single checkpoint file + encoder directory)
- Docker access is sandboxed via socket proxy (only container/image operations allowed)
- `EXEC=0` on the socket proxy — GGUF extension is pre-installed via host clone, no exec needed

---

*Built with the assistance of [Claude Code](https://claude.ai/code) (Anthropic).*
