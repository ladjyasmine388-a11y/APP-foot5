import type { ZodType } from 'zod';
import { ApiError } from './api';

export type FieldErrors = Record<string, string>;

/**
 * Valide un formulaire avec le MÊME schéma Zod que l'API (une seule source de vérité). Les messages du schéma sont en
 * français : on ne retient que le champ en faute, le texte affiché est traduit par l'interface.
 */
export function parseForm<T>(schema: ZodType<T>, values: unknown): { data: T; errors: null } | { data: null; errors: FieldErrors } {
  const result = schema.safeParse(values);
  if (result.success) return { data: result.data, errors: null };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    errors[key] ??= issue.code;
  }
  return { data: null, errors };
}

/** Champs refusés par le serveur (`details: [{ path, … }]`), pour les surligner comme une erreur locale. */
export function serverFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const out: FieldErrors = {};
  for (const item of error.details as { path?: unknown; code?: unknown }[]) {
    if (typeof item.path === 'string' && item.path) out[item.path] ??= typeof item.code === 'string' ? item.code : 'invalid';
  }
  return out;
}

/** Chaîne vide → undefined : un champ facultatif laissé vide n'est pas envoyé (le schéma strict le refuserait). */
export const blankToUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};
