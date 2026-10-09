import { ApiBody } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

/**
 * Documente le corps d'une route dans OpenAPI à partir du schéma Zod (une seule source de vérité :
 * ce qui est validé est exactement ce qui est documenté).
 */
export function ApiZodBody(schema: ZodType): MethodDecorator {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  // Le champ $schema n'est pas attendu dans un document OpenAPI.
  delete (json as { $schema?: string }).$schema;
  return ApiBody({ schema: json } as Parameters<typeof ApiBody>[0]);
}
