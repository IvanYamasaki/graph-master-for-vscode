/**
 * Liga ao Lab o detector de p-hacking (lab/integrity.ts) e o relatório de experimento (lab/report.ts): contexto de
 * cada hipótese nova, família BH ampliada, avisos no chat e a ferramenta/comando que grava e abre o relatório.
 * O hub cria um por conversa, depois do Parallel (que também pendura um onVerdict no Lab).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Profile } from '../../profiles';
import { INTERPRET_MODEL, interpretReport } from './interpret';
import { LabIntegrity } from './integrity';
import { buildReport, reportTool, saveReport, withInterpretation, type ReportScope } from './report';
import { gitBranch, type Lab } from './tools';

export interface LabReportsHost {
  cwd: string;
  profile(): Profile;
  /** Id da conversa principal (sessionId); vazio antes da primeira mensagem. */
  conversation(): string;
  notice(text: string, level: 'info' | 'error'): void;
}

export class LabReports {
  readonly integrity: LabIntegrity;
  /** Avisos já dados; os que já existiam quando a conversa abriu não se repetem. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly lab: Lab,
    private readonly host: LabReportsHost,
  ) {
    this.integrity = new LabIntegrity(host.cwd, lab.store);
    for (const w of this.integrity.warnings()) {
      this.warned.add(w.key);
    }
    lab.familyOf = (h) => this.integrity.family(h);
    lab.onHypothesis = (h, by) => {
      this.integrity.tag(h, { conversation: host.conversation(), branch: gitBranch(host.cwd), agent: by });
      return this.fresh();
    };
    const previous = lab.onVerdict;
    lab.onVerdict = (h, v, by) => {
      const before = previous?.(h, v, by);
      const warn = this.fresh();
      return [typeof before === 'string' ? before : '', warn ?? ''].filter(Boolean).join('\n') || undefined;
    };
  }

  /** Avisos novos desde a última olhada: viram notice no chat e texto no resultado da ferramenta. */
  private fresh(): string | undefined {
    const out: string[] = [];
    for (const w of this.integrity.warnings()) {
      if (this.warned.has(w.key)) {
        continue;
      }
      this.warned.add(w.key);
      this.host.notice(`Laboratório: ${w.text}`, 'info');
      out.push(`Aviso do laboratório (${w.kind}): ${w.text}`);
    }
    return out.length ? out.join('\n') : undefined;
  }

  tools(): SdkMcpToolDefinition<any>[] {
    return [reportTool((args) => this.generate(args.scope, args.id, !!args.interpret))];
  }

  /** Monta, grava em .agm/lab/reports/ e abre no editor. Devolve o texto para o modelo ou o erro. */
  async generate(scope: ReportScope, id: string | undefined, interpret: boolean): Promise<string | Error> {
    let target = id;
    if (scope === 'hypothesis' && !target) {
      return new Error('Com scope "hypothesis", passe o id da hipótese (ex.: "h3").');
    }
    if (scope === 'branch') {
      target ??= gitBranch(this.host.cwd) ?? this.lab.store.hypotheses().at(-1)?.family;
    }
    if (scope === 'conversation') {
      target ??= this.host.conversation() || undefined;
    }
    if (!target) {
      return new Error(scope === 'branch' ? 'Não achei o ramo atual nem hipótese registrada; passe o id do ramo.' : 'Esta conversa ainda não tem id; mande uma mensagem antes ou passe o id.');
    }
    const built = buildReport({ root: this.host.cwd, store: this.lab.store, state: this.lab.state(), integrity: this.integrity, scope, id: target });
    if (built instanceof Error) {
      return built;
    }
    let markdown = built.markdown;
    let note = '';
    if (interpret) {
      const text = await interpretReport(this.host.profile(), this.host.cwd, markdown);
      if (text) {
        markdown = withInterpretation(markdown, text, INTERPRET_MODEL);
      } else {
        note = ' A interpretação por modelo falhou; o relatório saiu sem ela.';
      }
    }
    const file = saveReport(this.host.cwd, built.slug, markdown);
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    } catch {
      // Sem editor (teste, janela fechando): o arquivo está gravado do mesmo jeito.
    }
    const warnings = this.integrity.warnings(new Set(built.hypotheses)).length;
    return `Relatório de ${built.title} gravado em ${path.relative(this.host.cwd, file)} e aberto no editor: ${built.hypotheses.length} hipótese(s)${warnings ? `, ${warnings} aviso(s) de integridade` : ''}.${note} Os números do arquivo vêm só do quadro; não repita números que não estejam nele.`;
  }

  /** "Agent Graph Master: Gerar relatório de experimento". */
  async runCommand(): Promise<void> {
    const hyps = this.lab.store.hypotheses();
    if (!hyps.length) {
      void vscode.window.showInformationMessage('O quadro do laboratório está vazio (.agm/lab/): não há experimento para relatar.');
      return;
    }
    const branch = gitBranch(this.host.cwd) ?? hyps.at(-1)?.family;
    const conv = this.host.conversation();
    const scopes: (vscode.QuickPickItem & { scope: ReportScope })[] = [
      ...(conv ? [{ label: 'Esta conversa', description: conv.slice(0, 8), scope: 'conversation' as const }] : []),
      ...(branch ? [{ label: `Ramo ${branch}`, description: 'hipóteses registradas neste ramo', scope: 'branch' as const }] : []),
      { label: 'Uma hipótese', description: `${hyps.length} no quadro`, scope: 'hypothesis' as const },
    ];
    const pick = await vscode.window.showQuickPick(scopes, { placeHolder: 'Relatório de experimento: escopo' });
    if (!pick) {
      return;
    }
    let id: string | undefined = pick.scope === 'branch' ? branch : pick.scope === 'conversation' ? conv : undefined;
    if (pick.scope === 'hypothesis') {
      const h = await vscode.window.showQuickPick(
        [...hyps].reverse().map((x) => ({ label: `${x.id} · ${x.title}`, description: `${x.metric} · ${this.lab.store.status(x)}`, id: x.id })),
        { placeHolder: 'Qual hipótese?' },
      );
      if (!h) {
        return;
      }
      id = h.id;
    }
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Só dados registrados', interpret: false },
        { label: `Com interpretação de ${INTERPRET_MODEL}`, description: 'seção separada, marcada como a verificar', interpret: true },
      ],
      { placeHolder: 'Incluir texto interpretativo?' },
    );
    if (!mode) {
      return;
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Gerando relatório de experimento...' }, () =>
      this.generate(pick.scope, id, mode.interpret),
    );
    if (r instanceof Error) {
      void vscode.window.showErrorMessage(r.message);
    }
  }
}
