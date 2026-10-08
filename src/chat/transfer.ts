import * as fs from 'fs';
import * as path from 'path';
import type { Profile } from '../profiles';

/**
 * O CLI grava a conversa em <pasta da conta>/projects/<cwd com tudo que não é letra ou número trocado por "-">/<id>.jsonl.
 * Ao lado ficam <id>/ (transcritos de subagentes, resultados grandes de ferramenta) e, fora de projects,
 * file-history/<id>/ (os checkpoints de arquivos editados). Copiar os três para a pasta de outra conta deixa
 * o `resume` dessa conta abrir a mesma conversa.
 */
export interface SessionPaths {
  transcript: string;
  /** Pasta de projects onde o transcrito está. A cópia vai para a pasta de mesmo nome na outra conta. */
  projectFolder: string;
  extras: string[];
}

function projectFolderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Acha o transcrito da sessão na conta: primeiro na pasta do cwd, depois em qualquer projeto. */
export async function findSession(profile: Profile, sessionId: string, cwd: string): Promise<SessionPaths | undefined> {
  const projects = path.join(profile.configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  let folders: string[];
  try {
    folders = await fs.promises.readdir(projects);
  } catch {
    return undefined;
  }
  const preferred = projectFolderName(cwd).toLowerCase();
  folders.sort((a, b) => Number(b.toLowerCase() === preferred) - Number(a.toLowerCase() === preferred));
  for (const folder of folders) {
    const transcript = path.join(projects, folder, file);
    if (!fs.existsSync(transcript)) {
      continue;
    }
    const extras = [path.join(projects, folder, sessionId), path.join(profile.configDir, 'file-history', sessionId)].filter((p) => fs.existsSync(p));
    return { transcript, projectFolder: folder, extras };
  }
  return undefined;
}

/** Onde a conversa ficaria na outra conta, e se já há uma cópia lá (de uma troca anterior). */
export function targetTranscript(target: Profile, source: SessionPaths): { file: string; exists: boolean } {
  const file = path.join(target.configDir, 'projects', source.projectFolder, path.basename(source.transcript));
  return { file, exists: fs.existsSync(file) };
}

/** Copia transcrito, pasta da sessão e checkpoints para a outra conta, substituindo o que já houver lá. */
export async function copySession(source: SessionPaths, from: Profile, to: Profile): Promise<void> {
  const { file } = targetTranscript(to, source);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.copyFile(source.transcript, file);
  for (const extra of source.extras) {
    const rel = path.relative(from.configDir, extra);
    const dest = path.join(to.configDir, rel);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.cp(extra, dest, { recursive: true });
  }
}
