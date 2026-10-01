# Remote Control no chat da extensão

Remote Control deixa continuar uma sessão local do Claude Code pelo claude.ai/code ou pelo app do celular. O processo continua rodando nesta máquina; o claude.ai só manda mensagens para ele e recebe a transcrição.

## Como a extensão oficial liga (anthropic.claude-code 2.1.285)

Li o `package.json` e o `extension.js`/`webview/index.js` empacotados em `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-2.1.285-win32-x64`.

- O `package.json` não tem comando, setting nem menu de Remote Control. O liga/desliga fica dentro do webview (pílula "Remote Control" no rodapé e o comando `/remote-control`), e o "ligar em toda sessão" é a setting `remoteControlAtStartup` do próprio Claude Code (`~/.claude/settings.json`), gravada pelo webview com `applySettings`.
- Não é flag de linha de comando nem prompt "/remote-control". A oficial chama `query.enableRemoteControl(true)` do SDK, que manda o control request `{ subtype: "remote_control", enabled: true, name?, reattach_session_id?, keep_session_on_exit?, work_secret? }` ao CLI já rodando. Desligar é `enableRemoteControl(false)`.
- A resposta traz `session_url` (link da sessão no claude.ai, o que se abre no celular), `connect_url`, `environment_id`, `bridge_epoch` e `bridge_session_id`. A oficial trata "sem session_url" como erro.
- Depois disso o CLI emite frames `{ type: "system", subtype: "bridge_state", state, detail?, failure_kind?, bridge_epoch }`. Estados vistos no binário: `connected`, `ready`, `failed`, `policy_disabled` (e reconexões). A oficial só usa `failed` com o mesmo `bridge_epoch` para voltar a "desconectado".
- Estados que a oficial mostra: `disconnected`, `connecting`, `connected` (com `sessionUrl`), `error` (com texto). Com conectado ela põe no chat "Remote Control is active · Continue here, on your phone, or at claude.ai/code" com o link.
- A oficial sobe o CLI com `--replay-user-messages`. Mensagem que chega pelo claude.ai entra na mesma fila do CLI (`onInboundMessage` → `enqueue` com `bridgeOrigin: true`) e volta para o host como `{ type: "user", isReplay: true, uuid }`. É assim que a mensagem remota aparece no painel. O turno que ela abre chega como qualquer outro (init, assistant, result).
- Disponibilidade: a resposta de `initialize` traz `remote_control_available` (campo `@internal`, fora do `sdk.d.ts`): falso quando `disableRemoteControl` está nas managed settings, dentro de sessão remota, ou com provedor que não é a Anthropic. O `get_settings` traz `remote_control_policy_lock_reason`.
- `bridge.d.ts` (`@anthropic-ai/claude-agent-sdk/bridge`) é outra coisa: o lado "worker" que o próprio CLI usa para falar com o claude.ai. A oficial não usa.

## O que o SDK/CLI desta extensão aceita

SDK 0.3.284, CLI 2.1.284 (`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`).

- `Query.enableRemoteControl` existe em `sdk.mjs` com o mesmo código da oficial, mas não está na interface `Query` do `sdk.d.ts`. Chamamos por um cast.
- O CLI trata o control request `remote_control` (o handler recusa com "Remote Control cannot be enabled from inside a remote session") e emite `bridge_state`.
- `claude --help` lista `--remote-control [name]`, `--remote-control-session-name-prefix` e `--replay-user-messages`; `claude remote-control --help` é o modo servidor (`--spawn`, `--continue`, `--session-id`), que não serve para um processo já aberto pelo SDK.
- `sdk.d.ts` documenta `remoteControlAtStartup` e `disableRemoteControl` nas settings e `SDKWorkerShuttingDownMessage` com `reason: "remote_control_disabled"`.
- Exige login claude.ai (OAuth). Com chave de API ou Bedrock/Vertex o CLI recusa, e o erro aparece no painel.

## O que esta extensão faz

Código: `src/chat/remoteControl.ts` (estado da ponte e filtro do eco, com testes em `remoteControl.test.ts`), `src/chat/session.ts` (`startRemote`, `setRemoteControl`, `onRemoteMessage`, eco e `bridge_state`), `src/chat/panel.ts` (`setRemoteControl` com o modal, comando da paleta, `/remote-control`), `src/webview/main.ts` (`renderRemotePill`, `openRemoteMenu`, item do "+").


Mesmo mecanismo da oficial, só no chat principal (conta Claude):

- Interruptor "Remote Control" por conversa, no menu do "+" do compositor, no comando da paleta "Agent Graph Master: Remote Control (ligar/desligar no chat ativo)" e digitando `/remote-control` ou `/rc` no chat. Desligado por padrão.
- `agentGraphMaster.remoteControlAtStartup` (padrão false) liga ao abrir cada chat. É setting da extensão, não a `remoteControlAtStartup` do Claude Code; a do Claude Code não é lida nem gravada aqui.
- Pílula "Remote Control" na linha do compositor, ao lado da do navegador: conectando, conectado (abrir no navegador, copiar link), desconectado com motivo (ligar de novo). Indisponível aparece como item desativado no "+", com o motivo. Cada mudança deixa uma linha no chat, como o "Remote Control is active" da oficial.
- Com modo bypass, ligar pede confirmação modal (inclusive pela setting de início). O modo virar bypass com a ponte ligada (pelo painel, pelo plano ou pelo celular, visto no `init`) pede de novo, e o religar depois de reiniciar o processo também pede se o modo virou bypass sem confirmação. Recusar desliga a ponte.
- Desligar só mostra "desligado" depois de o CLI confirmar; se ele recusar, a pílula fica em erro ("não desligou"). Frame `bridge_state` connected/ready com a ponte desligada é ponte fantasma: a extensão manda desligar de novo (até 3 vezes) e avisa.
- O botão "Abrir" só abre https em claude.ai ou subdomínio.
- `remote_control_available === false` ou `bridge_state: policy_disabled` deixam o interruptor como indisponível.
- Processo do CLI reiniciado (raciocínio, navegador, MCP) derruba a ponte. Se o usuário tinha ligado, a extensão liga de novo no processo novo; o link pode mudar.
- Mensagens remotas: o CLI sobe com `--replay-user-messages`; eco com uuid que não é nosso, sem `isSynthetic`, com origem humana (ou sem origem) e sem tag do CLI no começo (`command-*`, `local-command-*`, `task-notification`, `system-reminder`, `bash-*`) vira bolha de usuário marcada "pelo Remote Control". O aviso de tarefas órfãs é lido antes do filtro, porque pode chegar só como eco.

## Limites

- Agentes roteados do hub ficam de fora: cada um é um processo próprio, e ligar em todos criaria uma sessão no claude.ai por agente. O mecanismo permitiria (é o mesmo `enableRemoteControl`), mas não há interface para isso.
- Conversa em conta Codex não tem Remote Control.
- Pedido de permissão respondido no celular: o CLI resolve sozinho; o cartão do painel fecha pelo `abort` do `canUseTool` se o CLI mandar o cancelamento. Não testado com conta real.
- Com `remoteControlAtStartup` e modo bypass, cada chat que abre (inclusive abas restauradas ao recarregar a janela) pede a confirmação modal.
- Processo do CLI que caiu não sobe sozinho: a ponte volta com a próxima mensagem enviada do painel. Do celular não dá para acordá-lo.
- Conversa retomada do histórico mostra as mensagens remotas antigas como mensagens comuns, sem a marca "pelo Remote Control".
- QR code não entra: o projeto não tem biblioteca de QR, e o pedido era não trazer dependência nova.
- Não testado contra o claude.ai nesta tarefa (não era para conectar nada). O fluxo segue o código da oficial e do CLI 2.1.284.
