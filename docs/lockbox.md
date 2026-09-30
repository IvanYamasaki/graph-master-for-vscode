# Cofre do conjunto de teste (lockbox)

Protegido só por convenção, o conjunto de teste acaba lido "só para conferir" ou avaliado de novo depois de cada ajuste. Quando isso acontece, o número final deixa de valer. O cofre transforma a convenção em regra do host.

Código: `src/chat/guard/lockbox.ts` (arquivo e reserva) e `src/chat/guard/agentGuard.ts` (ferramentas e hooks). Testes: `src/chat/guard/guard.test.ts`.

## O que um cofre liga

Um cofre junta três coisas, fixadas no registro e sem edição depois:

- caminhos protegidos (globs relativos ao projeto, ex.: `data/test/**`);
- as hipóteses que ele avalia;
- um comando de avaliação único, que pode levar `{hypothesis}`.

Para mudar qualquer uma das três, registre outro cofre. Para desfazer um cofre, o usuário apaga a entrada em `.agm/lockbox.json`.

## Ferramentas (só o orquestrador)

| Ferramenta | O que faz |
|---|---|
| `register_lockbox({ name, paths, hypothesis_ids, command, timeout_minutes })` | Pede aprovação do usuário e grava o cofre. |
| `lockbox_evaluate({ lockbox, hypothesis_id })` | Roda o comando do cofre para uma hipótese dele. A primeira avaliação de cada hipótese roda direto; da segunda em diante, pede aprovação com a hora da primeira. |
| `lockbox_status({ lockbox })` | Mostra caminhos, hipóteses, comando, cada avaliação com hora, código e sha256 da saída, e as tentativas de agente barradas. |

## Regras do host

- Os caminhos de todos os cofres entram nos caminhos protegidos de todos os agentes, somados aos de `.agm/protected.json` e aos `protected_paths` do spawn_agent. Os hooks de Read, Write, Edit, Grep, Glob e Bash barram o acesso. Cada tentativa barrada que cai num cofre é registrada no cofre, com agente, ferramenta e hora.
- `.agm/lockbox.json` e `.agm/lockbox.json.bak` também ficam protegidos: agente não lê nem grava o cofre.
- A reserva é atômica. `lockbox_evaluate` grava um registro "rodando" antes de qualquer espera, e só depois pede aprovação ou roda. Duas chamadas no mesmo turno não passam as duas como "primeira": a segunda vê a primeira e cai na aprovação. Recusar apaga a reserva. Uma avaliação parada no meio (agente parado, conversa trocada) continua contando como feita, porque o processo pode ter lido o teste.
- Reserva órfã. Cada reserva guarda o pid do processo da extensão. Ao ler o arquivo, uma reserva "rodando" cujo processo não existe mais (a janela fechou no meio) vira "interrompida" e é gravada assim. Ela continua contando: a próxima avaliação da hipótese pede aprovação, e o cartão diz que a anterior ficou sem resultado. O usuário libera nesse cartão.
- `run_evaluation` não é atalho para o cofre. Se o comando for o do cofre (com `{hypothesis}` trocado por uma hipótese dele, ou literal) ou citar os caminhos do cofre, ele passa pela mesma reserva e contagem de `lockbox_evaluate`. Sem hipótese reconhecível, conta como `(run_evaluation)`.
- O cofre falha fechado. Se `.agm/lockbox.json` estiver ilegível, valem os cofres da última cópia boa (memória ou `.bak`, gravado a cada escrita). Sem cópia boa, o padrão `**` protege tudo para os agentes até o usuário consertar ou apagar o arquivo. Nos dois casos o usuário recebe um aviso, nada se grava e `lockbox_evaluate` recusa.
- A avaliação roda com prioridade no semáforo de processos pesados: não espera atrás de seeds e trials dos agentes.

## Limite conhecido: comandos que o hub roda por um subagente

`run_seeds` e `start_sweep` rodam o comando no processo da extensão, fora dos hooks do agente. O host confere só o TEXTO do comando (`commandBlocked` em `protect.ts`, a mesma heurística do Bash). Um `python peek.py` cujo script abre `data/test` por dentro passa por essa checagem. O mesmo vale para o Bash do próprio agente: o hook vê a linha de comando, não os arquivos que o processo abre.

O que o host faz para compensar, quando o subagente tem algum caminho protegido (do projeto, de cofre ou do spawn_agent):

- cada chamada de `run_seeds` e de `start_sweep` pede aprovação do usuário, que fica sabendo do limite, e a aprovação não é lembrada;
- a saída dos processos (fim do stderr e do stdout) não volta ao agente, nem no resultado do `run_seeds` nem no erro dos trials da varredura;
- só o número das métricas pedidas chega ao quadro: a métrica primária da hipótese no `run_seeds` e os objetivos no `start_sweep`. O host copia esse valor para um JSON limpo, apaga a linha JSON crua tirada do stdout e troca as mensagens de erro de leitura por texto fixo, sem nomes de chave nem conteúdo do arquivo.

O próprio valor da métrica ainda pode carregar alguns bits. Esse canal fica aberto enquanto não houver sandbox.

O que não existe: sandbox de sistema de arquivos. Fechar isso de verdade pede rodar os processos com outro usuário do sistema, num contêiner, ou com as pastas do teste fora do alcance (permissões do sistema). Enquanto isso, o conjunto de teste de verdade deve ficar fora do repositório que os agentes veem, e só o comando do cofre sabe onde ele está.
