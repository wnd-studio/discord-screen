const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const setupToken = query.get('s');

const errors = {
  bot_nao_configurado: 'O proprietário ainda precisa ativar o bot no aplicativo.',
  bot_invalido: 'O token do bot foi recusado pelo Discord. O proprietário precisa gerar e cadastrar um novo token.',
  estado_invalido: 'A autorização perdeu a validade. Inicie novamente.',
  sem_permissao: 'Somente alguém com permissão para administrar o servidor pode concluir esta configuração.',
  sem_codigo: 'A autorização foi cancelada antes de terminar.',
  troca_falhou: 'O Discord não concluiu a autorização. Tente novamente.',
  perfil_falhou: 'Não foi possível confirmar sua conta do Discord.',
};

function fail(message) {
  $('loading').hidden = true;
  $('form').hidden = true;
  $('failure').hidden = false;
  $('failureText').textContent = message;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
  return data;
}

async function start() {
  const namedError = query.get('erro');
  if (namedError || !setupToken) return fail(errors[namedError] || 'Este link expirou. Instale novamente para continuar.');
  try {
    const data = await request(`/api/changelog/channels?s=${encodeURIComponent(setupToken)}`);
    if (data.guilds?.length > 1 && !data.guild) {
      $('guild').replaceChildren(...data.guilds.map((guild) => {
        const option = document.createElement('option');
        option.value = guild.id;
        option.textContent = guild.name;
        return option;
      }));
      $('guildLabel').hidden = false;
      $('guild').hidden = false;
      await loadGuild($('guild').value);
    } else {
      showGuild(data);
    }
    $('loading').hidden = true;
    $('form').hidden = false;
  } catch (problem) {
    fail(problem.message);
  }
}

function showGuild(data) {
  if (!data.guild) throw new Error('Não encontramos um servidor administrável onde o aplicativo esteja instalado.');
  if (!data.channels?.length) throw new Error('Não encontramos um canal de texto acessível nesse servidor.');
  $('guild').value = data.guild.id;
  $('guildLine').textContent = `Escolha onde o servidor “${data.guild.name}” receberá as atualizações.`;
  $('channel').replaceChildren(...data.channels.map((channel) => {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = `# ${channel.name}`;
    return option;
  }));
}

async function loadGuild(guildId) {
  $('channel').disabled = true;
  try {
    const data = await request(`/api/changelog/channels?s=${encodeURIComponent(setupToken)}&guild=${encodeURIComponent(guildId)}`);
    showGuild(data);
  } finally {
    $('channel').disabled = false;
  }
}

$('guild').addEventListener('change', () => loadGuild($('guild').value).catch((problem) => fail(problem.message)));

$('confirm').addEventListener('click', async () => {
  $('confirm').disabled = true;
  $('status').className = '';
  $('status').textContent = 'Enviando a mensagem de teste…';
  try {
    const data = await request('/api/changelog/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken, guildId: $('guild').value, channelId: $('channel').value }),
    });
    $('form').hidden = true;
    $('success').hidden = false;
    $('successText').textContent = `As próximas novidades serão enviadas em #${data.channelName}, no servidor ${data.guildName}.`;
    $('status').textContent = '';
  } catch (problem) {
    $('status').className = 'error';
    $('status').textContent = problem.message;
    $('confirm').disabled = false;
  }
});

start();
