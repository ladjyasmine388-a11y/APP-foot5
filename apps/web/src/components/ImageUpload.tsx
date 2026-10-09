import { UPLOAD_CONTENT_TYPES, UPLOAD_MAX_BYTES, type UploadedImage } from '@footfive/shared';
import { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { Alert, Button } from './ui';

/**
 * Envoi d'une image (avatar, logo, photo). Le fichier part tel quel dans le corps de la requête ; le serveur revérifie le VRAI
 * format, la taille et retire les métadonnées (position GPS) : les contrôles d'ici ne sont qu'un confort.
 */
export function ImageUpload({
  path,
  method = 'PUT',
  label,
  onUploaded,
}: {
  path: string;
  method?: 'PUT' | 'POST';
  label: string;
  onUploaded: (image: UploadedImage) => void;
}) {
  const { t, tError } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type))
      return setError(t('upload.badType'));
    if (file.size > UPLOAD_MAX_BYTES) return setError(t('upload.tooBig'));
    setBusy(true);
    try {
      onUploaded(
        await api<UploadedImage>(path, { method, binary: { data: file, contentType: file.type } }),
      );
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept={UPLOAD_CONTENT_TYPES.join(',')}
        className="sr-only"
        aria-label={label}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button variant="secondary" loading={busy} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <p className="text-xs text-muted">{t('upload.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
