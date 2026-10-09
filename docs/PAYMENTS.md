# Paiements

## Principe : le serveur vérifie, le navigateur ne prouve rien

Un paiement n'est « réussi » que lorsque **le serveur l'a confirmé auprès du prestataire** (`getPaymentState`, appel de
serveur à serveur). Ni la redirection du navigateur vers notre page de retour, ni le contenu d'un webhook ne suffisent :

- la **redirection** n'est qu'un confort : la page de retour appelle `GET /payments/:id`, et le serveur interroge lui-même le prestataire ;
- le **webhook** (authentifié par signature) sert de _déclencheur_ ; il désigne un paiement, l'état réel est redemandé au prestataire.
  Un webhook correctement signé mais mensonger ne peut donc rien confirmer.

## Architecture : le prestataire est interchangeable

Le reste de l'application ne connaît que le contrat abstrait
[`PaymentProvider`](../apps/api/src/modules/payments/providers/payment-provider.ts) :

| Méthode           | Rôle                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `createIntent`    | ouvre un paiement, renvoie l'adresse de la page de paiement hébergée    |
| `getPaymentState` | **source de vérité** : état réel, montant et devise encaissés           |
| `cancelIntent`    | ferme un paiement non abouti (il ne pourra plus être réglé)             |
| `refund`          | rembourse, **idempotent** (l'identifiant de notre `Refund` sert de clé) |
| `parseWebhook`    | authentifie le **corps brut** (signature + horodatage) et le normalise  |

`PAYMENT_PROVIDER=fake` : prestataire simulé (développement et tests, **refusé au démarrage en production**).
`PAYMENT_PROVIDER=live` : adaptateur réel — **pas encore branché** : le démarrage échoue avec un message explicite plutôt que
de retomber silencieusement sur le simulé.

### Brancher CIB / Edahabia (ou un agrégateur)

1. Obtenir du prestataire : la documentation d'API, un **compte de test (sandbox)**, le mécanisme de signature des webhooks.
2. Écrire `modules/payments/providers/<nom>.provider.ts` qui étend `PaymentProvider` et implémente les 5 méthodes.
3. Le retourner dans la fabrique de `payments.module.ts` quand `PAYMENT_PROVIDER=live`.
4. Rejouer la suite de tests `payments.test.ts` contre la sandbox : elle décrit tout le comportement attendu.

Points à vérifier avec le prestataire : le montant est-il exprimé en dinars ou en centimes ? la page de paiement renvoie-t-elle
l'identifiant marchand ? l'API offre-t-elle un remboursement partiel ? un webhook de remboursement (le traitement des
événements `refund.*` est prévu mais ignoré aujourd'hui) ?

## Parcours d'un paiement

```
POST /bookings/:id/pay            (Idempotency-Key, aucun montant : celui figé dans la réservation)
   │  Payment INITIATED → createIntent → Payment PENDING (+ page de paiement)
   │  le verrou est prolongé (≤ 3 × sa durée de base)
   ▼
le payeur règle sur la page du prestataire
   ▼
prestataire ──► POST /webhooks/payments/:provider      (signé, corps brut)
   │  1. signature + horodatage         → sinon 401, rien n'est enregistré
   │  2. (provider, eventId) unique     → livraison en double acquittée sans rien refaire
   │  3. getPaymentState (serveur→prestataire) : montant et devise = ceux attendus ?  sinon refus + audit
   │  4. Payment PENDING → SUCCEEDED (transition atomique)
   │  5. Booking PENDING_PAYMENT → CONFIRMED (transition atomique)
   ▼
GET /payments/:id (page de retour) refait la même vérification si le webhook s'est perdu
```

Une **seule** demande de paiement peut être en cours par réservation, garanti par un index unique partiel en base
(`Payment_one_inflight_per_booking_idx`) : un double clic ne peut pas ouvrir deux pages de paiement.

## Cas limites traités automatiquement

| Situation                                                           | Résultat                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Webhook falsifié, sans signature, avec un autre secret, trop ancien | 401, aucune trace, aucun changement                                               |
| Même événement reçu plusieurs fois (même simultanément)             | traité une seule fois                                                             |
| Montant ou devise encaissés ≠ attendus                              | rien n'est confirmé, alerte (journal + audit `payment.amount_mismatch`)           |
| Prestataire en panne pendant un webhook                             | 500 → il réessaie ; l'événement reste rejouable                                   |
| Webhook perdu                                                       | rattrapé par la page de retour ou par la maintenance (toutes les 30 s)            |
| Paiement après expiration du verrou, créneau encore libre           | le client garde son créneau (réservation confirmée)                               |
| Paiement après expiration, créneau **repris** par un autre client   | remboursement **automatique** intégral, pas de réservation fantôme                |
| Réservation annulée pendant le paiement                             | le paiement est fermé chez le prestataire ; s'il est réglé quand même → remboursé |
| **Paiement en double** (ancien paiement réglé après le nouveau)     | le règlement arrivé en dernier est remboursé                                      |
| Plantage entre « payé » et « confirmé »                             | terminé par la maintenance                                                        |

Le doublon est désigné par la **date de règlement** (puis l'identifiant en cas d'égalité) : deux paiements ne peuvent jamais se
rembourser mutuellement.

## Remboursements

Une annulation crée des demandes `Refund` (statut `REQUESTED`) **dans la transaction d'annulation** ; une fois celle-ci validée,
un événement interne déclenche l'exécution auprès du prestataire :

- transition `REQUESTED → PROCESSING` atomique (un seul exécutant) ;
- clé d'idempotence = identifiant du `Refund` : jamais deux remboursements, même si on rejoue ;
- succès → `Refund SUCCEEDED`, `Payment REFUNDED` (ou `PARTIALLY_REFUNDED`) ;
- échec définitif → `FAILED`, audit, intervention manuelle ; le motif d'origine est conservé ;
- panne temporaire → remis en file, repris par la maintenance ; abandon et alerte après 24 h.

Règles d'annulation : voir [BOOKINGS.md](BOOKINGS.md).

## Prestataire simulé (développement)

Il reproduit le comportement d'un vrai prestataire : état de paiement **chez lui**, page de paiement hébergée, webhook signé
(HMAC-SHA256 sur `horodatage.corps`, tolérance 5 min), remboursements idempotents. Page de démonstration :
`http://localhost:3000/api/v1/dev/fake-provider/checkout/<référence>` (boutons Payer / Échec / Annuler). Ces routes sont
fermées (404) en production et avec un vrai prestataire.

Variable utile : `API_PUBLIC_URL` (adresse publique de l'API ; défaut `http://localhost:<API_PORT>`).

## Sécurité

- Signature vérifiée sur les **octets exacts** du corps (`rawBody`) en temps constant, avec horodatage anti-rejeu.
- Aucun montant ne vient du client ; les vues de paiement ne divulguent ni la référence du prestataire, ni sa réponse brute.
- Webhook et page de retour passent par les mêmes transitions **conditionnelles** : impossible de confirmer deux fois.
- Les appels au prestataire ne sont **jamais** faits pendant qu'une transaction de base de données est ouverte.
