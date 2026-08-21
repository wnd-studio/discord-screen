/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError } from '/shared/broadcaster.js?v=5';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

let broadcaster = null;
let audioWasDetected = false;
let connectionState = 'idle';

function browserGuidance() {
  const ua = navigator.userAgent;
  if (/Firefox/i.test(ua)) {
    return 'No Firefox, você pode assistir normalmente, mas a transmissão com áudio e WebCodecs é limitada. Para transmitir, use Chrome ou Edge atualizado.';
  }
  if (/Edg\//i.test(ua)) {
    return 'No Edge, prefira “Aba” para áudio mais confiável. Algumas janelas compatíveis também exibem a opção “Compartilhar áudio”.';
  }
  if (/Chrome|Chromium|OPR|Brave/i.test(ua)) {
    return 'No Chrome, marque “Compartilhar áudio”. Aba é a opção mais confiável; algumas janelas compatíveis também oferecem áudio isolado.';
  }
  return 'A captura de áudio depende do navegador. Para maior compatibilidade, use Chrome ou Edge atualizado.';
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function fail(title, msg) {
  $('roomLine').textContent = title;
  $('setup').hidden = true;
  setStatus(msg, 'error');
}

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  fail('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  fail('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  fail('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  $('browserNote').textContent = browserGuidance();
  applyPresets();
  $('start').addEventListener('click', start);
  $('goLive').addEventListener('click', goLive);
  $('chooseAgain').addEventListener('click', chooseAgain);
  $('stop').addEventListener('click', () => broadcaster?.stop('Transmissão encerrada.'));
}

$('withCamera').addEventListener('change', () => {
  $('cameraOptions').hidden = !$('withCamera').checked;
});

/**
 * Aplica as opções escolhidas no modal da Activity, que chegam pela URL.
 *
 * Com elas definidas, os seletores saem de cena: repetir a mesma escolha aqui
 * só confundiria. Sem elas, a página segue mostrando os controles.
 */
function applyPresets() {
  const q = query.get('q');
  const fps = query.get('fps');
  const som = query.get('som');
  const cam = query.get('cam');
  const camPos = query.get('camPos');
  const camSize = query.get('camSize');

  // A opção de som veio decidida da atividade, então a caixa some junto com os
  // seletores — repetir a mesma escolha aqui só confundiria.
  if (som !== null) {
    $('withAudio').checked = som === '1';
    document.querySelector('.check').hidden = true;
  }
  if (cam !== null) {
    $('withCamera').checked = cam === '1';
    $('withCamera').closest('.check').hidden = true;
  }
  $('cameraOptions').hidden = !$('withCamera').checked;
  if (camPos) $('cameraPosition').value = camPos;
  if (camSize) $('cameraSize').value = camSize;

  if (!q && !fps) return;

  if (q) $('quality').value = q;
  if (fps) $('fps').value = fps;

  for (const row of document.querySelectorAll('#setup .row')) row.hidden = true;

  const mbps = (Number($('quality').value) / 1e6).toFixed(1).replace('.', ',');
  const comSom = $('withAudio').checked ? ' · com som' : '';
  const comCamera = $('withCamera').checked ? ' · com câmera' : '';
  $('presetLine').textContent = `${mbps} Mb/s · ${$('fps').value} fps${comSom}${comCamera}`;
  $('presetLine').hidden = false;
}

// -------------------------------------------------------------------- ações

async function start() {
  $('start').disabled = true;
  setStatus('Aguardando você escolher a tela…');
  audioWasDetected = false;
  broadcaster = buildBroadcaster();

  try {
    const prepared = await broadcaster.prepare();
    $('testPreview').srcObject = prepared.stream;
    $('testPreview').play().catch(() => {});
    $('setup').hidden = true;
    $('previewStep').hidden = false;
    $('previewStep').insertBefore($('cameraOptions'), document.querySelector('.preview-actions'));
    if (!$('withAudio').checked) setAudioTest(0, 'Áudio não solicitado', 'Volte e marque “Incluir áudio” se quiser transmitir som.');
    else if (!prepared.hasAudio) setAudioTest(0, 'Nenhum áudio encontrado', audioMissingHelp(prepared.surface));
    setStatus('Confira a imagem, a câmera e o medidor de áudio antes de começar.', 'ok');
  } catch (err) {
    broadcaster = null;
    $('start').disabled = false;
    setStatus(err.name === 'NotAllowedError' ? 'Você cancelou a seleção de tela.' : friendlyError(err), 'error');
  }
}

function buildBroadcaster() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return createBroadcaster({
    wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`,
    bitrate: Number($('quality').value),
    fps: Number($('fps').value),
    audio: $('withAudio').checked,
    camera: $('withCamera').checked,
    cameraDeviceId: $('cameraDevice').value,
    cameraPosition: $('cameraPosition').value,
    cameraSize: $('cameraSize').value,
    onStatus: (s) =>
      setStatus(
        `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}`
      ),
    onStats: (s) => {
      $('viewers').textContent = s.viewers;
      $('fpsOut').textContent = s.adaptiveLevel
        ? `${s.fps}/${s.targetFps} fps · auto`
        : `${s.fps} fps`;
      $('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
      $('elapsed').textContent =
        `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
      if (s.adaptiveLevel) {
        $('connectionBadge').textContent = 'Qualidade reduzida';
        $('connectionBadge').classList.add('off');
        $('connectionBadge').classList.remove('on');
      } else if (connectionState === 'connected') {
        $('connectionBadge').textContent = 'Conexão boa';
        $('connectionBadge').classList.remove('off');
        $('connectionBadge').classList.add('on');
      }
    },
    onAviso: (msg) => {
      setStatus(msg, 'aviso');
    },
    onPerformance: (msg) => setStatus(msg, 'ok'),
    onConnectionStatus: ({ state, attempt }) => {
      connectionState = state;
      const badge = $('connectionBadge');
      badge.classList.toggle('on', state === 'connected');
      badge.classList.toggle('off', state !== 'connected');
      badge.textContent = state === 'connected' ? 'Conectado' : state === 'reconnecting' ? `Reconectando${attempt ? ` (${attempt})` : ''}` : 'Conectando…';
    },
    onAudioLevel: ({ level, silent, unavailable }) => {
      audioWasDetected ||= !silent && level > 0.015;
      const label = unavailable ? 'Medidor indisponível' : audioWasDetected ? 'Áudio detectado' : 'Aguardando som…';
      const help = audioWasDetected
        ? 'Tudo certo: o áudio está chegando à transmissão.'
        : 'Reproduza algum som na fonte escolhida. A barra deve se movimentar.';
      setAudioTest(level, label, help);
    },
    onAudioStatus: ({ active, source }) => {
      const badge = $('audioBadge');
      badge.classList.toggle('off', !active);
      badge.classList.toggle('on', active);
      badge.textContent = active
        ? source === 'tab'
          ? 'Áudio da aba ativo'
          : source === 'window'
            ? 'Áudio da janela ativo'
            : 'Áudio do sistema ativo'
        : 'Sem áudio';
      // Mesmo sem áudio inicial, a pessoa consegue corrigir sem reiniciar vídeo.
      $('somAba').hidden = active && source === 'tab';
    },
    onCameraStatus: ({ active }) => {
      const badge = $('cameraBadge');
      const cameraPreview = $('cameraPreview');
      badge.classList.toggle('off', !active);
      badge.classList.toggle('on', active);
      badge.textContent = active ? 'Câmera ativa' : 'Sem câmera';
      $('cameraToggle').textContent = active ? 'Desligar câmera' : 'Ligar câmera';
      cameraPreview.hidden = !active;
      cameraPreview.srcObject = active ? broadcaster?.getCameraStream() ?? null : null;
      if (active) cameraPreview.play().catch(() => {});
      const testCamera = $('testCameraPreview');
      testCamera.hidden = !active;
      testCamera.srcObject = active ? broadcaster?.getCameraStream() ?? null : null;
      if (active) testCamera.play().catch(() => {});
      updateCameraPreviewLayout();
      $('cameraOptions').hidden = !active;
      if (active) loadCameras();
    },
    onEnd: (reason) => {
      broadcaster = null;
      $('preview').srcObject = null;
      $('cameraPreview').srcObject = null;
      $('cameraPreview').hidden = true;
      $('live').hidden = true;
      $('previewStep').hidden = true;
      $('setup').hidden = false;
      $('previewStep').insertBefore(document.querySelector('.audio-test'), document.querySelector('.preview-actions'));
      $('setup').insertBefore($('cameraOptions'), $('browserNote'));
      $('cameraOptions').hidden = !$('withCamera').checked;
      $('start').disabled = false;
      setStatus(reason);
    },
  });
}

async function goLive() {
  if (!broadcaster) return;
  $('goLive').disabled = true;
  try {
    const stream = await broadcaster.start();
    $('preview').srcObject = stream;
    $('preview').play().catch(() => {});
    $('previewStep').hidden = true;
    $('live').hidden = false;
    $('live').insertBefore($('cameraOptions'), $('cameraToggle'));
    $('live').insertBefore(document.querySelector('.audio-test'), document.querySelector('.stats'));
    setStatus('Transmissão iniciada.', 'ok');
  } catch (err) {
    broadcaster?.stop();
    broadcaster = null;
    $('start').disabled = false;
    $('setup').hidden = false;
    $('previewStep').hidden = true;
    setStatus(friendlyError(err), 'error');
  } finally {
    $('goLive').disabled = false;
  }
}

function chooseAgain() {
  broadcaster?.stop();
  broadcaster = null;
  for (const id of ['testPreview', 'testCameraPreview']) $(id).srcObject = null;
  $('previewStep').hidden = true;
  $('setup').hidden = false;
  $('previewStep').insertBefore(document.querySelector('.audio-test'), document.querySelector('.preview-actions'));
  $('setup').insertBefore($('cameraOptions'), $('browserNote'));
  $('cameraOptions').hidden = !$('withCamera').checked;
  $('start').disabled = false;
  setStatus('Escolha novamente a tela e confirme o áudio.');
}

function setAudioTest(level, label, help) {
  const percent = Math.round(Math.min(1, Math.max(0, level || 0)) * 100);
  $('audioMeter').style.width = `${percent}%`;
  $('audioPercent').textContent = `${percent}%`;
  $('audioTestLabel').textContent = label;
  $('audioHelp').textContent = help;
}

function audioMissingHelp(surface) {
  if (surface === 'window') return 'Essa janela não forneceu áudio. Tente outra janela compatível ou use uma aba do navegador.';
  if (surface === 'browser') return 'Escolha novamente a aba e marque “Compartilhar áudio da guia”.';
  return 'Escolha novamente e ative “Compartilhar áudio”. Se não aparecer, tente uma aba do navegador.';
}

function friendlyError(err) {
  if (err?.name === 'NotAllowedError') return 'A permissão foi recusada. Clique novamente e autorize a tela ou câmera.';
  if (err?.name === 'NotReadableError') return 'A tela ou câmera está sendo usada por outro programa. Feche-o e tente novamente.';
  return err?.message || 'Não foi possível iniciar a transmissão.';
}

function updateCameraPreviewLayout() {
  for (const id of ['cameraPreview', 'testCameraPreview']) {
    $(id).dataset.position = $('cameraPosition').value;
    $(id).dataset.size = $('cameraSize').value;
  }
}

async function loadCameras() {
  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const current = broadcaster?.getCameraStream()?.getVideoTracks()[0]?.getSettings?.().deviceId ?? '';
    $('cameraDevice').replaceChildren(...cameras.map((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Câmera ${index + 1}`;
      option.selected = device.deviceId === current;
      return option;
    }));
  } catch {}
}

// Mantém o vídeo como está e troca só de onde vem o som. Janela isolada é
// preferida quando o navegador oferece; aba é o fallback mais compatível.
$('somAba').addEventListener('click', async () => {
  if (!broadcaster) return;
  try {
    await broadcaster.trocarSom();
    setStatus('Fonte do áudio atualizada.', 'ok');
    $('somAba').textContent = 'Trocar fonte do áudio';
  } catch (err) {
    if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
  }
});

$('cameraToggle').addEventListener('click', async () => {
  if (!broadcaster) return;
  try {
    if (broadcaster.temCamera()) broadcaster.desligarCamera();
    else await broadcaster.ligarCamera();
  } catch (err) {
    setStatus(`Não foi possível ligar a câmera: ${err.message}`, 'error');
  }
});

$('cameraDevice').addEventListener('change', async () => {
  if (!broadcaster?.temCamera()) return;
  try {
    await broadcaster.trocarCamera($('cameraDevice').value);
    setStatus('Câmera alterada.', 'ok');
  } catch (err) {
    setStatus(`Não foi possível trocar a câmera: ${friendlyError(err)}`, 'error');
  }
});

for (const id of ['cameraPosition', 'cameraSize']) {
  $(id).addEventListener('change', () => {
    broadcaster?.setCameraLayout({
      position: $('cameraPosition').value,
      size: $('cameraSize').value,
    });
    updateCameraPreviewLayout();
  });
}

window.addEventListener('beforeunload', () => broadcaster?.stop());
