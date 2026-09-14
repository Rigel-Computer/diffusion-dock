let selectedCheckpoint = null;
let pollTimer = null;
let imagePollTimer = null;
let isContainerRunning = false;
let imagePresent = false;
let currentPort = 7643;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
    loadCheckpoints();
    pollStatus();
    startPolling(5000);
    pollImageStatus();

    document.getElementById('startBtn').addEventListener('click', startContainer);
    document.getElementById('stopBtn').addEventListener('click', stopContainer);
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    document.getElementById('installGgufBtn').addEventListener('click', installGgufExtension);
    document.getElementById('pullImageBtn').addEventListener('click', loadImage);
});

// --- Checkpoints ---
async function loadCheckpoints() {
    try {
        const r = await fetch('/api/checkpoints/list');
        const data = await r.json();
        renderCheckpoints(data.checkpoints);
    } catch (e) {
        document.getElementById('checkpointsList').innerHTML = '<p class="muted">Fehler beim Laden</p>';
    }
}

function renderCheckpoints(checkpoints) {
    const list = document.getElementById('checkpointsList');
    if (!checkpoints.length) {
        list.innerHTML = '<p class="muted">Keine .gguf / .safetensors Dateien in /weights gefunden</p>';
        return;
    }
    list.innerHTML = '';
    checkpoints.forEach(c => {
        const item = document.createElement('div');
        item.className = 'weight-item';
        const typeClass = c.type === 'gguf' ? 'badge-gguf' : 'badge-safe';
        item.innerHTML = `
            <input type="radio" name="checkpoint" value="${c.filename}">
            <span class="weight-name">${c.filename}</span>
            <span class="weight-config-badge ${typeClass}">${c.type.toUpperCase()}</span>
            ${c.has_config ? '<span class="weight-config-badge">CFG</span>' : ''}
            <span class="weight-size">${c.size_gb} GB</span>
        `;
        item.addEventListener('click', () => selectCheckpoint(c.filename, item));
        list.appendChild(item);
    });
}

async function selectCheckpoint(filename, element) {
    selectedCheckpoint = filename;

    document.querySelectorAll('.weight-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    element.querySelector('input[type="radio"]').checked = true;

    document.getElementById('configSection').style.display = '';
    document.getElementById('infoSection').style.display = '';
    document.getElementById('ggufSection').style.display = '';
    document.getElementById('configModelName').textContent = filename;
    document.getElementById('startBtn').disabled = isContainerRunning || !imagePresent;
    document.getElementById('saveConfigBtn').disabled = false;

    try {
        const r = await fetch(`/api/config/${encodeURIComponent(filename)}`);
        const data = await r.json();
        fillConfig(data.config);
    } catch (e) {}
}

function fillConfig(cfg) {
    document.getElementById('vramMode').value = cfg.vram_mode ?? 'normalvram';
    document.getElementById('vaePrecision').value = cfg.vae_precision ?? 'auto';
    document.getElementById('previewMethod').value = cfg.preview_method ?? 'auto';
    document.getElementById('forceFp16').checked = cfg.force_fp16 ?? false;
    document.getElementById('disableXformers').checked = cfg.disable_xformers ?? false;
}

function getConfig() {
    return {
        vram_mode: document.getElementById('vramMode').value,
        vae_precision: document.getElementById('vaePrecision').value,
        preview_method: document.getElementById('previewMethod').value,
        force_fp16: document.getElementById('forceFp16').checked,
        disable_xformers: document.getElementById('disableXformers').checked,
        port: currentPort,
    };
}

// --- Container Control ---
async function startContainer() {
    if (!selectedCheckpoint) return;
    const btn = document.getElementById('startBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const config = getConfig();
        const r = await fetch('/api/container/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkpoint_filename: selectedCheckpoint, ...config }),
        });
        const data = await r.json();
        if (r.ok) {
            showToast(data.message, 'success');
            startPolling(2000);
        } else {
            showToast(data.detail || 'Start fehlgeschlagen', 'error');
        }
    } catch (e) {
        showToast('Verbindungsfehler', 'error');
    }
    btn.textContent = 'Start';
}

async function stopContainer() {
    const btn = document.getElementById('stopBtn');
    btn.disabled = true;
    btn.textContent = 'Stopping...';
    try {
        const r = await fetch('/api/container/stop', { method: 'POST' });
        const data = await r.json();
        showToast(data.message, 'success');
    } catch (e) {
        showToast('Stop fehlgeschlagen', 'error');
    }
    btn.textContent = 'Stop';
    pollStatus();
}

async function installGgufExtension() {
    const btn = document.getElementById('installGgufBtn');
    btn.disabled = true;
    btn.textContent = 'Installiere...';
    try {
        const r = await fetch('/api/extensions/install-gguf', { method: 'POST' });
        const data = await r.json();
        if (r.ok) {
            showToast(data.message, 'success');
        } else {
            showToast(data.detail || 'Installation fehlgeschlagen', 'error');
        }
    } catch (e) {
        showToast('Verbindungsfehler', 'error');
    }
    btn.textContent = 'GGUF Extension installieren';
    pollStatus();
}

// --- Status Polling ---
function startPolling(interval) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, interval);
}

async function pollStatus() {
    try {
        const r = await fetch('/api/container/status');
        const data = await r.json();
        updateStatus(data);
        const badge = document.getElementById('dockerStatus');
        badge.textContent = 'Docker: OK';
        badge.className = 'docker-badge ok';
    } catch (e) {
        const badge = document.getElementById('dockerStatus');
        badge.textContent = 'Docker: Error';
        badge.className = 'docker-badge err';
    }
}

function updateStatus(data) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const checkpoint = document.getElementById('statusCheckpoint');
    const api = document.getElementById('statusApi');
    const openBtn = document.getElementById('openComfyBtn');
    const installBtn = document.getElementById('installGgufBtn');
    const ggufStatus = document.getElementById('ggufStatus');

    const wasStarting = dot.classList.contains('starting');
    dot.className = 'status-dot ' + (data.health || 'stopped');

    if (data.port) currentPort = data.port;

    if (data.health === 'healthy') {
        text.textContent = 'Running';
        api.textContent = 'ComfyUI bereit';
        api.className = 'status-api ready';
        isContainerRunning = true;
        openBtn.href = `http://localhost:${data.port || 7650}`;
        openBtn.style.pointerEvents = '';
        openBtn.style.opacity = '';
        installBtn.disabled = false;
        if (wasStarting) startPolling(30000);
    } else if (data.health === 'starting') {
        text.textContent = 'Starting...';
        api.textContent = 'Warte auf ComfyUI';
        api.className = 'status-api waiting';
        isContainerRunning = true;
        openBtn.style.pointerEvents = 'none';
        openBtn.style.opacity = '0.4';
        installBtn.disabled = true;
    } else {
        text.textContent = 'Stopped';
        api.textContent = '';
        api.className = 'status-api';
        isContainerRunning = false;
        openBtn.style.pointerEvents = 'none';
        openBtn.style.opacity = '0.4';
        installBtn.disabled = true;
        if (wasStarting) startPolling(5000);
    }

    checkpoint.textContent = data.checkpoint_file || '';

    if (ggufStatus) {
        if (data.gguf_extension) {
            ggufStatus.textContent = '✓ Installiert';
            ggufStatus.style.color = 'var(--success)';
        } else {
            ggufStatus.textContent = '✗ Nicht installiert';
            ggufStatus.style.color = 'var(--danger)';
        }
    }

    document.getElementById('startBtn').disabled = !selectedCheckpoint || isContainerRunning || !imagePresent;
    document.getElementById('stopBtn').disabled = !isContainerRunning;
}

// --- Image Pull ---
async function pollImageStatus() {
    try {
        const r = await fetch('/api/image/status');
        const data = await r.json();
        updateImageUI(data);
        if (data.pulling) {
            if (!imagePollTimer) imagePollTimer = setInterval(pollImageStatus, 2000);
        } else {
            if (imagePollTimer) { clearInterval(imagePollTimer); imagePollTimer = null; }
        }
    } catch (e) {}
}

function updateImageUI(data) {
    const statusText = document.getElementById('imageStatusText');
    const pullBtn    = document.getElementById('pullImageBtn');
    const progressWrap = document.getElementById('pullProgressWrap');
    const bar        = document.getElementById('pullProgressBar');
    const progText   = document.getElementById('pullProgressText');

    imagePresent = data.present;

    if (data.pulling) {
        statusText.textContent = 'Lade Image…';
        statusText.style.color = 'var(--warning)';
        pullBtn.style.display = 'none';
        progressWrap.style.display = '';
        bar.className = 'progress-bar-fill indeterminate';
        progText.textContent = data.progress || '';
    } else if (data.present) {
        statusText.textContent = '✓ Image vorhanden';
        statusText.style.color = 'var(--success)';
        pullBtn.style.display = 'none';
        progressWrap.style.display = 'none';
        bar.className = 'progress-bar-fill';
        bar.style.width = '100%';
    } else if (data.error) {
        statusText.textContent = 'Fehler: ' + data.error;
        statusText.style.color = 'var(--danger)';
        pullBtn.style.display = '';
        pullBtn.textContent = 'Erneut versuchen';
        progressWrap.style.display = 'none';
    } else {
        statusText.textContent = '✗ Image nicht lokal vorhanden';
        statusText.style.color = 'var(--danger)';
        pullBtn.style.display = '';
        pullBtn.textContent = 'Image laden';
        progressWrap.style.display = 'none';
    }

    document.getElementById('startBtn').disabled = !selectedCheckpoint || isContainerRunning || !imagePresent;
}

async function loadImage() {
    const pullBtn = document.getElementById('pullImageBtn');
    pullBtn.disabled = true;
    try {
        await fetch('/api/image/pull', { method: 'POST' });
        if (!imagePollTimer) imagePollTimer = setInterval(pollImageStatus, 2000);
        pollImageStatus();
    } catch (e) {
        showToast('Verbindungsfehler', 'error');
    }
    pullBtn.disabled = false;
}

// --- Config Save ---
async function saveConfig() {
    if (!selectedCheckpoint) return;
    try {
        const r = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkpoint_filename: selectedCheckpoint, config: getConfig() }),
        });
        if (r.ok) {
            showToast('Config gespeichert', 'success');
            loadCheckpoints();
        } else {
            showToast('Speichern fehlgeschlagen', 'error');
        }
    } catch (e) {
        showToast('Speichern fehlgeschlagen', 'error');
    }
}

// --- Toast ---
function showToast(msg, type) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast ' + (type || '');
    setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}
