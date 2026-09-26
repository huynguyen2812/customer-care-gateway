import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activationInputProps, normalizeActivationCodeInput, shouldClearCodeAfterError, shouldClearCodeForState } from '../web/src/lib/activation-code';

/**
 * Regression for "the activation-code field shows an old code again". Verified cause (browser QA 2026-09-26): the code
 * was kept in React state of the still-mounted page (navigating to the same hash URL is not a reload), not browser
 * form restore and not app storage. These tests pin down when the state is cleared, that typing/pasting still works,
 * and that the page never persists or auto-submits the code.
 */
describe('activation code field (web)', () => {
  const page = readFileSync(join(__dirname, '..', 'web', 'src', 'pages', 'PlatformConnection.tsx'), 'utf8');
  const lib = readFileSync(join(__dirname, '..', 'web', 'src', 'lib', 'activation-code.ts'), 'utf8');

  it('typing/pasting keeps the code usable (upper-case, trimmed; dashes kept)', () => {
    expect(normalizeActivationCodeInput('  abcd-efgh-jklm\n')).toBe('ABCD-EFGH-JKLM');
    expect(normalizeActivationCodeInput('ab12')).toBe('AB12');
  });

  it('clears after errors that make the code useless; keeps it after a lost answer / network error (retry the same code)', () => {
    for (const c of ['ACTIVATION_CODE_EXPIRED', 'ACTIVATION_RECOVERY_REQUIRED', 'DEVICE_REVOKED', 'ACTIVATION_CODE_INVALID', 'ACTIVATION_CODE_USED']) expect(shouldClearCodeAfterError(c)).toBe(true);
    for (const c of ['PLATFORM_UNREACHABLE', 'ACTIVATION_FAILED', 'ACTIVATION_IN_PROGRESS', 'ACTIVATION_RETRY_SAME_CODE', undefined, null]) expect(shouldClearCodeAfterError(c)).toBe(false);
  });

  it('clears when the server state makes the old code useless (activated, recovery required, unpaired, revoked)', () => {
    expect(shouldClearCodeForState('ACTIVE', null)).toBe(true);
    expect(shouldClearCodeForState('PENDING', 'RECOVERY_REQUIRED')).toBe(true);
    expect(shouldClearCodeForState('UNPAIRED', null)).toBe(true);
    expect(shouldClearCodeForState('REVOKED', null)).toBe(true);
    expect(shouldClearCodeForState('PENDING', 'RETRY_SAME_CODE')).toBe(false);
    expect(shouldClearCodeForState('PENDING', 'NOT_BOUND')).toBe(false);
    expect(shouldClearCodeForState(null, null)).toBe(false);
  });

  it('input hints against autofill/saving (a hint only, not a guarantee)', () => {
    expect(activationInputProps('vc-activation-x')).toMatchObject({ name: 'vc-activation-x', autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true' });
    expect(page).toMatch(/<form onSubmit=\{activate\} autoComplete="off"/);
    expect(page).toMatch(/\{\.\.\.activationInputProps\(fieldName\)\}/);
  });

  it('the page never persists the code nor puts it in the URL, and only an explicit submit calls the API', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // strip comments
    for (const src of [page, lib]) expect(code(src)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|location\.(hash|search|href)\s*=|history\.(push|replace)State/);
    // The only call that sends the code is inside the submit handler; onChange only updates state.
    expect(page.match(/platformActivate\(/g)).toHaveLength(1);
    expect(page).toMatch(/const activate = async \(e: React\.FormEvent\) => \{\s*e\.preventDefault\(\)/);
    expect(page).toMatch(/onChange=\{\(e\) => setCode\(normalizeActivationCodeInput\(e\.target\.value\)\)\}/);
    expect(page).not.toMatch(/useEffect\([^)]*platformActivate/);
  });
});
