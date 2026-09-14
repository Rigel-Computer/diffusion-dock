import os
import json
import socket
import threading
import docker
import requests
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --- Configuration ---
WEIGHTS_DIR = Path(os.getenv("WEIGHTS_DIR", "/weights"))
CONFIGS_DIR = Path(os.getenv("CONFIGS_DIR", "/app/configs"))
EXTENSIONS_DIR = Path(os.getenv("EXTENSIONS_DIR", "/app/extensions"))
COMFYUI_IMAGE = os.getenv("COMFYUI_IMAGE", "yanwk/comfyui-boot:cu126-slim-20260914")
COMFYUI_PORT = int(os.getenv("COMFYUI_PORT", "7643"))
COMFYUI_CONTAINER = os.getenv("COMFYUI_CONTAINER_NAME", "flux_comfyui")
COMFYUI_NETWORK = os.getenv("COMFYUI_NETWORK", "flux-net")

DEFAULT_CONFIG = {
    "vram_mode": "normalvram",
    "vae_precision": "auto",
    "force_fp16": False,
    "disable_xformers": False,
    "preview_method": "auto",
    "port": 7643,
}

app = FastAPI()

# --- Image Pull State ---
_pull_status: dict = {"pulling": False, "done": False, "error": None, "progress": ""}
_pull_lock = threading.Lock()


def _pull_image_bg() -> None:
    global _pull_status
    try:
        for line in docker_client.api.pull(COMFYUI_IMAGE, stream=True, decode=True):
            with _pull_lock:
                _pull_status["progress"] = line.get("progress") or line.get("status", "")
        with _pull_lock:
            _pull_status = {"pulling": False, "done": True, "error": None, "progress": ""}
    except Exception as exc:
        with _pull_lock:
            _pull_status = {"pulling": False, "done": False, "error": str(exc), "progress": ""}


# --- Docker Client ---
try:
    docker_client = docker.from_env()
    docker_client.ping()
    DOCKER_AVAILABLE = True
except Exception:
    docker_client = None
    DOCKER_AVAILABLE = False

# --- Resolve host paths for Docker-in-Docker ---
# The Docker daemon mounts volumes by host path, not container path.
# We inspect our own container's mount table to find both.
WEIGHTS_HOST_PATH = None
EXTENSIONS_HOST_PATH = None
if DOCKER_AVAILABLE:
    try:
        hostname = socket.gethostname()
        mgr = docker_client.containers.get(hostname)
        for mount in mgr.attrs["Mounts"]:
            if mount["Destination"] == "/weights":
                WEIGHTS_HOST_PATH = mount["Source"]
            elif mount["Destination"] == "/app/extensions":
                EXTENSIONS_HOST_PATH = mount["Source"]
    except Exception:
        pass


# --- Pydantic Models ---
class StartRequest(BaseModel):
    checkpoint_filename: str
    vram_mode: str = "normalvram"
    vae_precision: str = "auto"
    force_fp16: bool = False
    disable_xformers: bool = False
    preview_method: str = "auto"
    port: int = 7650


class ConfigSaveRequest(BaseModel):
    checkpoint_filename: str
    config: dict


# --- Helpers ---
def is_gguf(filename: str) -> bool:
    return filename.lower().endswith(".gguf")


def get_model_mount_path(filename: str) -> str:
    # GGUF diffusion models go to models/unet/ (ComfyUI-GGUF extension expects this)
    if is_gguf(filename):
        return "/root/ComfyUI/models/unet"
    return "/root/ComfyUI/models/checkpoints"


def get_config_path(filename: str) -> Path:
    return CONFIGS_DIR / f"{Path(filename).stem}.json"


def load_config(filename: str) -> dict:
    path = get_config_path(filename)
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()


def get_running_container():
    if not DOCKER_AVAILABLE:
        return None
    try:
        c = docker_client.containers.get(COMFYUI_CONTAINER)
        if c.status == "running":
            return c
    except docker.errors.NotFound:
        pass
    return None


def check_comfyui_api(port: int) -> bool:
    # /system_stats antwortet sobald der Python-Prozess läuft – kein Modell muss geladen sein.
    # /models/checkpoints wäre zu spät: es antwortet erst nach dem ersten Workflow-Run.
    try:
        r = requests.get(
            f"http://host.docker.internal:{port}/system_stats", timeout=3
        )
        return r.status_code == 200
    except Exception:
        return False


def gguf_extension_installed() -> bool:
    return EXTENSIONS_DIR.is_dir() and (EXTENSIONS_DIR / "ComfyUI-GGUF").exists()


# --- API Endpoints ---
@app.get("/api/checkpoints/list")
def list_checkpoints():
    if not WEIGHTS_DIR.exists():
        return {"checkpoints": [], "error": "Weights directory not found"}

    results = []
    for f in sorted(WEIGHTS_DIR.iterdir()):
        if not f.is_file():
            continue
        suffix = f.suffix.lower()
        if suffix not in (".gguf", ".safetensors"):
            continue
        stat = f.stat()
        results.append({
            "filename": f.name,
            "type": "gguf" if suffix == ".gguf" else "safetensors",
            "size_gb": round(stat.st_size / (1024**3), 1),
            "has_config": get_config_path(f.name).exists(),
        })
    return {"checkpoints": results}


@app.get("/api/container/status")
def container_status():
    if not DOCKER_AVAILABLE:
        return {"running": False, "health": "no_docker", "message": "Docker not available"}

    container = get_running_container()
    if not container:
        try:
            c = docker_client.containers.get(COMFYUI_CONTAINER)
            return {
                "running": False,
                "health": "stopped",
                "status": c.status,
                "checkpoint_file": c.labels.get("checkpoint_file", ""),
                "port": int(c.labels.get("port", COMFYUI_PORT)),
                "gguf_extension": gguf_extension_installed(),
            }
        except docker.errors.NotFound:
            return {
                "running": False,
                "health": "stopped",
                "checkpoint_file": "",
                "port": COMFYUI_PORT,
                "gguf_extension": gguf_extension_installed(),
            }

    port = int(container.labels.get("port", COMFYUI_PORT))
    api_ready = check_comfyui_api(port)

    return {
        "running": True,
        "health": "healthy" if api_ready else "starting",
        "api_available": api_ready,
        "checkpoint_file": container.labels.get("checkpoint_file", ""),
        "container_id": container.short_id,
        "port": port,
        "gguf_extension": gguf_extension_installed(),
    }


@app.post("/api/image/pull")
def pull_image():
    if not DOCKER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Docker not available")
    with _pull_lock:
        if _pull_status["pulling"]:
            return {"status": "already_pulling"}
        _pull_status.update({"pulling": True, "done": False, "error": None, "progress": ""})
    threading.Thread(target=_pull_image_bg, daemon=True).start()
    return {"status": "started"}


@app.get("/api/image/status")
def image_status():
    try:
        docker_client.images.get(COMFYUI_IMAGE)
        present = True
    except (docker.errors.ImageNotFound, Exception):
        present = False
    with _pull_lock:
        snap = dict(_pull_status)
    return {"present": present, **snap}


@app.post("/api/container/start")
def start_container(req: StartRequest):
    if not DOCKER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Docker not available")
    if not WEIGHTS_HOST_PATH:
        raise HTTPException(status_code=503, detail="Host-Pfad für /weights nicht aufgelöst")

    try:
        docker_client.images.get(COMFYUI_IMAGE)
    except docker.errors.ImageNotFound:
        raise HTTPException(
            status_code=409,
            detail="Image nicht lokal vorhanden. Bitte zuerst 'Image laden' klicken.",
        )

    if not (WEIGHTS_DIR / req.checkpoint_filename).exists():
        raise HTTPException(status_code=404, detail=f"Checkpoint nicht gefunden: {req.checkpoint_filename}")

    try:
        existing = docker_client.containers.get(COMFYUI_CONTAINER)
        existing.stop(timeout=15)
        existing.remove()
    except docker.errors.NotFound:
        pass

    # yanwk/comfyui-boot ignoriert den Docker-command-Parameter und liest Flags
    # stattdessen aus CLI_ARGS. Das Startup-Script des Images setzt die Flags
    # intern per eval – daher als einzelnen String übergeben, nicht als Liste.
    flags = ["--listen", "0.0.0.0", "--port", str(req.port)]

    if req.vram_mode == "lowvram":
        flags.append("--lowvram")
    elif req.vram_mode == "highvram":
        flags.append("--highvram")

    if req.vae_precision == "fp16":
        flags.append("--fp16-vae")
    elif req.vae_precision == "bf16":
        flags.append("--bf16-vae")
    elif req.vae_precision == "fp32":
        flags.append("--fp32-vae")

    if req.force_fp16:
        flags.append("--force-fp16")
    if req.disable_xformers:
        flags.append("--disable-xformers")
    if req.preview_method != "auto":
        flags.extend(["--preview-method", req.preview_method])

    volumes = {
        WEIGHTS_HOST_PATH: {
            "bind": get_model_mount_path(req.checkpoint_filename),
            "mode": "ro",
        }
    }
    if EXTENSIONS_HOST_PATH:
        volumes[EXTENSIONS_HOST_PATH] = {
            "bind": "/root/ComfyUI/custom_nodes",
            "mode": "rw",
        }

    try:
        container = docker_client.containers.run(
            COMFYUI_IMAGE,
            name=COMFYUI_CONTAINER,
            detach=True,
            environment={"CLI_ARGS": " ".join(flags)},
            device_requests=[
                docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])
            ],
            ports={f"{req.port}/tcp": req.port},
            volumes=volumes,
            labels={
                "checkpoint_file": req.checkpoint_filename,
                "port": str(req.port),
            },
            shm_size="12g",
            network=COMFYUI_NETWORK,
            security_opt=["no-new-privileges:true"],
            cap_drop=["ALL"],  # GPU läuft über DeviceRequest, braucht keine Linux-Capabilities

        )
        return {
            "status": "starting",
            "container_id": container.short_id,
            "message": f"Starte ComfyUI mit {req.checkpoint_filename}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/container/stop")
def stop_container():
    if not DOCKER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Docker not available")
    try:
        container = docker_client.containers.get(COMFYUI_CONTAINER)
        container.stop(timeout=15)
        container.remove()
        return {"status": "stopped", "message": "Container gestoppt"}
    except docker.errors.NotFound:
        return {"status": "stopped", "message": "Kein Container lief"}


@app.get("/api/config/{checkpoint_filename}")
def get_config(checkpoint_filename: str):
    return {"checkpoint_filename": checkpoint_filename, "config": load_config(checkpoint_filename)}


@app.post("/api/config")
def save_config_endpoint(req: ConfigSaveRequest):
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    with open(get_config_path(req.checkpoint_filename), "w") as f:
        json.dump(req.config, f, indent=2)
    return {"success": True}


@app.post("/api/extensions/install-gguf")
def install_gguf_extension():
    if not DOCKER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Docker not available")

    container = get_running_container()
    if not container:
        raise HTTPException(status_code=400, detail="ComfyUI muss laufen für die Installation")

    target = "/root/ComfyUI/custom_nodes/ComfyUI-GGUF"

    result = container.exec_run(
        ["git", "clone", "https://github.com/comfyanonymous/ComfyUI-GGUF", target],
        user="root",
    )
    if result.exit_code != 0 and b"already exists" not in result.output:
        raise HTTPException(status_code=500, detail=result.output.decode(errors="replace"))

    result = container.exec_run(
        ["pip", "install", "-r", f"{target}/requirements.txt"],
        user="root",
    )
    if result.exit_code != 0:
        raise HTTPException(status_code=500, detail=result.output.decode(errors="replace"))

    return {"success": True, "message": "ComfyUI-GGUF installiert. Container neu starten zum Aktivieren."}


# --- Static Files (muss zuletzt stehen) ---
app.mount("/", StaticFiles(directory="static", html=True), name="static")
