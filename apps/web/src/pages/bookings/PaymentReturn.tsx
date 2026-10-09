import type { PaymentView } from '@footfive/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Alert, Button, ErrorState, LinkButton, Loading, PageHeader } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';

const FINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * Page de retour du paiement. Le navigateur n'apporte AUCUNE preuve : on demande au serveur, qui interroge lui-même le
 * prestataire. On réinterroge toutes les 2 s tant que l'état n'est pas définitif (le webhook peut arriver après).
 */
export function PaymentReturnPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const paymentId = params.get('paymentId') ?? '';
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const payment = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => api<PaymentView>(`/payments/${paymentId}`),
    enabled: Boolean(paymentId),
    refetchInterval: (q) => (q.state.data && FINAL.has(q.state.data.status) ? false : 2000),
    retry: false,
  });
  const status = payment.data?.status;
  useEffect(() => {
    if (status) {
      void queryClient.invalidateQueries({ queryKey: ['booking', id] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
    }
  }, [status, id, queryClient]);

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={t('payment.title')} />
      {!paymentId ? (
        <Alert tone="error">{t('payment.failed')}</Alert>
      ) : payment.isError ? (
        <ErrorState error={payment.error} onRetry={() => void payment.refetch()} />
      ) : !status || !FINAL.has(status) ? (
        <div className="space-y-3">
          <Loading />
          <Alert tone="info">{status ? t('payment.pending') : t('payment.checking')}</Alert>
        </div>
      ) : status === 'SUCCEEDED' ? (
        <Alert tone="success">{t('payment.success')}</Alert>
      ) : status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED' ? (
        <Alert tone="warning">{t('payment.refundedAuto')}</Alert>
      ) : (
        <Alert tone="error">{t('payment.failed')}</Alert>
      )}
      <div className="mt-5 flex gap-2">
        <LinkButton to={`/bookings/${id}`}>{t('bookings.detail.title')}</LinkButton>
        {status && !FINAL.has(status) && <Button variant="secondary" onClick={() => void payment.refetch()}>{t('common.retry')}</Button>}
      </div>
    </div>
  );
}
