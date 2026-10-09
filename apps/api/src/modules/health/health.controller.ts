import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    // La vérification de la base de données sera ajoutée avec Prisma (étape 2).
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
