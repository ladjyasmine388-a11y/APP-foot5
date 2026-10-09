import { describe, expect, it } from 'vitest';
import { InvalidImageError, sniffImage, stripMetadata } from './image-sniff.js';

const u16 = (n: number): Buffer => Buffer.from([n >> 8, n & 0xff]);

/** JPEG minimal : APP0 (JFIF), APP1 (EXIF avec « GPS »), commentaire, SOS puis données et EOI. */
function jpegWithExif(): Buffer {
  const exif = Buffer.from('Exif\0\0GPS-48.85,2.35');
  const comment = Buffer.from('prise à Paris');
  const jfif = Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), u16(jfif.length + 2), jfif,
    Buffer.from([0xff, 0xe1]), u16(exif.length + 2), exif,
    Buffer.from([0xff, 0xfe]), u16(comment.length + 2), comment,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]),
  ]);
}

function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC non vérifié ici
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...chunks: Buffer[]): Buffer => Buffer.concat([PNG_SIG, ...chunks]);

describe('reconnaissance du format', () => {
  it('identifie JPEG, PNG et WebP d’après les octets', () => {
    expect(sniffImage(jpegWithExif())).toBe('image/jpeg');
    expect(sniffImage(png(chunk('IHDR', Buffer.alloc(13)), chunk('IEND')))).toBe('image/png');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
  });

  it('refuse SVG, GIF, HTML, PDF et fichiers vides ou trop courts', () => {
    for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'GIF89a....', '<html><script>', '%PDF-1.7', '', 'ÿØ']) {
      expect(sniffImage(Buffer.from(bad)), bad).toBeNull();
    }
  });
});

describe('retrait des métadonnées', () => {
  it('JPEG : supprime EXIF (GPS) et commentaires, garde JFIF et les données d’image', () => {
    const out = stripMetadata(jpegWithExif(), 'image/jpeg');
    expect(out.includes(Buffer.from('GPS'))).toBe(false);
    expect(out.includes(Buffer.from('Paris'))).toBe(false);
    expect(out.includes(Buffer.from('JFIF'))).toBe(true);
    expect(out.subarray(out.length - 9).equals(Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]))).toBe(true);
    expect(sniffImage(out)).toBe('image/jpeg');
  });

  it('PNG : supprime les blocs texte/EXIF/date, garde IHDR, IDAT et IEND', () => {
    const input = png(chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Location\0Paris')), chunk('eXIf', Buffer.from('GPS')), chunk('tIME', Buffer.alloc(7)), chunk('IDAT', Buffer.from('pixels')), chunk('IEND'));
    const out = stripMetadata(input, 'image/png');
    for (const gone of ['tEXt', 'eXIf', 'tIME', 'Paris', 'GPS']) expect(out.includes(Buffer.from(gone)), gone).toBe(false);
    for (const kept of ['IHDR', 'IDAT', 'pixels', 'IEND']) expect(out.includes(Buffer.from(kept)), kept).toBe(true);
  });

  it('refuse les fichiers tronqués ou mal formés', () => {
    const full = jpegWithExif();
    expect(() => stripMetadata(full.subarray(0, 12), 'image/jpeg')).toThrow(InvalidImageError);
    expect(() => stripMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toThrow(InvalidImageError);
    expect(() => stripMetadata(Buffer.from([0xff, 0xd8, 0x12, 0x34]), 'image/jpeg')).toThrow(InvalidImageError);
    expect(() => stripMetadata(png(chunk('IDAT'), chunk('IEND')), 'image/png')).toThrow(InvalidImageError); // IHDR absent
    expect(() => stripMetadata(png(chunk('IHDR', Buffer.alloc(13))), 'image/png')).toThrow(InvalidImageError); // IEND absent
    const huge = Buffer.concat([PNG_SIG, Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('IHDR')]);
    expect(() => stripMetadata(huge, 'image/png')).toThrow(InvalidImageError); // longueur annoncée hors fichier
    expect(() => stripMetadata(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xff, 0xff, 0x7f]), Buffer.from('WEBPVP8 ')]), 'image/webp')).toThrow(InvalidImageError);
  });
});
