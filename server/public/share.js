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
import { compatibilityInfo, createBroadcaster, supportError } from '/shared/broadcaster.js?v=6';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

let broadcaster = null;
let audioWasDetected = false;
let connectionState = 'idle';
const mobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
let captureMode = query.get('source') === 'camera' || mobileDevice || !navigator.mediaDevices?.getDisplayMedia ? 'camera' : 'screen';
let facingMode = 'user';
let wakeLock = null;

function browserGuidance() {
  const ua = navigator.userAgent;
  const support = compatibilityInfo();
  if (/Firefox/i.test(ua)) {
    return `Firefox detectado: transmissão em modo ${support.mode}. Vídeo e câmera estão disponíveis; o áudio depende da fonte oferecida pelo Firefox.`;
  }
  if (/Edg\//i.test(ua)) {
    return 'No Edge, prefira “Aba” para áudio mais confiável. Algumas janelas compatíveis também exibem a opção “Compartilhar áudio”.';
  }
  if (/Chrome|Chromium|OPR|Brave/i.test(ua)) {
    return 'No Chrome, marque “Compartilhar áudio”. Aba é a opção mais confiável; algumas janelas compatíveis também oferecem áudio isolado.';
  }
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR/i.test(ua)) {
    return `Safari detectado: transmissão em modo ${support.mode}. O áudio de tela pode não ser oferecido pelo macOS.`;
  }
  return `Modo ${support.mode} ativado. A captura de áudio depende das fontes oferecidas pelo navegador.`;
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
    const binary = atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
const missing = supportError(captureMode);

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
  selectSource(captureMode);
}

$('sourceScreen').addEventListener('click', () => selectSource('screen'));
$('sourceCamera').addEventListener('click', () => selectSource('camera'));
$('mobileFacing').addEventListener('change', () => {
  facingMode = $('mobileFacing').value;
  updatePrimaryPreviewMirror();
});

function selectSource(mode) {
  if (mode === 'screen' && !navigator.mediaDevices?.getDisplayMedia) {
    setStatus('Este celular não permite transmitir a tela pelo navegador. Use a câmera.', 'aviso');
    return;
  }
  captureMode = mode;
  $('sourceScreen').classList.toggle('selected', mode === 'screen');
  $('sourceCamera').classList.toggle('selected', mode === 'camera');
  $('sourceScreen').disabled = !navigator.mediaDevices?.getDisplayMedia;
  $('mobileCameraOptions').hidden = mode !== 'camera';
  $('withCamera').closest('.check').hidden = mode === 'camera';
  $('cameraOptions').hidden = mode === 'camera' || !$('withCamera').checked;
  $('withCamera').checked = mode === 'camera' ? false : $('withCamera').checked;
  $('audioOptionLabel').textContent = mode === 'camera' ? 'Incluir microfone na transmissão' : 'Incluir áudio na transmissão';
  document.querySelector('h1').textContent = mode === 'camera' ? 'Compartilhar câmera' : 'Compartilhar tela';
  $('sourceHelp').textContent = mode === 'camera'
    ? 'Transmita sua câmera e, se quiser, o microfone. Não é necessário instalar nada.'
    : 'Escolha uma tela, janela ou aba do computador.';
  $('browserNote').innerHTML = mode === 'camera'
    ? 'O navegador pedirá acesso à câmera e ao microfone. No celular, mantenha esta página aberta durante a transmissão.'
    : browserGuidance();
  $('keepOpenNote').textContent = mode === 'camera' && mobileDevice
    ? 'Mantenha esta página visível durante a transmissão. O celular pode pausar a câmera ao trocar de aplicativo ou bloquear a tela.'
    : 'Mantenha esta aba aberta enquanto transmite. Você pode voltar para o Discord — a transmissão continua.';
  $('start').textContent = mode === 'camera' ? 'Testar câmera antes' : 'Escolher e testar antes';
  if (mode === 'camera' && mobileDevice && !query.has('q')) $('quality').value = '1000000';
  $('cameraToggle').hidden = mode === 'camera';
  $('switchMobileCamera').hidden = true;
  updatePrimaryPreviewMirror();
}

function updatePrimaryPreviewMirror() {
  const mirrored = captureMode === 'camera' && facingMode === 'user';
  for (const id of ['testPreview', 'preview']) $(id).classList.toggle('mirrored', mirrored);
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
  const economy = query.get('eco') === '1';

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

  for (const row of document.querySelectorAll('#setup > .row')) row.hidden = true;

  const mbps = (Number($('quality').value) / 1e6).toFixed(1).replace('.', ',');
  const comSom = $('withAudio').checked ? ' · com som' : '';
  const comCamera = $('withCamera').checked ? ' · com câmera' : '';
  $('presetLine').textContent = `${economy ? 'Modo economia · ' : ''}${mbps} Mb/s · ${$('fps').value} fps${comSom}${comCamera}`;
  $('presetLine').hidden = false;
}

// -------------------------------------------------------------------- ações

async function start() {
  $('start').disabled = true;
  setStatus(captureMode === 'camera' ? 'Aguardando permissão para usar a câmera…' : 'Aguardando você escolher a tela…');
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
    captureMode,
    facingMode,
    maxWidth: query.get('eco') === '1' ? 1280 : 1920,
    maxHeight: query.get('eco') === '1' ? 720 : 1080,
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
        ? source === 'microphone'
          ? 'Microfone ativo'
          : source === 'tab'
          ? 'Áudio da aba ativo'
          : source === 'window'
            ? 'Áudio da janela ativo'
            : 'Áudio do sistema ativo'
        : 'Sem áudio';
      // Mesmo sem áudio inicial, a pessoa consegue corrigir sem reiniciar vídeo.
      $('somAba').hidden = captureMode === 'camera' || (active && source === 'tab');
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
      releaseWakeLock();
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
    await keepScreenAwake();
    $('cameraBadge').textContent = captureMode === 'camera' ? 'Câmera ativa' : $('cameraBadge').textContent;
    $('cameraBadge').classList.toggle('on', captureMode === 'camera');
    $('cameraBadge').classList.toggle('off', captureMode !== 'camera');
    $('cameraToggle').hidden = captureMode === 'camera';
    $('switchMobileCamera').hidden = captureMode !== 'camera';
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
  if (surface === 'camera') return 'Autorize o microfone junto com a câmera ou transmita somente o vídeo.';
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

$('switchMobileCamera').addEventListener('click', async () => {
  if (!broadcaster || captureMode !== 'camera') return;
  const next = facingMode === 'user' ? 'environment' : 'user';
  $('switchMobileCamera').disabled = true;
  try {
    const fresh = await broadcaster.trocarCameraPrincipal(next);
    facingMode = next;
    $('mobileFacing').value = facingMode;
    for (const id of ['preview', 'testPreview']) {
      $(id).srcObject = fresh;
      $(id).play().catch(() => {});
    }
    updatePrimaryPreviewMirror();
    setStatus(facingMode === 'user' ? 'Câmera frontal ativa.' : 'Câmera traseira ativa.', 'ok');
  } catch (err) {
    setStatus(`Não foi possível trocar a câmera: ${friendlyError(err)}`, 'error');
  } finally {
    $('switchMobileCamera').disabled = false;
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

async function keepScreenAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
  } catch {}
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && broadcaster?.isRunning()) keepScreenAwake();
});

window.addEventListener('beforeunload', () => {
  releaseWakeLock();
  broadcaster?.stop();
});
