# Como funciona

## Fluxo

1. O frontend é servido pelos Static Assets do mesmo Worker.
2. Dentro do Discord, o SDK entrega um código OAuth e `/api/token` troca esse
   código usando o Client Secret somente no Worker. Fora do Discord,
   `/auth/login` e `/auth/callback` executam o fluxo OAuth web.
3. O Worker consulta `/users/@me` e `/users/@me/guilds`, guarda somente os dados
   do servidor atual, emite uma identidade HMAC e cria/entra em uma sala.
4. O índice global (`RoomRegistry`) mantém as salas pesquisáveis e o histórico
   operacional de 90 dias. Cada sala possui seu próprio `Room` Durable Object.
5. Viewer e broadcaster abrem `/ws?t=...`; o Worker valida o token e encaminha o
   upgrade ao objeto da sala.
6. Salas privadas continuam acessíveis pelo link, mas não aparecem na lista
   pública. O dono pode alternar essa opção sem recriar a sala.

## Captura e transmissão

A Discord Activity roda em iframe sem permissão `display-capture`, então a
captura continua numa aba normal (`share.html`). `shared/broadcaster.js` usa
`getDisplayMedia` e WebCodecs. O Durable Object não decodifica mídia: valida o
slot e retransmite o pacote binário apenas aos espectadores que enviaram
`watch`. Quando não há nenhum espectador assistindo à tela, o transmissor fecha
os frames sem codificá-los e não envia áudio/vídeo, reduzindo o consumo da cota.

Formato preservado:

```text
[1B slot][1B tipo: 1=keyframe 2=delta 3=áudio][8B tempo][8B relógio][payload]
```

Eventos de controle preservados:

- broadcaster → sala: `start`, `config`, `audio-config`, `stop`;
- viewer → sala: `rename`, `watch`, `unwatch`, `stop-broadcast`, `kick` (dono);
- sala → clientes: `state`, `stream-start`, `config`, `audio-config`,
  `stream-stop`, `need-keyframe`, `stop-request`, `kicked`, `room-deleted`,
  `error`.

## Estado e hibernação

Metadados e senhas ficam no storage SQLite do Durable Object. Conexões usam a
WebSocket Hibernation API; papel, usuário, slot, configurações e telas assistidas
ficam em attachments serializados, permitindo reconstruir a sala quando o objeto
acorda. Salas vazias recebem um alarm de 12 segundos e depois removem seus dados
e a entrada no índice. O dono também pode excluir uma sala web imediatamente;
todos os participantes recebem `room-deleted` e são desconectados. Ao listar,
entradas antigas cujo objeto já não existe são removidas automaticamente.

## Administração e histórico

`/admin` usa o mesmo OAuth2 do Discord e aceita o proprietário da aplicação,
membros da equipe ou IDs configurados em `ADMIN_DISCORD_IDS`. A sessão fica em
cookie `HttpOnly`, `Secure` e `SameSite=Lax` por até 12 horas.

O registro global guarda aberturas da Atividade, servidores/canais atuais,
início e término de transmissões, bloqueios e auditoria. O painel pode encerrar
salas, desconectar ou bloquear usuários, bloquear servidores e ativar manutenção.
O vídeo e o áudio nunca fazem parte desse histórico.

O endpoint `/api/discord/events` valida a assinatura Ed25519 e recebe eventos
oficiais de autorização e desautorização da aplicação. A chave pública e a lista
de proprietários são descobertas por Client Credentials; nenhum segredo é enviado
ao navegador.

## Segurança

- tokens são HMAC-SHA-256 via Web Crypto;
- tokens de sala expiram em 8 horas;
- senhas usam PBKDF2-SHA-256 com salt aleatório e 100 mil iterações (máximo suportado pelo runtime da Cloudflare);
- há limite e bloqueio temporário para tentativas de senha;
- participantes removidos não conseguem reconectar enquanto a sala existir;
- bloqueios administrativos persistentes são conferidos também no upgrade WebSocket;
- ações administrativas ficam em trilha de auditoria;
- webhooks do Discord exigem assinatura Ed25519 válida;
- cada sala aceita até 50 espectadores e 4 transmissores simultâneos;
- tokens de identidade não abrem WebSocket de sala;
- um broadcaster só injeta pacotes no slot que recebeu;
- avatar proxy aceita apenas ID/hash no formato Discord;
- `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` e `SESSION_SECRET` existem apenas
  como secrets do Worker.

## Estrutura

```text
worker/index.js       roteamento HTTP, OAuth, administração e despacho de WebSocket
worker/discord.js     Client Credentials, proprietários e assinatura de webhook
worker/room.js        Durable Object de uma sala e relay em tempo real
worker/registry.js    salas, métricas, servidores, bloqueios e auditoria em SQLite
worker/tokens.js      assinatura/verificação HMAC
worker/passwords.js   hash/verificação de senha
client/               interface da transmissão e painel administrativo em Vite
server/public/        captura, termos e privacidade (somente assets estáticos)
shared/               pipeline WebCodecs compartilhado
wrangler.jsonc        assets, bindings e migrations Cloudflare
```
