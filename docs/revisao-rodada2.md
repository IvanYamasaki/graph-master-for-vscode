# Revisão da segunda rodada (a7 hub, a8 lab, a9 guard, a10 cérebro)

Revisão só de leitura, feita por a11 em 2026-09-30 sobre o working tree não commitado. "Confirmado" quer dizer que li o
código e, onde indicado, reproduzi. "Plausível" é leitura sem reprodução.

## Alta

### A1. paired_seeds dá p ≈ 0,0001 com 2 seeds (confirmado, reproduzido)

`src/chat/lab/evaluate.ts:388` calcula o p do modo `paired_seeds` com `pairedBootstrap` (`src/chat/lab/stats.ts:573`),
que conta réplicas bootstrap com |d − diff| ≥ |diff|. Quando todas as diferenças por seed têm o mesmo sinal, nenhuma
réplica chega lá, e o p vale 1/(B+1), qualquer que seja o n. Reproduzi com o `pairedBootstrap` compilado:

| diferenças por seed | p do código | IC 95% | p exato do sign-flip (bicaudal) |
|---|---|---|---|
| 0,01; 0,02 | 0,0001 | [0,010; 0,020] | 0,50 |
| 0,01; 0,02; 0,03 | 0,0001 | [0,010; 0,030] | 0,25 |
| 5 positivas | 0,0001 | [0,009; 0,024] | 0,0625 |
| 4 positivas, 1 negativa | 0,0086 | [0,003; 0,024] | 0,19 |

Com `min_seeds: 2` ou `3` (o registro aceita), o veredito sai "suportada" com 2 ou 3 instâncias. Com o padrão de 5, sai
"suportada" num caso em que nenhum teste pareado exato passa a 0,05. O IC percentil também fica estreito demais com n
pequeno. O p entra na família BH, então o número errado contamina a correção das outras hipóteses também.

Correção: o p de `paired_seeds` deve vir de `pairedT` (já existe em `stats.ts:209` e o modo `seeds` pareado usa ele em
`compareArms`) ou de um sign-flip exato (2^n para n ≤ 16, Monte Carlo acima). O IC deve ser o t da média das
diferenças, ou BCa. Também vale exigir `min_seeds ≥ 6` em `paired_seeds`, porque com 5 nem o teste exato chega a 0,05.
O `pairedBootstrap` continua certo para `paired_bootstrap` com centenas de linhas.

### A2. Qualquer agente sobrescreve o resultado do cofre com log_run (confirmado por leitura)

O `log_run` (`src/chat/lab/tools.ts:396-431`) não recusa hipótese `single`. O braço dela chama `"cofre"` (`SINGLE_ARM`,
`tools.ts:26`), e o read_board mostra esse nome. Veja o cenário. O main registra h5 `single` e o cofre lb1 apontando
para h5, e o `lockbox_evaluate` grava r30 com acc = 0,71. Depois um subagente chama
`log_run({ hypothesis_id: "h5", arm: "cofre", seed: 0, command: "x", metrics: [{ name: "acc", value: 0.93 }] })`, e o
run r31 entra com source "declarado". A partir daí o `declare_result` (`tools.ts:594-596`) responde "O resultado é o run
r31 (acc = 0.93)", porque usa `.at(-1)`. O read_board e os agregados passam a usar r31 também. Pior, se o agente fizer
isso antes da avaliação, `store.ts:177` já marca a hipótese "concluída" sem o cofre ter rodado.

Correção: recusar `log_run` e `addHostRun` em hipótese `single`, porque só `addLockboxRun` grava nela. O resultado que
vale deve ser o run da primeira avaliação do cofre (`lockbox.evalId` mais antigo), não o último. Isso bate com a frase
"A avaliação que vale é a de ..." do guard (`agentGuard.ts`, `evaluateInLockbox`).

## Média

### M1. Lembrete de hipótese dispara em agente de outra conversa (confirmado)

`staleHypotheses` (`src/chat/lab/tools.ts:210`) filtra por `h.createdBy === agentId`. O quadro é do projeto
(`.agm/lab/`, `store.ts:141`), mas o id do agente recomeça em a1 a cada conversa (`hub.ts:1094`). O caso real está em
teste-drones. Lá h2 tem createdBy "a1", 20 runs e nenhum veredito, então `readyToDeclare` dá true. Na próxima conversa
nesse projeto, o primeiro a1 (qualquer tarefa) tem o relatório final segurado e recebe "uma hipótese sua tem runs
suficientes...". O `reminded` (em memória) não protege, porque é por sessão do VS Code e não por conversa.

Correção: filtrar também pela conversa. `integrity.conversationOf(h)` (`integrity.ts:104`) já guarda isso em
`context.jsonl`. Outra saída é gravar `createdIn` na hipótese.

### M2. Parar o agente no turno do lembrete perde o relatório (confirmado por leitura)

O relatório vai para `heldReport` e o agente volta a "rodando" (`hub.ts:2640-2654`). Se o usuário clicar Parar nesse
turno, `hub.ts:845` limpa `heldReport` e nada é entregue. Antes desta rodada o relatório já teria saído. O mesmo vale
para o "parar de vez" (`hub.ts:1935`, que manda `lastTurnText`, o texto do turno do lembrete, e não o relatório) e para
o fechamento do VS Code no meio do turno, porque `heldReport` não é persistido.

Correção: quando o held vem só do lembrete (nenhuma pendência real), o Parar deve entregar o `heldReport` a `reportTo`
em vez de descartar. Uma forma é guardar um flag `heldByReminder` e, no stop, entregar `mergeHeldReport(held, '')`.

### M3. Resultado do cofre chega a subagentes pelo quadro (confirmado por leitura)

`addLockboxRun` (`tools.ts:173`) grava a métrica do cofre como run da hipótese `single`. O `read_board`
(`tools.ts:545`), o `declare_result` (mensagem de erro de `tools.ts:596`) e o `experiment_report` são ferramentas de
qualquer agente, não só do main. Assim qualquer subagente lê o número do teste. Isso contraria a regra de que os
números do cofre só vão ao main, e abre caminho para escolher pelo teste.

Correção: o `board()` e as mensagens devem esconder as métricas de runs com `lockbox` quando `callerId !== MAIN_CALLER`,
mostrando por exemplo "avaliado em <hora>, valor só para o main". Para `experiment_report` pedido por subagente, vale o
mesmo.

### M4. Os números do cofre abrem o aviso de número para quase tudo (plausível)

`checkReport` (`tools.ts:281`) aceita todos os `lockboxNumbers(root)` sem `sinceIso`. São até 500 números por avaliação
(`lockbox.ts:310`), com todos os números do stdout, inteiros incluídos, de todos os cofres e de todas as conversas, para
todos os agentes. A tolerância do casamento é de ±10^−decimais (`provenance.ts`, `matches`). Uma avaliação que imprime
uma tabela por instância com uns 200 valores em [0,1] cobre cerca de 1−e^(−200·0,02) ≈ 98% dos números de duas casas
nesse intervalo. Depois disso, qualquer "acurácia 0,87" inventada passa sem aviso. Os agregados de `runAggregates`
também incluem mín. e máx. de runs de outros agentes, e grupo de um run só dá o próprio valor. Na prática, a regra de
que o agente só cita os runs dele deixou de valer para extremos e singletons. Isso é menor que o problema do cofre.

Correção: aceitar só as `metrics` da avaliação (a última linha JSON), não `numbers`, e só as do cofre desta conversa
(`sinceIso` com o início da conversa). Para agentes que não sejam o main, uma opção é nem aceitar, já que eles não
deveriam ter o número (M3). Nos agregados, usar só média e mediana de grupos com 2 ou mais runs.

### M5. gitInfo perde o arquivo modificado e marca como sujo o arquivo de saída (confirmado, reproduzido o formato)

1. `git()` faz `.trim()` na saída inteira (`tools.ts:806`), e o parser corta `l.slice(3)` (`tools.ts:829`). O
   porcelain de um arquivo rastreado e modificado sem stage é `" M solver.py"`. Depois do trim ele vira
   `"M solver.py"`, e o slice devolve `"olver.py"`. O primeiro arquivo da lista nesse estado nunca casa. `dirty` ainda
   fica true por causa do `status --untracked-files=no`, mas `dirtyFiles` some, e com isso o aviso específico some
   também. Isso acontece justamente no caso mais comum, que é mexer no script e rodar sem commitar. Correção: não dar
   trim antes de separar as linhas (usar `trimEnd`), ou usar `--porcelain -z`.
2. `commandFiles` pega todo arquivo existente com extensão citado no comando, e o status usa `--ignored`. No
   `run_seeds` com `--out results/{arm}_{seed}.json` (o exemplo da própria descrição da ferramenta), o arquivo de saída
   existe quando `addHostRun` roda. Como é untracked ou ignorado, todo run sai com `dirty: true` e com "Atenção: ...
   não está no git". O mesmo acontece com dados ignorados (`--data data/train.csv`) e com checkpoints. O aviso vira
   ruído e o dirty perde o sentido. Correção: tirar do `commandFiles` o `metricsFile`/`artifact` do run e os arquivos
   ignorados pelo git (tirar `--ignored`), ou olhar só as extensões de código (.py, .sh, .R, .jl, .yaml de config
   rastreado).

## Baixa

- **B1. O git roda de forma síncrona no extension host** (`tools.ts:806`, `execFileSync`, timeout de 3 s). Agora são até
  4 processos por `log_run`/`addHostRun`, contra 2 antes. Um `run_seeds` de 50 seeds dá cerca de 200 spawns de git na
  thread do host. No Windows, com uns 50 ms cada, são ~10 s de UI travada em pedaços, e o pior caso é de 12 s por run.
  Caminhos fora do projeto e de outro drive saem certos (`commandFiles` descarta `..` e caminho absoluto). Sugestão:
  `execFile` assíncrono, ou cache do `rev-parse`/`status` por workdir durante um mesmo `run_seeds`.
- **B2. Herança de protected_paths e Codex** (`hub.ts:2171`). Um agente protegido pode criar um filho Codex. O filho
  herda a lista, mas o Codex não aplica, e só sai um aviso. Sugestão: recusar `provider: "codex"` quando o criador tem
  proteção herdada. Fora isso, a herança se sustenta. spawn_attempts passa por `hub.spawn` com `creator: callerId`
  (`attempts.ts:109`), o worktree também, a união é persistida em `agentStore.ts:198` e volta no restore
  (`hub.ts:965`), e run_seeds/sweep usam `info.protectedPaths` (a união). O verificador nasce com
  `creator: 'main'` (`verify.ts:117`), então fica sem a proteção do agente que pediu a verificação. Isso é aceitável,
  porque ele reporta ao main, mas vale uma linha na doc.
- **B3. Gasto em US$ de caixa mista.** `boxSpendSummary` (`agentGuard.ts:524`) só avisa "Codex não entra" quando todos
  os membros são Codex. Numa caixa mista o US$ aparece sem ressalva. Não vi soma dupla: `boxMembers` junta a caixa e
  as filhas diretas, cada agente tem uma caixa só e o aninhamento é de um nível. Plausível, e anterior a esta rodada: no
  restore, `lastCostTotal` começa em `spent.usd` (`agentGuard.ts:305`). Se o primeiro total do processo retomado já
  passar esse valor, o delta subtrai o gasto antigo e a conta fica menor.
- **B4. O lembrete não sai quando o turno final também responde a uma pergunta** (`replyTurn`). O relatório é entregue
  sem ele, e não existe "próximo turno final". O efeito é pequeno, porque é o mesmo comportamento de antes.
- **B5. parallelLaunchHint** casa `-P 22` (`scp -P 22`) e qualquer `Start-Process`. É só aviso, limitado a 3 por
  agente, então o impacto é pequeno.

## O que conferi e está certo

- O lembrete segura no máximo um turno por hipótese. `takeStaleReminder` marca antes de devolver, e no turno seguinte
  o relatório sai com `mergeHeldReport`. Pendência nova no turno do lembrete cai no caminho do `hold`, que junta e não
  sobrescreve. Pausa por orçamento e limite de uso mantêm causa e held. Erro no turno do lembrete entrega o held junto
  com a falha, e a fila com mensagem (`queued > 0`) não recebe lembrete.
- Cofre sem hipótese. A reserva (`reserveEvaluation`) é síncrona e grava antes de qualquer await, então duas chamadas
  seguidas veem a primeira como `previous`. `lockbox_evaluate` e `run_evaluation` usam a mesma chave `(cofre)`, e a
  recusa apaga a reserva. `addLockboxRun` grava um run por avaliação aprovada, com o mesmo braço e a seed 0. Isso não é
  duplicata acidental, mas "o resultado" vira o último (ver A2).
- `single` fica fora da família BH (`integrity.ts:113,170`) e fora do `readyToDeclare`. O p de `paired_seeds` entra na
  família como os outros, e o problema é o valor dele (A1).
- Cérebro (a10). Lote só com ESTADO.md é descartado em `flushMain`, e ESTADO.md não vai para agentes (filtro `!e.state`
  no `dispatch`). Não vi regressão.
- Para quem não usa nada disso, o custo extra por relatório final é `staleHypotheses`, `runAggregates` sobre o quadro
  inteiro e a leitura de `.agm/lockbox.json`. Tudo isso é barato com quadro pequeno e fica 0 sem quadro
  (`hasData()`). A regressão real para esse usuário é M1, com hipóteses antigas no projeto.
