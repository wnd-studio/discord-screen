const $ = (selector) => document.querySelector(selector);
const login = $('#login');
const dashboard = $('#dashboard');
const toast = $('#toast');
let admin = null;
let refreshTimer = null;
let currentOverview = null;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3800);
}

async function post(path, payload = {}) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = new Error(data.error || `Erro ${response.status}`);
    problem.status = response.status;
    throw problem;
  }
  return data;
}

const number = (value) => new Intl.NumberFormat('pt-BR').format(Number(value || 0));
const date = (value) => value ? new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short',
}).format(new Date(Number(value))) : '—';
const duration = (ms) => {
  const minutes = Math.round(Number(ms || 0) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
};
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function empty(text) { return el('div', 'empty-state', text); }

const brandAvatars = [
  '/brand/wnd-calm.png',
  '/brand/wnd-dizzy.png',
  '/brand/wnd-neutral.png',
];

function brandAvatarFor(value = '') {
  let hash = 0;
  for (const character of String(value)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return brandAvatars[hash % brandAvatars.length];
}

function participantAvatar(person) {
  const image = document.createElement('img');
  const fallback = brandAvatarFor(person.id);
  image.className = 'participant-avatar';
  image.alt = '';
  image.src = /^\d{15,21}$/.test(person.id || '') && /^(?:a_)?[0-9a-f]{32}$/.test(person.avatar || '')
    ? `/api/avatar/${person.id}/${person.avatar}`
    : fallback;
  image.addEventListener('error', () => {
    image.classList.add('brand-fallback');
    image.src = fallback;
  }, { once: true });
  if (image.src.endsWith(fallback)) image.classList.add('brand-fallback');
  return image;
}

async function action(payload, confirmation) {
  if (confirmation && !confirm(confirmation)) return;
  try {
    await post('/api/admin/action', payload);
    showToast('Ação concluída.');
    await loadOverview();
  } catch (problem) {
    showToast(problem.message, true);
  }
}

function reason(fallback) {
  const value = prompt('Motivo (aparece somente no registro administrativo):', fallback);
  return value === null ? null : (value.trim() || fallback);
}

function renderStats(totals) {
  const values = [
    ['Servidores conhecidos', totals.servers],
    ['Aberturas em 30 dias', totals.launches30d],
    ['Usuários em 30 dias', totals.uniqueUsers30d],
    ['Transmissões em 30 dias', totals.streams30d],
    ['Tempo transmitido', duration(totals.streamedMs30d)],
    ['Pessoas agora', totals.activePeople, 'live'],
  ];
  $('#stats').replaceChildren(...values.map(([label, value, className]) => {
    const card = el('article', `stat ${className || ''}`.trim());
    card.append(el('span', '', label), el('strong', '', typeof value === 'number' ? number(value) : value));
    return card;
  }));
}

function renderChart(daily) {
  const byDay = new Map(daily.map((item) => [item.day, Number(item.launches)]));
  const days = [];
  for (let index = 13; index >= 0; index--) {
    const value = new Date();
    value.setUTCHours(0, 0, 0, 0);
    value.setUTCDate(value.getUTCDate() - index);
    const key = value.toISOString().slice(0, 10);
    days.push({ key, launches: byDay.get(key) || 0 });
  }
  const maximum = Math.max(1, ...days.map((item) => item.launches));
  $('#chart').replaceChildren(...days.map((item) => {
    const wrap = el('div', 'bar-wrap');
    const value = el('span', 'bar-value', number(item.launches));
    const bar = el('div', 'bar');
    bar.style.height = `${Math.max(3, item.launches / maximum * 112)}px`;
    bar.title = `${item.launches} abertura(s) em ${item.key}`;
    const label = el('span', 'bar-day', item.key.slice(8, 10));
    wrap.append(value, bar, label);
    return wrap;
  }));
}

function roomCard(room) {
  const card = el('article', 'room-card');
  const title = el('div', 'room-title');
  title.append(el('h3', '', room.name || room.id), el('span', 'badge', room.isCall ? 'Atividade' : 'Sala web'));
  card.append(title, el('p', 'room-meta', `${room.guildId || 'Web'} · ${room.channelId || room.instance || 'sem canal'}`));
  const counts = el('div', 'room-counts');
  counts.append(el('span', '', `${number(room.people)} pessoa(s)`), el('span', '', `${number(room.streamCount)} transmissão(ões)`), el('span', '', `desde ${date(room.createdAt)}`));
  card.append(counts);

  const participants = el('div', 'participant-list');
  if (!room.participants?.length) participants.append(empty('A sala ainda não recebeu conexões.'));
  for (const person of room.participants || []) {
    const row = el('div', 'participant');
    const text = el('span', 'participant-name', person.name || person.id);
    text.title = person.id;
    row.append(participantAvatar(person), text, el('span', 'role', person.role === 'broadcaster' ? 'transmissor' : 'espectador'));
    const disconnect = el('button', 'button secondary small', 'Desconectar');
    disconnect.onclick = () => {
      const why = reason('Desconectado pela administração');
      if (why) action({ action: 'kick-user', roomId: room.id, userId: person.id, reason: why }, `Desconectar ${person.name}?`);
    };
    const block = el('button', 'button danger-outline small', 'Bloquear');
    block.onclick = () => {
      const why = reason('Uso indevido do aplicativo');
      if (why) action({ action: 'block-user', userId: person.id, reason: why }, `Bloquear ${person.name} em todo o aplicativo?`);
    };
    row.append(disconnect, block);
    participants.append(row);
  }
  card.append(participants);
  const actions = el('div', 'room-actions');
  const close = el('button', 'button danger-outline small', 'Encerrar sala');
  close.onclick = () => {
    const why = reason('Encerrada pela administração');
    if (why) action({ action: 'close-room', roomId: room.id, reason: why }, `Encerrar a sala “${room.name}”?`);
  };
  actions.append(close);
  card.append(actions);
  return card;
}

function renderRooms(rooms, query = '') {
  const term = query.trim().toLowerCase();
  const filtered = term ? rooms.filter((room) => [
    room.id, room.name, room.guildId, room.channelId,
    ...(room.participants || []).flatMap((person) => [person.id, person.name]),
  ].some((value) => String(value || '').toLowerCase().includes(term))) : rooms;
  $('#rooms').replaceChildren(...(filtered.length ? filtered.map(roomCard) : [empty('Nenhuma sala corresponde ao filtro.') ]));
}

function changeLabel(current, previous) {
  const before = Number(previous || 0);
  const now = Number(current || 0);
  if (!before) return now ? 'novo movimento' : 'sem atividade';
  const percent = Math.round(((now - before) / before) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}% vs. 7 dias anteriores`;
}

function renderAnalytics(analytics = {}) {
  const summary = analytics.summary || {};
  const cards = [
    ['Aberturas · 7 dias', number(summary.launches7d), changeLabel(summary.launches7d, summary.previousLaunches7d)],
    ['Transmissões · 7 dias', number(summary.streams7d), changeLabel(summary.streams7d, summary.previousStreams7d)],
    ['Salas criadas · 30 dias', number(summary.rooms30d), 'somente contagem agregada'],
    ['Servidores ativos · 30 dias', number(summary.activeServers30d), 'com pelo menos uma abertura'],
    ['Duração média', duration(summary.averageStreamMs30d), `${number(summary.completedStreams30d)} transmissões concluídas`],
    ['Maior transmissão', duration(summary.longestStreamMs30d), 'nos últimos 30 dias'],
  ];
  $('#analyticsSummary').replaceChildren(...cards.map(([label, value, detail]) => {
    const card = el('article', 'metric-card');
    card.append(el('span', '', label), el('strong', '', value), el('small', '', detail));
    return card;
  }));

  const daily = analytics.daily || [];
  const maxDaily = Math.max(1, ...daily.flatMap((item) => [Number(item.launches), Number(item.streams)]));
  $('#activityChart').replaceChildren(...(daily.length ? daily.map((item) => {
    const column = el('div', 'trend-column');
    const bars = el('div', 'trend-bars');
    const launches = el('i', 'trend-bar launches');
    launches.style.height = `${Math.max(2, Number(item.launches) / maxDaily * 100)}%`;
    launches.title = `${number(item.launches)} abertura(s)`;
    const streams = el('i', 'trend-bar streams');
    streams.style.height = `${Math.max(2, Number(item.streams) / maxDaily * 100)}%`;
    streams.title = `${number(item.streams)} transmissão(ões)`;
    bars.append(launches, streams);
    column.append(bars, el('span', '', item.day.slice(8)));
    return column;
  }) : [empty('Ainda não há atividade suficiente para o gráfico.') ]));

  const byHour = new Map((analytics.hourly || []).map((item) => [Number(item.hour), Number(item.launches)]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, launches: byHour.get(hour) || 0 }));
  const maxHour = Math.max(1, ...hours.map((item) => item.launches));
  $('#hourlyChart').replaceChildren(...hours.map((item) => {
    const row = el('div', 'hour-row');
    const label = el('span', '', `${String(item.hour).padStart(2, '0')}h`);
    const track = el('div', 'hour-track');
    const bar = el('i', 'hour-bar');
    bar.style.width = `${item.launches / maxHour * 100}%`;
    track.append(bar);
    row.append(label, track, el('strong', '', number(item.launches)));
    return row;
  }));

  const top = analytics.topServers || [];
  $('#topServers').replaceChildren(...(top.length ? top.map((server, index) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', `${index + 1}. ${server.name}`));
    main.append(el('span', '', `Última atividade ${date(server.lastSeen)}`));
    row.append(main, el('span', 'badge', `${number(server.launches)} abertura(s)`));
    return row;
  }) : [empty('Nenhum servidor ativo neste período.') ]));
}

const percent = (value, total) => total ? `${Math.round(Number(value || 0) / Number(total) * 100)}%` : '0%';
const eventLabels = {
  activity_launch: 'Aberturas da Atividade', room_created: 'Salas criadas', room_deleted: 'Salas encerradas',
  stream_started: 'Transmissões iniciadas', stream_stopped: 'Transmissões finalizadas',
  application_authorized: 'Instalações autorizadas', application_deauthorized: 'Instalações removidas',
};

function renderTechnicalAnalytics(analytics = {}) {
  const tech = analytics.technical || {};
  const completed = Number(tech.completedStreams30d || 0);
  const cards = [
    ['Transmissões com áudio', percent(tech.streamsWithAudio30d, completed), `${number(tech.streamsWithAudio30d)} de ${number(completed)}`],
    ['Interrompidas por conexão', percent(tech.disconnectedStreams30d, completed), `${number(tech.disconnectedStreams30d)} ocorrência(s)`],
    ['Encerradas com a sala', number(tech.roomClosedStreams30d), 'encerramento administrativo ou da sala'],
    ['Configuração média', tech.averageWidth30d && tech.averageHeight30d ? `${tech.averageWidth30d}×${tech.averageHeight30d}` : '—', tech.averageFps30d ? `${tech.averageFps30d} fps` : 'fps não informado'],
    ['Bitrate médio', tech.averageBitrate30d ? `${(tech.averageBitrate30d / 1_000_000).toFixed(1)} Mb/s` : '—', 'configuração enviada pelo transmissor'],
    ['Origem das salas', `${number(tech.callRooms30d)} calls`, `${number(tech.linkRooms30d)} salas por link`],
    ['Instalações conhecidas', `${number(tech.installedServers)}/${number(tech.knownServers)}`, 'autorizadas / servidores observados'],
  ];
  $('#technicalMetrics').replaceChildren(...cards.map(([label, value, detail]) => {
    const card = el('article', 'metric-card');
    card.append(el('span', '', label), el('strong', '', value), el('small', '', detail));
    return card;
  }));

  const codecs = analytics.codecs || [];
  const codecTotal = codecs.reduce((sum, item) => sum + Number(item.total || 0), 0);
  $('#codecMetrics').replaceChildren(...(codecs.length ? codecs.map((item) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', String(item.codec).replace(/^avc1.*/i, 'H.264')));
    main.append(el('span', '', `${percent(item.total, codecTotal)} das transmissões concluídas`));
    row.append(main, el('span', 'badge', number(item.total)));
    return row;
  }) : [empty('Nenhuma configuração de codec registrada.') ]));

  const events = analytics.eventKinds || [];
  $('#eventMetrics').replaceChildren(...(events.length ? events.map((item) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', eventLabels[item.kind] || item.kind));
    main.append(el('span', '', `Último registro ${date(item.lastSeen)}`));
    row.append(main, el('span', 'badge', number(item.total)));
    return row;
  }) : [empty('Nenhum evento operacional no período.') ]));

  const inventory = analytics.dataInventory || {};
  const lines = [
    ['Eventos armazenados', number(inventory.storedEvents)],
    ['Usuários ativos · 24h', number(inventory.activeUsers24h)],
    ['Usuários ativos · 7 dias', number(inventory.activeUsers7d)],
    ['Servidores ativos · 7 dias', number(inventory.activeServers7d)],
    ['Evento mais antigo', date(inventory.oldestEventAt)],
    ['Evento mais recente', date(inventory.newestEventAt)],
    ['Retenção automática', '90 dias'],
    ['Nomes em eventos', '30 dias'],
  ];
  $('#dataInventory').replaceChildren(...lines.map(([label, value]) => {
    const row = el('div', 'inventory-row');
    row.append(el('span', '', label), el('strong', '', value));
    return row;
  }));
}

function renderServers(servers, query = '') {
  const term = query.trim().toLowerCase();
  const filtered = term ? servers.filter((server) => [
    server.guildId, server.name, server.lastChannelName, server.authorizedByName, server.authorizedBy,
  ]
    .some((value) => String(value || '').toLowerCase().includes(term))) : servers;
  const rows = filtered.map((server) => {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const cell = el('div', 'server-cell');
    if (server.icon) {
      const image = document.createElement('img');
      image.className = 'server-icon';
      image.alt = '';
      image.src = `https://cdn.discordapp.com/icons/${server.guildId}/${server.icon}.webp?size=64`;
      image.addEventListener('error', () => {
        image.classList.add('brand-fallback');
        image.src = '/brand/wnd-dizzy.png';
      }, { once: true });
      cell.append(image);
    } else {
      const image = document.createElement('img');
      image.className = 'server-icon brand-fallback';
      image.src = '/brand/wnd-dizzy.png';
      image.alt = '';
      cell.append(image);
    }
    const names = el('span', 'server-name');
    names.append(el('strong', '', server.name || 'Servidor sem nome'), el('small', '', server.guildId));
    cell.append(names);
    identity.append(cell);
    row.append(identity);
    const installer = document.createElement('td');
    const installerName = server.authorizedByName || (server.authorizedBy ? 'Usuário do Discord' : 'Não informado');
    installer.append(el('span', 'server-name', installerName));
    if (server.authorizedBy) installer.querySelector('.server-name').append(el('small', '', server.authorizedBy));
    row.append(installer);
    row.append(el('td', '', server.lastChannelName || server.lastChannelId || '—'));
    row.append(el('td', '', number(server.launches)));
    row.append(el('td', '', date(server.lastSeen)));
    const state = document.createElement('td');
    state.append(el('span', `badge ${server.installed ? 'installed' : ''}`, server.installed ? 'Autorizado' : 'Uso registrado'));
    row.append(state);
    const controls = document.createElement('td');
    const button = el('button', 'button danger-outline small', 'Bloquear');
    button.onclick = () => {
      const why = reason('Servidor bloqueado pela administração');
      if (why) action({ action: 'block-guild', guildId: server.guildId, reason: why }, `Bloquear o servidor “${server.name || server.guildId}”?`);
    };
    controls.append(button);
    row.append(controls);
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.append(empty('O histórico começa a ser preenchido quando a Atividade for aberta novamente.'));
    row.append(cell);
    rows.push(row);
  }
  $('#servers').replaceChildren(...rows);
}

function renderBlocks(blocks) {
  const rows = blocks.map((block) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', `${block.subjectType === 'guild' ? 'Servidor' : 'Usuário'} · ${block.subjectId}`));
    main.append(el('span', '', `${block.reason || 'Sem motivo'} · ${block.expiresAt ? `até ${date(block.expiresAt)}` : 'permanente'}`));
    const remove = el('button', 'button secondary small', 'Remover');
    remove.onclick = () => action({ action: 'unblock', subjectType: block.subjectType, subjectId: block.subjectId }, 'Remover este bloqueio?');
    row.append(main, remove);
    return row;
  });
  $('#blocks').replaceChildren(...(rows.length ? rows : [empty('Nenhum usuário ou servidor bloqueado.') ]));
}

const actionLabels = {
  'close-room': 'Encerrou uma sala',
  'kick-user': 'Desconectou um usuário',
  'block-user': 'Bloqueou um usuário',
  'block-guild': 'Bloqueou um servidor',
  unblock: 'Removeu um bloqueio',
  maintenance: 'Alterou o modo de manutenção',
  'publish-changelog': 'Publicou um changelog',
  'set-supporter': 'Cadastrou ou atualizou um apoiador',
  'remove-supporter': 'Removeu um apoiador',
  'toggle-changelog-channel': 'Alterou o recebimento de changelogs',
};

function renderSupporters(supporters = []) {
  const active = supporters.filter((item) => item.active);
  $('#supporterStatus').textContent = `${number(active.length)} ativo(s)`;
  $('#supporters').replaceChildren(...(supporters.length ? supporters.map((supporter) => {
    const row = el('div', `stack-row ${supporter.active ? '' : 'inactive'}`.trim());
    const main = el('div', 'stack-main');
    const label = supporter.tier === 'founder' ? 'Fundador' : 'Apoiador';
    main.append(el('strong', '', `${supporter.publicName || supporter.userId} · ${label}`));
    main.append(el('span', '', `${supporter.userId} · ${supporter.expiresAt ? `até ${date(supporter.expiresAt)}` : 'permanente'}${supporter.showCredit ? ' · créditos públicos' : ''}`));
    const remove = el('button', 'button danger-outline small', 'Remover');
    remove.onclick = () => action(
      { action: 'remove-supporter', userId: supporter.userId },
      `Remover os benefícios de ${supporter.publicName || supporter.userId}?`
    );
    row.append(main, remove);
    return row;
  }) : [empty('Nenhum apoiador cadastrado ainda.')]));
}

function renderBotDiagnostics(bot = {}) {
  const box = $('#botDiagnostics');
  const status = el('div', `bot-health ${bot.valid ? 'healthy' : 'unhealthy'}`);
  status.append(
    el('strong', '', bot.valid ? `${bot.name || 'Bot'} conectado` : bot.configured ? 'Bot com problema' : 'Bot não configurado'),
    el('span', '', bot.valid
      ? `${bot.guildCount === null || bot.guildCount === undefined ? '—' : number(bot.guildCount)} servidor(es) · verificado ${date(bot.checkedAt)}`
      : bot.error || 'Configure DISCORD_BOT_TOKEN na Cloudflare.')
  );
  box.replaceChildren(status);
}

function renderChangelog(changelog = {}, botConfigured, installUrl, bot = {}) {
  const channels = changelog.channels || [];
  const enabled = channels.filter((item) => item.enabled);
  $('#changelogStatus').textContent = botConfigured
    ? `${number(enabled.length)} canal(is) ativo(s)`
    : 'Bot ainda não configurado';
  $('#publishChangelog').disabled = !botConfigured || !enabled.length;
  $('#installBot').href = installUrl || '/changelog/install';
  renderBotDiagnostics(bot);

  $('#changelogChannels').replaceChildren(...(channels.length ? channels.map((channel) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', `${channel.guildName || channel.guildId} · #${channel.channelName || channel.channelId}`));
    main.append(el('span', '', channel.enabled
      ? `ativo${channel.lastSentAt ? ` · último envio ${date(channel.lastSentAt)}` : ''}`
      : `desativado${channel.lastError ? ` · ${channel.lastError}` : ''}`));
    const toggle = el('button', `button ${channel.enabled ? 'danger-outline' : 'secondary'} small`, channel.enabled ? 'Desativar' : 'Reativar');
    toggle.onclick = () => action(
      { action: 'toggle-changelog-channel', guildId: channel.guildId, enabled: !channel.enabled },
      `${channel.enabled ? 'Desativar' : 'Reativar'} as novidades em #${channel.channelName || channel.channelId}?`
    );
    row.append(main, toggle);
    return row;
  }) : [empty('Nenhum servidor escolheu um canal ainda.')]));

  const history = changelog.history || [];
  $('#changelogHistory').replaceChildren(...(history.length ? history.map((publication) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', `${publication.version ? `v${publication.version} · ` : ''}${publication.title}`));
    main.append(el('span', '', `${publication.successCount} enviado(s) · ${publication.failureCount} falha(s) · ${date(publication.createdAt)}`));
    row.append(main);
    return row;
  }) : [empty('Nenhum changelog publicado pelo painel.')]));
}

function renderAudit(audit, query = '') {
  const term = query.trim().toLowerCase();
  const filtered = term ? audit.filter((entry) => [
    entry.adminName, entry.action, actionLabels[entry.action], entry.targetId,
  ].some((value) => String(value || '').toLowerCase().includes(term))) : audit;
  const rows = filtered.map((entry) => {
    const row = el('div', 'stack-row');
    const main = el('div', 'stack-main');
    main.append(el('strong', '', `${entry.adminName} · ${actionLabels[entry.action] || entry.action}`));
    main.append(el('span', '', `${entry.targetId || 'aplicativo'} · ${date(entry.createdAt)}`));
    row.append(main);
    return row;
  });
  $('#audit').replaceChildren(...(rows.length ? rows : [empty('As próximas ações administrativas aparecerão aqui.') ]));
}

function renderOperations(operations = {}, bot = {}) {
  const cards = [
    ['Sessão administrativa', `${operations.sessionHours || '—'} horas`, 'Renovada somente após novo login'],
    ['Proteção contra abuso', operations.rateLimits ? 'Ativa' : 'Indisponível', 'Limites por origem sem armazenar o IP'],
    ['Privacidade', `${operations.nameRetentionDays || '—'} dias`, 'Nomes antigos são removidos dos eventos'],
    ['Bot e webhook', bot.valid && operations.webhookConfigured ? 'Saudáveis' : 'Requer atenção', bot.valid ? 'Bot conectado' : 'Bot indisponível'],
  ];
  $('#operations').replaceChildren(...cards.map(([label, value, detail], index) => {
    const warning = index === 3 && !(bot.valid && operations.webhookConfigured);
    const card = el('article', `operation-card ${warning ? 'warning' : ''}`.trim());
    card.append(el('span', '', label), el('strong', '', value), el('span', '', detail));
    return card;
  }));
  const alerts = operations.alerts || [];
  $('#operationalAlerts').replaceChildren(...(alerts.length ? alerts.map((alert) => {
    const row = el('div', 'stack-row');
    row.append(el('div', 'stack-main', alert.message));
    return row;
  }) : [empty('Nenhum alerta operacional neste momento.') ]));
}

function applyFilters() {
  if (!currentOverview) return;
  renderRooms(currentOverview.rooms || [], $('#roomFilter').value);
  renderServers(currentOverview.servers || [], $('#serverFilter').value);
  renderAudit(currentOverview.audit || [], $('#auditFilter').value);
}

async function loadOverview(silent = false) {
  const refresh = $('#refresh');
  if (!silent) refresh.disabled = true;
  try {
    const data = await post('/api/admin/overview');
    currentOverview = data;
    renderStats(data.totals || {});
    renderChart(data.daily || []);
    renderAnalytics(data.analytics || {});
    renderTechnicalAnalytics(data.analytics || {});
    renderRooms(data.rooms || []);
    renderServers(data.servers || []);
    renderBlocks(data.blocks || []);
    renderSupporters(data.supporters || []);
    renderAudit(data.audit || []);
    renderChangelog(data.changelog, data.botConfigured, data.installUrl, data.bot);
    renderOperations(data.operations, data.bot);
    $('#updatedAt').textContent = `Atualizado ${date(data.generatedAt)}`;
    $('#maintenanceBanner').hidden = !data.maintenance;
    $('#enableMaintenance').hidden = Boolean(data.maintenance);
    const app = data.application;
    const webhookConfigured = Boolean(app?.webhookTypes?.length) || app?.webhookStatus === 2;
    $('#appCounts').textContent = app
      ? `${app.approximateGuildCount ?? '—'} instalação(ões) aproximada(s) · webhook ${webhookConfigured ? 'configurado' : 'ainda sem confirmação'}`
      : 'Informações do Discord temporariamente indisponíveis';
  } catch (problem) {
    if (problem.status === 401) return showLogin();
    if (!silent) showToast(problem.message, true);
  } finally {
    refresh.disabled = false;
  }
}

for (const id of ['roomFilter', 'serverFilter', 'auditFilter']) {
  $(`#${id}`).addEventListener('input', applyFilters);
}

function showLogin() {
  dashboard.hidden = true;
  login.hidden = false;
  clearInterval(refreshTimer);
  const error = new URLSearchParams(location.search).get('erro');
  if (error === 'sem_acesso') $('#loginMessage').textContent = 'Esta conta ainda não foi autorizada para administrar o aplicativo. Confira ADMIN_DISCORD_IDS na Cloudflare.';
  else if (error) $('#loginMessage').textContent = 'Não foi possível concluir a entrada. Tente novamente.';
}

async function start() {
  try {
    const result = await post('/api/admin/me');
    admin = result.user;
    login.hidden = true;
    dashboard.hidden = false;
    $('#welcome').textContent = `Olá, ${admin.name}`;
    $('#adminIdentity').textContent = `Administrador: ${admin.name} · ${admin.id}`;
    await loadOverview();
    refreshTimer = setInterval(() => loadOverview(true), 10_000);
  } catch (problem) {
    if (problem?.message && problem.status !== 401) {
      $('#loginMessage').textContent = `Não foi possível validar a sessão: ${problem.message}`;
    }
    showLogin();
  }
}

$('#refresh').onclick = () => loadOverview();
$('#enableMaintenance').onclick = () => action(
  { action: 'maintenance', enabled: true },
  'Ativar manutenção? Todas as salas serão encerradas e novas entradas ficarão suspensas.'
);
$('#disableMaintenance').onclick = () => action(
  { action: 'maintenance', enabled: false },
  'Reabrir o aplicativo para todos?'
);

$('#supporterTier').addEventListener('change', () => {
  $('#supporterDaysField').hidden = $('#supporterTier').value === 'founder';
});

$('#supporterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const userId = $('#supporterUserId').value.trim();
  if (!/^\d{15,21}$/.test(userId)) return showToast('Informe um ID válido do Discord.', true);
  const publicName = $('#supporterPublicName').value.trim();
  if ($('#supporterCredit').checked && !publicName) return showToast('Informe o nome que aparecerá nos agradecimentos.', true);
  try {
    await post('/api/admin/action', {
      action: 'set-supporter', userId, publicName,
      tier: $('#supporterTier').value,
      durationDays: Number($('#supporterDays').value || 90),
      showCredit: $('#supporterCredit').checked,
    });
    showToast('Apoiador salvo. O badge aparecerá na próxima entrada no aplicativo.');
    $('#supporterForm').reset();
    $('#supporterDays').value = '90';
    $('#supporterDaysField').hidden = false;
    await loadOverview(true);
  } catch (problem) {
    showToast(problem.message, true);
  }
});

$('#changelogForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('#changelogTitle').value.trim();
  const summary = $('#changelogSummary').value.trim();
  const details = $('#changelogDetails').value.trim();
  if (!title || (!summary && !details)) return showToast('Preencha o título e a descrição.', true);
  const targets = $('#changelogStatus').textContent;
  if (!confirm(`Publicar “${title}” agora para ${targets}?`)) return;
  const button = $('#publishChangelog');
  button.disabled = true;
  try {
    const result = await post('/api/admin/changelog/publish', {
      version: $('#changelogVersion').value.trim(), title, summary, details,
    });
    showToast(`${result.successCount} envio(s) concluído(s)${result.failureCount ? ` · ${result.failureCount} falha(s)` : ''}.`, Boolean(result.failureCount));
    $('#changelogForm').reset();
    await loadOverview(true);
  } catch (problem) {
    showToast(problem.message, true);
    button.disabled = false;
  }
});

start();
