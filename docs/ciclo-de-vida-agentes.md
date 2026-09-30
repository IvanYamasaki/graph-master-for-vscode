# Ciclo de vida dos agentes roteados: "aguardando", contato criador-subagente e limite de uso

Nota de implementação da rodada de 2026-09-29 (hub.ts, session.ts, protocol.ts, webview). Complementa o que o código já explica em comentário.

## O problema

O fim do turno de um agente marcava `completed` e entregava o texto como "Relatório final" a `reportTo`. Isso falhava quando o agente:

- lançou um processo em segundo plano (Bash `run_in_background`, Agent em background) e encerrou o turno dizendo "segue rodando";
- criou subagentes com `spawn_agent` (report_to padrão = ele mesmo) e encerrou o turno antes de os relatórios chegarem;
- fez uma pergunta ao criador com `send_to_agent` e encerrou o turno esperando a resposta.

Nos três casos o mapa ficava verde, o criador recebia um relatório prematuro e o agente às vezes nunca voltava.

## O que o SDK faz com tarefa em segundo plano (medido)

Experimento com o SDK 0.3.284 e o CLI local, entrada em streaming (sessão aberta), modelo haiku, comando `sleep 12 && echo X` com `run_in_background`:

1. `system/background_tasks_changed` com a tarefa, `system/task_started` com `is_backgrounded: true`, `task_type: local_bash`, `tool_use_id` da chamada.
2. O modelo responde e chega o `result` do turno normalmente (`terminal_reason: completed`).
3. Doze segundos depois: `background_tasks_changed` vazio, `task_updated` com `status: completed`, `task_notification` com `summary` e `output_file`.
4. Em seguida o CLI abre um turno sozinho: `system/init`, `assistant` (o modelo comenta o resultado) e `result`. Nenhuma mensagem nossa entra nesse turno.

Conclusões que o código usa:

- A sessão conta as tarefas abertas por `task_started`/`task_updated`/`task_notification` e usa `background_tasks_changed` como sinal de nível (substitui o conjunto). Tarefas `ambient`/`skip_transcript` não contam. O conjunto zera a cada processo novo.
- O turno aberto pelo CLI não passa por `send()`, então ninguém marcava a sessão como ocupada. `noteAutoTurn()` marca `busy` quando chega um `init` que não é o primeiro do processo, um `message_start` ou um `assistant` fora de turno. O `result` desse turno chega ao hub com `auto: true`.
- Como garantia, quando uma tarefa termina e o agente está "aguardando", o hub espera 15 s (`WAKE_GRACE_MS`); se nenhum turno começou nesse meio-tempo, manda ele mesmo o aviso com o `output_file`.
- O modo `-p` (uma só mensagem) é diferente: lá o CLI segura o `result` até as tarefas terminarem ("hold-back"). A extensão não usa esse modo.

Codex: o app-server não tem noção de tarefa em segundo plano fora do turno (o `exec` dele bloqueia até o fim ou até o `yield`). Não há equivalente a contar; agentes Codex só entram no mecanismo de filhos e de pergunta.

## Status `waiting`

`AgentStatus` ganhou `waiting`. No fim de um turno sem erro, o hub calcula `pendingFor(agent)` (turnRules.pendingInfo):

- `background`: tarefas abertas na sessão;
- `children`: agentes com `reportTo` igual a este, em `running`, `waiting` ou pausados por orçamento; restaurados e vigias não contam;
- `question`: destinos a quem este agente perguntou com `send_to_agent` (`expect_reply` padrão) e que ainda podem responder.

Com pendência (ou com mensagens ainda na fila do SDK), o texto do turno não é entregue como relatório final: vira `progress` (nota de progresso, no nó) e a causa `report` volta para a fila. Respostas a quem perguntou (`reply`) saem mesmo assim. O status vira `waiting`, com `summary` "aguardando ..." e `pending` detalhado. Quando o último filho reporta, a tarefa termina ou a resposta chega, a própria mensagem acorda o agente; o fim desse turno, sem pendência, entrega o relatório final.

Sem deadlock:

- filho que falha, termina sem texto ou é parado avisa o pai que estava aguardando (`tellWaitingParent`), com o último texto dele;
- filho parado por orçamento continua pendente até o usuário decidir no cartão (Dar mais ou Parar de vez; o segundo já avisava `reportTo`);
- filho restaurado do disco não conta;
- `stop_agent` e o botão Parar funcionam em `waiting` e limpam a pendência;
- o main não tem status: `list_agents` começa pelas pendências do chamador e o nó raiz mostra "N rodando · M aguardando".

## Contato entre criador e subagente

- O prompt do agente agora tem os guias compartilhados primeiro e a identidade (id, criador, irmãos da caixa, filhos, destino do relatório) por último, para os irmãos compartilharem o prefixo de cache.
- `COOPERATION_GUIDE` explica: perguntar ao criador em vez de adivinhar; responder a uma pergunta escrevendo a resposta no fim do turno (não com `send_to_agent`); dizer ao filho o que espera receber; continuar no que não depende; não esperar em laço; usar coletor com `report_to`; relatório curto com detalhe em arquivo.
- `send_to_agent` ganhou `expect_reply` (padrão true). Com true, o chamador entra em "aguardando resposta". Com false, a mensagem é aviso (`TurnCause` `notice`) e a resposta não volta. A ferramenta agora devolve erro quando o destino não pode ser retomado, em vez de despejar a mensagem no main; e avisa quando o destino já tinha concluído com contexto grande.
- `report_progress({ text, notify_creator })` atualiza a nota de progresso do nó; com `notify_creator`, a linha entra no turno em andamento do criador (`notify`) ou vai na frente da próxima mensagem a ele (`heldNotes`, `mainNotes`), sem abrir turno.
- `list_agents` aceita `status` (inclui `active`) e `box`, e mostra criador, filhos, destino, progresso e pendência de cada um.
- `list_models` lista os aliases com id completo (haiku → claude-haiku-4-5-20251001, sonnet → claude-sonnet-5-5, opus → claude-opus-5-5, claude-fable-5-1), a lista viva de `supportedModels` do último processo e os modelos Codex.

## Limite de uso do fornecedor

`session.ts` reconhece o limite por três caminhos: `rate_limit_event` com `status: rejected` (traz `resetsAt`), `assistant.error === 'rate_limit'` e o texto do `result` de erro (prefixos de `USAGE_LIMIT_ERROR_PREFIXES`, "resets 3pm"). O hub marca `failed` com `summary` "limite de uso até HH:MM", guarda `info.limit`, mantém as causas na fila e avisa criador e destino com as opções (esperar e retomar, ou recriar com outro modelo). O botão do nó vira "Tentar de novo" e manda "continue de onde parou". Trocar de conta automaticamente continua proibido e não existe no código.

## Outras correções da mesma rodada

- `lastTurnText` é só o texto depois da última ferramenta do turno, e zera no `result`: acabou o relatório com narração e a "Resposta" que repetia o relatório anterior.
- Trava de laço (`maxAutoReports`) conta só as entregas dos últimos 10 minutos e não descarta os outros destinos do turno; mensagem do usuário zera.
- Relatório acima de 6 mil caracteres vai inteiro para `.agm/reports/<id>-<hora>.md`; quem recebe ganha o começo e o caminho.
- Agentes roteados sobem com `strictMcpConfig` (só o servidor `agents` e o `.mcp.json` aprovado), salvo vigias, `spawn_agent` com `user_mcp: true` ou `agentGraphMaster.subagentUserMcp`.
- Com outro agente roteado de pé, a sessão nova recebe `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `NUMEXPR_NUM_THREADS` e `VECLIB_MAXIMUM_THREADS` = 1 (config `agentGraphMaster.limitThreadsWhenParallel`), sem sobrescrever variável já definida.
- Ferramentas de infra (jobs de GPU, vigia de treino) ficam sem `alwaysLoad` fora do main.

## Correções depois da revisão do a6 (docs/revisao-ciclo-de-vida.md)

- Pergunta ao main: o fim do turno da conversa principal entrega o texto dela a todo agente com `asked` = main (`hub.onMainTurnEnd`, ligado em `panel.ts`); texto vazio vira aviso para seguir sem resposta. O guia do main diz isso e oferece `send_to_agent` com `expect_reply: false` para responder só a um.
- `releaseAskers(id, motivo)`: quem perguntou deixa de esperar e recebe um aviso quando o perguntado para (`stop`, `stopForGood`), bate no limite, termina o turno sem texto de resposta ou tem a resposta barrada pela trava de laço.
- Processo do CLI que morre ou é trocado com turno aberto: `endDeadTurn` chama `onTurnEnd` com erro e `dropBackgroundTasks` encerra as tarefas registradas, avisando o hub. Sem isso o filho ficava "rodando" e o pai aguardando para sempre.
- Relatório segurado (`heldReport`) sai junto com o turno de acordar (`turnRules.mergeHeldReport`): turno curto vira atualização anexada, turno do tamanho do relatório substitui, turno vazio entrega o segurado. Resposta a pergunta usa só o texto do turno.
- Não há mais retenção por fila do CLI. O caso que ela cobria (relatório de filho chegou no meio do turno do pai) agora entra na pendência: causa `report` carrega `from`, e `pendingFor` conta filho cujo relatório ainda está na fila.
- Turno aberto pelo CLI sozinho (`auto`) não consome a causa de uma mensagem ainda na fila (`turnRules.consumedCauses`).
- `lastTurnText`: se não houver texto depois da última ferramenta (relatório seguido de `brain_fact` ou `report_progress`), vale o último bloco de texto não vazio do turno.
- Parar um agente em `waiting`: mata as tarefas em segundo plano (`stopBackgroundTasks`, `q.stopTask`), marca `stoppedByUser` (relatório e aviso de filho ficam só no log dele, sem reabrir; pergunta a ele volta como erro), solta perguntadores, e para os processos pesados dele (`parallel/guard/search.stopWorkOf`, do a4); `reset` chama `stopAllWork`.
- Limite de uso: só por `rate_limit_event`, `assistant.error === 'rate_limit'` ou o texto de erro do próprio `result`; o texto que o modelo escreveu não conta mais. Mensagem que chega no meio do turno não zera o sinal de limite nem o texto do turno.
- `strictMcp` desligado para agente de navegador (o `--chrome` é um servidor MCP). Prompt do agente avisa quando os conectores estão desligados e manda pedir `user_mcp: true` a quem criou; o guia do main também.
- Caixas: `BoxInfo.createdBy`; só o main ou quem criou a caixa muda o orçamento dela ou põe agentes nela, e um agente só move para fora de caixa sua os agentes que ele mesmo criou, nunca a si próprio.

## Segunda passada do a6

- Resposta do main só no turno certo: `asked` guarda o instante da pergunta; o panel avisa o início do turno do main e passa a fila no fim; `turnRules.mainAnswerTargets` só responde quando a fila está vazia e o turno começou depois da pergunta.
- `heldReport` junta os turnos (`turnRules.nextHeldReport`) e não muda em turno que só respondeu a uma pergunta.
- `boxFor` segue a regra do `assign_box`: subagente só cria filhos na própria caixa, numa caixa-filha ou numa que criou; caixa nova dele nasce dentro da sua.
- `stopForGood` mata as tarefas em segundo plano; `result` atrasado de agente parado não muda o status; com relatório de filho na fila e sessão ocupada o agente fica `running`; `BoxInfo.closed` é persistido e o `spawn_agent` recusa caixa fechada mesmo depois do restore.

## Ficou de fora

- Entrega em lote dos relatórios ao main (segurar 30 s quando irmãos ainda rodam): não feito; a janela de novidades do cérebro é o modelo a reaproveitar.
- Mudança do interruptor do navegador depois que o agente subiu: o prompt de sistema fica congelado; seria uma mensagem, como o `lateNotice` do cérebro.
- Codex sem equivalente para processo em segundo plano (ver acima).
- Testes só das regras puras (`src/chat/turnRules.test.ts`); o fluxo do hub depende do VS Code e do SDK.
- Filho que bate no limite sai da lista de pendentes do pai; se for retomado depois e reportar, o pai (já concluído) recebe um segundo "Relatório final". Aceito: o aviso de limite já foi ao pai.
