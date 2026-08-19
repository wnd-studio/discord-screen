# Hospedando sua própria versão — passo a passo completo

Este guia ensina a baixar, configurar, testar e publicar uma cópia independente do Screen Share. Ele foi escrito para quem está começando e utiliza a Cloudflare como hospedagem.

Ao terminar, você terá:

- sua própria aplicação no Discord;
- seu próprio Worker na Cloudflare;
- seus próprios secrets, separados dos secrets deste projeto;
- uma URL pública no formato `https://discord-screen.SEUSUBDOMINIO.workers.dev`;
- uma atividade que pode ser testada dentro do Discord e pelo navegador.

> **Importante:** nunca reutilize credenciais de outra instalação. Cada pessoa deve criar sua própria aplicação Discord e seus próprios secrets.

## 1. O que você precisa

Crie gratuitamente estas duas contas:

- [Cloudflare](https://dash.cloudflare.com/sign-up), para hospedar o Worker, os Durable Objects e o frontend;
- [Discord Developer Portal](https://discord.com/developers/applications), para criar a Activity e configurar o OAuth2.

Instale no computador:

- [Git](https://git-scm.com/downloads), para baixar e atualizar o projeto;
- [Node.js 22 LTS](https://nodejs.org/en/download), versão 22.12 ou mais recente;
- pnpm 11, instalado no passo seguinte.

Abra o PowerShell no Windows ou o Terminal no macOS/Linux e confira:

```bash
git --version
node --version
npm --version
```

Se algum comando não for reconhecido, feche e abra o terminal depois da instalação.

## 2. Instalar o pnpm

Execute:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm --version
```

Se `corepack` não estiver disponível, use:

```bash
npm install --global pnpm@11.19.0
pnpm --version
```

## 3. Baixar o projeto

Escolha uma pasta e execute:

```bash
git clone https://github.com/wnd-studio/discord-screen.git
cd discord-screen
pnpm install
```

Quem não quiser instalar o Git também pode abrir o repositório no GitHub, clicar em **Code → Download ZIP**, extrair o arquivo e abrir o terminal dentro da pasta extraída. Nesse caso, as atualizações futuras precisarão ser baixadas manualmente.

## 4. Criar sua aplicação no Discord

1. Abra o [Discord Developer Portal](https://discord.com/developers/applications).
2. Clique em **New Application**.
3. Escolha um nome e confirme a criação.
4. Em **General Information**, configure o nome, a descrição e o ícone desejados.
5. Guarde o **Application ID/Client ID**. Esse número é público e será usado como `DISCORD_CLIENT_ID`.

### Obter o Client Secret

1. No menu da aplicação, abra **OAuth2**.
2. Localize **Client Secret** e use **Reset Secret** se o portal solicitar.
3. Copie o valor naquele momento e guarde-o em local seguro.

Esse valor será o `DISCORD_CLIENT_SECRET`. Não envie esse secret para outras pessoas, não mostre em transmissões e não coloque no GitHub.

### Preparar a instalação da Activity

1. Abra **Installation**.
2. Em **Installation Contexts**, habilite **User Install** e **Guild Install**.
3. Em **Install Link**, escolha **Discord Provided Link**.
4. Em **Default Install Settings**, utilize o escopo `applications.commands` para os dois contextos.
5. Salve as alterações.
6. Abra **Activities → Settings** e habilite **Enable Activities**.

O Discord cria automaticamente o comando principal usado para iniciar a Activity.

Ainda não configure a URL definitiva. Primeiro publicaremos o Worker para descobrir o endereço exato.

## 5. Entrar na Cloudflare pelo terminal

Dentro da pasta do projeto, execute:

```bash
pnpm exec wrangler login
```

O navegador abrirá uma página da Cloudflare. Autorize o Wrangler e volte ao terminal. Depois confirme:

```bash
pnpm exec wrangler whoami
```

Se esta for sua primeira utilização de Workers, a Cloudflare poderá pedir a criação de um subdomínio `workers.dev`. Escolha um nome e anote-o.

Você também pode encontrar esse nome no painel da Cloudflare, dentro de **Workers & Pages**. O endereço final combina:

```text
nome do Worker: discord-screen
subdomínio da conta: SEUSUBDOMINIO
endereço final: https://discord-screen.SEUSUBDOMINIO.workers.dev
```

Se já existir um Worker chamado `discord-screen` na sua conta, altere somente o campo `name` no arquivo `wrangler.jsonc` e utilize o novo nome também em `PUBLIC_ORIGIN`.

## 6. Preparar os secrets de produção

Gere um `SESSION_SECRET` forte:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Copie o arquivo de exemplo.

No Windows PowerShell:

```powershell
Copy-Item .production.vars.example .production.vars
```

No macOS ou Linux:

```bash
cp .production.vars.example .production.vars
```

Abra `.production.vars` em um editor de texto e preencha:

```dotenv
DISCORD_CLIENT_ID=COLE_O_CLIENT_ID_DO_DISCORD
DISCORD_CLIENT_SECRET=COLE_O_CLIENT_SECRET_DO_DISCORD
SESSION_SECRET=COLE_O_VALOR_ALEATORIO_GERADO
PUBLIC_ORIGIN=https://discord-screen.SEUSUBDOMINIO.workers.dev
```

Regras importantes:

- não coloque aspas ao redor dos valores;
- não deixe espaços antes ou depois do sinal `=`;
- não adicione uma barra `/` no final de `PUBLIC_ORIGIN`;
- não envie `.production.vars` para ninguém;
- o arquivo `.production.vars` já está incluído no `.gitignore`.

`DISCORD_BOT_TOKEN` é opcional e não é necessário para a instalação básica.

## 7. Fazer o primeiro deploy

Execute:

```bash
pnpm build
pnpm exec wrangler deploy --secrets-file .production.vars
```

O primeiro comando monta o frontend. O segundo publica o Worker, os Static Assets, as migrations e os Durable Objects, enviando os secrets de forma protegida.

No final, o Wrangler mostrará uma URL. Ela deve ser igual ao `PUBLIC_ORIGIN` informado. Se for diferente:

1. corrija `PUBLIC_ORIGIN` dentro de `.production.vars`;
2. execute novamente `pnpm exec wrangler deploy --secrets-file .production.vars`.

## 8. Finalizar a configuração no Discord

Volte ao [Discord Developer Portal](https://discord.com/developers/applications), abra sua aplicação e use seu endereço real nos campos abaixo.

### OAuth2 Redirect URI

Em **OAuth2 → Redirects**, adicione:

```text
https://discord-screen.SEUSUBDOMINIO.workers.dev/auth/callback
```

O endereço deve ser exatamente igual, sem barra no final. Depois clique em **Save Changes**.

### Activity URL Mapping

Em **Activities → URL Mappings**, adicione:

```text
PREFIX: /
TARGET: discord-screen.SEUSUBDOMINIO.workers.dev
```

No campo `TARGET`, não inclua `https://`. Essa é uma regra do proxy de Activities do Discord.

Confirme também em **Activities → Settings** que a Activity está habilitada para Web/Desktop.

## 9. Testar a instalação

### Teste pelo navegador

Abra:

```text
https://discord-screen.SEUSUBDOMINIO.workers.dev/api/health
```

A resposta esperada é parecida com:

```json
{
  "ok": true,
  "architecture": "cloudflare-workers-durable-objects"
}
```

Depois abra a página principal, crie uma sala e teste a entrada usando outra janela ou uma aba anônima.

### Teste dentro do Discord

1. No Discord, abra **Configurações do usuário → Avançado**.
2. Habilite o **Modo desenvolvedor**.
3. Entre em um canal de voz de um servidor de teste.
4. Abra o menu de Aplicativos/Atividades.
5. Procure pelo nome da aplicação e inicie-a.

Durante o desenvolvimento, uma Activity ainda não distribuída normalmente fica visível somente para o proprietário e os integrantes da equipe de desenvolvimento.

## 10. Permitir que outras pessoas instalem

No Discord Developer Portal:

1. abra **Installation**;
2. confirme que `User Install` e `Guild Install` continuam habilitados;
3. copie o **Install Link** fornecido pelo Discord;
4. envie esse link para a outra pessoa.

Para instalar diretamente em um servidor, a pessoa precisa ter a permissão **Gerenciar servidor**. A publicação no App Directory é um processo separado e não é obrigatória para compartilhar o link direto.

## 11. Usar um domínio próprio — opcional

1. Abra **Cloudflare Dashboard → Workers & Pages → seu Worker → Settings → Domains & Routes**.
2. Adicione o domínio desejado.
3. Troque `PUBLIC_ORIGIN` em `.production.vars` pelo novo endereço.
4. Publique novamente com `pnpm exec wrangler deploy --secrets-file .production.vars`.
5. Atualize o OAuth2 Redirect URI e o Activity URL Mapping no Discord.

Todas essas configurações precisam apontar para o mesmo domínio.

## 12. Atualizar uma instalação existente

Quem clonou o projeto com Git pode atualizar usando:

```bash
git pull
pnpm install
pnpm deploy
```

Os secrets já cadastrados na Cloudflare são preservados pelos deploys seguintes. Use novamente `--secrets-file .production.vars` somente quando quiser atualizar os valores.

## Problemas comuns

### `Required secrets are not configured`

Confirme se todos os quatro campos de `.production.vars` foram preenchidos e execute o deploy com:

```bash
pnpm exec wrangler deploy --secrets-file .production.vars
```

### `Invalid OAuth2 redirect_uri`

O endereço no Discord precisa ser idêntico a `PUBLIC_ORIGIN` mais `/auth/callback`. Verifique `https://`, domínio, barras e erros de digitação.

### A Activity abre vazia ou não encontra o backend

Confira o URL Mapping. O prefixo deve ser `/` e o target deve conter apenas o domínio, sem `https://`.

### O aplicativo não aparece no Discord

Confirme que:

- **Enable Activities** está ligado;
- a plataforma Web/Desktop está habilitada;
- o Modo desenvolvedor está ligado na conta que é proprietária da aplicação;
- você está procurando dentro do menu de Aplicativos/Atividades.

### O health check funciona, mas o login não

Verifique `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_ORIGIN` e o Redirect URI cadastrado no Discord. Se o Client Secret tiver sido redefinido no portal, atualize também o valor na Cloudflare.

## Segurança

- Nunca publique `.production.vars` ou `.dev.vars`.
- Nunca coloque `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` ou `DISCORD_BOT_TOKEN` no frontend.
- Não envie screenshots que mostrem secrets.
- Se um secret vazar, redefina-o no Discord ou na Cloudflare imediatamente.
- Cada instalação deve utilizar credenciais próprias.

## Referências oficiais

- [Primeira Discord Activity](https://docs.discord.com/developers/activities/building-an-activity)
- [URL Mappings de Discord Activities](https://docs.discord.com/developers/activities/development-guides/local-development#url-mapping)
- [Wrangler e deploy de Workers](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Secrets em Cloudflare Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Instalação do pnpm](https://pnpm.io/installation)

