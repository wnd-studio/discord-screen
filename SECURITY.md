# Segurança do Discord Screen

## Controles atuais

- Sessões administrativas assinadas, `HttpOnly`, `Secure` e com duração máxima de 4 horas.
- A autorização administrativa é validada contra o proprietário, equipe ou lista configurada no Discord antes da emissão de uma sessão curta de 4 horas.
- Todos os fluxos OAuth usam `state` assinado, cookie temporário e URI de retorno fixa.
- Ações administrativas exigem origem válida, confirmação na interface e entram na auditoria.
- Limites de requisição usam um identificador HMAC temporário; o endereço IP puro não é armazenado.
- Webhooks do Discord exigem assinatura Ed25519 válida.
- Webhooks com timestamp antigo são recusados para impedir repetição de eventos capturados.
- Se o armazenamento de limites estiver indisponível, uma proteção local temporária continua restringindo tentativas abusivas.
- Segredos permanecem exclusivamente nas variáveis protegidas da Cloudflare.

## Retenção

- Eventos de uso: 90 dias.
- Nome associado ao evento: removido após 30 dias.
- Auditoria administrativa: 180 dias.
- Histórico de publicações: 365 dias.
- Bloqueios expirados e contadores de limite antigos: removidos automaticamente.
- O conteúdo de tela e áudio não é gravado pelo serviço.
- O painel mostra contagens, tendências e durações agregadas; não oferece histórico de comportamento por usuário.
- Não são coletados navegador, modelo do dispositivo, localização ou conteúdo para alimentar as métricas.

## Relato responsável

Não publique vulnerabilidades com dados reais em uma issue. Envie um relato privado pelo contato do proprietário do repositório, informando impacto, passos mínimos para reprodução e versão afetada. Nunca inclua tokens, cookies, chaves ou conteúdo de transmissões.
