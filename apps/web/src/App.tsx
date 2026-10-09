import { CURRENCY, LOCALES } from '@footfive/shared';

/** Coquille temporaire : l'interface réelle (design system, i18n AR/FR/EN + RTL, pages) arrive à l'étape 10. */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Foot Five</h1>
      <p>Réservez votre Foot Five. Trouvez vos coéquipiers. Trouvez vos adversaires.</p>
      <small>
        Langues : {LOCALES.join(', ')} · Devise : {CURRENCY}
      </small>
    </main>
  );
}
