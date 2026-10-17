// Hover and signature-help content.
import { MarkupContent, MarkupKind } from 'vscode-languageserver';
import { functionDocs, directiveDocs, sysvarDocs, mnemonicDocs, optionDocs, specialTargetDocs, systemParams, errorMessages, FunctionDoc } from './lexicon';
import { ParsedDoc } from './parser';
import { ClassMember } from './parser';

const code = (s: string) => '```providex\n' + s + '\n```';

export function functionHover(name: string): string | undefined {
  const d = functionDocs[name.toUpperCase()];
  if (!d) return `**${name.toUpperCase()}()** — ProvideX built-in function`;
  const sigs = (d.signatures ?? []).map((s) => s.label).join('\n');
  let md = code(sigs || name.toUpperCase() + '(...)');
  if (d.returns) md += `\n\n*Returns:* ${d.returns}`;
  if (d.doc) md += '\n\n' + d.doc;
  const params = d.signatures?.[0]?.params?.filter((p) => p.doc) ?? [];
  if (params.length) md += '\n\n' + params.map((p) => `- \`${p.name}\` — ${p.doc}`).join('\n');
  if (d.options?.length) md += `\n\n*Options:* ${d.options.map((o) => '`' + o + '=`').join(', ')}`;
  return md;
}

export function directiveHover(name: string): string | undefined {
  const key = name.toUpperCase();
  const d = directiveDocs[key] ?? directiveDocs[key.replace('_', ' ')] ?? directiveDocs[key.replace(' ', '_')];
  if (!d) return undefined;
  let md = d.syntax?.length ? code(d.syntax.join('\n')) : `**${key}**`;
  if (d.doc) md += '\n\n' + d.doc;
  if (d.examples?.length) md += '\n\n*Example:*\n' + code(d.examples.join('\n'));
  return md;
}

export function sysvarHover(name: string): string | undefined {
  const d = sysvarDocs[name.toUpperCase()];
  if (!d) return `**${name.toUpperCase()}** — ProvideX system variable`;
  return `**${name.toUpperCase()}** — system variable${d.returns ? ` (${d.returns})` : ''}\n\n${d.doc ?? ''}`;
}

export function mnemonicHover(text: string): string | undefined {
  const key = text.replace(/^'|'$/g, '').toUpperCase();
  const d = mnemonicDocs[key] ?? mnemonicDocs[`'${key}'`];
  return `**'${key}'** — mnemonic${d ? '\n\n' + d : ''}`;
}

export function optionHover(name: string): string | undefined {
  const d = optionDocs[name.toUpperCase()];
  return `**${name.toUpperCase()}=** — I/O option${d ? '\n\n' + d : ''}`;
}

export function specialHover(name: string): string | undefined {
  const d = specialTargetDocs[name.toUpperCase()];
  return `**${name.toUpperCase()}** — special branch target${d ? '\n\n' + d : ''}`;
}

export function paramHover(code2: string): string | undefined {
  const p = systemParams[code2.toUpperCase()];
  if (!p) return undefined;
  let md = `**'${code2.toUpperCase()}'** — system parameter${p.title ? ` (${p.title})` : ''}`;
  if (p.doc) md += '\n\n' + p.doc;
  const range = [p.min !== undefined ? `min ${p.min}` : '', p.max !== undefined ? `max ${p.max}` : '', p.default !== undefined ? `default ${p.default}` : ''].filter(Boolean).join(', ');
  if (range) md += `\n\n*${range}*`;
  return md;
}

export function errorHover(n: number): string | undefined {
  const e = errorMessages[String(n)];
  if (!e) return undefined;
  return `**${e.kind === 'warning' ? 'Warning' : 'Error'} #${n}:** ${e.text}`;
}

export function memberHover(m: ClassMember, owner: string, comments: string[]): string {
  const vis = m.local ? 'LOCAL ' : '';
  let s = m.kind === 'function' ? `FUNCTION ${vis}${m.perform ? 'PERFORM ' : ''}${m.signature}${m.label ? ' ' + m.label : ''}` : `PROPERTY ${vis}${m.name}${m.getLabel ? ' GET ' + m.getLabel : ''}${m.setLabel ? ' SET ' + m.setLabel : ''}`;
  if (m.kind === 'property' && m.local) s = `LOCAL ${m.name}`;
  let md = code(s) + `\n\n*class* \`${owner}\``;
  if (comments.length) md += '\n\n' + comments.join('\n\n');
  return md;
}

export function md(value: string): MarkupContent {
  return { kind: MarkupKind.Markdown, value };
}

export function functionSignatures(name: string): FunctionDoc['signatures'] {
  return functionDocs[name.toUpperCase()]?.signatures;
}

export function labelHover(doc: ParsedDoc, name: string, line: number, comments: string[]): string {
  const text = doc.lines[line]?.trim() ?? '';
  let s = code(text) ;
  if (comments.length) s += '\n\n' + comments.join('\n\n');
  void name;
  return s;
}
