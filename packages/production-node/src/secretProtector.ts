import { spawn } from 'node:child_process';

export interface SecretProtector {
  readonly kind: 'plaintext-alpha' | 'windows-dpapi' | 'macos-keychain';
  isProtected(value: string): boolean;
  protect(value: string, purpose: string): Promise<string>;
  unprotect(value: string, purpose: string): Promise<string>;
  delete(value: string, purpose: string): Promise<void>;
}

export class PlaintextAlphaSecretProtector implements SecretProtector {
  readonly kind = 'plaintext-alpha' as const;

  isProtected(): boolean {
    return false;
  }

  async protect(value: string): Promise<string> {
    return value;
  }

  async unprotect(value: string): Promise<string> {
    return value;
  }

  async delete(): Promise<void> {
    // Alpha fallback only. There is no external secret store to clean.
  }
}

const DPAPI_PREFIX = 'dpapi:v1:';

const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$protectedDataAssembly = Join-Path $PSHOME 'System.Security.Cryptography.ProtectedData.dll'",
  "if (Test-Path $protectedDataAssembly) { Add-Type -Path $protectedDataAssembly } else { Add-Type -AssemblyName System.Security }",
  "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$entropy = [Text.Encoding]::UTF8.GetBytes([string]$payload.purpose)",
  "if ([string]$payload.operation -eq 'protect') {",
  "  $plain = [Text.Encoding]::UTF8.GetBytes([string]$payload.value)",
  "  $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "  [Console]::Out.Write([Convert]::ToBase64String($cipher))",
  "} elseif ([string]$payload.operation -eq 'unprotect') {",
  "  $cipher = [Convert]::FromBase64String([string]$payload.value)",
  "  $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  "} else {",
  "  throw 'invalid_dpapi_operation'",
  "}"
].join('; ');

function runPowerShell(payload: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        DPAPI_SCRIPT
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', error => reject(error));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(
          stderr.trim()
            ? `windows_dpapi_failed: ${stderr.trim().slice(0, 500)}`
            : `windows_dpapi_failed: exit_${code}`
        ));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export class WindowsDpapiSecretProtector implements SecretProtector {
  readonly kind = 'windows-dpapi' as const;

  isProtected(value: string): boolean {
    return value.startsWith(DPAPI_PREFIX);
  }

  async protect(value: string, purpose: string): Promise<string> {
    if (!value) return value;
    if (this.isProtected(value)) return value;

    const protectedValue = await runPowerShell({
      operation: 'protect',
      value,
      purpose
    });

    if (!protectedValue) throw new Error('windows_dpapi_empty_result');
    return `${DPAPI_PREFIX}${protectedValue}`;
  }

  async unprotect(value: string, purpose: string): Promise<string> {
    if (!value) return value;
    if (!this.isProtected(value)) return value;

    return runPowerShell({
      operation: 'unprotect',
      value: value.slice(DPAPI_PREFIX.length),
      purpose
    });
  }

  async delete(): Promise<void> {
    // DPAPI stores the encrypted bytes inline in providers.json.
  }
}

const KEYCHAIN_PREFIX = 'keychain:v1:';
const KEYCHAIN_SERVICE = 'com.millionsnest.nestlive';

function keychainAccount(purpose: string): string {
  return `provider.${Buffer.from(purpose, 'utf8').toString('base64url')}`;
}

function keychainReference(purpose: string): string {
  return `${KEYCHAIN_PREFIX}${Buffer.from(purpose, 'utf8').toString('base64url')}`;
}

function purposeFromKeychainReference(value: string): string | null {
  if (!value.startsWith(KEYCHAIN_PREFIX)) return null;
  try {
    return Buffer.from(
      value.slice(KEYCHAIN_PREFIX.length),
      'base64url'
    ).toString('utf8');
  } catch {
    return null;
  }
}

function runMacSecurity(
  args: string[],
  allowNotFound = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', error => reject(error));
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }

      if (
        allowNotFound &&
        (code === 44 || /could not be found/i.test(stderr))
      ) {
        resolve('');
        return;
      }

      reject(new Error(
        stderr.trim()
          ? `macos_keychain_failed: ${stderr.trim().slice(0, 500)}`
          : `macos_keychain_failed: exit_${code}`
      ));
    });
  });
}

export class MacOsKeychainSecretProtector implements SecretProtector {
  readonly kind = 'macos-keychain' as const;

  isProtected(value: string): boolean {
    return purposeFromKeychainReference(value) !== null;
  }

  async protect(value: string, purpose: string): Promise<string> {
    if (!value) return value;
    if (this.isProtected(value)) return value;

    const encodedSecret = Buffer.from(value, 'utf8').toString('base64');
    await runMacSecurity([
      'add-generic-password',
      '-U',
      '-a',
      keychainAccount(purpose),
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
      encodedSecret
    ]);

    return keychainReference(purpose);
  }

  async unprotect(value: string, purpose: string): Promise<string> {
    if (!value) return value;
    if (!this.isProtected(value)) return value;

    const storedPurpose = purposeFromKeychainReference(value);
    if (!storedPurpose || storedPurpose !== purpose) {
      throw new Error('macos_keychain_reference_mismatch');
    }

    const encodedSecret = await runMacSecurity([
      'find-generic-password',
      '-a',
      keychainAccount(purpose),
      '-s',
      KEYCHAIN_SERVICE,
      '-w'
    ]);

    if (!encodedSecret) throw new Error('macos_keychain_secret_missing');
    try {
      return Buffer.from(encodedSecret, 'base64').toString('utf8');
    } catch {
      throw new Error('macos_keychain_secret_invalid');
    }
  }

  async delete(value: string, purpose: string): Promise<void> {
    if (!this.isProtected(value)) return;
    const storedPurpose = purposeFromKeychainReference(value);
    if (!storedPurpose || storedPurpose !== purpose) return;

    await runMacSecurity([
      'delete-generic-password',
      '-a',
      keychainAccount(purpose),
      '-s',
      KEYCHAIN_SERVICE
    ], true);
  }
}

export function createPlatformSecretProtector(
  platform: NodeJS.Platform = process.platform
): SecretProtector {
  if (platform === 'win32') return new WindowsDpapiSecretProtector();
  if (platform === 'darwin') return new MacOsKeychainSecretProtector();
  return new PlaintextAlphaSecretProtector();
}
