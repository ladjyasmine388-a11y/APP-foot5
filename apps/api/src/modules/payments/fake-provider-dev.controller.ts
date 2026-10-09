import {
  type CanActivate,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Errors } from '../../common/errors/app-exception.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { Public } from '../auth/auth.decorators.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { FakePaymentProvider } from './providers/fake-payment.provider.js';

/**
 * Ces routes n'existent QUE si le prestataire simulé est actif ET que l'environnement n'est pas la production.
 * (Le prestataire simulé est de toute façon refusé au démarrage en production : double verrou.)
 */
@Injectable()
export class FakeProviderOnlyGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(FakePaymentProvider) private readonly fake: FakePaymentProvider | null,
  ) {}

  canActivate(): boolean {
    if (this.env.NODE_ENV === 'production' || this.env.PAYMENT_PROVIDER !== 'fake' || !this.fake) {
      throw Errors.notFound();
    }
    return true;
  }
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const formatAmount = (minor: number, currency: string): string =>
  `${new Intl.NumberFormat('fr-FR').format(minor)} ${currency}`;

/**
 * Fausse page de paiement du prestataire (développement). Elle imite le parcours réel : le payeur règle sur la page
 * du PRESTATAIRE, qui envoie ensuite un WEBHOOK SIGNÉ à l'API, puis renvoie le navigateur vers l'application.
 */
@ApiExcludeController()
@Public()
@UseGuards(FakeProviderOnlyGuard)
@Controller('dev/fake-provider')
export class FakeProviderDevController {
  private readonly logger = new Logger(FakeProviderDevController.name);

  constructor(
    @Inject(FakePaymentProvider) private readonly fake: FakePaymentProvider,
    private readonly webhooks: PaymentWebhooksService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('checkout/:ref')
  checkout(@Param('ref') ref: string, @Res() reply: FastifyReply): void {
    const data = this.fake.checkoutData(ref);
    if (!data) throw Errors.notFound('Paiement introuvable');

    const form = (action: string, label: string, style: string): string =>
      `<form method="post" enctype="text/plain" action="${encodeURIComponent(ref)}/${action}"><button class="${style}">${label}</button></form>`;
    const body =
      data.status === 'PENDING'
        ? `${form('pay', 'Payer', 'primary')}${form('fail', 'Simuler un échec', 'secondary')}${form('cancel', 'Annuler', 'secondary')}`
        : `<p class="state">Ce paiement est déjà « ${escapeHtml(data.status)} ».</p>`;

    // La politique de sécurité par défaut (helmet) interdit qu'un formulaire redirige vers une autre origine ; or cette page doit
    // renvoyer le payeur vers le site (comme le fait toute vraie page de paiement). On autorise donc uniquement l'origine du site.
    void reply
      .header(
        'content-security-policy',
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${this.env.WEB_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paiement simulé — Foot Five</title>
<style>body{font-family:system-ui,sans-serif;background:#0b5d3b;margin:0;min-height:100vh;display:grid;place-items:center}
main{background:#fff;border-radius:16px;padding:28px;width:min(92vw,380px);box-shadow:0 10px 40px #0004}
.badge{background:#fde68a;color:#78350f;font-size:12px;font-weight:700;padding:4px 10px;border-radius:99px;display:inline-block}
h1{margin:14px 0 4px;font-size:28px}p{color:#444;margin:6px 0 18px}form{margin:8px 0}
button{width:100%;padding:14px;border:0;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}
.primary{background:#16a34a;color:#fff}.secondary{background:#eee;color:#222}.state{font-weight:600}</style></head>
<body><main><span class="badge">SIMULATION — aucun argent réel</span>
<h1>${escapeHtml(formatAmount(data.amountMinor, data.currency))}</h1>
<p>${escapeHtml(data.description)}</p>${body}</main></body></html>`);
  }

  @Post('checkout/:ref/:action')
  async act(
    @Param('ref') ref: string,
    @Param('action') action: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const data = this.fake.checkoutData(ref);
    if (!data) throw Errors.notFound('Paiement introuvable');
    const outcome = ({ pay: 'SUCCEEDED', fail: 'FAILED', cancel: 'CANCELLED' } as const)[
      action as 'pay' | 'fail' | 'cancel'
    ];
    if (!outcome) throw Errors.notFound();

    if (data.status === 'PENDING') {
      // Le prestataire enregistre le règlement puis PRÉVIENT l'API par un webhook signé (comme en production).
      const webhook = this.fake.completePayment(ref, outcome);
      try {
        await this.webhooks.handle('fake', webhook.rawBody, webhook.headers);
      } catch (error) {
        // Comme un vrai prestataire : l'échec de livraison n'empêche pas le payeur de revenir sur le site.
        this.logger.warn(
          `Livraison du webhook simulé en échec : ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    // Les adresses de retour sont fabriquées par NOTRE serveur à l'initiation : pas de redirection ouverte.
    void reply.redirect(outcome === 'CANCELLED' ? data.cancelUrl : data.returnUrl, 303);
  }
}
