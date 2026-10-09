export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export class InvalidImageError extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Détermine le VRAI format d'après les premiers octets : l'en-tête Content-Type et l'extension sont déclaratifs et ne
 * prouvent rien. Seuls JPEG, PNG et WebP sont acceptés (jamais SVG, qui peut contenir du script).
 */
export function sniffImage(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const EXTENSION: Record<ImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Segments JPEG qui portent des métadonnées : EXIF/XMP (APP1, dont la position GPS), APP13 (IPTC) et commentaires. */
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe]);

function stripJpeg(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 2)];
  let pos = 2;
  while (pos < data.length) {
    if (data[pos] !== 0xff) throw new InvalidImageError('Structure JPEG invalide');
    const marker = data[pos + 1];
    if (marker === undefined) throw new InvalidImageError('JPEG tronqué');
    if (marker === 0xff) {
      pos += 1; // octets de remplissage
      continue;
    }
    if (marker === 0xda) {
      parts.push(data.subarray(pos)); // début des données d'image : tout le reste est conservé tel quel
      return Buffer.concat(parts);
    }
    if (marker === 0xd9) throw new InvalidImageError('JPEG sans données d’image');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(data.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > data.length) throw new InvalidImageError('JPEG tronqué');
    const end = pos + 2 + data.readUInt16BE(pos + 2);
    if (end > data.length || end < pos + 4) throw new InvalidImageError('Segment JPEG invalide');
    if (!JPEG_DROPPED.has(marker)) parts.push(data.subarray(pos, end));
    pos = end;
  }
  throw new InvalidImageError('JPEG sans données d’image');
}

/** Blocs PNG de métadonnées : EXIF, textes, date de modification. */
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 8)];
  let pos = 8;
  let first = true;
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > data.length) throw new InvalidImageError('PNG tronqué');
    if (first && type !== 'IHDR') throw new InvalidImageError('PNG invalide');
    first = false;
    if (!PNG_DROPPED.has(type)) parts.push(data.subarray(pos, end));
    pos = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  throw new InvalidImageError('PNG sans fin de fichier');
}

/**
 * Retire les métadonnées d'un JPEG ou d'un PNG (notamment la position GPS d'une photo prise au téléphone) et vérifie la
 * structure du fichier. Limite connue : les blocs EXIF/XMP d'un WebP sont conservés (la structure est seulement vérifiée).
 */
export function stripMetadata(data: Buffer, type: ImageType): Buffer {
  if (type === 'image/jpeg') return stripJpeg(data);
  if (type === 'image/png') return stripPng(data);
  if (data.readUInt32LE(4) + 8 > data.length) throw new InvalidImageError('WebP tronqué');
  return data;
}
