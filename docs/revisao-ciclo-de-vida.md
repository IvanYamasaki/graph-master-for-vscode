# Revisão crítica: ciclo de vida dos agentes roteados e mudanças da rodada de 2026-09-29

Revisão só de leitura (agente a6). Nada foi editado além deste arquivo. Linhas referem-se ao working tree de 2026-09-29.
"Confirmado" quer dizer que li o caminho no código. "Plausível" depende de comportamento do CLI/SDK que não medi.
Os itens de semáforo/orçamento e do lab pareado vieram de dois subagentes de revisão; eu não reli cada linha deles.

## 1. Ciclo de vida (hub.ts, session.ts, turnRules.ts)

### Alta

**1.1 Pergunta ao main trava o agente para sempre.** Confirmado.
- `hub.ts:2181`: `asked` conta `main` sempre (`t === MAIN_ID`). A pergunta só sai da lista em `deliver()` (`hub.ts:2659`), quando chega uma mensagem *vinda* do main, ou seja, só se o main chamar `send_to_agent`.
- O guia do main (`hub.ts:481`) manda o contrário: "responda escrevendo a resposta no fim do turno (ela é entregue a ele)". Não existe código que entregue o texto do turno do main a quem perguntou (`panel.ts` não chama o hub no fim do turno do main).
- Cenário: a3 faz `send_to_agent({agent_id:"main", message:"qual pasta?"})`. O main responde em texto, como o guia pede. a3 fica "aguardando resposta de main" para sempre e o relatório final dele nunca sai; os pais de a3 também ficam presos.
- Correção: no fim do turno do main, entregar `lastTurnText` a cada agente com `asked.has('main')` cuja mensagem abriu aquele turno (ou, no mínimo, trocar o guia do main para "responda com send_to_agent(..., expect_reply:false)" e limpar `asked` quando o main manda qualquer coisa ao agente).

**1.2 Quem perguntou a outro agente fica "aguardando" para sempre quando o perguntado não responde com texto.** Confirmado.
- Nada reavalia a pendência do perguntador quando o perguntado some. `pendingFor` (`hub.ts:2181`) já ignora destino `failed`/`stopped`, mas só roda no fim de turno do próprio perguntador ou em `refreshPending`, e ninguém chama isso nesses casos. `tellWaitingParent` (`hub.ts:2244`) só olha `reportTo`, não `asked`.
- Caminhos que travam:
  - perguntado parado com `stop()` (`hub.ts:800-832`) ou `stopForGood`;
  - perguntado que bate no limite de uso: `onLimitHit` (`hub.ts:2273`) avisa só criador e destino;
  - turno de resposta sem texto (texto só antes da última ferramenta, ver 1.5): `if (!text ...) { finish(); return; }` em `hub.ts:2467`; o perguntado fica `completed`, que conta como "ainda pode responder";
  - resposta barrada pela trava de laço (`hub.ts:2523-2530`): `continue` sem avisar ninguém.
- Correção: função `releaseAskers(id, motivo)` chamada em `stop`, `stopForGood`, `onLimitHit`, `finish()` quando nenhuma resposta saiu e no bloqueio da trava; ela apaga `id` de `asked` de cada perguntador e entrega um `notice` ("a3 parou/falhou sem responder"). Resposta vazia deveria sair como "(a3 terminou o turno sem texto)".

### Média

**1.3 Processo do CLI que morre deixa o filho "rodando" e o pai "aguardando" para sempre.** Confirmado.
- `session.ts:750-756`: no `finally` do `consume` só há `setBusy(false)`. Não há `onTurnEnd`, e `backgroundTasks` não é esvaziado. No hub, `onBusyChange(false)` (`hub.ts:2112`) não mexe no status.
- Antes, um filho preso em `running` era só um nó verde errado. Agora `pendingChildren` (`hub.ts:2172`) conta `running`, e o pai nunca entrega o relatório. O mesmo vale para um agente em `waiting` por processo em segundo plano cujo CLI caiu: a tarefa morreu, o `task_notification` nunca chega.
- Correção: no `finally`, se `busy`, chamar `onTurnEnd({ isError: true, ... })`; e esvaziar `backgroundTasks` emitindo `ended` com `status: 'failed'`. `start()` (`session.ts:266`) tem o mesmo problema ao reiniciar o processo (reloadProjectMcp, setChrome): limpa o mapa sem avisar.

**1.4 O texto segurado não é o relatório que sai.** Confirmado.
- Com pendência, o texto do turno vira só `progress` (600 caracteres, `hub.ts:2444`) e `pending.note`. O relatório final entregue depois é o texto do *turno em que nada mais falta* (`rawText`, `hub.ts:2414`).
- O prompt do agente (`hub.ts:557`) diz: "Se o sistema estiver segurando o relatório por pendência..., ele sai sozinho quando ela acabar." O modelo lê isso como "o texto que já escrevi será entregue", e no turno de acordar escreve algo como "Recebi o relatório de a4, tudo certo". É isso que chega ao destino como "Relatório final".
- Correção: guardar o texto segurado inteiro (`agent.heldReport`) e, na entrega final, mandar o texto do último turno com o segurado anexado (ou só o segurado, se o último for curto); ou mudar o prompt e as mensagens de acordar para "reescreva o relatório final completo".

**1.5 Regressão geral: segurar por `turn.queued > 0` perde o relatório.** Confirmado.
- `hub.ts:2431`: `hold = !!pending || turn.queued > 0`. Vale para quem não usa nada novo. Se o usuário (ou outro agente com uma pergunta) manda mensagem enquanto o agente escreve o relatório final, o relatório desse turno não vai a ninguém. `progress` só é gravado com `pending` (`hub.ts:2444`), então com fila pura o texto nem fica no nó.
- O turno seguinte, que responde à mensagem, sai para `reportTo` como "Relatório final" (a causa `report` foi devolvida à fila na frente).
- Correção: quando o hold é só por fila e o turno tinha `report`, guardar o texto (mesma estrutura do 1.4) e entregá-lo junto no turno seguinte; ou só segurar por fila quando a causa enfileirada for `report` de filho.

**1.6 `lastTurnText` só com o texto depois da última ferramenta.** Confirmado (`session.ts:861`).
- Relatório escrito e seguido de uma ferramenta (`brain_fact`, `report_progress`, TodoWrite, um `git status` final) vira texto vazio. O pai recebe "terminou sem entregar relatório" (`tellWaitingParent`), e o "Enviar ao chat principal" do main também passa a vir vazio.
- Correção: se o trecho depois da última ferramenta estiver vazio, usar o último bloco de texto não vazio do turno.

**1.7 Parar em `waiting` não para o que segura o agente.** Confirmado em parte.
- `stop()` (`hub.ts:819-831`) chama `interrupt()` numa sessão ociosa e zera `causes`, mas não para os filhos nem as tarefas em segundo plano.
  - Filhos: quando um filho reporta, `deliver()` empurra causa `report` e reabre o pai parado, que entrega um "Relatório final" depois de o usuário tê-lo parado. Confirmado.
  - Tarefa em segundo plano: se o `q.interrupt()` não matar a tarefa (plausível), o turno automático do CLI marca a sessão ocupada, o status volta a `running` e depois `completed`, gastando tokens.
- Correção: em `stop` de agente `waiting`, oferecer parar os filhos pendentes (ou ao menos marcar `stoppedByUser` e, em `deliver`, só registrar sem abrir turno); matar as tarefas via `q.stopTask`/equivalente, se o SDK expuser.

**1.8 Falso "limite de uso".** Confirmado.
- `session.ts` (bloco do `result`): `limit = m.is_error ? (limitHit ?? limitFromText(errorText) ?? limitFromText(this.lastTurnText))`. O `LIMIT_RE` casa "429", "rate limit" e "usage limit".
- Um agente que depura um cliente HTTP ("a API devolveu 429") e cujo turno termina em erro por outro motivo (interrupção pelo botão Parar, max turns) vira `failed` "limite de uso". Criador e destino recebem o aviso "espere o limite liberar, nunca troque de conta".
- Correção: não olhar `lastTurnText`; só `rate_limit_event`, `assistant.error === 'rate_limit'` e o texto de erro do próprio `result`.

### Baixa

- `send()` zera `limitHit` (`session.ts:369`). Mensagem que chega no meio de um turno que já recebeu `rate_limit_event` faz o turno terminar como "falhou" comum.
- Filho que bate no limite conta como terminado para o pai (`failed` sai de `pendingChildren`). Se depois alguém o retoma e ele reporta, o pai (já `completed`) abre turno e manda um segundo "Relatório final".
- Resposta barrada pela trava de laço: `finish()` avisa o pai "terminou sem entregar relatório", o que é enganoso (o relatório existe e está no nó).
- Plausível: a conta `consumed = causes.length - turn.queued` (`hub.ts:2410`) assume uma causa por mensagem enfileirada. A causa `report` devolvida à fila e os turnos que o CLI injeta sozinho (aviso de tarefa) quebram essa igualdade; com uma pergunta na fila ao mesmo tempo, a resposta pode sair com o texto do turno errado.

### O que conferi e está certo
- Restore: `running`/`waiting` salvos voltam `stopped` com `causes: []`; `pending` não é restaurado; restaurado não conta como filho.
- Filho que falha, termina sem texto ou é parado avisa o pai em `waiting` (`tellWaitingParent`), sem duplicar quando o relatório já saiu (`deliveredTo`).
- Filho com `report_to` diferente do criador não segura o criador; `tellWaitingParent` usa o mesmo critério (`reportTo`).
- Main nunca bloqueia; `tellWaitingParent` ignora `main` e `user`.
- Pausa de orçamento: `budgetPaused` segura o pai até o cartão; "Parar de vez" limpa `budgetPaused` e avisa `reportTo`.
- Carência de 15 s do acordar: não dispara se um turno começou depois do fim da tarefa (`lastTurnStart >= endedAt`), e o turno automático sem causa não gera entrega dupla.

## 2. strictMcpConfig

- Vigias continuam com tudo (`hub.ts:2088`, `!repeatEveryMinutes`). Confirmado.
- Plausível, média: agente de navegador sobe com `--chrome` e `strictMcpConfig` ao mesmo tempo (`hub.ts:2083` e `2088`). Se o CLI trata o servidor `claude-in-chrome` como MCP comum, o strict o descarta e o agente de navegador fica sem Chrome (o `readBrowserStatus` mostraria "indisponível"). Correção barata: `strictMcp` falso quando `browserActive`.
- Média, confirmado: agente que precisa de conector (Slack, Drive) só o ganha se quem cria passar `user_mcp: true`. Isso só aparece na descrição do parâmetro; o guia do main e o `COOPERATION_GUIDE` não falam disso, e o agente criado não sabe que está sem conectores. Agentes criados por `spawn_attempts`, torneios e verificadores não têm como pedir. Correção: uma linha no prompt do agente ("conectores do usuário desligados; peça ao criador para recriar com user_mcp") e no guia do main.

## 3. Semáforo pesado e orçamento por caixa (subagente)

Não há vazamento de vaga: `evaluation.ts:33`, `sweep.ts:316` e `seeds.ts` liberam em `finally`, com flag contra liberar duas vezes. Não há contagem dupla no orçamento da caixa (`boxSpent` soma cada agente uma vez). `docs/lockbox.md` não existe no working tree.

- Alta: corrida no cofre (`agentGuard.ts:824-838`). `previous` é lido antes do `await runEvaluation`; duas chamadas de `lockbox_evaluate` no mesmo turno veem `previous = 0` e rodam sem o clique do usuário. Gravar um registro "em andamento" antes de rodar.
- Alta: `run_seeds`/`start_sweep` de subagente só checam caminho protegido no texto do comando (`blockedFor` em `parallel/index.ts` e `search/manager.ts`). `python peek.py` que lê `data/test` passa, e o fim do stderr volta ao agente (`seeds.ts:92`).
- Média: JSON do cofre corrompido cai no `catch` e devolve `[]` (`lockbox.ts:74`), desprotegendo tudo em silêncio.
- Média: `boxTools` está disponível a todo agente (`hub.ts:1411`). Um subagente pode subir o orçamento da própria caixa com `create_box` (`hub.ts:1473`) ou sair dela com `assign_box(..., "none")`, e aí o gasto dele sai da soma (`agentGuard.ts:423`).
- Média: depois de "parar" a caixa, `boxSpawnBlock` libera de novo (`agentGuard.ts:558`).
- Média: quem espera no semáforo não é cancelável (`heavy.ts:63-67`, `sweep.ts:204`); varredura parada fica presa até alguém liberar vaga.
- Média: `run_seeds`, `run_evaluation` e `lockbox_evaluate` não param com `stop`, `stopForGood` nem `hub.reset`.
- Média, regressão: o `run_evaluation` do main agora entra na fila; com 2 núcleos o limite é 1. Varredura com `parallel: 4` fica limitada a núcleos/2 sem aviso.

## 4. Lab pareado (subagente)

Correto: p bilateral por bootstrap deslocado com +1 (`(1+extreme)/(B+1)`, nunca 0); IC invertido para "lower"; mesmos pesos nos dois braços em cada réplica; AUC ponderada com empate como meio par; id duplicado rejeitado (`paired.ts:82`); o p pareado entra na família BH no lugar do p, sem contar duas vezes; RNG determinístico por hipótese.

- Média: sem coluna `unit`, cada linha vira unidade, mesmo com `unit` declarado na hipótese (`paired.ts:85`, `evaluate.ts:182, 189-201`). O IC fica estreito demais. `alignRows` usa só a unidade do baseline.
- Média: linhas sem par saem da comparação e o veredito continua valendo (`evaluate.ts:177-196, 245-250`). Uma variante que grava só as linhas em que acerta ganha por seleção. Com `dropped > 0` deveria dar inconclusiva, ou ao menos entrar em `warnings`.
- Baixa: vale só o último run com predições de cada braço (`evaluate.ts:165`); p com piso 1/(B+1) (acima de 20 mil linhas, B = 1000); d_z pesa unidades e o diff pesa linhas; `pairedCheck.ts:46` compara o hash das predições com o do `metrics_file`; `run_seeds` não recusa hipótese pareada.

## Segunda passada (a6, depois das correções do a1, a3 e a4)

### Ciclo de vida (hub.ts, session.ts, panel.ts)

| Item | Estado | Onde |
|---|---|---|
| 1.1 pergunta ao main | parcial | `panel.ts:203`, `hub.ts:2278-2293` |
| 1.2 perguntador preso | fechado | `hub.ts:2260` (`releaseAskers`), chamado em `stop` 854, `stopForGood` 1869, `onLimitHit` 2388, `finish` 2582 e trava 2664 |
| 1.3 processo morto | fechado | `session.ts:774` (`endDeadTurn`), `787` (`dropBackgroundTasks`), chamados em `stop()` 551 e no `finally` 765 |
| 1.4 texto segurado | parcial | `hub.ts:2550-2552` sobrescreve; `turnRules.ts:153` |
| 1.5 hold por fila | fechado | `hub.ts:2543` (`hold = !!pending`); filho na fila entra por `pendingFor` 2250 |
| 1.6 `lastTurnText` vazio | fechado | `session.ts:906`, `979` (`turnLastText`) |
| 1.7 stop em waiting | fechado | `hub.ts:833-855`, `deliver` 2795; resta o caso do `stopForGood` abaixo |
| 1.8 falso limite | fechado | `session.ts:986` |
| strictMcp navegador/conectores | fechado | `hub.ts` `strictMcpFor` (exclui `browser`/`browserActive`), prompt 565, guia do main 487 |
| `send()` zerando limite | fechado | `session.ts:370-375` |

1.1 continua parcial. `onMainTurnEnd` responde no fim de *qualquer* turno do main e ignora `turn.queued`. Se a pergunta chega com o main ocupado (o caso comum, porque o main coordena), ela entra na fila do CLI. O turno em andamento, sobre outro assunto, vira "Resposta da conversa principal" e limpa `asked`. O turno que de fato responde não vai a ninguém. O mesmo vale para um turno do main aberto pelo relatório de outro agente ou por mensagem do usuário, se a pergunta chegou antes e o main ainda não tinha lido. Correção: guardar em cada perguntador a hora da entrega ao main e, no `onMainTurnEnd`, só responder quando `turn.queued === 0` e o turno começou depois da entrega (ou contar os turnos enfileirados do main desde a pergunta).

1.4 continua parcial. `heldReport` é sobrescrito a cada turno segurado (`hub.ts:2551`), sem juntar com o anterior. Dois cenários perdem o relatório. (a) Pai com dois filhos: escreve o relatório, o filho 1 chega e o pai escreve "recebi a3, falta a4". Esse texto curto vira o `heldReport`, e o relatório original some. (b) Agente em `waiting` recebe pergunta de B: a causa `report` segurada e a `reply(B)` são consumidas juntas, `wantsReport` fica true, e a resposta a B vira o `heldReport`. Correção: `agent.heldReport = mergeHeldReport(agent.heldReport, rawText)` na linha 2551, e só quando o turno não for de resposta.

### Achados novos

- Média. Subagente escapa do orçamento da caixa pelo `spawn_agent`. `boxFor` (`hub.ts:1646-1653`) aceita qualquer caixa existente e cria caixa nova sem mãe, sem `ownsBox`. Um agente dentro da caixa b1 (com orçamento) cria filhos com `box: "outra"` e o gasto deles não entra em b1. Também põe agentes em caixa de terceiros, o que o `assign_box` agora proíbe. Correção: no `boxFor` de subagente, exigir `ownsBox` ou herdar a caixa de quem cria como `parent`.
- Baixa. Status `waiting` com a sessão ocupada. Com relatório de filho na fila do CLI, `pendingFor` segura e o status vira `waiting` (`hub.ts:2554`), mas o turno enfileirado já vai rodar. Como `busy` não alterna, `onBusyChange(true)` não dispara e o nó mostra "aguardando" enquanto trabalha. O `maxRoutedAgents` (que conta só `running`) e o `tryPush` das novidades do cérebro tratam o agente como ocioso.
- Baixa. `stopForGood` (`hub.ts:1848-1869`) não chama `stopBackgroundTasks`. Agente parado por orçamento com processo em segundo plano volta a rodar quando o CLI abre o turno automático.
- Baixa, plausível. `onTurnEnd` não olha `stoppedByUser`. Se o `result` do turno interrompido chega depois do `stop()`, o status vira `failed` por cima de `stopped`.
- Baixa, plausível. `consumedCauses` só sabe de `auto` quando o turno automático abre com a sessão ociosa. Aviso de tarefa que o CLI enfileira no meio de um turno conta em `queued` sem causa, e uma resposta pode sair com o texto do turno errado.

### Guard, semáforo e cofre (subagente)

Fechados: 1 (reserva síncrona, `agentGuard.ts:898`); 3 (última cópia boa, `.bak` ou `protectAll`, `lockbox.ts:118-133`); 5 (`closed`, `agentGuard.ts:481,603`); 6 (abort na fila, `heavy.ts:81-90`, `sweep.ts:176`); 7 (`hub.ts:848-850`, `1865-1867`, `stopAllWork` no reset). Li o `heavy.ts` também: não há vazamento de vaga no abort e nada libera duas vezes.

Parciais:
- 2: o cartão agora avisa, e stdout/stderr ficam ocultos (`seeds.ts:116`, `manager.ts:567`, `sweep.ts:287`). Ainda saem dados pelo valor da métrica, pelos nomes das chaves do JSON (`sweep.ts:309`) e por `read.message` (`sweep.ts:297`).
- 8: a prioridade resolve a espera do `run_evaluation` (`heavy.ts:75`). Continuam o teto de núcleos/2 nas varreduras e `OMP_NUM_THREADS=1` desde o primeiro processo.

Aberto: 9, `run_evaluation` roda o comando do cofre sem reserva nem contagem (`agentGuard.ts:1022-1038`).

Novos, todos baixos:
- O listener de `abort` não é removido depois do grant (`heavy.ts:81`). A varredura usa um só sinal, então passa de 10 listeners e o Node emite `MaxListenersExceededWarning`.
- Reserva do cofre que fica "rodando" para sempre se a janela fechar no meio. Falha fechado.
- `closed` da caixa só existe em memória e some no restore.
- Interromper o turno do main não para `run_evaluation` nem `lockbox_evaluate`.

### Lab pareado (subagente)

- Fechado: 2 (limite de 5% por braço, contra o total do próprio braço, bloqueia suportada e refutada; `evaluate.ts:197`, `261-262`).
- Parcial: 1. `unit` declarado é exigido nos dois braços (`tools.ts:394`, `evaluate.ts:242-245`), mas agrupamentos diferentes entre os arquivos ainda viram só uma nota (`evaluate.ts:194-207`).
- Abertos, sem mudança: 3 a 7 (`evaluate.ts:166`, `stats.ts:478`, `stats.ts:564`, `pairedCheck.ts:46`, `seeds.ts:40-60` e `tools.ts:133`).
- Não houve regressão para hipótese sem `unit`.

## Terceira passada (checagem final)

Nada de severidade alta. Um achado médio continua aberto: um subagente escapa do orçamento da caixa pelo `create_box`.

- Resposta do main pela hora da pergunta: fechado. `hub.ts:1303` grava a hora antes do `deliver`; `turnRules.ts:187` junto com `hub.ts:2309-2318`. Resta um caso plausível e baixo: se o CLI dobrar a pergunta dentro do turno em andamento (sem `queued`), a resposta só sai no turno seguinte do main.
- heldReport: fechado. `nextHeldReport` em `turnRules.ts:198`, usado em `hub.ts:2594`; junta com o anterior e não mexe em turno de resposta.
- boxFor com ownsBox: parcial. `hub.ts:1655-1670` fechou o `spawn_agent` em caixa alheia e cria a caixa nova como filha. Mas o `create_box` de subagente (`hub.ts:1517`) ainda cria caixa sem mãe quando `parent_box` é omitido, e o `assign_box` (`hub.ts:1536`) também. Um agente em b1 cria "x", fica dono dela e põe filhos lá com `spawn_agent({box:"x"})`, fora da soma de b1. Correção: em subagente, `parent = own?.id` por padrão nesses dois caminhos (ou recusar caixa sem mãe quando quem cria está em caixa com orçamento).
- stopForGood com stopBackgroundTasks: fechado (`hub.ts:1877`).
- stoppedByUser com result atrasado: parcial. `hub.ts:2540` cobre o `result` que chega depois do stop. Em `stop()` (`hub.ts:834-837`) a flag só é marcada depois do `await stopBackgroundTasks()` e do `await interrupt()`. Um `result` que chega durante esses awaits passa pelo fluxo normal e pode entregar o texto parcial como "Relatório final". Correção: marcar `stoppedByUser` antes dos awaits.
- waiting com a sessão ocupada: fechado (`hub.ts:2597`, `waitingNow` exige `queued === 0`).
- closed persistido: fechado (`agentGuard.ts:481` e `625`, `agentStore.ts:298`).
- run_evaluation do comando do cofre: fechado para comando igual ao do cofre ou que cite os caminhos dele (`agentGuard.ts:951-965`, `1092-1094`). Um script que chama o comando do cofre por dentro continua passando: é a mesma limitação textual do item seguinte.
- run_seeds/start_sweep protegido: fechado no que o hub devolve (`seeds.ts:135-147`, `sweep.ts:287`, `298`, `310`, `316-319`). Resta o limite de sempre: o script roda fora dos hooks e pode gravar em arquivo que o agente lê. Com `metrics_file_template`, o JSON cru fica no caminho escolhido pelo agente (`seeds.ts:139-141`). O cartão avisa disso.
- Listener do abort: fechado (`heavy.ts:91-95`).
- Reserva órfã: fechado (`lockbox.ts:122-133`, `markInterrupted` por pid vivo). Baixa: pid reaproveitado pelo sistema mantém a reserva como "rodando".
