import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

/**
 * Minimal reader/writer for the OpenSSH private key container.
 *
 * `node:crypto` can generate ed25519 keys but only exports them as PKCS#8 PEM,
 * which OpenSSH refuses to load for that curve — so the container format is
 * built here rather than shelling out to `ssh-keygen`. The format is documented
 * in OpenSSH's `PROTOCOL.key`:
 *
 *   "openssh-key-v1\0" | ciphername | kdfname | kdfoptions | nkeys |
 *   publickey blob | encrypted (here: plaintext) private section
 *
 * Only unencrypted keys are supported: a session container has no way to type
 * a passphrase, so an encrypted key could never be used anyway.
 */

const AUTH_MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
const PEM_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_FOOTER = '-----END OPENSSH PRIVATE KEY-----';
const PEM_LINE_LENGTH = 70;
/** Block size used for padding when the key is not encrypted. */
const NO_CIPHER_BLOCK_SIZE = 8;
const NONE = 'none';

const ENCRYPTED_KEY_MESSAGE =
  'The private key is passphrase-protected. Session containers cannot unlock it — paste an unencrypted key.';

export const ED25519 = 'ssh-ed25519';
const ED25519_KEY_BYTES = 32;

export type SshKeyErrorCode = 'invalid_private_key' | 'encrypted_private_key';

export class SshKeyError extends Error {
  constructor(
    readonly code: SshKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshKeyError';
  }
}

export interface SshKeyPair {
  /** OpenSSH-format private key, ready to be written to disk with `0600`. */
  readonly privateKey: string;
  /** `authorized_keys` line, e.g. `ssh-ed25519 AAAAC3… chief-web`. */
  readonly publicKey: string;
  /** `SHA256:…`, matching what `ssh-keygen -lf` prints. */
  readonly fingerprint: string;
  readonly type: string;
}

/** What we can learn about a private key the operator pasted in. */
export interface InspectedKey {
  readonly type: string;
  /** `null` when the public half cannot be derived (e.g. an ECDSA PEM). */
  readonly publicKey: string | null;
  readonly fingerprint: string | null;
}

// --- SSH wire encoding -----------------------------------------------------

function sshString(value: Buffer | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** Sequential cursor over an SSH wire-format buffer. */
class Reader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  readBytes(length: number): Buffer {
    if (this.offset + length > this.buffer.length) {
      throw new SshKeyError('invalid_private_key', 'The key data is truncated.');
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readUInt32(): number {
    return this.readBytes(4).readUInt32BE();
  }

  readString(): Buffer {
    return this.readBytes(this.readUInt32());
  }

  expect(prefix: Buffer): void {
    if (!this.readBytes(prefix.length).equals(prefix)) {
      throw new SshKeyError('invalid_private_key', 'This is not an OpenSSH private key.');
    }
  }
}

// --- Formatting ------------------------------------------------------------

function pemArmor(body: Buffer): string {
  const base64 = body.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) {
    lines.push(base64.slice(i, i + PEM_LINE_LENGTH));
  }
  return `${PEM_HEADER}\n${lines.join('\n')}\n${PEM_FOOTER}\n`;
}

/** `SHA256:<base64 of the sha256 digest, unpadded>` — OpenSSH's own format. */
export function fingerprintOf(publicKeyBlob: Buffer): string {
  const digest = createHash('sha256').update(publicKeyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export function formatPublicKey(publicKeyBlob: Buffer, comment: string): string {
  const type = new Reader(publicKeyBlob).readString().toString('utf8');
  const encoded = publicKeyBlob.toString('base64');
  return comment === '' ? `${type} ${encoded}` : `${type} ${encoded} ${comment}`;
}

// --- Generation ------------------------------------------------------------

/**
 * Generates an ed25519 deploy keypair. The raw scalars are the trailing 32
 * bytes of the DER encodings, which is stable for this curve (the prefix is a
 * fixed algorithm header).
 */
export function generateEd25519KeyPair(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const rawPublic = spki.subarray(spki.length - ED25519_KEY_BYTES);
  const seed = pkcs8.subarray(pkcs8.length - ED25519_KEY_BYTES);

  const publicKeyBlob = Buffer.concat([sshString(ED25519), sshString(rawPublic)]);

  // Two identical check integers let a decrypting client detect a wrong
  // passphrase; for an unencrypted key they are simply carried through.
  const checkInt = randomBytes(4);
  let privateSection = Buffer.concat([
    checkInt,
    checkInt,
    sshString(ED25519),
    sshString(rawPublic),
    sshString(Buffer.concat([seed, rawPublic])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  while ((privateSection.length + padding.length) % NO_CIPHER_BLOCK_SIZE !== 0) {
    padding.push(padding.length + 1);
  }
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);

  const container = Buffer.concat([
    AUTH_MAGIC,
    sshString(NONE),
    sshString(NONE),
    sshString(''),
    uint32(1),
    sshString(publicKeyBlob),
    sshString(privateSection),
  ]);

  return {
    privateKey: pemArmor(container),
    publicKey: formatPublicKey(publicKeyBlob, comment),
    fingerprint: fingerprintOf(publicKeyBlob),
    type: ED25519,
  };
}

// --- Inspection of a pasted key -------------------------------------------

function decodeOpenSshContainer(pem: string): Buffer {
  const start = pem.indexOf(PEM_HEADER);
  const end = pem.indexOf(PEM_FOOTER);
  if (start === -1 || end === -1 || end < start) {
    throw new SshKeyError('invalid_private_key', 'The OpenSSH key is missing its BEGIN/END lines.');
  }
  const base64 = pem.slice(start + PEM_HEADER.length, end).replace(/\s+/g, '');
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length === 0) {
    throw new SshKeyError('invalid_private_key', 'The OpenSSH key body is empty.');
  }
  return decoded;
}

/**
 * Reads the *public* half out of an OpenSSH private key. That section sits in
 * front of the encrypted blob, so it is readable even for a passphrase-locked
 * key — which lets us reject those with a precise message.
 */
function inspectOpenSshKey(pem: string): InspectedKey {
  const reader = new Reader(decodeOpenSshContainer(pem));
  reader.expect(AUTH_MAGIC);
  const cipher = reader.readString().toString('utf8');
  reader.readString(); // kdfname
  reader.readString(); // kdfoptions
  const keyCount = reader.readUInt32();
  if (keyCount < 1) {
    throw new SshKeyError('invalid_private_key', 'The OpenSSH key contains no keys.');
  }
  const publicKeyBlob = reader.readString();
  const type = new Reader(publicKeyBlob).readString().toString('utf8');

  if (cipher !== NONE) {
    throw new SshKeyError(
      'encrypted_private_key',
      `${ENCRYPTED_KEY_MESSAGE} (\`ssh-keygen -p -N "" -f key\` removes the passphrase.)`,
    );
  }

  return { type, publicKey: formatPublicKey(publicKeyBlob, ''), fingerprint: fingerprintOf(publicKeyBlob) };
}

/** Big-endian two's-complement integer, as SSH encodes RSA parameters. */
function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const first = trimmed[0] ?? 0;
  return first & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
}

/** Builds the SSH public key blob for the key types we can re-encode. */
function publicKeyBlobFrom(key: KeyObject): Buffer | null {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.kty === 'RSA' && jwk.n !== undefined && jwk.e !== undefined) {
    return Buffer.concat([
      sshString('ssh-rsa'),
      sshString(mpint(Buffer.from(jwk.e, 'base64url'))),
      sshString(mpint(Buffer.from(jwk.n, 'base64url'))),
    ]);
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x !== undefined) {
    return Buffer.concat([sshString(ED25519), sshString(Buffer.from(jwk.x, 'base64url'))]);
  }
  return null;
}

/**
 * Encryption is visible in the armor: PKCS#8 says so in the BEGIN line, and the
 * traditional format carries a `Proc-Type: 4,ENCRYPTED` header. OpenSSL's own
 * error for a missing passphrase is unhelpfully generic, so detect it up front.
 */
function isEncryptedPem(pem: string): boolean {
  return pem.includes('ENCRYPTED PRIVATE KEY') || /^Proc-Type:\s*4,ENCRYPTED/m.test(pem);
}

function inspectPemKey(pem: string): InspectedKey {
  if (isEncryptedPem(pem)) throw new SshKeyError('encrypted_private_key', ENCRYPTED_KEY_MESSAGE);

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SshKeyError('invalid_private_key', 'The private key could not be parsed.');
  }

  const blob = publicKeyBlobFrom(key);
  if (blob === null) {
    // e.g. an ECDSA PEM: the key still works for git, we just cannot show the
    // public half, and the operator already has it on their machine.
    return { type: key.asymmetricKeyType ?? 'unknown', publicKey: null, fingerprint: null };
  }
  return {
    type: new Reader(blob).readString().toString('utf8'),
    publicKey: formatPublicKey(blob, ''),
    fingerprint: fingerprintOf(blob),
  };
}

/**
 * Validates a pasted private key and derives its public half when possible.
 * Throws `SshKeyError` for anything git could not use non-interactively.
 */
export function inspectPrivateKey(pem: string): InspectedKey {
  const trimmed = pem.trim();
  if (trimmed === '') {
    throw new SshKeyError('invalid_private_key', 'The private key is empty.');
  }
  if (trimmed.includes(PEM_HEADER)) return inspectOpenSshKey(trimmed);
  if (/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/m.test(trimmed)) return inspectPemKey(trimmed);
  throw new SshKeyError(
    'invalid_private_key',
    'Expected a PEM private key beginning with `-----BEGIN … PRIVATE KEY-----`.',
  );
}
