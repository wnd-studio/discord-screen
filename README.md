<div align="center">
  <img src="https://cdn.discordapp.com/app-icons/1539449081527803925/2a48530cf46b16af0e11df6da6979af7.png?size=256" width="120" alt="Ícone do Screen Share">

  <h1>Screen Share</h1>

  <p><strong>Compartilhamento de tela simples e em tempo real para comunidades no Discord.</strong></p>

  <p>
    Uma Discord Activity desenvolvida para estudos, aulas, reuniões e trabalhos em grupo,<br>
    com backend serverless hospedado na Cloudflare.
  </p>

  <p>
    <img src="https://img.shields.io/badge/Discord-Activity-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord Activity">
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
    <img src="https://img.shields.io/badge/WebSocket-tempo_real-111827?style=flat-square" alt="WebSocket em tempo real">
    <img src="https://img.shields.io/badge/versao-0.4.0-22C55E?style=flat-square" alt="Versão 0.4.0">
  </p>

  <p>
    <a href="https://discord.com/oauth2/authorize?client_id=1539449081527803925">
      <img src="https://img.shields.io/badge/Instalar_no_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Instalar no Discord">
    </a>
    <a href="https://discord-screen.wendellsilvaa012.workers.dev">
      <img src="https://img.shields.io/badge/Abrir_versao_web-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Abrir versão web">
    </a>
  </p>

  <p>
    <a href="https://discord-screen.wendellsilvaa012.workers.dev/termos">Termos de uso</a>
    ·
    <a href="https://discord-screen.wendellsilvaa012.workers.dev/privacidade">Privacidade</a>
    ·
    <a href="docs/como-funciona.md">Documentação técnica</a>
    ·
    <a href="docs/hospedagem-do-zero.md">Hospede sua versão</a>
  </p>
</div>

---

## Sobre o projeto

O **Screen Share** é uma aplicação comunitária de compartilhamento de tela integrada ao Discord. Depois que a atividade é instalada, os participantes entram em um canal de voz, abrem o Screen Share pelo menu de Aplicativos/Atividades e são colocados automaticamente na mesma sala.

Quem deseja transmitir clica em **Compartilhar tela** e escolhe uma tela, janela ou aba do navegador. O vídeo é comprimido no próprio computador, enviado em tempo real e reproduzido para as outras pessoas que estiverem com a atividade aberta.

O projeto também possui uma versão web. Nela é possível criar salas públicas ou privadas, proteger uma sala com senha e compartilhar um convite direto.

> O Screen Share não grava nem armazena o conteúdo das transmissões. Os pacotes de áudio e vídeo são apenas retransmitidos em tempo real.

## Por que o projeto foi adaptado para a Cloudflare?

A primeira versão utilizava uma arquitetura tradicional com **Node.js, Express, servidor HTTP e sessões mantidas em memória**. Ela funcionava localmente, mas dependia de um processo permanentemente ligado e apresentou problemas em serviços gratuitos de hospedagem — inclusive situações em que o deploy aparecia como ativo, mas as rotas HTTP não chegavam ao servidor.

Em vez de continuar criando configurações específicas para cada plataforma, o projeto foi refatorado para uma arquitetura compatível com a Cloudflare:

- o **Cloudflare Worker** recebe as requisições HTTP, processa o OAuth2 e entrega o frontend;
- os **Durable Objects** mantêm o estado das salas e suas conexões em tempo real;
- os **WebSockets** transportam os pacotes entre transmissores e espectadores;
- os **Static Assets** da Cloudflare entregam a interface e as páginas públicas;
- a aplicação é executada sob demanda, sem depender de um servidor Node ligado continuamente.

Com isso, o serviço pode permanecer publicado 24 horas por dia. As transmissões ativas continuam sujeitas às cotas do plano Cloudflare utilizado.

## Hospede sua própria versão

Quer instalar o projeto no seu computador ou publicar uma cópia independente? O guia abaixo começa do zero e acompanha todo o processo:

- instalação do Git, Node.js e pnpm;
- download do repositório;
- criação da aplicação no Discord;
- configuração segura dos secrets;
- primeiro deploy na Cloudflare;
- Redirect URI, URL Mapping e link de instalação;
- testes e solução dos problemas mais comuns.

### [Abrir o guia completo de hospedagem →](docs/hospedagem-do-zero.md)

O guia utiliza apenas serviços gratuitos para a configuração inicial. As cotas do plano Cloudflare continuam valendo para transmissões ativas.

## Como usar no Discord

1. Um administrador instala a atividade usando o botão **Instalar no Discord** no início desta página.
2. Os participantes entram no mesmo canal de voz.
3. Uma pessoa abre **Aplicativos/Atividades → Screen Share**.
4. Os demais participantes abrem ou entram na atividade iniciada.
5. Quem vai transmitir clica em **Compartilhar tela**.
6. Uma aba externa segura é aberta para escolher a tela, janela ou aba desejada.
7. Os espectadores mantêm a atividade aberta para acompanhar a transmissão.

A aba externa é necessária porque uma Discord Activity roda dentro de um `iframe` protegido. Esse ambiente possui restrições de segurança para a captura direta da tela do computador.

Para transmitir áudio, compartilhe uma **aba do navegador** e habilite a opção de compartilhar o som. Esse método também evita capturar novamente o áudio da chamada do Discord.

## Funcionalidades

| Recurso | Situação atual |
|---|---|
| Login com a conta do Discord | ✅ OAuth2 integrado |
| Sala automática por chamada do Discord | ✅ Disponível |
| Salas públicas na versão web | ✅ Disponível |
| Salas privadas por link | ✅ Disponível |
| Senha opcional para salas web | ✅ Disponível |
| Convites com prazo de validade | ✅ Expiram em 8 horas |
| Remoção de participantes pelo dono | ✅ Disponível nas salas web |
| Exclusão manual da sala pelo dono | ✅ Disponível nas salas web |
| Painel administrativo protegido | ✅ Disponível em `/admin` |
| Histórico de uso por servidor | ✅ Retenção operacional de 90 dias |
| Encerramento e bloqueios administrativos | ✅ Usuário, servidor ou sala |
| Eventos de autorização do Discord | ✅ Webhook assinado |
| Vídeo em tempo real | ✅ WebCodecs + WebSocket |
| Áudio de abas do navegador | ✅ Opus |
| Múltiplos transmissores | ✅ Até 4 por sala |
| Espectadores | ✅ Limite de segurança de 50 por sala |
| Gravação da transmissão | ❌ Não realizada |
| Transmissão iniciada pelo celular | ❌ Ainda não suportada |

O transmissor também interrompe a codificação quando ninguém está assistindo, reduzindo consumo de processamento e da cota da Cloudflare.

### Painel administrativo

Abra `https://SEU_HOST/admin` e entre com o Discord. O proprietário da aplicação e os membros da
equipe cadastrada no Developer Portal são reconhecidos automaticamente. IDs extras podem ser
adicionados em `ADMIN_DISCORD_IDS`.

O painel mostra salas ativas, participantes, transmissões, servidores onde a Atividade foi usada,
histórico de 90 dias e ações administrativas. É possível encerrar salas, desconectar ou bloquear
usuários, bloquear servidores e ativar o modo de manutenção. Nenhuma imagem ou áudio da transmissão
é exibido ou armazenado no painel.

## Arquitetura

```mermaid
flowchart LR
    U[Discord Activity ou navegador]
    W[Cloudflare Worker]
    D[Discord OAuth2]
    G[RoomRegistry + histórico administrativo]
    R[Room Durable Object]
    A[Static Assets]

    U <-->|HTTP e autenticação| W
    U <-->|WebSocket e mídia| R
    W <-->|OAuth2| D
    W --> G
    W --> R
    W --> A
```

### Componentes principais

- **Worker + Static Assets:** frontend, APIs, autenticação, página de captura, termos e privacidade.
- **`RoomRegistry` Durable Object:** índice persistente das salas, histórico operacional, servidores conhecidos, bloqueios e auditoria administrativa.
- **`Room` Durable Object:** uma unidade isolada por sala, responsável por participantes, senha, estado, WebSockets e relay binário.
- **Discord OAuth2:** troca o código de autorização e consulta o perfil no backend. O Client Secret nunca chega ao navegador.
- **WebCodecs:** codifica vídeo em H.264, VP8 ou VP9, de acordo com o suporte do navegador, e áudio em Opus.
- **Tokens HMAC:** assinam identidades, acessos e convites utilizando `SESSION_SECRET`.

Os detalhes do protocolo e do ciclo de uma transmissão estão em [docs/como-funciona.md](docs/como-funciona.md).

## Segurança e privacidade

- secrets são configurados como variáveis protegidas na Cloudflare;
- `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` e tokens privados não são incluídos no frontend;
- identidades e acessos de sala são assinados pelo backend;
- convites privados possuem prazo de validade;
- senhas de sala não são armazenadas em texto puro;
- áudio e vídeo não são gravados em banco de dados ou filesystem;
- o histórico contém somente metadados operacionais e eventos antigos são removidos depois de 90 dias;
- o painel `/admin` usa cookie seguro e aceita somente o proprietário/equipe da aplicação ou IDs explicitamente autorizados;
- eventos do Discord são aceitos apenas após validação da assinatura Ed25519;
- o frontend só recebe as informações necessárias para a sessão atual.

## Limitações atuais

- A transmissão deve ser iniciada por um computador. A captura de tela no celular ainda depende das limitações dos navegadores e do sistema operacional.
- O áudio deve vir de uma aba do navegador. A captura de áudio do sistema inteiro é bloqueada para evitar eco da chamada do Discord.
- A transmissão utiliza relay WebSocket, e não uma infraestrutura WebRTC/SFU. Cada espectador aumenta o tráfego de saída da sala.
- O plano gratuito da Cloudflare possui cotas diárias. O aplicativo pode ficar publicado continuamente, mas transmissões intensas ou várias salas ativas por muitas horas podem consumir a cota.
- Captura e reprodução dependem do suporte a WebCodecs. Navegadores incompatíveis podem não conseguir transmitir ou assistir.
- Uma interrupção na conexão do transmissor pode exigir que o compartilhamento seja iniciado novamente.
- O limite atual é de quatro transmissores e cinquenta espectadores conectados por sala.
- A remoção feita pelo dono vale enquanto a sala existir; a administração também pode aplicar bloqueios persistentes a usuários ou servidores.
- O Discord informa qual servidor autorizou a aplicação, mas o evento de desautorização não traz o servidor. Por isso o painel mantém o histórico de uso/autorização e mostra separadamente a contagem aproximada de instalações atuais fornecida pelo Discord.

---

<details>
<summary><strong>Executar o projeto localmente</strong></summary>

> Para uma instalação começando do zero, consulte o [guia completo de hospedagem](docs/hospedagem-do-zero.md).

### Pré-requisitos

- Node.js 20.19+ ou 22.12+;
- pnpm 11;
- conta Cloudflare com Workers habilitado;
- aplicação criada no Discord Developer Portal.

### Instalação

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm dev
```

No Windows, copie `.dev.vars.example` para `.dev.vars` pelo Explorer ou execute:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Preencha `.dev.vars` com as credenciais de desenvolvimento. O arquivo real é ignorado pelo Git.

</details>

<details>
<summary><strong>Variáveis e secrets</strong></summary>

### Obrigatórios

| Variável | Finalidade |
|---|---|
| `DISCORD_CLIENT_ID` | ID público da aplicação no Discord |
| `DISCORD_CLIENT_SECRET` | Credencial privada do OAuth2 |
| `SESSION_SECRET` | Valor aleatório forte para assinatura dos tokens |
| `PUBLIC_ORIGIN` | Endereço público da aplicação, sem barra no final |

### Opcional

| Variável | Finalidade |
|---|---|
| `DISCORD_BOT_TOKEN` | Permite conferir a presença do participante no canal de voz |
| `ADMIN_DISCORD_IDS` | IDs adicionais autorizados no painel, separados por vírgula; o proprietário da aplicação já é reconhecido automaticamente |
| `DISCORD_PUBLIC_KEY` | Chave pública para validar webhooks; normalmente é descoberta automaticamente pela API do Discord |

Nunca coloque valores reais desses secrets no código ou no repositório.

Para gerar um segredo de sessão:

```bash
openssl rand -base64 48
```

</details>

<details>
<summary><strong>Publicar na Cloudflare</strong></summary>

> Esta é a referência resumida. Iniciantes devem seguir o [guia completo de hospedagem](docs/hospedagem-do-zero.md), que também cobre a criação das contas e da aplicação Discord.

1. Instale as dependências e autentique o Wrangler:

   ```bash
   pnpm install
   pnpm exec wrangler login
   ```

2. Copie `.production.vars.example` para `.production.vars` e preencha os quatro secrets obrigatórios.

3. Faça o primeiro deploy enviando todos os secrets de forma protegida:

   ```bash
   pnpm build
   pnpm exec wrangler deploy --secrets-file .production.vars
   ```

4. Nos deploys seguintes, os secrets são preservados e basta executar:

   ```bash
   pnpm deploy
   ```

5. Confirme o funcionamento em `https://SEU_HOST/api/health`.

Para utilizar domínio próprio, abra **Cloudflare Dashboard → Workers & Pages → discord-screen → Settings → Domains & Routes → Add → Custom Domain**. Depois atualize `PUBLIC_ORIGIN` e publique novamente.

</details>

<details>
<summary><strong>Configurar o Discord Developer Portal</strong></summary>

Para a URL pública `https://tela.seudominio.com`, configure:

- **OAuth2 Redirect URI:** `https://tela.seudominio.com/auth/callback`
- **Activities → URL Mappings → `/`:** `tela.seudominio.com` (sem `https://`)
- **Installation Contexts:** `User Install` e `Guild Install`
- **Default Install Scope:** `applications.commands`
- **Webhooks → Endpoint URL:** `https://tela.seudominio.com/api/discord/events`
- **Webhook Events:** `APPLICATION_AUTHORIZED` e `APPLICATION_DEAUTHORIZED`

Se utilizar um endereço `workers.dev`, coloque exatamente esse mesmo host nos campos. Não adicione barra final ao redirect e mantenha `PUBLIC_ORIGIN` idêntico ao endereço publicado.

</details>

## Comandos do projeto

| Comando | Função |
|---|---|
| `pnpm build` | Monta o frontend e reúne os assets públicos |
| `pnpm dev` | Inicia Worker e Durable Objects localmente |
| `pnpm check` | Valida o bundle com um dry-run do Wrangler |
| `pnpm test:webhook` | Valida a assinatura Ed25519 dos eventos do Discord |
| `pnpm smoke` | Testa HTTP, salas, senha, painel administrativo, bloqueios, WebSocket e relay |
| `pnpm deploy` | Executa o build e publica na Cloudflare |
| `pnpm cf:typegen` | Gera tipos dos bindings Cloudflare |

## Tecnologias

`JavaScript` · `Vite` · `WebCodecs` · `WebSocket` · `Discord Embedded App SDK` · `Discord OAuth2` · `Cloudflare Workers` · `Cloudflare Durable Objects`

---

<div align="center">
  Desenvolvido como uma alternativa leve para transmissões de estudo e colaboração em comunidade.
</div>
