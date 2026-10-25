import type { ChatResources, ProcView, ResourceKillResultMsg, ResourceMsgFromWebview, ResourceReport, SuspectView } from '../chat/resourceMonitorTypes';

/**
 * Pílula "Mem 1,2 GB" do rodapé do chat. Clique abre um popover com os maiores processos da sessão, o que está
 * ocioso e um botão "Encerrar" por suspeito. Não encerra nada sozinha: manda `resourceKill` e o host valida de novo.
 */
export interface ResourcePill {
  el: HTMLElement;
  /** Relatório novo do host. `chatId` é o chat que este rodapé mostra. */
  update(report: ResourceReport, chatId: string): void;
  /** Resultado de um "Encerrar". */
  killResult(msg: ResourceKillResultMsg): void;
}

const MB = 1024 * 1024;

function fmtBytes(b: number): string {
  const mb = b / MB;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} GB` : `${Math.round(mb)} MB`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

export function createResourcePill(post: (msg: ResourceMsgFromWebview) => void): ResourcePill {
  const root = el('span', 'res-wrap');
  const pill = el('button', 'res-pill', 'Mem …');
  pill.type = 'button';
  pill.title = 'Memória desta sessão (CLI e processos que ele subiu). Clique para ver.';
  pill.setAttribute('aria-haspopup', 'dialog');
  const pop = el('div', 'res-pop');
  pop.hidden = true;
  root.append(pill, pop);

  let last: { report: ResourceReport; chat?: ChatResources } | undefined;
  let notice = '';

  const close = () => {
    pop.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    if (!last) {
      return;
    }
    const { report, chat } = last;
    pill.textContent = chat?.alive ? `Mem ${fmtBytes(chat.totalBytes)}` : `Mem ${fmtBytes(report.host.rssBytes)}`;
    pill.dataset.level = chat?.alive ? chat.level : report.level;
    pop.replaceChildren(...popBody(report, chat));
  };

  function row(p: ProcView): HTMLElement {
    const r = el('div', 'res-row');
    r.append(el('span', 'res-name', p.kind === 'cli' ? 'CLI' : p.short), el('span', 'res-mem', fmtBytes(p.rssBytes)));
    r.title = `${p.name} (PID ${p.pid})`;
    return r;
  }

  function suspect(chatId: string, s: SuspectView): HTMLElement {
    const r = el('div', 'res-row res-suspect');
    const text = el('span', 'res-name', s.label);
    text.title = `${s.name} (PID ${s.pid}), libera ${fmtBytes(s.treeBytes)}`;
    const btn = el('button', 'res-kill', 'Encerrar');
    btn.type = 'button';
    btn.title = s.risky ? 'Servidor MCP: as ferramentas dele somem desta sessão até reiniciar o chat' : `Encerra o PID ${s.pid} e o que ele subiu`;
    btn.addEventListener('click', () => {
      if (s.risky && !window.confirm(`Encerrar ${s.short}? As ferramentas dele deixam de funcionar nesta sessão.`)) {
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Encerrando…';
      post({ type: 'resourceKill', chatId, pid: s.pid, name: s.name, startedMs: s.startedMs });
    });
    r.append(text, el('span', 'res-mem', fmtBytes(s.treeBytes)), btn);
    return r;
  }

  function popBody(report: ResourceReport, chat?: ChatResources): HTMLElement[] {
    const out: HTMLElement[] = [];
    out.push(el('div', 'res-title', chat?.alive ? `Esta sessão: ${fmtBytes(chat.totalBytes)}` : 'Esta sessão: sem processo do CLI'));
    if (chat?.alive) {
      for (const p of chat.top) {
        out.push(row(p));
      }
      if (chat.suspects.length) {
        out.push(el('div', 'res-sub', 'Parados sem necessidade'));
        for (const s of chat.suspects) {
          out.push(suspect(chat.chatId, s));
        }
      } else {
        out.push(el('div', 'res-none', 'Nada ocioso por aqui.'));
      }
    }
    out.push(el('div', 'res-sub', 'Memória do extension host'));
    const heap = el('div', 'res-row');
    heap.append(el('span', 'res-name', 'Extensão (heap)'), el('span', 'res-mem', fmtBytes(report.host.heapUsedBytes)));
    heap.title = 'heapUsed do processo desta extensão (process.memoryUsage)';
    const rss = el('div', 'res-row');
    rss.append(el('span', 'res-name', 'Extension host (todas as extensões)'), el('span', 'res-mem', fmtBytes(report.host.rssBytes)));
    rss.title = 'rss do extension host, que roda todas as extensões do VS Code juntas';
    out.push(heap, rss);
    if (notice) {
      out.push(el('div', 'res-note', notice));
    }
    const again = el('button', 'res-refresh', 'Medir agora');
    again.type = 'button';
    again.addEventListener('click', () => post({ type: 'resourcesRefresh' }));
    out.push(again);
    return out;
  }

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    pill.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) {
      notice = '';
      post({ type: 'resourcesRefresh' });
    }
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !root.contains(e.target as Node)) {
      close();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      close();
    }
  });

  return {
    el: root,
    update(report, chatId) {
      last = { report, chat: report.chats.find((c) => c.chatId === chatId) };
      render();
    },
    killResult(msg) {
      notice = msg.message;
      render();
      post({ type: 'resourcesRefresh' });
    }
  };
}
