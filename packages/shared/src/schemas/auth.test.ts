import { describe, expect, it } from 'vitest';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth';
import { birthDateSchema, normalizePhone, passwordSchema, toAsciiDigits } from './primitives';

const validRegistration = {
  firstName: 'Yasmine',
  lastName: 'Benali',
  email: 'Yasmine@Example.com',
  phone: '0550 12 34 56',
  password: 'un-bon-mot-de-passe',
  acceptTerms: true,
};

describe('normalizePhone', () => {
  it.each([
    ['0550123456', '+213550123456'],
    ['0550 12 34 56', '+213550123456'],
    ['0550-12-34-56', '+213550123456'],
    ['+213 550 12 34 56', '+213550123456'],
    ['00213550123456', '+213550123456'],
    ['٠٥٥٠١٢٣٤٥٦', '+213550123456'], // chiffres arabo-indiens
    ['+33612345678', '+33612345678'], // autre pays : accepté tel quel
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '123', '+0123456789', '055012', '0550123456789012345'])(
    'refuse « %s »',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );

  it('toAsciiDigits convertit aussi les chiffres persans', () => {
    expect(toAsciiDigits('۰۵۵۰')).toBe('0550');
  });
});

describe('passwordSchema', () => {
  it('accepte un mot de passe solide', () => {
    expect(passwordSchema.safeParse('Un-Bon-Mot-De-Passe-2026').success).toBe(true);
  });

  it.each([
    ['trop court', 'Abc123!'],
    ['trop long', 'a1'.repeat(70)],
    ['trop courant', 'password123'],
    ['trop courant (casse)', 'PASSWORD123'],
    ['trop répétitif', 'aaaaaaaaaaaa'],
  ])('refuse un mot de passe %s', (_label, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });
});

describe('birthDateSchema', () => {
  it('accepte une date valide', () => {
    expect(birthDateSchema.safeParse('1995-06-15').success).toBe(true);
  });

  it.each([
    ['impossible (30 février)', '2000-02-30'],
    ['format incorrect', '15/06/1995'],
    ['dans le futur', '2999-01-01'],
    ['moins de 13 ans', new Date().toISOString().slice(0, 10)],
    ['avant 1900', '1850-01-01'],
  ])('refuse une date %s', (_label, value) => {
    expect(birthDateSchema.safeParse(value).success).toBe(false);
  });
});

describe('registerSchema', () => {
  it('normalise email (minuscules) et téléphone (E.164) et applique les valeurs par défaut', () => {
    const parsed = registerSchema.parse(validRegistration);
    expect(parsed.email).toBe('yasmine@example.com');
    expect(parsed.phone).toBe('+213550123456');
    expect(parsed.level).toBe('BEGINNER');
    expect(parsed.preferredPosition).toBe('ANY');
    expect(parsed.locale).toBe('fr');
  });

  it('exige le consentement aux conditions', () => {
    expect(registerSchema.safeParse({ ...validRegistration, acceptTerms: false }).success).toBe(
      false,
    );
    const { acceptTerms: _omitted, ...without } = validRegistration;
    expect(registerSchema.safeParse(without).success).toBe(false);
  });

  it('refuse un mot de passe identique à l’email', () => {
    const result = registerSchema.safeParse({
      ...validRegistration,
      email: 'quelquun@example.com',
      password: 'quelquun@example.com',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['platformRole', 'ADMIN'],
    ['emailVerifiedAt', '2026-01-01T00:00:00Z'],
    ['status', 'ACTIVE'],
    ['passwordHash', 'x'],
    ['id', '00000000-0000-0000-0000-000000000000'],
  ])('REFUSE le champ interdit « %s » (assignation de masse)', (field, value) => {
    const result = registerSchema.safeParse({ ...validRegistration, [field]: value });
    expect(result.success).toBe(false);
  });

  it('refuse les prénoms contenant des caractères dangereux', () => {
    expect(
      registerSchema.safeParse({ ...validRegistration, firstName: '<script>alert(1)</script>' })
        .success,
    ).toBe(false);
    expect(
      registerSchema.safeParse({ ...validRegistration, firstName: 'Jean-Pierre' }).success,
    ).toBe(true);
    expect(registerSchema.safeParse({ ...validRegistration, firstName: 'يوسف' }).success).toBe(
      true,
    );
    expect(registerSchema.safeParse({ ...validRegistration, firstName: "O'Brien" }).success).toBe(
      true,
    );
  });
});

describe('loginSchema', () => {
  it('normalise l’email et refuse les champs en trop', () => {
    expect(loginSchema.parse({ email: ' Yas@Test.COM ', password: 'x' }).email).toBe(
      'yas@test.com',
    );
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x', remember: true }).success).toBe(
      false,
    );
  });
});

describe('updateProfileSchema', () => {
  it('accepte une modification partielle', () => {
    expect(updateProfileSchema.parse({ city: 'Oran' })).toEqual({ city: 'Oran' });
    expect(updateProfileSchema.parse({ phone: '0661 00 00 00' })).toEqual({
      phone: '+213661000000',
    });
  });

  it('refuse une requête vide', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it.each(['email', 'platformRole', 'status', 'emailVerifiedAt', 'passwordHash', 'avatarUrl'])(
    'REFUSE de modifier « %s » via le profil',
    (field) => {
      expect(updateProfileSchema.safeParse({ city: 'Oran', [field]: 'x' }).success).toBe(false);
    },
  );

  it('borne les préférences', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(updateProfileSchema.safeParse({ preferences: tooMany }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ preferences: { theme: { nested: 1 } } }).success).toBe(
      false,
    );
  });
});

describe('changePasswordSchema / resetPasswordSchema', () => {
  it('refuse un nouveau mot de passe identique à l’ancien', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'un-bon-mot-de-passe',
        newPassword: 'un-bon-mot-de-passe',
      }).success,
    ).toBe(false);
  });

  it('applique la politique de mot de passe à la réinitialisation', () => {
    expect(
      resetPasswordSchema.safeParse({ token: 'a'.repeat(43), password: 'court' }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ token: 'a'.repeat(43), password: 'un-bon-mot-de-passe' })
        .success,
    ).toBe(true);
  });
});
