# Como funciona

## Fluxo

1. O frontend é servido pelos Static Assets do mesmo Worker.
2. Dentro do Discord, o SDK entrega um código OAuth e `/api/token` troca esse
   código usando o Client Secret somente no Worker. Fora do Discord,
   `/auth/login` e `/auth/callback` executam o fluxo OAuth web.
3. O Worker consulta `/users/@me`, emite uma identidade HMAC e cria/entra em uma
   sala.
4. O índice global (`RoomRegistry`) mantém apenas metadados pesquisáveis. Cada
   sala possui seu próprio `Room` Durable Object.
5. Viewer e broadcaster abrem `/ws?t=...`; o Worker valida o token e encaminha o
   upgrade ao objeto da sala.

## Captura e transmissão

A Discord Activity roda em iframe sem permissão `display-capture`, então a
captura continua numa aba normal (`share.html`). `shared/broadcaster.js` usa
`getDisplayMedia` e WebCodecs. O Durable Object não decodifica mídia: valida o
slot e retransmite o pacote binário apenas aos espectadores que enviaram
`watch`.

Formato preservado:

```text
[1B slot][1B tipo: 1=keyframe 2=delta 3=áudio][8B tempo][8B relógio][payload]
```

Eventos de controle preservados:

- broadcaster → sala: `start`, `config`, `audio-config`, `stop`;
- viewer → sala: `rename`, `watch`, `unwatch`, `stop-broadcast`;
- sala → clientes: `state`, `stream-start`, `config`, `audio-config`,
  `stream-stop`, `need-keyframe`, `stop-request`, `error`.

## Estado e hibernação

Metadados e senhas ficam no storage SQLite do Durable Object. Conexões usam a
WebSocket Hibernation API; papel, usuário, slot, configurações e telas assistidas
ficam em attachments serializados, permitindo reconstruir a sala quando o objeto
acorda. Salas vazias recebem um alarm de 12 segundos e depois removem seus dados
e a entrada no índice.

## Segurança

- tokens são HMAC-SHA-256 via Web Crypto;
- senhas usam PBKDF2-SHA-256 com salt aleatório e 120 mil iterações;
- há limite e bloqueio temporário para tentativas de senha;
- tokens de identidade não abrem WebSocket de sala;
- um broadcaster só injeta pacotes no slot que recebeu;
- avatar proxy aceita apenas ID/hash no formato Discord;
- `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` e `SESSION_SECRET` existem apenas
  como secrets do Worker.

## Estrutura

```text
worker/index.js       roteamento HTTP, OAuth, tokens e despacho de WebSocket
worker/room.js        Durable Object de uma sala e relay em tempo real
worker/registry.js    índice SQLite das salas
worker/tokens.js      assinatura/verificação HMAC
worker/passwords.js   hash/verificação de senha
client/               interface Vite preservada
server/public/        captura, termos e privacidade (somente assets estáticos)
shared/               pipeline WebCodecs compartilhado
wrangler.jsonc        assets, bindings e migrations Cloudflare
```


