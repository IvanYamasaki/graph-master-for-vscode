# Revisão: matar o processo errado e esconder tarefa viva

Revisão só de leitura (a14, 2026-09-30) das mudanças não commitadas em `src/chat/proc/`, `taskLiveness.ts`, `taskProcs.ts`, `session.ts` e `panel.ts`. Os testes existentes passam (`taskLiveness.test.ts` e `proc.test.ts`). Os dois cenários de raiz errada abaixo foram reproduzidos chamando `taskRootPid` de verdade com uma lista de processos montada à mão (script em `%TEMP%\a14repro.ts`, fora do repositório).

## Alta

### A1. "Encerrar" numa tarefa perdida ou concluída mata o servidor de outra tarefa

`src/chat/taskProcs.ts:27-36` (`taskRootPid`), `src/chat/proc/find.ts:79` e `:99`, `src/chat/panel.ts:281` e `:481-505`.

A raiz da tarefa é procurada assim: um trecho do comando na linha, descendente do extension host, iniciado depois de `startedAt - 5 s`. Se nada casar, a busca repete sem a condição de hora e fica com o mais recente. Falta um limite superior de tempo. Falta também amarrar a busca ao CLI desta sessão, já que todos os chats e todos os agentes roteados da janela descendem do mesmo extension host.

Cenário, reproduzido:
1. A tarefa T1 roda `npm run dev` às 10:00. O CLI reinicia (troca de raciocínio, Chrome ligado ou desligado, MCP aprovado) e T1 vira `lost`. O bash de T1 fica órfão: o pai morreu, então ele sai da árvore do extension host.
2. Às 10:01 o mesmo agente, ou outro agente da janela, sobe `npm run dev` de novo (T2).
3. O usuário abre o popup de T1 (o painel lê os processos de qualquer item `local_bash`, qualquer que seja o status) e clica em "Encerrar". `taskRootPid(T1)` devolve a raiz de T2 (`lost task -> root 300` no teste). O modal mostra "PID bash.exe, PID node.exe (porta 3000)", que parece o servidor de T1. O usuário confirma e derruba o servidor vivo de T2.

É exatamente o caso de uso do recurso (tarefa perdida cujos processos podem continuar vivos), e é nele que a busca erra.

Correção sugerida:
- Guardar a identidade da raiz (`pid`, `name`, `startedAt`) na primeira leitura bem-sucedida enquanto o item está `running` e com o CLI desta sessão vivo. Daí em diante, usar só essa foto e conferir a identidade antes de mostrar e antes de matar.
- Para item que não está `running`, não fazer busca nova sob o extension host. Se não houver foto, mostrar "sem processos conhecidos" e mandar para a lista de órfãos.
- Na busca: janela fechada (`startedAt - 5 s` a `startedAt + 5 s`), sem o recuo "o mais recente". Dá para restringir `parentPid` ao PID do CLI desta sessão, que aparece como filho do extension host com `claude.exe` no nome e nasceu logo depois do `start()`. O SDK aceita `spawnClaudeCodeProcess`, e por ele dá para capturar o PID.

## Média

### M1. Dois agentes lançam o mesmo comando em até 5 s: "Parar" mata a árvore do outro

`src/chat/taskProcs.ts:35`, `src/chat/proc/find.ts:99`, `src/chat/session.ts` (`stopAgent`: `snapshotTaskTree` seguido de `killSurvivors`).

Com `startedAfter`, vence o processo mais cedo depois do marco. Se o agente A lançou `npm test` 3 s antes do agente B, o marco de B (`startedAt - 5 s`) inclui o processo de A, e ele vence (`two agents -> root 400`, esperado 500). O "Parar" de B tira foto da árvore de A e `killSurvivors` a mata, porque ela sobrevive ao `stopTask` de B. Acontece com agentes em paralelo que rodam os mesmos `npm test` ou `npx tsc`. Corrige junto com A1: restringir ao CLI da sessão e, com vários candidatos, escolher o mais próximo de `startedAt` (menor distância absoluta), não o mais cedo.

### M2. `killTaskTree` do painel mata um PID lido antes do modal, sem conferir a identidade

`src/chat/panel.ts:505`. `procs.root.pid` vem da leitura feita antes de `showWarningMessage`. O modal pode ficar aberto por minutos, e depois ainda roda `stopAgent`, que já mata a árvore. Aí `killTree(pid)` age sobre o que tiver esse PID agora. O Windows reaproveita PID depressa. `killTree` não recebe `startedAt`. Correção: passar a foto (`ProcStamp`) e reler antes do kill, como `killSurvivors` já faz; ou simplesmente não chamar `killTaskTree` quando `stopAgent` já rodou `killSurvivors`. O mesmo vale para `killOrphans` (`panel.ts:537`) e `pickOrphans` (`panel.ts:1196`): este último não relê nada depois do QuickPick e do modal.

### M3. A lista de órfãos inclui servidor que o usuário abriu num terminal externo, e o modal não mostra isso

`src/chat/proc/find.ts:142-218`, `src/chat/taskProcs.ts:114-123`, `src/chat/panel.ts:528`.

A blindagem cobre o editor, o extension host e tudo abaixo deles. Terminal integrado, tsserver e os CLIs de outras janelas do VS Code ficam de fora, e isso eu conferi pela árvore real: `claude.exe` é filho de um `Code.exe --type=utility`. Ficam dentro os processos que citam a pasta do projeto e foram abertos fora do VS Code:
- `npm run dev` no Windows Terminal: o `node ...\extensao claude\node_modules\vite\bin\vite.js` cita a pasta, a subida pelos lançadores para no `pwsh` interativo, e o grupo aparece com `parentAlive: true`;
- tarefas de shell de um `claude` rodando num terminal externo ou no app Claude Desktop sobre o mesmo projeto;
- processos Node de outra IDE (JetBrains, Visual Studio) que citam a pasta.

A webview mostra "pai vivo" (`orphansUi.ts:107`). O modal de confirmação (`panel.ts:528`) mostra só PID, os primeiros 90 caracteres do comando (em geral o caminho do `node.exe`, que não identifica nada), portas e quantidade. Não mostra o pai, a hora de início, nem que o pai está vivo. O QuickPick sem chat aberto mostra a hora, mas também não mostra o pai. Correção: grupo com pai vivo fora dos lançadores vai numa seção separada ("lançado por pwsh.exe PID x, ainda aberto") e fica fora do "Encerrar todos". O modal passa a trazer pai, hora de início e o trecho do comando que cita a pasta.

### M4. O custo em US$ só entra no fim do turno: turno interrompido não conta, e o `max_usd` não barra turno longo

Causa do "US$ 0,00" do a13. `src/chat/session.ts:1138` só informa `total_cost_usd` no `result`. Os tokens entram por mensagem (`session.ts:1018`), por isso os 11 M aparecem. O a13 fez quase tudo num turno só, e a janela fechou antes do `result`. `spent.usd` ficou `undefined`, e `spendLines` (`costs.ts:89-94`) mostra `US$ 0,00` porque há `maxUsd`. O registro salvo no workspaceState confirma: hoje ele tem `tokens 12433397, usd 0.3454`. Esse valor é só o turno retomado; o custo do turno longo se perdeu. O `agentStore` persiste `spent.usd` (`agentStore.ts:196`, `:313`), então não é problema de persistência nem de restauração.

Consequência mais séria: o teto `max_usd` só é conferido quando chega um `result`, então um único turno longo passa do teto sem ser interrompido.

Correção: em `session.ts:1014-1019`, estimar US$ por mensagem com `usage` (entrada, criação de cache, leitura de cache, saída) vezes o preço do modelo, a partir de `MODEL_PRICES` em `costs.ts`, com os multiplicadores de cache. Mandar isso a `onUsage` como `usdDelta` por `messageId`, como já é feito com tokens. No `result`, trocar a estimativa do turno pelo delta real de `total_cost_usd` em `agentGuard.onUsage` (`agentGuard.ts:341-348`).

## Baixa ou plausível

- **P1 (plausível).** `taskkill /T /F /PID raiz` (`kill.ts:338`) segue o `ParentProcessId` do Windows. Se ele não conferir a hora de criação, mata "filhos" antigos cujo ppid aponta para o PID reaproveitado pela raiz, justo o caso que `isRealParent` evita. As vítimas já estão calculadas (`victims`, folhas primeiro): matar uma a uma com `/F /PID` dispensa o `/T`.
- **P2 (plausível).** Um item dado como `completed` pela regra do nível (`taskLiveness.ts:200-209`) não volta a `running` se depois chegar sinal de vida. `touchTask` (`session.ts:773`) só desfaz `lost`. Se algum `background_tasks_changed` omitir uma tarefa viva (tarefa de subagente, por exemplo; não confirmei o que o CLI lista), o item some do contador enquanto `task_progress` continua chegando. Correção: marcar o status inferido (por exemplo `inferred: true`) e deixar `touchTask` desfazer também esse `completed`.
- **P3 (fora do diff, plausível).** `setEffort`, `setChrome` e `reloadProjectMcp` chamam `start()` na hora quando `busy` é falso, mesmo com tarefas em segundo plano abertas (`session.ts:436-475`). O hub desliga o Chrome no fim do turno de um agente, e um agente "aguardando processo" com servidor rodando perde as tarefas: o CLI é trocado e elas viram `lost`. Correção: tratar `backgroundTasks.size > 0` como ocupado nesses três caminhos.
- **P4.** `agentGuard.ts:305` inicia `lastCostTotal` com o `spent.usd` salvo, supondo que o resume continua o total. Se o processo novo recomeçar de zero e o primeiro total passar do valor salvo, só a diferença entra, e o gasto fica subcontado. Com a estimativa de M4, a conta por mensagem torna isso irrelevante.

## Custo (item 3): sem problema

A leitura de processos é `execFile` assíncrono (`proc/system.ts:310`) e não trava o extension host: medi 2,0 s para 1212 processos. Ela só roda sob demanda, quando o popup de uma tarefa `local_bash` abre (uma vez por abertura, `procUi.ts:85-87`), no "Atualizar", no "Encerrar" e na lista de órfãos. O timer de 2 min (`panel.ts:188-193`) chama só `reconcileTasks`, que é puro e não lê processos. Há um detalhe: cliques repetidos em "Atualizar" disparam PowerShells em paralelo, sem deduplicação. Uma promessa em voo por agente resolve.
