# Sala de Tela — Cloudflare

Aplicação de compartilhamento de tela integrada ao Discord. O frontend continua
sendo Vite/WebCodecs; HTTP, OAuth, salas e WebSockets rodam em Cloudflare Workers
e Durable Objects.

## Arquitetura

- **Worker + Static Assets:** frontend, páginas de captura, termos e privacidade.
- **`RoomRegistry` Durable Object:** índice persistente das salas por instância.
- **`Room` Durable Object:** uma unidade por sala, responsável por senha, estado,
  participantes, WebSockets e relay binário.
- **Discord OAuth2:** troca de código e consulta de perfil sempre no Worker; o
  Client Secret nunca chega ao navegador.
- **Tokens HMAC:** identidades e acessos de sala assinados com `SESSION_SECRET`.

Recursos práticos já incluídos:

- salas públicas ou privadas por link;
- convite copiável direto da sala;
- senha opcional e bloqueio contra tentativas repetidas;
- dono da sala pode remover participantes;
- links de acesso expiram em 8 horas;
- até 50 espectadores e 4 transmissores por sala;
- o transmissor pausa a codificação quando ninguém está assistindo.

Veja os detalhes do protocolo em [docs/como-funciona.md](docs/como-funciona.md).

## Pré-requisitos

- Node.js 20.19+ ou 22.12+;
- pnpm 11;
- conta Cloudflare com Workers habilitado;
- aplicação no Discord Developer Portal.

## Desenvolvimento local

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm dev
```

No Windows, copie `.dev.vars.example` para `.dev.vars` pelo Explorer ou use:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Preencha `.dev.vars`. O arquivo real é ignorado pelo Git.

## Variáveis e secrets

Secrets obrigatórios em produção:

- `DISCORD_CLIENT_ID` — ID público da aplicação Discord;
- `DISCORD_CLIENT_SECRET` — secret OAuth2 da aplicação;
- `SESSION_SECRET` — valor aleatório forte usado para assinar tokens.

Secret opcional:

- `DISCORD_BOT_TOKEN` — habilita a conferência de presença no canal de voz.

Variável recomendada:

- `PUBLIC_ORIGIN` — origem pública sem barra final, por exemplo
  `https://tela.seudominio.com`. É usada no callback OAuth e no link da aba de
  captura. Configure-a como secret para evitar manter domínio específico no Git.

Gere o segredo de sessão, por exemplo, com:

```bash
openssl rand -base64 48
```

## Publicação exata na Cloudflare

1. Instale as dependências e autentique o Wrangler:

   ```bash
   pnpm install
   pnpm exec wrangler login
   ```

2. Cadastre os secrets, um comando de cada vez:

   ```bash
   pnpm exec wrangler secret put DISCORD_CLIENT_ID
   pnpm exec wrangler secret put DISCORD_CLIENT_SECRET
   pnpm exec wrangler secret put SESSION_SECRET
   pnpm exec wrangler secret put PUBLIC_ORIGIN
   ```

3. Se usar verificação de call, cadastre também:

   ```bash
   pnpm exec wrangler secret put DISCORD_BOT_TOKEN
   ```

4. Publique Worker, assets e Durable Objects juntos:

   ```bash
   pnpm deploy
   ```

5. Copie a URL exibida pelo Wrangler. Se quiser domínio próprio, abra
   **Cloudflare Dashboard → Workers & Pages → discord-screen → Settings →
   Domains & Routes → Add → Custom Domain**. Depois atualize `PUBLIC_ORIGIN` e
   rode `pnpm deploy` novamente.

6. Confirme `https://SEU_HOST/api/health`. A resposta deve conter
   `"architecture":"cloudflare-workers-durable-objects"`.

## Configuração no Discord Developer Portal

Para a URL pública `https://tela.seudominio.com`, configure:

- **OAuth2 Redirect URI:** `https://tela.seudominio.com/auth/callback`
- **Activities → URL Mappings → `/`:** `https://tela.seudominio.com`

Se usar o subdomínio `workers.dev`, use exatamente esse host nos dois lugares.
Não inclua barra final no redirect e mantenha `PUBLIC_ORIGIN` idêntico ao host
publicado.

## Comandos

| Comando | Função |
|---|---|
| `pnpm build` | monta o frontend e reúne os assets públicos |
| `pnpm dev` | inicia Worker e Durable Objects localmente |
| `pnpm check` | valida o bundle com dry-run do Wrangler |
| `pnpm smoke` | testa HTTP, sala privada, senha, moderação, WebSocket e relay contra `pnpm dev` |
| `pnpm deploy` | build e publicação na Cloudflare |
| `pnpm cf:typegen` | gera tipos dos bindings Cloudflare |

## Limitações

- Compartilhar tela no celular continua indisponível por restrição do navegador.
- A transmissão usa relay WebSocket, não WebRTC/SFU; cada espectador multiplica
  a saída e o número prático depende dos limites de CPU/memória do Durable Object.
- O plano gratuito tem cotas diárias. A Cloudflare contabiliza mensagens
  WebSocket recebidas na proporção 20:1; só o vídeo contínuo a 60 fps usa cerca
  de 10,8 mil requisições faturáveis por hora, antes do áudio e das chamadas HTTP.
  Portanto, o serviço pode ficar publicado 24/7 sem custo, mas streaming intenso
  ou mais de uma sala continuamente ativa pode exigir o plano pago.
- A captura e reprodução dependem de WebCodecs; navegadores sem suporte completo
  podem não transmitir ou assistir corretamente.
- Até quatro transmissores simultâneos por sala, preservando o limite original.
- O limite de segurança atual é de 50 espectadores conectados por sala. A cota
  gratuita pode acabar antes disso se muitas pessoas assistirem por muitas horas.
- A remoção de um participante vale enquanto aquela sala existir. Como salas
  vazias são apagadas automaticamente, não há uma lista permanente de banidos.
