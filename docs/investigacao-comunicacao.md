# Investigação: comunicação e custo entre agentes

Agente a5, 2026-09-29. Só leitura do código em `main` (e35fef4). Tamanhos em caracteres vêm de `wc -c` nas linhas-fonte (incluem aspas e indentação, então superestimam uns 10%). A conversão para tokens usa ~3,5 caracteres por token em português, que é uma estimativa.

Não repito o que a1 a a4 já tratam: concluído com background, protocolo criador-filho, list_models, OMP_NUM_THREADS, 429, janela do cérebro, bootstrap, aviso de número, run_seeds, semáforo de CPU, budget por caixa, cofre.

Ordem por retorno (ganho sobre esforço).

## 1. Subagentes sobem todos os MCP do usuário

- Evidência: `src/chat/session.ts:249-255`. Há `settingSources: ['user','project','local']` e nenhum `strictMcpConfig`. O `~/.claude.json` tem 5 servidores (bigquery, supabase, notion, whatsapp, clause), e os conectores do claude.ai (Drive, Notion, Slack, Supabase, Tally) também entram. No meu contexto de subagente chegaram ~225 nomes de ferramentas adiadas (~9 mil caracteres) e as instruções de Notion, Supabase (duas vezes), Tally e clause (~7 mil caracteres). O clause deu timeout de 30 s.
- Impacto: ~4 a 5 mil tokens fixos por agente, relidos em todo turno (a 0,1x com cache). A isso somam-se 5 processos MCP por agente, ou ~60 com 12 agentes, e avisos de "ferramentas novas disponíveis" que caem no meio da conversa.
- Proposta: para agentes roteados (não o main), `strictMcpConfig: true` e `mcpServers` = `agents` + os servidores do `.mcp.json` já aprovados (lidos da mesma fonte de `projectMcpSettings`). Para cortar os conectores do claude.ai, a env `ENABLE_CLAUDEAI_MCP_SERVERS=false` em `profileEnv`. Isso eu não verifiquei nesta versão; testar antes. Uma config `agentGraphMaster.agentUserMcp: "none" | "all"` cobre quem precisa de Slack num agente, e vigias de Slack precisam: para eles o default seria "all".
- Arquivos: `session.ts` (opção nova em `SessionOptions`), `hub.ts:openSession`. Conflito: a1 (dono de session/hub).

## 2. O relatório entregue leva a narração e se repete em turnos de fila

- Evidência: `session.ts:309` zera `turnTexts` só em `send()`. `session.ts:772` acumula todo bloco de texto do turno. `session.ts:838` junta tudo e nunca limpa. `hub.ts:1931` entrega esse texto inteiro. Dois efeitos:
  - (a) o relatório chega com toda a narração do turno ("Vou ler o hub...", as respostas a "o usuário não ouve você há um tempo"), então a primeira linha deixa de ser a conclusão;
  - (b) mensagem que chega com o agente ocupado zera o acumulado no meio do turno, e o turno seguinte da fila herda o texto do anterior. A "Resposta" a um send_to_agent repete o relatório final inteiro.
- `codexSession.ts:596` zera por turno (certo). `noteReport` (`hub.ts:2075`) já pega só o último texto para o cérebro.
- Impacto: o main recebe o relatório duas vezes e com narração. O contexto do main é o que vive mais e é relido a cada turno. Um relatório de 3 mil tokens duplicado custa isso em todo turno seguinte do main até compactar.
- Proposta: em `session.ts`, no `result`, `lastTurnText = ...; this.turnTexts = []`, e tirar o reset de `send()`. Guardar também `finalText` = textos depois do último `tool_use` do turno. O hub entrega `finalText` e o mapa continua mostrando tudo.
- Arquivos: `session.ts`, `hub.ts:onTurnEnd`. Conflito: a1.

## 3. `autoDeliveries` nunca zera e o limite descarta o turno inteiro

- Evidência: começa em 0 (`hub.ts:853`, `1751`), cresce em `hub.ts:1999` e nunca volta. Em `hub.ts:1997` o limite faz `return`, não `continue`, então os outros destinos do mesmo turno se perdem também.
- Impacto: falha. Um agente com mais de 10 trocas (perguntas ao criador, pedidos de status, rodadas de revisão) para de entregar, inclusive o relatório final. O criador espera para sempre, e com o protocolo de perguntas que a1 está fazendo isso vai acontecer com frequência.
- Proposta: laço de verdade é A↔B sem humano no meio. Zerar o contador quando o agente recebe mensagem do usuário (`sendFromUser`) e contar por par (from, to) numa janela de ~10 min. Trocar `return` por `continue`. Quando bloquear, avisar quem espera ("a7 foi bloqueado por laço").
- Arquivos: `hub.ts`. Conflito: a1.

## 4. send_to_agent diz "entregue" antes de saber se o destino existe de fato

- Evidência: `hub.ts:1140-1144` só confere `this.agents.has`. Em `deliver` (`hub.ts:2108-2113`), se `live()` falha (sem sessionId, conta removida, worktree descartado), a mensagem vai para o main como se fosse dele. Quem mandou recebeu "Mensagem entregue" e fica esperando a resposta.
- Impacto: falha silenciosa. O main recebe uma mensagem que era para outro agente e pode agir sobre ela.
- Proposta: `deliver` devolve boolean (ou Error) e o send_to_agent responde `isError` com o motivo de `live()`. O fallback para o main fica só para relatórios.
- Arquivos: `hub.ts`. Conflito: a1.

## 5. Prompt de sistema congelado: guia do cérebro some do primeiro agente, e o toggle do navegador não muda o prompt

- Evidência: o cérebro só liga com 2 agentes rodando ou uma caixa (`brain/keeper.ts:102-110`). O guia entra no prompt do agente só se `brain.isActive` (`hub.ts:482`), então o primeiro agente de uma conversa sem caixa nasce sem as instruções do cérebro, embora tenha as ferramentas. Além disso, o SDK 0.3.284 grava o prompt no primeiro request (`systemPrompt.snapshot`, padrão true, `sdk.d.ts:2350-2365`): o `append` recalculado num restart ou resume é ignorado até compactar. Assim `browserGuideMain` (`hub.ts:490`), que muda com o interruptor e reinicia a sessão (`session.ts:370-385`), não chega ao modelo.
- Impacto: o primeiro agente não consulta nem escreve no cérebro. O main com o navegador ligado continua instruído a delegar e a criar agente com browser, e o spawn falha.
- Proposta: estado que muda não vai no `append`. Quando o cérebro liga, mandar um aviso único aos agentes rodando, pelo canal de novidades que já existe (`brain/news.ts`). Na troca do interruptor, mandar uma linha ao main na próxima mensagem. Ou incluir o guia do cérebro sempre que `brain.notify !== 'off'`.
- Arquivos: `hub.ts`, `brain/keeper.ts`. Conflito: a1 e a2.

## 6. Ferramentas carregadas ao contrário: lab, infra e externas sempre carregadas, cérebro adiado

- Evidência: todas as ferramentas de lab (`lab/tools.ts`, 5), infra (`infra/index.ts`, 5), relatório (`lab/report.ts`) e as externas (`hub.ts:1394-1437`) têm `alwaysLoad: true`. As 5 do cérebro não têm e chegam como adiadas, embora o prompt mande chamar `brain_read` "antes de começar". Neste agente vieram 22 ferramentas `mcp__agents__*` carregadas. Só submit_job, watch_training, register_hypothesis, log_run e spawn_attempts somam ~12 mil caracteres de schema (estimativa pelo que recebi). Os guias de subagente medem: ferramentas 1.834, externo 2.150, lab 654, infra 560, cérebro ~1.900, identidade 644, ou ~7,8 mil caracteres (~2,2 mil tokens) de `append`. Desses, ~3,4 mil (externo, lab e infra) não servem à maioria dos agentes.
- Impacto: ~4 a 5 mil tokens fixos por agente em schemas e guias que ele não usa, e um ToolSearch extra (um turno) para usar o cérebro.
- Proposta: lab, infra e externas sem `alwaysLoad` para subagentes, com uma linha de guia ("laboratório, jobs de GPU, web_research e generate_image: carregue com ToolSearch 'agents lab'; número de resultado só via log_run"). A regra de proveniência fica porque `checkReport` avisa. O guia completo continua para quem o main criou com um sinal no prompt (ex.: `spawn_agent({ kits: ["lab"] })`). `brain_read`, `brain_search` e `brain_fact` com `alwaysLoad`.
- Arquivos: `lab/tools.ts`, `lab/report.ts`, `infra/index.ts`, `brain/tools.ts`, `hub.ts:externalTools/systemAppendFor`. Conflito: a3 (lab), a2 (cérebro), a1.

## 7. Contexto inicial do filho: anexar o estado da frente em vez de 2 a 3 chamadas

- Evidência: o filho recebe só `prompt` (`hub.ts:1771`). Para saber da caixa ele carrega ToolSearch e chama `brain_read` do índice e depois da frente, três turnos relendo o contexto inteiro. Os irmãos e os arquivos de cada um só chegam se o criador escrever à mão (como no meu prompt: "a1 dono do hub...").
- Proposta: no primeiro envio, o hub prefixa um bloco curto (até ~1,5 mil caracteres): caminho e trecho do `ESTADO.md` da frente, lista de irmãos rodando na caixa (id, descrição, `owns`) e o caminho do índice. Custa ~400 tokens e economiza 2 a 3 turnos por agente.
- Arquivos: `hub.ts:spawn`, `brain/store.ts` (leitura do ESTADO). Conflito: a1 e a2.

## 8. Reserva de arquivos entre irmãos (claim)

- Evidência: não existe reserva de arquivo nem de tarefa (rg por claim/owner em brain, guard e parallel não achou nada). A posse de arquivo vive só no texto do prompt. O guarda já tem hook PreToolUse de caminho protegido (`guard/protect.ts`).
- Proposta: `spawn_agent({ owns: ["src/chat/brain/**"] })`, guardado em `AgentInfo`. O mesmo hook avisa (não bloqueia) quando um agente em modo shared faz Edit ou Write em caminho de outro agente rodando, e diz de quem é, para ele usar send_to_agent. A lista `owns` entra no roster do item 7.
- Impacto: evita edição concorrente no mesmo arquivo, que hoje só se descobre no fim, com retrabalho.
- Arquivos: `guard/protect.ts`, `guard/agentGuard.ts`, `hub.ts`. Conflito: a4 (guard) e a1.

## 9. Relatórios ao main em lote

- Evidência: cada relatório vira um `send` ao main (`hub.ts:2104`, `sendMain`). Com o main ocioso, cada um abre um turno inteiro.
- Impacto: com contexto do main em 100 mil tokens, cada turno extra relê ~100 mil a 0,1x (~10 mil equivalentes) mais a saída. Uma onda de 5 agentes que terminam em 2 minutos dá 5 turnos quando 1 ou 2 bastariam.
- Proposta: com o main ocioso e outros agentes da mesma caixa ou do mesmo criador ainda rodando, segurar o relatório por uma janela (config `reportBatchSeconds`, ex.: 30) e entregar os que chegarem juntos numa mensagem só. Com o main ocupado já vale a fila do SDK.
- Arquivos: `hub.ts:deliver/sendMain`. Conflito: a1 (parecido com a janela de novidades do cérebro; dá para reusar o mecanismo).

## 10. Mensagem a agente concluído ou restaurado custa o contexto inteiro

- Evidência: `live()` (`hub.ts:1847`) retoma a sessão por resume. Depois do TTL do cache, a primeira chamada reescreve o contexto todo no cache.
- Impacto: uma pergunta de uma linha a um agente com 150 mil tokens custa ~190 mil equivalentes (escrita a 1,25x).
- Proposta: o retorno do send_to_agent informa quando o destino estava parado, com o tamanho do contexto dele (`info.totalTokens`). O guia sugere ler antes o relatório ou a nota do agente no cérebro, ou criar um agente novo com o relatório anexado.
- Arquivos: `hub.ts`. Conflito: a1.

## 11. Tamanho do relatório sem teto

- Evidência: nada limita o texto em `onTurnEnd`. A regra de "até 1 página" existe só no prompt de quem cria.
- Proposta: acima de N caracteres (config, ex.: 6 mil), o hub grava o relatório inteiro em `.agm/reports/<id>.md` (ou usa a nota do agente no cérebro) e entrega os primeiros ~2 mil caracteres com o caminho.
- Arquivos: `hub.ts:onTurnEnd`. Conflito: a1.

## 12. Ordem do append e reuso de cache entre irmãos

- Evidência: o `append` do subagente começa pela identidade (`hub.ts:471`), única por agente. Tudo o que vem depois (guias iguais entre irmãos) fica fora do prefixo comum.
- Proposta: guias primeiro e identidade, destino, orçamento e worktree no fim. Irmãos do mesmo modelo e conta passam a ler do cache ~2 mil tokens do primeiro request em vez de escrever. Ganho pequeno, mudança trivial.
- Conflito: a1.

## 13. list_agents cresce sem limite

- Evidência: `hub.ts:1149-1173` lista todos os agentes, concluídos e restaurados inclusive, a ~300 caracteres por linha.
- Proposta: filtros `status` e `box`. Por padrão, para subagente: a própria caixa e os que estão rodando.
- Conflito: a1.

## Ponto que se sobrepõe ao a1

Filho que pergunta ao criador e encerra o turno esperando a resposta é tratado como relatório final (`hub.ts:1920` marca completed, e a causa 'report' encaminha o texto). O protocolo criador-filho do a1 precisa de um estado "esperando resposta" que não entregue nem conte como `autoDeliveries`.
