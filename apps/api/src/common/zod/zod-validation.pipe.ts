import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { FieldIssue } from '@footfive/shared';
import { type ZodError, type ZodType, z } from 'zod';
import { AppException } from '../errors/app-exception.js';

export function formatZodIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Valide ET transforme une entrée (corps, paramètre, query) avec un schéma Zod.
 * Les schémas vivent dans @footfive/shared : le web et le mobile appliquent exactement les mêmes règles,
 * mais c'est TOUJOURS la validation du serveur qui fait foi.
 *
 * Usage : `@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput`
 */
export class ZodValidationPipe<S extends ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    // Un corps absent est traité comme un objet vide : le schéma décide s'il est acceptable.
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new AppException(
        'VALIDATION_ERROR',
        HttpStatus.BAD_REQUEST,
        'Données invalides',
        formatZodIssues(result.error),
      );
    }
    return result.data;
  }
}
