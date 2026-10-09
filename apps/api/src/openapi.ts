import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Documentation OpenAPI : interface sur /api/docs, spécification JSON sur /api/docs-json.
 * Le client web et la future application mobile peuvent en générer un client typé.
 */
export function setupOpenApi(app: NestFastifyApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Foot Five API')
    .setDescription(
      'API REST de la plateforme Foot Five (réservation de terrains, équipes, matchs).\n\n' +
        'Erreurs : `{ "error": { "code", "message", "details?", "requestId" } }` — traduire à partir du `code`.\n' +
        'Montants : entiers en unité mineure (DZD). Dates : ISO 8601 UTC.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'api/docs-json',
  });
}
