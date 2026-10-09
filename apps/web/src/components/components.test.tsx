import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../i18n';
import { BarChart } from './BarChart';
import { Field, Input, Modal } from './ui';

function Probe() {
  const { t, money, tError } = useI18n();
  return (
    <div>
      <p data-testid="title">{t('nav.bookings')}</p>
      <p data-testid="money">{money(8500)}</p>
      <p data-testid="error">{tError(new Error('x'))}</p>
    </div>
  );
}

describe('langue et sens de lecture', () => {
  it('l’arabe passe la page en droite-à-gauche et traduit textes et montants', () => {
    render(
      <I18nProvider initial="ar">
        <Probe />
      </I18nProvider>,
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(screen.getByTestId('title')).toHaveTextContent('الحجوزات');
    expect(screen.getByTestId('money').textContent).toMatch(/دج/);
  });

  it('le français et l’anglais restent de gauche à droite', () => {
    const { unmount } = render(
      <I18nProvider initial="fr">
        <Probe />
      </I18nProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByTestId('title')).toHaveTextContent('Réservations');
    unmount();
    render(
      <I18nProvider initial="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('title')).toHaveTextContent('Bookings');
    expect(screen.getByTestId('error')).toHaveTextContent('unexpected error');
  });
});

describe('composants', () => {
  it('un champ relie son libellé, son aide et son erreur au contrôle (accessibilité)', () => {
    render(
      <I18nProvider initial="fr">
        <Field label="Email" hint="aide" error="erreur">
          {(p) => <Input {...p} />}
        </Field>
      </I18nProvider>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('-err');
    expect(screen.getByText('erreur')).toBeInTheDocument();
    expect(screen.queryByText('aide')).not.toBeInTheDocument(); // l'erreur remplace l'aide
  });

  it('l’histogramme expose aussi ses valeurs aux lecteurs d’écran', () => {
    render(
      <I18nProvider initial="fr">
        <BarChart
          data={[
            { label: '01', value: 3000 },
            { label: '02', value: 0 },
          ]}
          format={(n) => `${n} DA`}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('row', { name: /01 3000 DA/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /02 0 DA/ })).toBeInTheDocument();
  });

  it('la fenêtre modale n’affiche rien tant qu’elle est fermée et se ferme par son bouton', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    const onClose = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <Modal
          open={false}
          onClose={onClose}
          title="Titre"
          footer={<button onClick={onClose}>Fermer</button>}
        >
          contenu
        </Modal>
      </MemoryRouter>,
    );
    expect(screen.queryByText('contenu')).not.toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <Modal
          open
          onClose={onClose}
          title="Titre"
          footer={<button onClick={onClose}>Fermer</button>}
        >
          contenu
        </Modal>
      </MemoryRouter>,
    );
    expect(screen.getByText('contenu')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Fermer'));
    expect(onClose).toHaveBeenCalled();
  });
});
