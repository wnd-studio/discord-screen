/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. Por isso as duas variantes de H264 vêm antes:
// annexb dispensa o blob `description`, e avcC é aceito onde annexb não é.
const CANDIDATES = [
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

function codecCandidates() {
  const ua = navigator.userAgent;
  if (/Firefox/i.test(ua)) return [CANDIDATES[2], CANDIDATES[1], CANDIDATES[0], CANDIDATES[3]];
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR/i.test(ua)) {
    return [CANDIDATES[1], CANDIDATES[0], CANDIDATES[2], CANDIDATES[3]];
  }
  return CANDIDATES;
}

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

// Teto de resolução: acima disso banda e CPU disparam sem ganho de legibilidade.
// A imagem é reduzida proporcionalmente, nunca cortada.
const MAX_W = 1920;
const MAX_H = 1080;

const even = (n) => Math.max(2, n - (n % 2));

function fitWithin(w, h) {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/** Motivo pelo qual este navegador não consegue transmitir, ou null. */
export function supportError() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não oferece a tecnologia de vídeo necessária. Atualize o navegador ou tente Chrome, Edge, Firefox ou Safari no computador.';
  }
  return null;
}

export function compatibilityInfo() {
  return {
    capture: Boolean(navigator.mediaDevices?.getDisplayMedia),
    video: Boolean(window.VideoEncoder && window.VideoFrame && window.EncodedVideoChunk),
    audio: Boolean(window.AudioEncoder && window.AudioData),
    directFrames: Boolean(window.MediaStreamTrackProcessor),
    mode: window.MediaStreamTrackProcessor ? 'otimizado' : 'compatível',
  };
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {number} opts.bitrate      bits por segundo
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {boolean} [opts.camera]    mostrar a câmera sobre a tela
 * @param {string} [opts.cameraDeviceId] câmera preferida
 * @param {string} [opts.cameraPosition] canto da sobreposição
 * @param {string} [opts.cameraSize] tamanho da sobreposição
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  viewers, fps, mbps, segundos no ar
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 * @param {(msg:string)=>void} [opts.onPerformance] ajuste automático de carga
 * @param {(info:object)=>void} [opts.onAudioStatus] estado da captura de som
 * @param {(info:object)=>void} [opts.onCameraStatus] estado da câmera
 * @param {(info:object)=>void} [opts.onAudioLevel] nível instantâneo do áudio
 * @param {(info:object)=>void} [opts.onConnectionStatus] estado da conexão
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  audio = false,
  camera = false,
  cameraDeviceId = '',
  cameraPosition = 'bottom-right',
  cameraSize = 'medium',
  onStatus,
  onStats,
  onEnd,
  onError,
  onAviso,
  onPerformance,
  onAudioStatus,
  onCameraStatus,
  onAudioLevel,
  onConnectionStatus,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  let cameraStream = null;
  let cameraVideo = null;
  let audioContext = null;
  let audioCaptureContext = null;
  let audioCaptureSource = null;
  let audioCaptureProcessor = null;
  let audioCaptureMute = null;
  let audioMeterTimer = null;
  let audioMeterSource = null;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let receivedFrames = 0;
  let droppedFrames = 0;
  let viewers = 0;
  let statsTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let stopping = false;
  let lastAudioConfig = null;

  // A escolha da pessoa é o teto. O modo adaptativo só desce temporariamente
  // quando o encoder não acompanha e volta a subir depois de estabilizar.
  let requestedBitrate = bitrate;
  let requestedFps = fps;
  let adaptiveLevel = 0;
  let overloadedSeconds = 0;
  let stableSeconds = 0;

  async function capture() {
    if (stream?.active) return stream;
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: audio ? audioConstraints() : false,
      // Estes são hints de DisplayMediaStreamOptions (nível superior), não
      // restrições da faixa de áudio. Dentro de `audio` o Chromium os ignorava.
      ...(audio ? { systemAudio: 'include', windowAudio: 'window' } : {}),
    });

    const track = stream.getVideoTracks()[0];
    // Diz ao encoder que o conteúdo é tela (texto/UI), não vídeo natural —
    // preserva nitidez das bordas em vez de suavizar.
    track.contentHint = 'text';
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    if (camera) {
      await ligarCamera().catch((err) => {
        onAviso?.(`A tela será transmitida sem câmera: ${cameraError(err)}`);
      });
    }

    const audioTrack = stream.getAudioTracks()[0] ?? null;
    if (audioTrack) {
      const surface = track.getSettings?.().displaySurface;
      const source = surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'system';
      setupAudioMeter(audioTrack);
      onAudioStatus?.({ active: true, source, preview: true });
    } else if (audio) {
      onAudioStatus?.({ active: false, reason: 'missing', preview: true });
    }

    return stream;
  }

  /** Captura sem publicar: usada pela tela de teste antes de entrar ao vivo. */
  async function prepare() {
    const prepared = await capture();
    return {
      stream: prepared,
      hasAudio: prepared.getAudioTracks().length > 0,
      surface: prepared.getVideoTracks()[0]?.getSettings?.().displaySurface ?? 'unknown',
    };
  }

  async function start() {
    stopping = false;
    await capture();
    const track = stream.getVideoTracks()[0];

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: Boolean(window.MediaStreamTrackProcessor),
    });

    statsTimer = setInterval(() => {
      const snapshot = {
        viewers,
        fps: frames,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        targetFps: fps,
        dropped: droppedFrames,
        adaptiveLevel,
      };
      onStats?.(snapshot);
      evaluatePerformance(snapshot, receivedFrames);
      bytes = 0;
      frames = 0;
      receivedFrames = 0;
      droppedFrames = 0;
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber: em vários sistemas a caixa "compartilhar
    // o som" fica desmarcada, e o navegador devolve a tela sem faixa de som.
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) {
      const surface = track.getSettings?.().displaySurface;
      const source = surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'system';
      pumpAudio(audioTrack, source);
    }
    else if (audio) {
      onAudioStatus?.({ active: false, reason: 'missing' });
      onAviso?.(
        'A transmissão começou sem áudio. Na janela do navegador, escolha uma fonte com som e ative “Compartilhar áudio”.'
      );
    } else {
      onAudioStatus?.({ active: false, reason: 'disabled' });
    }

    return stream;
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */
  function audioConstraints() {
    const c = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
      c.restrictOwnAudio = true;
    }
    return c;
  }

/**
   * Devolve a faixa de som que o navegador realmente entregou.
   *
   * O nó: o som do sistema é capturado como uma mistura única, e nenhum
   * navegador expõe um jeito de tirar um processo dela. O Windows tem essa API
   * (é assim que o Discord nativo compartilha som sem se ouvir), mas página web
   * não alcança. Então "som da tela inteira" é sempre "som do sistema INTEIRO",
   * com a saída do Discord dentro — e a call inteira se escuta, com atraso.
   *
   * Aba é diferente: o som sai só daquela aba, e o Discord nunca entra.
   *
   * O comportamento antigo descartava automaticamente essa faixa em tela
   * inteira. Isso surpreendia quem havia marcado “compartilhar áudio” e era a
   * principal origem das transmissões mudas. Agora respeitamos a escolha e
   * avisamos sobre o possível eco, sem remover o áudio.
   */
  function prepararSom(videoTrack, capturado) {
    const faixa = capturado.getAudioTracks()[0];
    if (!faixa) return null;

    const superficie = videoTrack.getSettings?.().displaySurface;
    somBloqueado = false;
    if (superficie === 'window') {
      onAviso?.(
        'Áudio da janela solicitado. A separação funciona apenas quando o navegador e o aplicativo selecionado oferecem essa opção.'
      );
    } else if (superficie !== 'browser') {
      onAviso?.(
        'Áudio do sistema ativo. Ele pode incluir a voz do Discord; se houver eco, use “Trocar fonte do áudio” e escolha uma aba.'
      );
    }
    return faixa;
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba, que é isolada por construção. A
   * segunda janela de escolha é o preço, e é um preço honesto — não há como o
   * navegador adivinhar de qual aplicativo o som deveria vir.
   */
  async function trocarSom() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: audioConstraints(),
      systemAudio: 'include',
      windowAudio: 'window',
    });

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    escolha.getVideoTracks().forEach((t) => t.stop());

    if (!faixa) {
      escolha.getTracks().forEach((t) => t.stop());
      throw new Error(
        'Essa escolha veio sem som. Tente uma janela que ofereça áudio ou escolha uma aba e marque “Compartilhar áudio”.'
      );
    }

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    stopAudioCompatibilityCapture();
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {}
    }
    audioEncoder = null;

    somBloqueado = false;
    const source = superficie === 'browser' ? 'tab' : superficie === 'window' ? 'window' : 'system';
    faixa.addEventListener('ended', () => onAviso?.('A fonte do áudio foi encerrada.'));
    if (source !== 'tab') {
      onAviso?.('Áudio do aplicativo/sistema ativo. Se a voz do Discord voltar em eco, escolha uma janela compatível ou uma aba.');
    }
    pumpAudio(faixa, source);
    return faixa;
  }

  // ------------------------------------------------------------------- câmera

  function cameraError(err) {
    if (err?.name === 'NotAllowedError') return 'a permissão foi recusada';
    if (err?.name === 'NotFoundError') return 'nenhuma câmera foi encontrada';
    if (err?.name === 'NotReadableError') return 'a câmera está sendo usada por outro programa';
    return err?.message || 'não foi possível abrir a câmera';
  }

  async function ligarCamera() {
    if (cameraStream) return cameraStream;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não permite usar a câmera.');

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : {}),
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      cameraVideo = document.createElement('video');
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      cameraVideo.srcObject = cameraStream;
      Object.assign(cameraVideo.style, {
        position: 'fixed',
        left: '-9999px',
        width: '2px',
        height: '2px',
        opacity: '0',
      });
      document.body.append(cameraVideo);
      await cameraVideo.play();
      camera = true;
      cameraStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        desligarCamera();
        onAviso?.('A câmera foi desligada pelo navegador.');
      }, { once: true });
      if (srcW && srcH) configureStage(srcW, srcH, targetSize(srcW, srcH));
      wantKeyframe = true;
      onCameraStatus?.({
        active: true,
        deviceId: cameraStream.getVideoTracks()[0]?.getSettings?.().deviceId ?? '',
        position: cameraPosition,
        size: cameraSize,
      });
      return cameraStream;
    } catch (err) {
      cameraStream?.getTracks().forEach((track) => track.stop());
      cameraStream = null;
      cameraVideo?.remove();
      cameraVideo = null;
      camera = false;
      onCameraStatus?.({ active: false });
      throw err;
    }
  }

  function desligarCamera() {
    const wasActive = Boolean(cameraStream);
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraVideo?.remove();
    cameraVideo = null;
    camera = false;
    if (srcW && srcH) configureStage(srcW, srcH, targetSize(srcW, srcH));
    wantKeyframe = true;
    if (wasActive) onCameraStatus?.({ active: false });
  }

  async function trocarCamera(deviceId) {
    cameraDeviceId = deviceId || '';
    desligarCamera();
    return ligarCamera();
  }

  function setCameraLayout({ position, size } = {}) {
    if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(position)) {
      cameraPosition = position;
    }
    if (['small', 'medium', 'large'].includes(size)) cameraSize = size;
    wantKeyframe = true;
    onCameraStatus?.({
      active: Boolean(cameraStream),
      deviceId: cameraStream?.getVideoTracks()[0]?.getSettings?.().deviceId ?? cameraDeviceId,
      position: cameraPosition,
      size: cameraSize,
    });
  }

  // -------------------------------------------------------------------- áudio

  function setupAudioMeter(track) {
    clearInterval(audioMeterTimer);
    audioMeterTimer = null;
    try { audioMeterSource?.disconnect(); } catch {}
    audioMeterSource = null;
    if (!onAudioLevel || !track || !window.AudioContext) return;

    try {
      audioContext ??= new AudioContext();
      audioContext.resume().catch(() => {});
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      audioMeterSource = audioContext.createMediaStreamSource(new MediaStream([track]));
      audioMeterSource.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      audioMeterTimer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          energy += centered * centered;
        }
        const rms = Math.sqrt(energy / samples.length);
        onAudioLevel?.({ level: Math.min(1, rms * 5), silent: rms < 0.004 });
      }, 100);
    } catch {
      onAudioLevel?.({ level: 0, silent: true, unavailable: true });
    }
  }

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track, source = 'system') {
    if (!window.AudioEncoder || !window.AudioData) {
      onAudioStatus?.({ active: false, reason: 'unsupported' });
      onAviso?.('Este navegador consegue transmitir a imagem, mas não oferece o codificador de áudio necessário.');
      return;
    }

    setupAudioMeter(track);
    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => {
          console.warn('[audio encoder]', err.message);
          onAudioStatus?.({ active: false, reason: 'encoder' });
          onAviso?.(`O áudio parou: ${err.message}`);
        },
      });
      audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      onAudioStatus?.({ active: false, reason: 'encoder' });
      onAviso?.(`Não foi possível iniciar o áudio: ${err.message}`);
      return;
    }

    onAudioStatus?.({ active: true, source });

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    lastAudioConfig = { codec: 'opus', sampleRate, numberOfChannels };
    ws?.send(JSON.stringify({ type: 'audio-config', config: lastAudioConfig }));

    if (!window.MediaStreamTrackProcessor) {
      pumpAudioViaWebAudio(track, sampleRate, numberOfChannels);
      return;
    }

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let dados;
      try {
        const { done, value } = await audioReader.read();
        if (done) break;
        dados = value;
      } catch {
        break;
      }

      if (viewers > 0 && audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn('[audio encode]', err.message);
        }
      }
      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    if (viewers === 0 || ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data));
    bytes += 18 + data.byteLength;
  }

  async function pickConfig(width, height) {
    // Duas passadas: navegadores que não conhecem `latencyMode` podem recusar a
    // configuração inteira por causa dela. Mais latência é melhor que nada.
    for (const realtime of [true, false]) {
      for (const candidate of codecCandidates()) {
        const cfg = { ...candidate, width, height, bitrate, framerate: fps };
        if (realtime) cfg.latencyMode = 'realtime';
        try {
          if (typeof VideoEncoder.isConfigSupported !== 'function') return cfg;
          const { supported } = await VideoEncoder.isConfigSupported(cfg);
          if (supported) return cfg;
        } catch {
          // candidato inválido neste navegador; tenta o próximo
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (window.MediaStreamTrackProcessor) pumpDirect(track);
    else pumpViaVideo();
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let frame;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        frame = value;
      } catch {
        break;
      }
      if (!encodeFrame(frame)) break;
    }
  }

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Fora do fluxo mas no DOM: alguns navegadores não decodificam um elemento
    // solto, e display:none chega a pausar a reprodução.
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play().catch(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      // Alguns navegadores pausam ao trocar de aba; sem isso o loop morre em
      // silêncio e a transmissão congela sem erro nenhum.
      if (video.paused) video.play().catch(() => {});
      if (video.readyState < 2 || !video.videoWidth) return schedule();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode ser bem acima do fps alvo.
      if (!hasRvfc && now - lastAt < 1000 / (fps + 2)) return schedule();
      lastAt = now;

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }
    // Sem ninguém assistindo, manter a captura aberta custa zero mensagens de
    // mídia. O primeiro `watch` pede um keyframe e retoma na hora.
    if (viewers === 0) {
      frame.close();
      return true;
    }
    receivedFrames++;
    // Backpressure: fila no encoder vira latência que nunca mais sai.
    if (encoder.encodeQueueSize > 2) {
      droppedFrames++;
      frame.close();
      return true;
    }

    const timestamp = frame.timestamp ?? performance.now() * 1000;
    syncSize(frame);

    const now = Date.now();
    if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    let out = frame;
    if (stage) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      drawCamera();
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = now;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    out.close();
    frames++;
    return true;
  }

  /** Firefox/Safari: transforma a faixa em AudioData através da Web Audio API. */
  function pumpAudioViaWebAudio(track, sampleRate, numberOfChannels) {
    try {
      audioCaptureContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      audioCaptureSource = audioCaptureContext.createMediaStreamSource(new MediaStream([track]));
      audioCaptureProcessor = audioCaptureContext.createScriptProcessor(2048, numberOfChannels, numberOfChannels);
      audioCaptureMute = audioCaptureContext.createGain();
      audioCaptureMute.gain.value = 0;
      let timestamp = 0;
      audioCaptureProcessor.onaudioprocess = (event) => {
        if (!running || viewers === 0 || audioEncoder?.state !== 'configured') return;
        const frames = event.inputBuffer.length;
        const planar = new Float32Array(frames * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel++) {
          planar.set(event.inputBuffer.getChannelData(channel), channel * frames);
        }
        let audioData;
        try {
          audioData = new AudioData({
            format: 'f32-planar', sampleRate, numberOfFrames: frames,
            numberOfChannels, timestamp, data: planar,
          });
          audioEncoder.encode(audioData);
          timestamp += Math.round((frames * 1_000_000) / sampleRate);
        } catch (err) {
          console.warn('[audio compat]', err.message);
        } finally {
          audioData?.close();
        }
      };
      audioCaptureSource.connect(audioCaptureProcessor);
      audioCaptureProcessor.connect(audioCaptureMute);
      audioCaptureMute.connect(audioCaptureContext.destination);
      audioCaptureContext.resume().catch(() => {});
      onAviso?.('Modo de áudio compatível ativado para este navegador.');
    } catch (err) {
      onAudioStatus?.({ active: false, reason: 'unsupported' });
      onAviso?.(`O navegador não conseguiu preparar o áudio: ${err.message}`);
    }
  }

  function stopAudioCompatibilityCapture() {
    if (audioCaptureProcessor) audioCaptureProcessor.onaudioprocess = null;
    try { audioCaptureSource?.disconnect(); } catch {}
    try { audioCaptureProcessor?.disconnect(); } catch {}
    try { audioCaptureMute?.disconnect(); } catch {}
    audioCaptureContext?.close().catch(() => {});
    audioCaptureContext = null;
    audioCaptureSource = null;
    audioCaptureProcessor = null;
    audioCaptureMute = null;
  }

  function drawCamera() {
    if (!cameraVideo || cameraVideo.readyState < 2 || !stageCtx) return;
    const margin = Math.max(12, Math.round(stage.width * 0.012));
    const factors = { small: 0.17, medium: 0.24, large: 0.32 };
    const width = Math.min(Math.round(stage.width * factors[cameraSize]), cameraSize === 'large' ? 480 : 360);
    const ratio = cameraVideo.videoWidth && cameraVideo.videoHeight
      ? cameraVideo.videoWidth / cameraVideo.videoHeight
      : 16 / 9;
    const height = Math.round(width / ratio);
    const right = cameraPosition.endsWith('right');
    const bottom = cameraPosition.startsWith('bottom');
    const x = right ? stage.width - width - margin : margin;
    const y = bottom ? stage.height - height - margin : margin;
    const radius = Math.max(8, Math.round(width * 0.04));

    stageCtx.save();
    stageCtx.beginPath();
    stageCtx.roundRect(x, y, width, height, radius);
    stageCtx.clip();
    // Espelho apenas na câmera; a tela permanece exatamente como foi capturada.
    stageCtx.translate(x + width, y);
    stageCtx.scale(-1, 1);
    stageCtx.drawImage(cameraVideo, 0, 0, width, height);
    stageCtx.restore();

    stageCtx.save();
    stageCtx.strokeStyle = 'rgba(255,255,255,.8)';
    stageCtx.lineWidth = Math.max(2, Math.round(width * 0.008));
    stageCtx.beginPath();
    stageCtx.roundRect(x, y, width, height, radius);
    stageCtx.stroke();
    stageCtx.restore();
  }

  /**
   * Controle de carga sem perguntas nem reinício.
   *
   * Três segundos ruins evitam reagir a uma engasgada isolada. A recuperação é
   * deliberadamente mais lenta (20 s), para não ficar oscilando entre níveis.
   */
  function evaluatePerformance(stats, received) {
    if (!running || viewers === 0 || stats.seconds < 5 || received === 0) return;

    const dropRate = stats.dropped / received;
    // FPS baixo também pode significar uma tela parada, não sobrecarga. Quadro
    // descartado por fila cheia é o sinal confiável de que o encoder perdeu o
    // ritmo, então só ele aciona a redução.
    const overloaded = dropRate > 0.15;
    overloadedSeconds = overloaded ? overloadedSeconds + 1 : 0;
    stableSeconds = !overloaded && dropRate < 0.03 ? stableSeconds + 1 : 0;

    if (overloadedSeconds >= 3 && adaptiveLevel < 3) {
      adaptiveLevel++;
      overloadedSeconds = 0;
      stableSeconds = 0;
      applyAdaptiveLevel();
      onPerformance?.(
        `Desempenho ajustado automaticamente para ${fps} fps. A qualidade volta a subir quando o computador estabilizar.`
      );
    } else if (stableSeconds >= 20 && adaptiveLevel > 0) {
      adaptiveLevel--;
      overloadedSeconds = 0;
      stableSeconds = 0;
      applyAdaptiveLevel();
      onPerformance?.(`Desempenho estável: qualidade aumentada automaticamente para ${fps} fps.`);
    }
  }

  function adaptiveSettings() {
    const levels = [
      { fps: requestedFps, scale: 1, bitrate: requestedBitrate },
      { fps: Math.min(requestedFps, 30), scale: 0.85, bitrate: requestedBitrate * 0.8 },
      { fps: Math.min(requestedFps, 24), scale: 0.7, bitrate: requestedBitrate * 0.6 },
      { fps: Math.min(requestedFps, 15), scale: 0.55, bitrate: requestedBitrate * 0.4 },
    ];
    const current = levels[adaptiveLevel];
    return {
      fps: Math.max(10, Math.round(current.fps)),
      scale: current.scale,
      bitrate: Math.max(750_000, Math.round(current.bitrate)),
    };
  }

  function targetSize(width, height) {
    const base = fitWithin(width, height);
    const { scale } = adaptiveSettings();
    return { width: even(Math.round(base.width * scale)), height: even(Math.round(base.height * scale)) };
  }

  function applyAdaptiveLevel() {
    const next = adaptiveSettings();
    fps = next.fps;
    bitrate = next.bitrate;

    if (encoder?.state === 'configured' && srcW && srcH) {
      const target = targetSize(srcW, srcH);
      config = { ...config, ...target, bitrate, framerate: fps };
      encoder.configure(config);
      configureStage(srcW, srcH, target);
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
      });
    }

    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele faz recortar as bordas.
   */
  function syncSize(frame) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH)) return;

    srcW = sw;
    srcH = sh;
    const target = targetSize(sw, sh);

    if (target.width !== config.width || target.height !== config.height) {
      config = { ...config, ...target };
      encoder.configure(config);
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
      });
    }

    configureStage(sw, sh, target);
  }

  // targetSize preserva a proporção, então reduzir não corta nada.
  function configureStage(sw, sh, target) {
    if (target.width === sw && target.height === sh && !camera) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    if (viewers === 0 || ws?.readyState !== WebSocket.OPEN) return;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data
    );
    ws.send(buf);
    bytes += buf.byteLength;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
  function empacotar(tipo, timestamp, data) {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, tipo);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc) {
    const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  // ---------------------------------------------------------------- websocket

  function connect(reconnecting = false) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      ws = socket;
      socket.binaryType = 'arraybuffer';
      onConnectionStatus?.({ state: reconnecting ? 'reconnecting' : 'connecting', attempt: reconnectAttempts });

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        reconnectAttempts = 0;
        onConnectionStatus?.({ state: 'connected' });
        if (reconnecting && running) {
          socket.send(JSON.stringify({ type: 'start' }));
          if (lastAudioConfig) {
            socket.send(JSON.stringify({ type: 'audio-config', config: lastAudioConfig }));
          }
          wantKeyframe = true;
          onAviso?.('Conexão recuperada. A transmissão continuou automaticamente.');
        }
        resolve();
      });

      socket.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);

        if (msg.type === 'slot') mySlot = msg.slot;
        else if (msg.type === 'state') {
          const mine = (msg.streams ?? []).find((stream) => stream.slot === mySlot);
          viewers = mine?.watchers?.length ?? 0;
        }
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') {
          viewers = Math.max(1, viewers);
          wantKeyframe = true;
        }
        else if (msg.type === 'stop-request') stop('Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!running) reject(new Error('Falha ao conectar no servidor.'));
        socket.close();
      });

      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (ws === socket) ws = null;
        if (running && !stopping) scheduleReconnect();
      });
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer || stopping || !running) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10_000);
    onConnectionStatus?.({ state: 'reconnecting', attempt: reconnectAttempts, delay });
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect(true);
      } catch {
        if (reconnectAttempts >= 8) {
          stop('Não foi possível recuperar a conexão com o servidor.');
        } else {
          scheduleReconnect();
        }
      }
    }, delay);
  }

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: audio ? audioConstraints() : false,
      ...(audio ? { systemAudio: 'include', windowAudio: 'window' } : {}),
    });

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'text';
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    stopAudioCompatibilityCapture();
    const novoAudio = prepararSom(track, fresh);
    if (audioEncoder?.state === 'configured') {
      try { audioEncoder.close(); } catch {}
    }
    audioEncoder = null;
    if (novoAudio) {
      const surface = track.getSettings?.().displaySurface;
      const source = surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'system';
      pumpAudio(novoAudio, source);
    }
    else if (audio) {
      onAudioStatus?.({ active: false, reason: 'missing' });
      onAviso?.('A nova tela foi compartilhada sem áudio. Ative “Compartilhar áudio” no seletor do navegador.');
    }

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
    if (nextBitrate) requestedBitrate = nextBitrate;
    if (nextFps) requestedFps = nextFps;
    adaptiveLevel = 0;
    overloadedSeconds = 0;
    stableSeconds = 0;
    bitrate = requestedBitrate;
    fps = requestedFps;
    if (encoder?.state !== 'configured') return;

    applyAdaptiveLevel();
  }

  const getSettings = () => ({
    bitrate: requestedBitrate,
    fps: requestedFps,
    adaptiveLevel,
    cameraPosition,
    cameraSize,
    cameraDeviceId,
  });

  function cleanup() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    // Antes de zerar o palco: desligarCamera pode reconstruí-lo para remover a
    // sobreposição quando a transmissão ainda está viva.
    srcW = 0;
    srcH = 0;
    desligarCamera();
    clearInterval(audioMeterTimer);
    audioMeterTimer = null;
    try { audioMeterSource?.disconnect(); } catch {}
    audioMeterSource = null;
    audioContext?.close().catch(() => {});
    audioContext = null;
    stopAudioCompatibilityCapture();
    stage = null;
    stageCtx = null;
  }

  function stop(reason) {
    const wasRunning = running;
    const hadCapture = Boolean(stream || cameraStream);
    stopping = true;
    running = false;

    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    clearInterval(statsTimer);
    statsTimer = null;

    reader?.cancel().catch(() => {});
    reader = null;
    audioReader?.cancel().catch(() => {});
    audioReader = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {}
      }
    }
    encoder = null;
    audioEncoder = null;
    lastAudioConfig = null;

    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    ws = null;

    cleanup();
    if (wasRunning || hadCapture) onEnd?.(reason ?? '');
  }

  return {
    prepare,
    start,
    stop,
    changeScreen,
    trocarSom,
    ligarCamera,
    desligarCamera,
    trocarCamera,
    setCameraLayout,
    setQuality,
    getSettings,
    temSom: () => Boolean(audioEncoder),
    temCamera: () => Boolean(cameraStream),
    getCameraStream: () => cameraStream,
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
  };
}
