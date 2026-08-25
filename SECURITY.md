# Segurança do Discord Screen

## Controles atuais

- Sessões administrativas assinadas, `HttpOnly`, `Secure` e com duração máxima de 4 horas.
- A autorização administrativa é revalidada contra o proprietário, equipe ou lista configurada no Discord.
- OAuth usa `state` assinado, cookie temporário e URI de retorno fixa.
- Ações administrativas exigem origem válida, confirmação na interface e entram na auditoria.
- Limites de requisição usam um identificador HMAC temporário; o endereço IP puro não é armazenado.
- Webhooks do Discord exigem assinatura Ed25519 válida.
- Segredos permanecem exclusivamente nas variáveis protegidas da Cloudflare.

## Retenção

- Eventos de uso: 90 dias.
- Nome associado ao evento: removido após 30 dias.
- Auditoria administrativa: 180 dias.
- Histórico de publicações: 365 dias.
- Bloqueios expirados e contadores de limite antigos: removidos automaticamente.
- O conteúdo de tela e áudio não é gravado pelo serviço.

## Relato responsável

Não publique vulnerabilidades com dados reais em uma issue. Envie um relato privado pelo contato do proprietário do repositório, informando impacto, passos mínimos para reprodução e versão afetada. Nunca inclua tokens, cookies, chaves ou conteúdo de transmissões.
