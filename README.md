# Agent Graph Master

Extensão local do VS Code que roda o Claude Code (e o Codex) num chat próprio, com várias contas, agentes em paralelo e um laboratório de experimentos de ML. O chat usa o Claude Code que você já tem instalado, com o mesmo CLAUDE.md, as mesmas skills e os mesmos servidores MCP. A extensão acrescenta um mapa dos agentes da conversa e ferramentas que registram, testam e verificam resultados de experimentos.

Foi escrita para pesquisadores de ML e desenvolvedores que instalam a extensão na própria máquina. Versão atual: 1.2.1. Não há publicação no Marketplace.

## Instalação

Precisa de Node.js com npm e do comando `code` no PATH.

```
npm install
npm run install-local   # compila, gera agent-graph-master.vsix e instala no VS Code
```

Para instalar só o arquivo: `code --install-extension agent-graph-master.vsix --force`. Recarregue a janela depois.

### Requisitos

| Item | Para quê | Obrigatório |
| --- | --- | --- |
| Claude Code (`claude`) | Todo o chat e os agentes Claude | Sim |
| Codex CLI (`npm i -g @openai/codex`) | Contas Codex, agentes Codex, pesquisa e imagem via GPT | Não |
| Antigravity CLI (`agy`) | Pesquisa na web com o Gemini pela assinatura Google | Não |
| Python com `optuna` | Varredura de hiperparâmetros com Optuna | Não |
| git com pelo menos um commit | Worktree por agente, Best-of-N, verificador, commit em cada run | Só para esses recursos |
| Extensão Claude in Chrome | Controlar o navegador | Não |
| `uv` | Servidores MCP do pacote de pesquisa (MLflow, Optuna, Jupyter) | Não |

A extensão procura o `claude.exe` no PATH, na instalação do npm, em `~/.local/bin` e na extensão oficial. Por padrão escolhe a instalação mais nova, porque a lista de modelos do chat vem do CLI e uma instalação velha esconde os modelos novos (`claudePathStrategy`). O Codex e o `agy` têm busca automática parecida, com `codexPath` e `external.agyPath` para forçar um caminho.

## Contas

Abra o ícone do Agent Graph Master na barra lateral. A seção Contas lista as contas. A conta Padrão é a pasta `~/.claude` de sempre.

- Claude. **Adicionar conta**, escolha Claude, dê um nome e escolha "Fazer login agora". Abre um terminal com o login do Claude Code, que você faz uma vez pelo navegador. Cada conta tem uma pasta própria (`~/.claude-profiles/<nome>`, configurável em `profilesRoot`), usada como `CLAUDE_CONFIG_DIR`.
- Codex. **Adicionar conta**, escolha Codex. O login pode ser pela conta do ChatGPT (navegador ou código de dispositivo) ou por chave de API da OpenAI, que vai ao CLI pelo stdin. Se a máquina já tem login em `~/.codex`, a extensão oferece reaproveitá-lo. Contas novas ficam em `~/.codex-profiles` (`codexProfilesRoot`) e cada pasta serve de `CODEX_HOME`.
- Troca rápida. Clique em "Claude: <conta>" na barra de status, ou no botão de check da lista. A troca grava `CLAUDE_CONFIG_DIR` em `claudeCode.environmentVariables` e nas variáveis dos terminais. Sessões novas usam a conta nova. As abertas ficam na antiga até você recarregar a janela; `afterSwitch` escolhe entre perguntar, recarregar ou não fazer nada. A conta ativa vale só para o Claude Code; contas Codex são escolhidas ao abrir o chat.
- Cada chat fica preso à conta com que foi aberto. Dá para ter chats de contas diferentes lado a lado ("Abrir chat com outra conta").
- O ícone de terminal ao lado de cada conta abre o CLI com aquela conta, sem trocar a ativa.

A extensão não lê nem copia tokens. Quem lê e renova o login é o CLI oficial. Não existe rodízio automático de contas: usar várias contas para driblar limite de uso viola os termos dos fornecedores. A troca é sempre um clique seu.

## O chat

Abra com o botão "Chat" na barra de status, o ícone na barra do editor, `Ctrl+Shift+Alt+K` (`Cmd+Shift+Alt+K` no Mac) ou o balão ao lado de uma conta. Cada chat é uma aba. As abas voltam com a conversa depois de recarregar a janela.

Por baixo roda o Claude Agent SDK com o `claude` instalado, o prompt de sistema padrão do Claude Code e as ferramentas dele. A extensão lê CLAUDE.md e settings de usuário, projeto e local.

- Resposta em streaming, ferramentas recolhíveis com diff das edições e saída dos comandos.
- Pedidos de permissão com "Sim", "Sim, e não perguntar de novo" e "Não", perguntas com opções e aprovação de plano.
- Menu "+". Enviar do computador, adicionar contexto (menção `@` de arquivo ou pasta do projeto), mencionar o arquivo aberto com as linhas selecionadas, pesquisar na web, gerar imagem e ligar o navegador.
- Anexos. Arraste arquivos para a janela, cole imagem da área de transferência ou use o menu. Arquivo do explorer do VS Code vira `@caminho`. Arquivo de fora vai com o texto embutido. Imagem vai como imagem.
- "@" no texto sugere arquivos do projeto. "/" abre os comandos de barra do Claude Code (`/rename`, `/goal` e os das suas skills).
- Modelo e raciocínio. Começam em Opus (o alias `opus`) e raciocínio médio. Mude no seletor do composer ou em `defaultModel` e `defaultEffort`.
- Limites do plano no rodapé. Duas barras (5 horas e semana) relidas a cada minuto (`usageRefreshMinutes`). O mouse mostra porcentagem e quando cada janela zera. O clique atualiza na hora. Em conta Codex aparecem as janelas do plano ChatGPT.
- Histórico. O botão de relógio lista as conversas salvas daquela conta nesta pasta, inclusive as do CLI e da extensão oficial, e continua qualquer uma.
- Nome da aba. É o nome da sessão: o título que o Claude Code gera depois do primeiro turno, ou o do `/rename`. Antes disso a aba se chama "Nova conversa". A conta e o modelo ficam em cinza no cabeçalho do chat.
- Nova conversa. O botão "+" do topo abre outra aba com conta e pasta iguais.
- `Esc` interrompe a resposta em andamento.

### Consulta lateral

O botão de balões no topo do chat abre outra aba, ao lado, para tirar dúvidas do projeto, depurar ou perguntar sobre vários agentes de uma vez. Pergunta sobre um agente só vai na thread dele (abaixo).

- Sessão própria (Sonnet, raciocínio médio; `companion.model` e `companion.effort`). Nada do que se diz nela entra no contexto do orquestrador, e ela não interrompe nem espera o chat principal.
- Só leitura. Lê arquivos e a web sem pedir; Write, Edit e subagentes estão bloqueados; Bash e PowerShell pedem aprovação a cada comando.
- Ferramentas de leitura do chat principal: agentes com status, caixa, tempo e tokens, as últimas ações de um agente com horário, o relatório dele, as últimas mensagens da conversa, o laboratório, worktrees, buscas e jobs.
- Cada resposta tem "Enviar ao principal". Só esse clique leva o texto ao chat principal, como mensagem sua marcada "da consulta lateral".
- Uma consulta por conversa principal. Fechar e abrir de novo, ou recarregar a janela, traz a mesma conversa.

### Chat como canal do Slack

O chat principal é desenhado como um canal: toda mensagem fica à esquerda, com avatar, nome em negrito e hora ("10h57"). Você aparece como "Você"; o orquestrador, como "Claude" com o selo APP. Mensagens seguidas do mesmo autor em até 5 minutos ficam sob o mesmo cabeçalho, e a hora delas aparece no hover, na margem. As ferramentas do orquestrador viram uma linha recolhida presa à fala dele ("4 ações · Bash, Read"), que abre no clique (ou já aberta, com `toolsExpanded`). A estatística do turno fica pequena e cinza. No hover de cada mensagem há "Copiar", no canto direito. Quando a conversa cruza a meia-noite, um divisor marca o dia. Mensagens que vêm do histórico (conversa reaberta) não têm hora: o transcrito não guarda.

### Posts e threads dos agentes

Cada agente é uma pessoa no canal. Enquanto roda, o lugar dele no chat mostra o avatar, os pontinhos de digitando com a nota do `report_progress` e a linha "Agora" (a mesma do popup: ferramenta em uso, o texto que escreve ou a última ferramenta).

- Cada relatório que o agente entrega vira um post no mesmo lugar: avatar na cor dele, nome, hora e um texto curto em primeira pessoa. O relatório inteiro fica recolhido embaixo ("Relatório completo"). Agente retomado que entrega outro relatório ganha um post novo, na ordem em que chegou.
- O texto do post é escrito pelo orquestrador: ao receber o relatório ele abre a resposta com `<post agent="aN">...</post>`. O bloco sai da fala dele (inclusive durante o streaming) e vai para o post. Sem bloco, o post mostra a linha "Resumo:" do relatório.
- Cada post tem a própria thread. "Responder em thread" aparece no hover; com conversa, o rodapé mostra os avatares, "12 respostas" e "Última resposta hoje às 14h24". O "Abrir thread" do popup do nó abre a thread do post mais recente do agente.
- A thread abre num painel à direita (em janela estreita ocupa a tela, com "Voltar"). No topo fica o post com o relatório recolhido; embaixo, as respostas. Enter envia.
- Quem responde é uma sessão só leitura (as ferramentas da consulta lateral, sem Bash nem PowerShell) que fala em primeira pessoa como o agente, pelo relatório daquele post e pelo log dele. Nada da thread chega ao agente de verdade nem à conversa principal.
- Posts e threads ficam em `.agm/sessions/<conversa>/threads.json` e voltam ao recarregar a janela ou reabrir a conversa. O arquivo do formato antigo (uma thread por agente) abre sem erro: as mensagens vão para a thread do post mais recente do agente.

### Modos de permissão

| Modo | Efeito |
| --- | --- |
| Perguntar antes | Pergunta antes de cada ação que muda algo |
| Aceitar edições | Edita arquivos sozinho e pergunta o resto |
| Planejar | Só planeja; nada muda até você aprovar |
| Sem perguntas (bypass) | Executa tudo sem perguntar |

**O padrão é bypass** (`defaultPermissionMode`). O Claude roda comandos de terminal e apaga arquivos sem confirmação. Use em pasta confiável e versionada, ou troque o modo no composer. Alguns guardas da extensão valem mesmo em bypass: caminhos protegidos, aprovação de ações do navegador, aprovação de jobs e de servidores MCP do projeto.

## Orquestração de agentes

O chat principal recebe um servidor MCP embutido chamado `agents` (desligue com `routedAgents`). O prompt do orquestrador é acrescentado à sessão. Ferramentas principais:

| Ferramenta | O que faz |
| --- | --- |
| `spawn_agent` | Cria um agente em sessão separada e volta na hora. Aceita `report_to`, `model`, `effort`, `color`, `repeat_every_minutes`, `provider`/`account` (Codex), `browser`, `isolation`, `budget`, `protected_paths` e `box` |
| `send_to_agent` | Manda mensagem a um agente ou ao `main`; a resposta volta como mensagem nova |
| `list_agents` | Lista agentes com status, modelo, raciocínio, cor, destino do relatório e tokens |
| `stop_agent` | Interrompe um agente e encerra a recorrência de um vigia |
| `create_box` | Cria uma caixa no mapa (nome, descrição, cor, `parent_box` para uma etapa dentro de um projeto, um nível só) |
| `assign_box` | Move agentes existentes para uma caixa, inclusive concluídos e restaurados; `"none"` tira da caixa |
| `propose_task` | Só para vigias e agentes; propõe uma tarefa ao usuário |
| `worktree_status` | Mostra branch, commits e arquivos de um agente isolado |

- Relatório direto ao destino. `report_to` aceita `parent` (padrão), `main`, `user` (só aparece no mapa) ou o id de outro agente. Assim um coletor recebe o trabalho de vários produtores sem passar pelo contexto do orquestrador.
- Modelo por tarefa. O prompt orienta usar Haiku com raciocínio baixo para busca e tarefa mecânica, Sonnet médio para código de rotina, Opus alto para problema difícil e Fable para trabalho longo.
- Cores. O orquestrador escolhe uma cor por frente de trabalho. As cores aparecem no mapa e no grafo.
- Caixas. Com mais de 2 agentes para o mesmo objetivo, o prompt manda criar uma caixa ("Onda 1 · fundação") e pôr os agentes nela com `box`. Nome que não existe cria a caixa; agente criado por outro agente entra na caixa de quem criou. Se o orquestrador criar três soltos seguidos, o resultado do `spawn_agent` lembra de agrupar. As caixas são salvas junto com os agentes da conversa.
- Vigias. `spawn_agent` com `repeat_every_minutes` (2 a 240) acorda o agente a cada N minutos, com o contexto mantido. Resposta que começa com `[SEM NOVIDADES]` não é entregue. O vigia só lê. Ele pode propor tarefas, mas nunca as executa.
- Best-of-N. `spawn_attempts` cria de 2 a 8 agentes com a mesma tarefa, cada um em worktree próprio. Quando todos terminam, o hub escolhe a melhor por uma métrica declarada antes (arquivo `result.json` na raiz do worktree ou o último `log_run`) e entrega um relatório só, com o ranking e o texto completo da vencedora. Mesclar é decisão sua.
- Agentes Codex. `provider: "codex"` roda o agente numa conta Codex. O prompt manda usar só com autorização do usuário.
- Persistência. Os agentes são gravados no `workspaceState` e voltam depois de recarregar. Vigia volta parado e navegador volta desligado; "Retomar" reativa.
- Limites de segurança. `maxRoutedAgents` (12) agentes rodando ao mesmo tempo, `maxAutoReports` (10) entregas automáticas por agente para cortar laços A → B → A, e detecção de agente preso (`stuckRepeatCount`, `stuckMinutes`).

### O mapa

O botão de agentes no composer abre o mapa, com três vistas.

- Grafo. A árvore de agentes, com cores, status e progresso. Nós de jobs, buscas e vigias de treino aparecem ali também. Cada caixa é um retângulo com os agentes em grade e uma aresta só até a conversa principal. Clicar no título recolhe a caixa num nó-resumo (nome, contagem, um ponto por agente, tokens); caixa com tudo concluído já abre recolhida, e a escolha manual fica salva. Mais de 8 agentes sem caixa vão para uma caixa "Avulsos", e o botão "Organizar em caixas" prepara no composer um pedido para o orquestrador agrupar os existentes.
- Lista. Agentes agrupados por caixa (cabeçalho recolhível, avulsos no fim) ou, sem caixas, por status. Cada cartão mostra título, quem criou, para onde vai o relatório, tempo, tokens, modelo e o relatório final.
- Hipóteses. A árvore de hipóteses do laboratório, com veredito, selo de verificação, buscas e jobs. Dá para podar uma hipótese (o `read_board` passa a avisar os agentes).

Clicar num nó abre um popup com rota, status e relatório em Markdown (ou, se o agente está rodando, a ferramenta em uso e as últimas ações). Botões: Abrir chat, Copiar relatório, Parar e Retomar. Em agente isolado ainda aparecem Ver diff, Mesclar e Descartar. Abrir o chat de um agente permite conversar com ele, trocar modelo e raciocínio ou continuar numa conta diferente.

## Pesquisa em ML

Estas ferramentas valem em qualquer chat (também com `routedAgents` desligado). Vigias não recebem as ferramentas do laboratório. Os dados ficam em `.agm/` na pasta do projeto, em arquivos JSONL só de acréscimo.

### Laboratório

- `register_hypothesis`. Pré-registra métrica primária, direção, melhora mínima (absoluta ou relativa), dois braços (padrão `baseline` e `variante`), seeds mínimas (padrão 5), alpha (padrão 0,05) e família. Métrica e critério não mudam depois. Para ajustar, registre outra com `derived_from`.
- `log_run`. Registra uma execução de um braço com uma seed. Com `metrics_file`, o host lê o número do JSON que o script gravou e guarda o sha256; sem ele, o número é marcado como declarado. Grava também comando e commit (com aviso de árvore suja). Se `metrics` contradiz o arquivo, o registro é recusado.
- `declare_result`. Único jeito de concluir uma comparação. A hipótese é "suportada" só quando as quatro condições valem juntas: seeds mínimas em cada braço; IC de 95% (bootstrap) da diferença todo acima de zero; diferença igual ou maior que a melhora mínima; e p ajustado por Benjamini-Hochberg na família abaixo de alpha. "Refutada" exige seeds suficientes e o IC abaixo de zero ou abaixo da melhora mínima. O resto é "inconclusiva", com estimativa de seeds que faltam. O veredito avisa efeito muito grande (|d| > 3) e variância zero.
- `read_board` e `post_finding`. O primeiro mostra o quadro. O segundo anota um achado ligado a runs registrados.
- Aviso de número sem registro. O relatório final de um agente que cita número (decimal ou porcentagem) ausente dos runs dele e dos vereditos recebe um aviso automático.
- Família da correção. Duas hipóteses entram na mesma família se têm o mesmo texto `family`, o mesmo ramo git, a mesma conversa, ou uma deriva da outra.

### Verificador independente

Quando `declare_result` dá "suportada", o hub cria sozinho um agente só de leitura, em worktree próprio (`autoVerify`, modelo `verifierModel`, padrão Sonnet médio). Ele reexecuta cada braço com seed nova e procura vazamento entre treino e teste. Antes disso o host confere, sem modelo, se o veredito se reproduz com os runs gravados, se os arquivos de métricas mantêm o sha256 e se os caminhos protegidos são iguais entre os commits. O selo (verificado, divergente ou inconclusivo) aparece no cartão da hipótese. `request_verification` pede a verificação de outro veredito.

### Seeds, torneio e varredura

- `run_seeds`. O próprio hub roda o mesmo comando com K seeds, sem modelo, e registra cada execução como run. É mais barato e mais determinístico que um agente fazendo o laço. O comando leva `{seed}` (e opcionalmente `{arm}`). Você aprova cada modelo de comando na primeira vez da conversa. Paralelismo padrão 2 (`seedParallelism`); em GPU única, use 1.
- `start_tournament`. Juízes-modelo comparam candidatos em pares, e um Elo ordena as ideias. Geradores baratos podem propor candidatos e uma etapa `evolve` cria variantes das duas melhores. O torneio prioriza o que testar e não conclui nada empírico. `promote_to_hypothesis` transforma o vencedor numa hipótese do laboratório.
- `start_sweep`. Varredura de hiperparâmetros sem modelo no laço. O hub pede pontos ao Optuna (pelo Python do projeto) ou ao amostrador embutido, roda o comando a cada trial e registra cada trial como run. Devolve os melhores parâmetros, a importância e, com vários objetivos, a fronteira de Pareto. `setup_optuna` cria `.agm/venv` e instala o optuna só lá, com sua aprovação. `search_status` e `stop_search` completam o conjunto. O melhor trial é otimista: para afirmar melhora, registre uma hipótese confirmatória.
- Detector de p-hacking. Nunca bloqueia, só avisa: troca de métrica depois de um resultado ruim, muitas hipóteses no mesmo ramo sem ordem pré-registrada e `declare_result` repetido com mais seeds (parada opcional).
- Relatório de experimento. O comando "Gerar relatório de experimento" e a ferramenta `experiment_report` gravam um Markdown em `.agm/lab/reports/` com hipóteses, critérios, seeds, médias, IC, p ajustado, selo, comandos, commits, buscas relacionadas e avisos de integridade. Só entra dado registrado. A interpretação opcional (`interpret: true`, feita por Haiku) vai numa seção separada, marcada como a verificar.

### Isolamento, orçamento e avaliador congelado

- Worktree por agente. `isolation: "worktree"` cria uma cópia git em `.agm/worktrees/<id>`, na branch `agm/<id>-...`, a partir do HEAD. Só funciona em repositório com pelo menos um commit. Alteração não commitada não vai junto; arquivos fora do git entram se estiverem no `.worktreeinclude` da raiz. Mesclar e descartar são cliques seus.
- Orçamento. `budget` com `max_tokens`, `max_minutes` e `max_usd`, por agente ou por padrão em `defaultAgentBudget`. Aos 80% o mapa avisa. Em 100% o agente para e o chat pergunta se você dá mais. O custo em dólares é estimativa do SDK e não existe para agentes Codex.
- Caminhos protegidos. `protectedPaths`, `.agm/protected.json` e `protected_paths` no `spawn_agent` listam globs (por exemplo `eval/**`, `data/test/**`) que agentes Claude não leem nem gravam, nem em bypass. É uma barreira heurística, não um sandbox (ver Limitações).
- `run_evaluation`. Só o orquestrador roda a avaliação oficial (`evaluationCommand`, com tempo máximo em `evaluationTimeoutMinutes`). Você aprova na primeira vez de cada conversa.

### Jobs de GPU e vigia de treino

- `submit_job`. Submete treino em `local`, `slurm`, `modal` ou `runpod`, pelos CLIs de cada um (`sbatch`, `modal run`, `runpodctl`). Todo job abre um cartão de aprovação com recursos, horas e custo estimado. O teto de gasto total é `jobs.maxTotalUsd` (padrão US$ 50). Preços por GPU vão em `jobs.gpuPricesUsdPerHour`. O script recebe `AGM_JOB_ID`, `AGM_JOB_DIR` e `AGM_METRICS_FILE`; com `lab`, o JSON de métricas vira run do laboratório. `cancel_job` também pede sua aprovação, e `list_jobs` mostra o estado.
- `watch_training`. Lê um log, um run do MLflow ou um run do W&B em intervalos fixos, sem modelo. Detecta NaN/Inf, divergência, platô e job parado. Quando algo dispara, um modelo pequeno (`trainingWatch.summaryModel`, padrão Haiku) resume o log, e você recebe um cartão com "Parar o job", "Ignorar" e "Mandar ao agente responsável". O hub nunca cancela sozinho.
- MLflow. Com `mlflow.trackingUri` e `mlflow.mirrorRuns`, cada `log_run` é espelhado no servidor (tags `node_id`, `hypothesis_id`, `arm`, `seed`, `git_sha`).

### Pacote de pesquisa

O comando "Agent Graph Master: Configurar pacote de pesquisa" grava no `.mcp.json` do projeto servidores MCP de MLflow, Weights & Biases, Optuna, Hugging Face e Jupyter (este da comunidade). Tokens ficam no SecretStorage do VS Code, e o `.mcp.json` guarda só a referência à variável. Nenhum pacote Python é instalado; os servidores rodam com `uv`/`uvx`.

### Exemplo de fluxo

```
Registre a hipótese: trocar o otimizador de AdamW para Lion melhora a acurácia
de validação em pelo menos 0,5 ponto. Use train.py, métrica "val_acc", 5 seeds.
Rode os dois braços com run_seeds, com --seed {seed} --out results/{arm}_{seed}.json.
Dê orçamento de 60 minutos ao que precisar de agente. Proteja eval/**.
Depois declare o resultado e mande o relatório do experimento.
```

O orquestrador registra a hipótese, pede sua aprovação para o comando do `run_seeds`, roda os dois braços, chama `declare_result`, e, se o resultado for "suportada", o verificador entra sozinho. No fim, `experiment_report` grava o relatório em `.agm/lab/reports/`.

## Web e imagens

- Pesquisa comum. O próprio Claude usa `WebSearch` e `WebFetch`, sem gastar nada além da assinatura Claude. É o caminho padrão.
- `web_research` com Gemini. Usa o Antigravity (`agy`) logado com a conta Google, ou a chave de API do Gemini. Padrão de `external.researchProvider`.
- `web_research` com GPT. Usa o Codex CLI logado (cota do plano ChatGPT), ou a chave de API da OpenAI. O prompt manda usar o GPT só quando você pedir.
- `generate_image`. O GPT gera imagem pelo Codex CLI ou pela API da OpenAI. O Gemini gera imagem só com chave de API; a geração de imagem do Antigravity não funciona pela extensão. As imagens caem em `assets/generated` (`external.imageFolder`), sem sobrescrever arquivo existente.
- Chaves. Comandos "Configurar chave do Gemini/da OpenAI" guardam a chave no SecretStorage do VS Code, nunca no `settings.json`. As variáveis `GEMINI_API_KEY`, `GOOGLE_API_KEY` e `OPENAI_API_KEY` também servem.
- Token de assinatura nunca sai do CLI que o emitiu. Vigias e agentes Codex não têm estas duas ferramentas.

## Navegador

Com a extensão Claude in Chrome instalada e conectada, o item "Usar o navegador (Claude in Chrome)" do menu "+" liga o navegador no chat, ou `claudeInChrome` liga por padrão nas conversas novas. O Claude age no Chrome com as contas em que você já está logado. Para tarefa longa, o orquestrador cria um agente com `browser: true`.

- Um dono por vez. Se um agente está com o navegador, o chat não consegue ligá-lo. O agente devolve o navegador quando entrega o relatório. Vigias e agentes Codex não usam o navegador.
- Ações que escrevem (clicar, digitar, preencher formulário, abrir endereço, rodar JavaScript, enviar arquivo) pedem sua aprovação no chat, mesmo em bypass (`browserActionsNeedApproval`, ligado por padrão). Ler a página, listar abas e capturar a tela não pedem.
- O navegador trabalha num grupo de abas próprio e não enxerga as abas que você já tinha abertas.
- Texto de página é conteúdo de terceiros e pode trazer instruções escondidas (injeção de prompt). Desligar a aprovação é um risco real.

## Segurança

- Tarefas de fora. O que um vigia acha no Slack, no e-mail ou num arquivo chega como cartão de aprovação no chat. A tarefa só vai ao agente principal quando você clica em Executar (`externalTasksNeedApproval`). Desligado, a tarefa chega marcada como conteúdo de terceiros, mas o agente principal costuma rodar sem pedir permissão.
- Servidores MCP do projeto. O Claude Code sobe sozinho os servidores do `.mcp.json`, o que deixaria uma pasta baixada da internet rodar comandos escritos por outra pessoa. A extensão desliga esses servidores até você aprovar cada um, por nome e hash do conteúdo. Entrada alterada volta a pedir aprovação. O que o pacote de pesquisa grava conta como aprovado, depois de uma confirmação sua.
- Caminhos protegidos. Um hook antes de cada ferramenta bloqueia leitura e escrita nos globs configurados, e a saída de Grep, Glob e Bash é filtrada. É defesa em profundidade, não sandbox. Um comando de shell pode chegar ao arquivo por indireção (variável, base64, glob como `ev*l/`, um script que abre o arquivo). Agentes Codex não passam por esse hook.
- Aprovação de custo. Jobs, cancelamentos, `run_seeds`, varreduras, `run_evaluation` e `setup_optuna` pedem sua aprovação.
- Sem rodízio de contas para driblar limites. Se uma conta bate no limite, o agente avisa e para.

## Custos

| O que roda | O que gasta |
| --- | --- |
| Chat, agentes Claude, verificador, juízes do torneio, resumos e interpretação | Assinatura Claude (limites de 5 horas e semana) |
| Agentes Codex, `web_research` e imagem via GPT pelo CLI | Cota do Codex no plano ChatGPT |
| `web_research` via Antigravity | Assinatura Google AI |
| Pesquisa ou imagem por chave de API | Crédito pago na OpenAI ou no Google. A extensão avisa o custo na primeira vez |
| Jobs de GPU (Slurm, Modal, RunPod) | Conta de cada provedor, limitada pelo teto `jobs.maxTotalUsd` e por sua aprovação |

Agentes em paralelo multiplicam o consumo, e o contexto inteiro segue em cada chamada. Recomendações:

- Vigias em Haiku com raciocínio baixo e intervalo de 5 a 15 minutos.
- Levantamento e leitura em Haiku ou Sonnet. Opus e Fable só onde a dificuldade justifica.
- Pesquisa longa num agente Sonnet médio com `WebSearch`, não em `web_research`.
- Em experimento, defina `budget` com `max_minutes` e `max_usd`. Tokens sobem rápido.
- Prefira `run_seeds`, `start_sweep` e `watch_training` a agentes que fazem o mesmo com modelo no laço.

## Configurações principais

Todas começam com `agentGraphMaster.`. A lista completa está em Configurações do VS Code.

| Chave | Padrão | Efeito |
| --- | --- | --- |
| `defaultModel` | `opus` | Modelo inicial dos chats |
| `defaultEffort` | `medium` | Raciocínio inicial |
| `defaultPermissionMode` | `bypassPermissions` | Modo de permissão com que os chats começam |
| `companion.model` / `companion.effort` | `sonnet` / `medium` | Modelo e raciocínio da consulta lateral |
| `routedAgents` | `true` | Liga `spawn_agent` e companhia |
| `maxRoutedAgents` | `12` | Agentes rodando ao mesmo tempo por chat |
| `maxAutoReports` | `10` | Entregas automáticas por agente |
| `defaultAgentBudget` | `{}` (sem limite) | Orçamento dos agentes criados sem `budget` |
| `protectedPaths` | `[]` | Globs que agentes Claude não leem nem gravam |
| `evaluationCommand` | vazio | Comando da avaliação oficial (`run_evaluation`) |
| `evaluationTimeoutMinutes` | `30` | Tempo máximo da avaliação e de cada execução de `run_seeds` sem timeout próprio |
| `seedParallelism` | `2` | Execuções simultâneas do `run_seeds` |
| `autoVerify` | `true` | Verificador independente depois de "suportada" |
| `verifierModel` / `verifierEffort` | `sonnet` / `medium` | Modelo e raciocínio do verificador |
| `stuckRepeatCount` / `stuckMinutes` | `3` / `10` | Marca agente possivelmente preso; 0 desliga |
| `claudeInChrome` | `false` | Conversas novas começam com o navegador ligado |
| `browserActionsNeedApproval` | `true` | Aprovação das ações de escrita no navegador |
| `externalTasksNeedApproval` | `true` | Aprovação de tarefas vindas de fora |
| `usageRefreshMinutes` | `1` | Releitura dos limites no rodapé; 0 desliga |
| `external.researchProvider` | `gemini` | Provedor padrão do `web_research` |
| `external.imageProvider` | `openai` | Provedor padrão do `generate_image` |
| `external.imageFolder` | `assets/generated` | Pasta das imagens geradas |
| `mlflow.trackingUri` / `mlflow.mirrorRuns` | vazio / `false` | Servidor MLflow e espelho dos runs |
| `jobs.maxTotalUsd` | `50` | Teto de gasto somado dos jobs; 0 desliga |
| `jobs.gpuPricesUsdPerHour` | `{}` | Preço por hora de uma GPU, por tipo |
| `trainingWatch.summaryModel` | `haiku` | Modelo do resumo dos alertas de treino |
| `claudePath` / `claudePathStrategy` | vazio / `newest` | Onde achar o `claude.exe` |
| `codexPath` / `codexDefaultModel` | vazio | Executável e modelo do Codex |
| `afterSwitch` | `ask` | O que fazer depois de trocar de conta |

## Limitações conhecidas

- O modo padrão é bypass. Reveja antes de abrir um projeto que você não conhece.
- Os caminhos protegidos são heurísticos, não um sandbox, e não valem para agentes Codex. Não use Codex em experimento com avaliador congelado.
- Agentes Codex não têm as ferramentas do servidor `agents` (nem `spawn_agent`, `web_research`, `generate_image` ou as do laboratório). O orçamento em dólares não existe para eles.
- O Gemini só gera imagem com chave de API.
- O aviso de número sem registro só olha decimais e porcentagens, ignora blocos de código e crases, e é um alerta, não uma prova.
- O `declare_result` não recalcula o p ajustado de uma hipótese já declarada quando outra da família é declarada depois. Hipótese da família sem veredito entra na correção com p = 1. A análise de poder usa aproximação normal.
- O worktree parte do último commit. Alteração não commitada e arquivos fora do git não vão junto, salvo os listados em `.worktreeinclude`.
- A varredura sem Optuna usa um amostrador embutido mais simples (TPE independente por parâmetro).
- O RunPod só funciona com `jobs.runpodImage` definida, e a imagem precisa executar `AGM_COMMAND`.
- Só um dono do navegador por vez.
- A troca de conta não afeta sessões já abertas antes de você recarregar a janela.

## Desenvolvimento

```
npm install
npm run compile          # checa tipos (extensão e webview) e gera out/ com esbuild
npm run watch            # esbuild em modo observação
npm run package          # compile + vsce package, gera agent-graph-master.vsix
npm run install-local    # package + instala no VS Code
```

Estrutura: `src/extension.ts` (contas, comandos), `src/chat/` (sessões, hub de agentes, laboratório, busca, infraestrutura, guardas) e `src/webview/` (interface do chat e do mapa).

Testes. Só dois arquivos ficam no repositório, `src/chat/lab/lab.test.ts` e `src/chat/lab/stats.test.ts`, sem framework. Cada um traz no cabeçalho o comando para rodar (esbuild para `$TEMP` e depois `node`). Os demais scripts de teste (hub, painel, persistência, interface, integrações) estão hoje em `%TEMP%\agmtest`, fora do repositório. Isso é uma pendência: precisam ser movidos para o repositório e ligados a um `npm test`.

## Licença

MIT.
